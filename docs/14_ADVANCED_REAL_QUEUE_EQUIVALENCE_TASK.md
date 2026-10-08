# Advanced 真实队列 Payload 等价性与正式功能回归任务

> 状态：待本地 Codex 执行  
> 前置报告：[`13_ADVANCED_PERFORMANCE_DIAG_REPORT.md`](13_ADVANCED_PERFORMANCE_DIAG_REPORT.md)  
> 当前代码基线：`78024d27bcb8eae0700ce01a4f622df7e3cae9f7`  
> 当前目标：验证 **TerryDirector Advanced 的真实 UI 队列路径** 与本地脚本直接调用 ComfyUI `/prompt` API 的 payload 是否执行等价；同时完成 Advanced 正式实时预览路径恢复后的功能回归。

---

## 1. 为什么还要做这一轮

上一轮性能诊断已经得到几个可靠结论：

1. 输入真正一致时，Base 与 Advanced 的 `td_s*` H3 核心 expanded graph 完全一致。
2. `cache_key=None` 与 `cache_key=str(unique_id)` 的严格 A/B 未表现出 sampler 性能差异。
3. LATENT cache 写盘不是几十分钟异常的来源。
4. CreateVideo / video save 不是灾难性 sampler 降速的稳定触发条件。
5. 浏览器接收 Advanced 的 progress / execution WebSocket 事件，也不是稳定触发条件。
6. 历史上出现过 5～15 倍单步卡顿，但上一轮严格测试没有复现，因此不能声称根因已找到或已经永久修复。

上一轮本地 Codex 的主要任务是通过脚本直接向 ComfyUI `/prompt` API 提交任务。

这条测试链路非常有价值，但它和用户真实使用的 Advanced 执行入口仍存在一个待确认点：

```text
用户真实 Advanced 执行
→ TerryDirector 前端
→ app.queuePrompt(0, 1, [String(advancedNode.id)])
→ ComfyUI graphToPrompt()
→ api.queuePrompt(...)
→ POST /prompt
```

而本地测试此前主要是：

```text
Codex 读取/构造 API prompt
→ 直接 POST /prompt
```

这里不需要模拟鼠标。

真正需要确认的是：

> **这两条路径最终发给 ComfyUI 后端的执行 payload 是否等价。**

---

## 2. 当前正式代码状态

### 2.1 Advanced 预览路径已恢复

在性能隔离阶段，Advanced 曾临时强制：

```python
preview_override=None
```

因此即使 UI 中存在实时预览控件，后端正式预览路径实际被关闭。

提交 `78024d2` 已恢复原正式逻辑：

- `preview_enabled = False`
  - 不启用实时采样预览；
- `preview_enabled = True` 且 `preview_fps == 1`
  - 使用 ComfyUI 自带 MiniMax H3 / TAESD 单帧 preview；
- `preview_enabled = True` 且 `preview_fps > 1`
  - 如果存在 `ModelPreviewOverrideKJ`，使用 KJ 多帧预览；
  - 如果 KJ 不可用，回退到 1 fps core preview。

当前日志会明确显示：

```text
preview=off
preview=core-1fps
preview=kj-12fps
```

本轮性能等价性测试**首先全部使用 `preview=off`**，避免重新引入变量。

### 2.2 现有诊断能力保留

当前仍保留：

- `input_signature`
- `core_graph_signature`
- Base → Advanced core graph 对比
- Assemble memory checkpoint
- Advanced terminal cache/save timing

不要删除这些诊断能力，除非本轮最终确认它们需要收口。

---

# 3. 本轮唯一主问题

本轮主问题不是“Advanced 为什么慢”，而是先回答一个更基础的问题：

> **真实 `app.queuePrompt(... [Advanced节点ID])` 生成的请求，与 Codex 测试脚本直接提交的 `/prompt` 请求，到底是否相同。**

在回答这个问题前，不继续修改 H3 核心图、cache、assembly 或 ComfyUI 环境。

---

# 4. ComfyUI 前端真实队列路径背景

ComfyUI 前端的实际逻辑大致是：

```text
app.queuePrompt(
    number,
    batchCount,
    [advancedNodeId]
)
```

内部会：

1. 对所有 widget 执行 `beforeQueued`；
2. 调用 `graphToPrompt()`，实时序列化当前画布；
3. 得到：
   - `p.output`：API prompt graph；
   - `p.workflow`：当前 workflow metadata；
4. 调用：

```js
api.queuePrompt(number, p, {
    partialExecutionTargets: [advancedNodeId],
    previewMethod,
})
```

最终 `POST /prompt` body 的关键结构是：

```json
{
  "client_id": "...",
  "prompt": { "...": "..." },
  "partial_execution_targets": ["<Advanced node id>"],
  "extra_data": {
    "comfy_usage_source": "comfyui-frontend",
    "extra_pnginfo": {
      "workflow": {}
    },
    "preview_method": "..."
  }
}
```

注意：

- `prompt` 是最重要的实际执行图；
- `partial_execution_targets` 很重要，因为 TerryDirector 的“只运行当前导演节点”依赖它；
- `preview_method` 可能改变采样预览行为，需要纳入比较；
- `client_id` 主要影响 WebSocket 事件归属，但真实等价运行时也应记录；
- `extra_pnginfo.workflow` 主要是工作流/输出 metadata，但仍应保存并区分“执行差异”和“metadata 差异”；
- auth token / API key 属于认证字段，不作为本地执行图差异判断依据。

---

# 5. Task A：捕获真实 UI queue payload

## 5.1 不做鼠标自动化

不要使用：

- pyautogui；
- OCR；
- 模拟鼠标点击；
- 模拟键盘。

本轮需要走真实前端代码路径，但可以**程序化调用现有 `app.queuePrompt`**。

也就是说：

```js
app.queuePrompt(0, 1, [String(advancedNode.id)])
```

本身就是我们要验证的真实执行入口。

## 5.2 临时捕获位置

优先在前端 `api.queuePrompt` 调用边界做临时 instrumentation，因为这里已经拿到了：

- 完整 `p.output`
- 完整 `p.workflow`
- `partialExecutionTargets`
- `previewMethod`
- 当前 `client_id`

不要在 `graphToPrompt()` 之前自己重新构造 prompt。

### 推荐做法

仅在 TerryDirector Advanced 的 partial execution target 命中时：

1. 捕获 `api.queuePrompt` 收到的数据；
2. 构造一份诊断 snapshot；
3. 保存到本地临时文件，例如：

```text
ComfyUI/output/.terrydirector_diag/ui_queue_payload.json
```

snapshot 至少包含：

```json
{
  "client_id": "...",
  "prompt": {},
  "workflow": {},
  "partial_execution_targets": [],
  "preview_method": "...",
  "number": 0
}
```

### 要求

- instrumentation 必须是临时的；
- 测试完成后删除；
- 不应改变 prompt 内容；
- 不应改变 queue 顺序；
- 不应插入新的 expanded graph 节点；
- 不应修改 Advanced widget 值；
- 不应调用第二次 `graphToPrompt()` 来代替真实数据。

---

# 6. Task B：捕获当前 Codex API 测试 payload

将上一轮 Codex 直接提交 `/prompt` 的 payload 同样保存为：

```text
ComfyUI/output/.terrydirector_diag/codex_api_payload.json
```

要求：

- 使用同一份当前画布/workflow 状态；
- 0.2MP；
- 608×352；
- 3 个活动片段；
- seed=9；
- preview off；
- Advanced 节点相同；
- 不修改模型、VAE、sampler、sigmas、prompt、assets。

---

# 7. Task C：执行 payload canonical diff

## 7.1 第一层：执行图比较

优先比较：

```text
ui.prompt
vs
codex.prompt
```

canonicalize 时：

- object key 排序；
- 保留 node id；
- 保留每个 node：
  - `class_type`
  - `inputs`
- 保留 link；
- 不忽略 widget 派生的 input；
- 不忽略 `config_json`；
- 不忽略 `rerun_clip_id`；
- 不忽略 seed；
- 不忽略 Advanced 保存/preview 参数。

输出：

```text
prompt hash
node count
新增节点
缺失节点
每个不同 node 的具体 input diff
```

## 7.2 第二层：partial execution

比较：

```text
partial_execution_targets
```

真实 UI 应该明确只包含当前 Advanced 节点目标。

如果 Codex API 脚本没有提供该字段，必须记录为真实差异，不要直接假设“后端最终结果一样”。

## 7.3 第三层：执行相关 extra_data

比较：

```text
preview_method
client_id
```

分别说明：

- 是否不同；
- 是否会改变采样/preview；
- 是否只影响事件路由。

## 7.4 第四层：metadata

`extra_pnginfo.workflow` 单独比较。

不要把 metadata 差异与实际 `prompt` 图差异混为一谈。

---

# 8. Task D：用“真实 UI 捕获 payload”直接重放

这是本轮最关键的对照。

拿到真实 UI queue 的 snapshot 后，构造一份**执行语义一致**的直接 API replay：

```text
UI queue capture
→ 取出完全相同 prompt
→ 相同 partial_execution_targets
→ 相同 preview_method
→ 使用浏览器 client_id（用于本轮严格等价）
→ POST /prompt
```

这样得到两条真正可比较的路径：

### D1. UI Queue

```text
app.queuePrompt(...)
→ /prompt
```

### D2. Exact Replay

```text
capture 的同一 payload
→ 直接 /prompt
```

两次测试都使用：

- 0.2MP
- 3 段
- seed=9
- preview off

记录：

```text
input_signature
core_graph_signature
clip 1 sampler
clip 2 sampler
clip 3 sampler
Prompt total
cache total
video save
```

### 判断

#### 如果 D1 与 D2 性能一致

可以认为：

> “是不是 API 提交”本身不是性能差异来源。

后续本地 Codex 可以继续用 exact payload API replay 做高效测试。

#### 如果 D1 慢、D2 正常

说明差异存在于：

- 前端 queue 生命周期；
- `beforeQueued`；
- 浏览器/ComfyUI 前端运行时；
- 提交前后的状态时序；

而不是 `/prompt` body 本身。

这时不要继续改 H3 图，应针对 queue 生命周期做下一轮诊断。

#### 如果两者 payload 本来就不同

先查清差异，不做性能结论。

---

# 9. Task E：Advanced 正式功能回归

完成 payload 等价性以后，验证提交 `78024d2` 恢复的正式 preview 行为。

仍然先用 0.2MP / 3 段。

## E1. Preview Off

```text
preview_enabled = false
```

日志必须包含：

```text
preview=off
```

要求：

- 不出现 KJ preview graph node；
- 不出现实时预览画面；
- sampler 保持正常；
- cache/save/local-rerun 路径不受影响。

## E2. 1 FPS Core Preview

```text
preview_enabled = true
preview_fps = 1
```

日志应包含：

```text
preview=core-1fps
```

要求：

- 使用 ComfyUI MiniMax H3 / TAESD 单帧 preview；
- Advanced 顶部预览能收到采样 preview；
- 任务结束后切换为最终视频；
- 最终视频仍可播放。

## E3. KJ Multi-frame Preview

如果 `ModelPreviewOverrideKJ` 已安装：

```text
preview_enabled = true
preview_fps = 12
```

日志应包含类似：

```text
preview=kj-12fps
```

要求：

- expanded graph 包含 `ModelPreviewOverrideKJ`；
- Advanced 顶部出现动态 preview；
- 最终视频正常；
- preview foldout / fps / tiny VAE 逻辑正常。

如果 KJ 未安装：

- 应自动回退 `core-1fps`；
- 不得报错终止任务。

---

# 10. Task F：真实 UI 9 段长任务（条件执行）

只有以下全部满足后再跑：

- Task C payload 已明确；
- Task D UI vs exact replay 性能一致；
- E1 preview-off 功能正常。

使用：

- 0.5MP
- 960×544
- 原始 9 段
- seed=9
- preview off
- **真实 `app.queuePrompt` 路径**

目的不是继续证明 cache，而是验证：

> 用户实际使用路径在当前代码中是否仍能完成约 36～37 分钟的正常任务。

如果正常，只跑一次即可，不要重复浪费 GPU 时间。

如果再次出现历史几百秒/step 异常，立即进入 Task G。

---

# 11. Task G：仅在异常再次出现时启用非侵入式 timing

不要预先重构 graph。

异常出现后，记录：

```text
td_sN_sample start / finish
td_sN_decode_video start / finish
td_sN_decode_audio start / finish
td_sN_assemble start / finish
```

每个边界同步记录：

```text
process RSS
system RAM used / free
CUDA free / total
torch allocated / reserved
prompt id
execution node id
display node id
client id
timestamp
```

必须先回答：

> 卡顿时间究竟落在 sample、decode_video、decode_audio、assemble，还是节点之间的 executor 调度空档？

得到这个答案以后再设计下一轮 A/B。

---

# 12. 重要观察：assembly 内存压力

上一轮 0.5MP / 9 段最终拼接出现：

```text
frames=1200
images≈7.17GB
process RSS≈44.7GB
system RAM≈96.8%
```

其他长任务峰值甚至达到约 97.5%～98.2%。

这是当前明确存在的结构性资源风险，但：

- Base / Advanced 都存在；
- 上一轮没有因此稳定复现灾难性 sampler 降速；
- 历史异常也不是严格单调变慢。

因此本轮：

> **只记录，不重构 assembly。**

后续应单独建立内存优化任务，不和 Advanced 历史性能异常混在一起。

---

# 13. 本轮禁止事项

不要：

- 调整 ComfyUI 启动参数；
- 升级/降级 ComfyUI；
- 修改模型或 VAE；
- 修改 H3 sampler/sigmas；
- 重构公共 assembly；
- 修 trailing gap；
- 实现 SelfLift；
- 修改时间线 UI；
- 删除 cache；
- 为了“可能更快”提交猜测性优化；
- 用鼠标/OCR自动化代替真实 `app.queuePrompt`。

---

# 14. 最终结果报告格式

创建：

```text
docs/15_ADVANCED_REAL_QUEUE_EQUIVALENCE_REPORT.md
```

至少包含：

## A. Payload 等价性

```text
UI prompt hash
Codex prompt hash
UI partial_execution_targets
Codex partial_execution_targets
preview_method
client_id
prompt node diff
metadata diff
```

明确给出：

```text
执行 payload：EXACT MATCH / NOT MATCH
```

不能只写“看起来一样”。

## B. UI vs Exact Replay

表格：

| 路径 | clip1 | clip2 | clip3 | Prompt total | cache | video save |
|---|---:|---:|---:|---:|---:|---:|
| UI queue | | | | | | |
| exact API replay | | | | | | |

## C. Preview 功能回归

记录：

- off
- core 1fps
- KJ multi-frame（若可用）

## D. 9 段真实 UI 回归

若执行，记录：

- 每个 sampler；
- Prompt 总时间；
- cache；
- save；
- memory peak；
- 是否出现历史异常。

## E. 代码状态

列出：

- 临时 instrumentation；
- 是否已全部删除；
- 最终 `git status --short`；
- 最终 commit hash。

---

# 15. 本轮成功标准

至少确认以下事实：

1. 真实 UI Queue 与 Codex API 测试的执行 payload 是否完全等价；
2. 如果不等价，差异具体是什么；
3. exact UI payload replay 是否和 UI Queue 性能一致；
4. `78024d2` 恢复后的 Advanced preview 三种行为是否正确；
5. 不引入新的性能架构改动。

本轮不要以“找到历史卡顿根因”为成功条件。

真正的成功标准是：

> **把真实用户执行路径与自动化测试路径彻底对齐。以后所有性能 A/B 都建立在可证明等价的提交语义上。**
