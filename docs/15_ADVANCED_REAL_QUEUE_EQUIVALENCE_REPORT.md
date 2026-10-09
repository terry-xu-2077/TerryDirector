# Advanced 真实队列 Payload 等价性与正式功能回归报告

> 执行日期：2026-10-09  
> 任务文档：[`14_ADVANCED_REAL_QUEUE_EQUIVALENCE_TASK.md`](14_ADVANCED_REAL_QUEUE_EQUIVALENCE_TASK.md)  
> 拉取后的任务基线：`9d4a4c43bf3610ddf7dc202bc7d3817499e11557`  
> 已实测代码提交：`a8eb0a081ebc02be8efb2f3f81898017bbac99be`  
> 环境：ComfyUI `0.39.0`、frontend `1.53.10`、RTX 3090 24GB  

## 结论

1. UI 与独立 Codex 构造器得到的**可执行 prompt 图完全一致**：8 个节点，`class_type + inputs` canonical hash 都是 `0849e6b7dbba85952ea853492c0618135c4a38fca9d017c0be95dff596b35073`。
2. 完整捕获快照严格比较为 **NOT MATCH**：原始 prompt 有 5 个 `_meta.title` 本地化差异，`preview_method` 在 API 边界分别为 `default` / `null`，`client_id` 不同，workflow metadata 有 43 处序列化差异。这些差异均不改变本次 backend 执行图。
3. 真实 UI 的 `partialExecutionTargets` 被本机已安装的南风提示词列表前端包装器丢失；UI 与直接 API 最终都没有向 backend 提交 `partial_execution_targets`。这是明确的真实路径差异，不能按预期目标判为完整等价。
4. 使用 UI 捕获内容做 exact API replay 后，两次 3 段任务的 sampler、cache 和 video save 等价；UI 总时间 227.34 秒，exact replay 220.41 秒，差值 6.93 秒。
5. Advanced 三种预览行为均完成真实回归。1fps 核心预览发现并修复了一处阻断执行的兼容问题；修复后能收到 12 个原生 JPEG 预览事件。KJ 12fps 能收到 15 个动态 MP4 预览事件并正常切换最终视频。
6. 0.5MP、960×544、原始 9 段真实 UI 任务一次完成，总时间 `37:40`，未复现历史几百秒/step 异常。最终 assembly 达到 98.3% 系统内存，结构性内存风险仍然存在。

## A. Payload 等价性

### A1. 捕获方式

通过浏览器调试协议连接真实 ComfyUI frontend，在 `api.queuePrompt` 边界安装一次性内存包装器，然后程序化调用：

```javascript
app.queuePrompt(0, 1, [String(advancedNode.id)])
```

未使用鼠标、键盘、OCR，也没有再次调用 `graphToPrompt()` 代替真实数据。包装器原样转发参数，没有修改 prompt、队列顺序或节点 widget。

诊断快照保存在运行目录：

- `ComfyUI/output/.terrydirector_diag/ui_queue_payload.json`
- `ComfyUI/output/.terrydirector_diag/codex_api_payload.json`
- `ComfyUI/output/.terrydirector_diag/ui_vs_codex_payload_diff.json`
- `ComfyUI/output/.terrydirector_diag/ui_queue_options_probe.json`

### A2. Canonical diff

| 项目 | UI Queue | Codex API 构造器 | 结论 |
|---|---|---|---|
| prompt 节点数 | 8 | 8 | 相同 |
| 原始 prompt hash | `30772d110b1b204cf40c8b1fc29bc23ba057ff10e7fab4ca24adca23b3e35943` | `b205cbb741da1b528cb395a121070e8d19ca2b630bf29a57739eac16f2428a7e` | 不同 |
| 执行图 hash | `0849e6b7dbba85952ea853492c0618135c4a38fca9d017c0be95dff596b35073` | 同左 | **EXACT MATCH** |
| 执行节点 / input diff | 0 | 0 | **EXACT MATCH** |
| `partial_execution_targets` | `null` | `null` | 相同，但偏离预期 |
| API 边界 `preview_method` | `default` | `null` | 不同；两者实际 HTTP body 均省略该字段 |
| `client_id` | `7d5c1168fc1c47aeb981f50937ed6e64` | `codex-task14-0ad4dbeb69414a7bbaba80449b3a6127` | 不同，只影响事件路由 |
| workflow metadata diff | 43 处 | 43 处 | 不影响执行图 |

原始 prompt 的 5 个差异全部是 `_meta.title`：节点 329～333 的 UI 中文标题与 `/object_info` 英文标题不同。移除 `_meta` 后，`class_type`、全部 inputs、links、`config_json`、seed、rerun 与 preview/save 参数完全一致。

workflow metadata 的差异来自当前 frontend 再序列化：UI 增加 `frontendVersion` 和 VHS 字段，并省略或归一化部分 `localized_name`、输入描述及节点高度。没有 metadata 差异进入 backend 执行 inputs。

### A3. Partial execution 丢失原因

真实 `app.queuePrompt` 调用包含第三个参数 `['328']`。在 `api.queuePrompt` 边界实际收到的 options 虽然包含键名 `partialExecutionTargets`，值却是 `undefined`，JSON snapshot 因此记录为 `null`。

原因位于本机已安装的：

```text
ComfyUI/custom_nodes/nanfeng_prompt_nodes/web/prompt_list.js
```

其包装器只声明两个参数：

```javascript
app.queuePrompt = async function (number, batchCount) {
  // ...
  if (activeLists.length !== 1) return previousQueuePrompt(number, batchCount);
}
```

当没有恰好一个活动的南风提示词列表节点时，第三个 partial target 没有继续转发。rgthree、TerryDirector、Bernini 和 MiniMax 的相关包装器均使用 `arguments` 或 `...args` 转发，不是本次丢失来源。

本工作流当前只有 Advanced 分支作为活动输出，因此 backend 仍执行节点 328，所有本轮任务都能完成；但“只运行当前导演节点”的严格语义在包含其他活动输出的工作流中存在风险。此次没有修改第三方南风节点。

### A4. 严格判定

```text
执行 prompt 图（class_type + inputs）：EXACT MATCH
完整捕获快照 / 执行包络：NOT MATCH
真实 UI partial execution 与产品预期：NOT MATCH
```

## B. UI Queue 与 Exact Replay

Exact replay 直接读取 UI capture，使用相同 prompt、workflow metadata 和浏览器 `client_id`。由于真实 UI 的 partial target 已丢失、`preview_method=default` 在 HTTP 层被省略，replay 也省略这两个字段，保持实际 backend 语义一致。

| 路径 | prompt id | clip1 | clip2 | clip3 | Prompt total | cache | video save |
|---|---|---:|---:|---:|---:|---:|---:|
| UI queue | `6f50ec51-fc38-4a4c-beec-114ef3285828` | 45s / 11.43s/it | 37s / 9.44s/it | 53s / 13.42s/it | 227.34s | 0.049s | 3.603s |
| exact API replay | `d32b8880-aef9-4ea5-a45a-e9cb2f2c9958` | 45s / 11.40s/it | 37s / 9.43s/it | 53s / 13.42s/it | 220.41s | 0.012s | 3.569s |

两次均为：

- `input_signature=e487356e623301c5`
- `core_graph_signature=abd47a2ce1034013`
- 608×352、3 个活动片段、seed 9、preview off
- terminal total 分别为 3.655 秒 / 3.587 秒

总时间差为 6.93 秒；各 sampler 平均步时差不超过 0.03 秒。结论：**UI Queue 与相同 backend payload 的 exact replay 性能等价，“是否由 API 提交”不是本次性能差异来源。**

当前 Advanced 保存状态与 Base 快照还有一处已知编排输入差异：`td_s3_assemble.gap_after_frames` 为 906 / 912。它来自两节点各自保存的时间线状态，不是 UI queue 与 replay 差异，也没有在本任务中修改。

## C. Preview 功能回归

### C1. Preview Off

结果：**PASS**。

- 日志：`preview=off`
- expanded graph 不含 `ModelPreviewOverrideKJ`
- 没有核心 JPEG 或 KJ 动态预览事件
- sampler、cache、save、local rerun 路径未受影响
- 运行完成后顶部显示最终视频

在 core 与 KJ 回归完成后又执行了 9 段 preview-off 任务。保留的事件监听器计数没有增加，证明 1fps 使用过的全局 core preview 设置不会泄漏到后续 preview-off 任务。

### C2. 1fps Core Preview

首次运行结果：**FAIL，已修复并复测通过**。

首次 prompt `0205f555-49f1-488f-8554-dbbf740d3ec6` 在采样前失败：

```text
AttributeError: 'NoneType' object has no attribute 'show_progress_bar'
```

原因是正式逻辑强制 `latent_preview.set_preview_method('taesd')`。本机 `models/vae_approx/taeh3.safetensors` 是 KJ 支持的 flat 2D TinyVAE 布局，当前 ComfyUI core 的视频 TAESD 路径要求 `decoder.*` temporal TAEHV 布局；VAE 检测返回空模型后被直接解引用。

已在 Advanced 分支修复：

1. 每次执行先把 ComfyUI 的进程级 preview method 复位为启动默认值；
2. 1fps 选择 ComfyUI `auto`，由当前 MiniMax H3 `latent_rgb_factors` 生成原生单帧 core preview；
3. preview off 与 KJ 模式不会继承上一轮 core preview 全局状态。

复测 prompt `72333146-6018-459d-979d-4ee6116343f0`：

- 日志：`preview=core-1fps`
- 收到 12 个 `b_preview_with_metadata` JPEG 事件，3 个 sampler 各 4 个
- 所有事件的 `display_node_id` / `parent_node_id` 都是 Advanced `328`
- sampler：45s / 37s / 53s
- Prompt total：224.17s
- 最终视频：`TerryDirector_00039_.mp4`
- 完成后 live preview 清空，顶部切换到最终视频

结果：**PASS**。当前 core 1fps 使用 H3 原生 Latent2RGB；flat 2D `taeh3` 继续供 KJ TinyVAE 模式使用。

### C3. KJ 12fps Multi-frame Preview

结果：**PASS，有明显额外耗时**。

- prompt：`8f18572f-65e8-45ab-986b-b7e9f3633f2e`
- 日志：`preview=kj-12fps`
- expanded graph 增加 3 个 `ModelPreviewOverrideKJ`
- 收到 15 个 `kj_preview_override` 事件：每段 1 个初始化事件 + 4 个采样步骤
- 动态 payload 为 MP4，前端顶部 live video 在采样中可见
- sampler：46s / 42s / 56s
- Prompt total：496.08s
- cache：0.012s；video save：3.574s
- 最终视频：`TerryDirector_00040_.mp4`
- 完成后 live preview 清空并切换最终视频

KJ 任务总时间比 core 1fps 多约 272 秒，采样本身只增加约 9 秒，主要额外时间出现在动态 TinyVAE 预览与最后解码收尾。本任务只记录该成本，没有修改 KJ 节点或 H3 graph。

## D. 0.5MP / 9 段真实 UI 回归

### D1. 提交状态

- 真实入口：`app.queuePrompt(0, 1, ['328'])`
- prompt：`c8faca82-7e8f-4150-99f9-e0225c0926c5`
- `input_signature=d984fb13607eb508`
- `core_graph_signature=a93a3d13d2cef40b`
- expanded graph：156 节点
- 分辨率：960×544（0.5MP）
- 片段：原始 9 段全部启用
- timeline end：1194 帧
- seed：9
- preview：off

### D2. Sampler

| 片段 | sampler total | 平均 step |
|---:|---:|---:|
| 1 | 02:04 | 31.09s/it |
| 2 | 01:39 | 24.81s/it |
| 3 | 02:29 | 37.47s/it |
| 4 | 03:08 | 47.00s/it |
| 5 | 03:28 | 52.19s/it |
| 6 | 03:28 | 52.00s/it |
| 7 | 03:11 | 47.84s/it |
| 8 | 03:08 | 47.16s/it |
| 9 | 03:11 | 47.77s/it |

没有任何片段进入历史几百秒/step 区间，也没有随片段序号持续恶化。

### D3. 总时间、保存与输出

- Prompt total：`37:40`
- terminal cache：0.227s / 72.1MB
- video save：28.132s
- terminal total：28.396s
- 输出：`ComfyUI/output/video/TerryDirector_00041_.mp4`
- ffprobe：960×544、24fps、1194 帧、49.75 秒
- 文件大小：23,285,454 bytes
- 浏览器收到 `execution_success`，顶部最终视频可见且 live preview 已隐藏

结论：**真实用户入口一次完成了约 37 分钟的预期长任务，历史异常本轮没有复现。**

### D4. Assembly 内存峰值

最终 checkpoint：

```text
frames=1194
images=7136.0MB
process RSS=44647MB
system RAM=98.3%
RAM free=1080MB
```

这与任务文档记录的结构性 assembly 风险一致。高内存阶段第 8、9 段 sampler 仍为约 47 秒/步，没有出现灾难性 sampler 降速。本轮按要求只记录，没有改 assembly。

## E. 代码与清理状态

### E1. 正式代码改动

只修改 `director_node.py` 中 `TerryDirectorAdvanced` 的 live-preview 选择：

- core 1fps 从强制 TAESD 改为 ComfyUI H3 `auto` core preview；
- 每次 Advanced 执行前复位进程级 preview method；
- Base `TerryDirector` 节点及公共 H3 sampler、sigmas、decode、assembly 均未修改。

已实测代码提交：

```text
a8eb0a081ebc02be8efb2f3f81898017bbac99be
```

### E2. 临时 instrumentation

临时捕获仅存在于 headless Chrome 页面内存和工作区 `.codex-run` 辅助脚本。测试结束后均删除；没有向 TerryDirector frontend 写入诊断 hook，也没有把 instrumentation 提交到仓库。

`ComfyUI/output/.terrydirector_diag` 中的 JSON 是本轮结果证据，不属于运行时 instrumentation，保留供后续复核。

### E3. 工作流文件

两份 `Terry导演台.json` 测试前后 SHA256 均为：

```text
5C83EEAE351B028690E9F0125660D0E24D0415299C4C2F3EAB42BF464122E5DD
```

0.5MP、9 段与 preview widget 只改了 headless 浏览器内存状态，没有保存工作流。

### E4. 最终仓库状态

报告提交后应只包含：

- Advanced preview 修复提交 `a8eb0a081ebc02be8efb2f3f81898017bbac99be`
- 本报告与任务状态更新

最终交付 commit hash 由报告提交生成，记录在交付消息中；提交完成后 `git status --short` 必须为空。

## 后续建议

1. 在南风提示词列表前端包装器中使用 `...args` 或显式转发第三个参数，恢复所有扩展的 partial execution target。该修复应提交到对应第三方仓库，并单独回归多输出工作流。
2. 单独建立 assembly 内存优化任务。当前 0.5MP / 1194 帧将系统内存推至 98.3%，已经是明确的生产风险。
3. KJ 多帧预览应单独评估 preview frame 数量与 TinyVAE 收尾成本；本轮不应把其约 272 秒额外耗时与历史 preview-off sampler 异常混为一谈。
