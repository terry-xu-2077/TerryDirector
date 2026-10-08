# Advanced 性能差异诊断任务（交给本地 Codex）

> 状态：本轮验证已完成；当前代码未复现历史随机灾难性降速
> 目标：定位并修复 **TerryDirector Advanced 相比基础版出现随机/灾难性采样变慢** 的根因。  
> 当前仓库诊断基线：代码已加入 Base / Advanced 输入签名、核心 expanded graph 签名，以及 Base→Advanced 逐节点 diff 机制。  
> 当前代码提交基线：`244eb53`（创建本文档前）。
> 测试结果：见 [`13_ADVANCED_PERFORMANCE_DIAG_REPORT.md`](13_ADVANCED_PERFORMANCE_DIAG_REPORT.md)。

---

## 1. 项目背景

TerryDirector 是 ComfyUI 中针对 MiniMax H3 的导演时间线节点。

目前有两个主要节点：

- **TerryDirector（基础版）**
  - 负责时间线编排、提示词、资产引用、片段连续性。
  - 执行时展开为 H3 多片段生成图。
  - 已经可以作为可靠的性能基线。

- **TerryDirector Advanced**
  - 与基础版共用编辑器和 H3 生成逻辑。
  - 额外提供：
    - 顶部最终视频审片；
    - 视频保存；
    - 采样预览；
    - 分段 LATENT 持久缓存；
    - 单片段局部重跑；
    - Advanced 专属时间线/进度 UI。

当前问题不是“功能跑不通”，而是：

> **同一机器、同一 ComfyUI、同一模型、同一提示词/资产/时间线下，基础版性能正常，而 Advanced 会随机出现极端慢的 H3 sampling step。**

用户已经明确要求：  
**基础版就是环境控制组。只要同条件基础版正常，就不要继续把问题归因到 ComfyUI、显卡、DynamicVRAM 或系统环境；应优先定位 Advanced 自己触发了什么差异。**

---

## 2. 必须遵守的诊断原则

### 2.1 基础版是及格基线

同一环境中，基础版多次表现正常，因此：

- 不再要求用户测试：
  - `--disable-fast-disk`
  - `--disable-cuda-graphs`
  - `--disable-async-offload`
  - 其他 ComfyUI 启动参数
- 不再优先怀疑驱动、GPU、ComfyUI 本身。
- 若某个底层机制最后确实被触发异常，也必须先证明：
  **是 Advanced 的实现差异触发了它，而不是环境本身随机坏掉。**

### 2.2 每次只改一个变量

后续 A/B 测试必须做到：

- 同一个 Advanced 节点；
- 同一份时间线；
- 同一模型 / VAE / sampler / sigmas；
- 同一 seed；
- 同一分辨率；
- 同一提示词和资产；
- 只改变一个代码路径开关。

禁止再出现“同时改缓存、前端、图结构、启动参数，然后一起测”的情况。

### 2.3 优先代码差分，不靠猜

先回答：

1. Base 与 Advanced 输入是否真的一致？
2. 两者的 H3 核心 expanded graph 是否真的一致？
3. 如果一致，Advanced 外围图到底比正常版本多了什么？
4. 哪一个最小差异能稳定复现性能退化？

---

## 3. 已确认的性能事实

### 3.1 原始 9 段、较高分辨率测试

基础版曾完整跑完：

- 总耗时约：**33:52**
- 多数片段 sampler 在约 1.5～3.5 分钟量级。

Advanced 曾出现：

- 总耗时 **56:45**
- 某次片段 3 sampler：**46:52**
- 另一轮总耗时 **40:18**
- 还有一轮：
  - clip 7：**27:22**
  - clip 8：恢复到 **3:22**
  - clip 9：再次 **22:01**
  - 总耗时：**1:01:22**

这说明异常不是稳定线性变慢，而是可能出现：

```text
正常 → 极慢 → 恢复正常 → 再极慢
```

所以不能简单解释为“时间线越长内存越多，因此持续越来越慢”。

### 3.2 Batch cache 本身不是耗时来源

完整 9 段异常任务中：

- 9 个 LATENT cache 总大小：约 **72.1 MB**
- Batch cache 总时间：**0.171 s**
- 最终视频保存：**24.147 s**
- Advanced terminal 总时间：**24.328 s**
- 整个任务：**1:01:22**

因此：

> **几十分钟的异常发生在 sampling 阶段，不是 torch.save，也不是视频编码。**

### 3.3 video/save-only 版本曾表现正常

曾测试过 Advanced：

```text
Base H3 graph
+ CreateVideo
+ AdvancedFinish / video.save
- cache
- preview
- rerun
```

完整 9 段总时间约 **37:22**。

视频保存本身约 **27.8 s**。

说明单独加 `CreateVideo + Save` 并不会稳定制造灾难性 sampler 卡顿。

### 3.4 关闭环境功能都没有解决

已经做过、以后不要重复：

- `--disable-fast-disk`
  - RAM 接近满载，明显更慢。
- `--disable-cuda-graphs`
  - 第一段明显变慢。
- `--disable-async-offload`
  - 前三段比默认略慢。

这些实验已经结束，不再沿此方向花时间。

---

## 4. 当前用于快速测试的低分辨率基线

为了缩短测试时间，当前统一使用：

- 百万像素：**0.2 MP**
- 实际分辨率：**608 × 352**
- 活动片段：**3 段**
- seed：**9**
- 同一份提示词 / 资产 / 时间线
- MiniMax H3 Ref2VA int8 convrot
- Video VAE：int8 convrot
- 预览：关闭

### 4.1 基础版结果

诊断签名：

```text
Base input_signature=e487356e623301c5
Base core_graph_signature=2ebb26167f347144
nodes=50
```

sampler：

```text
clip 1: 00:49  / 12.39s/it
clip 2: 00:39  / 10.00s/it
clip 3: 00:57  / 14.50s/it
```

总时间：

```text
Prompt executed in 284.17 seconds
```

Assemble checkpoint：

```text
96 frames:
rss=10959MB
ram=48.6%
cuda_free=5243MB
torch_reserved=128MB

168 frames:
rss=11378MB
ram=49.2%
cuda_free=5561MB
torch_reserved=128MB

1200 frames:
rss=17177MB
ram=58.5%
cuda_free=4469MB
torch_reserved=128MB
```

> 注意：3 个活动片段测试时，最后出现 1200 frames 是当前 suspended clip / trailing gap 语义造成的尾部补黑帧。  
> 这是另一个可修问题，但 **当前性能诊断阶段不要顺手改它**，避免引入新变量。

### 4.2 Advanced 结果

输入签名完全一致：

```text
Advanced input_signature=e487356e623301c5
```

但旧版核心图 hash 不一致：

```text
Advanced core_graph_signature=abd47a2ce1034013
nodes=50
```

sampler：

```text
clip 1: 00:50 / 12.65s/it
clip 2: 00:41 / 10.48s/it
clip 3: 01:18 / 19.62s/it
```

终端：

```text
Cache batch: 0.039s / 7.1MB
Video save: 6.100s
Terminal total: 6.147s
Prompt executed in 330.85s
```

这次 0.2MP 下没有出现几百秒/step 的灾难性卡顿，但 Advanced 总体仍慢于 Base。

---

## 5. 目前最重要的代码事实

### 5.1 Base 与 Advanced 共用同一个 build_timeline_graph

基础版：

```python
build_timeline_graph(runtime, plan, seed)
```

Advanced 当前：

```python
build_timeline_graph(
    runtime,
    plan,
    seed,
    video_export=...,
    cache_key=cache_key,
    rerun=rerun,
    preview_override=None,
)
```

当：

- `rerun is None`
- `preview_override is None`

时，理论上 `td_s*` H3 片段核心图应该与 Base 相同。

### 5.2 一个关键历史对照

曾经跑得相对正常的 video/save-only 版本，与后来 cache-enabled 版本：

- `director_h3.py` 当时是相同的；
- `director_internal.py` 当时也是相同的；
- Advanced 入口真正的主要差别是：

正常版本：

```python
cache_key=None
rerun=None
preview_override=None
```

cache-enabled：

```python
cache_key=str(unique_id)
rerun=None  # 完整生成时
preview_override=None
```

因此后续非常值得做一个**同一当前代码、只切 cache_key 的严格 A/B**。

---

## 6. 当前仓库已经加入的诊断设施

当前诊断代码包含：

### 6.1 input signature

`director_node.py`

会打印：

```text
[TerryDirector][Diagnostic] Base input_signature=...
[TerryDirector][Diagnostic] Advanced input_signature=...
```

签名覆盖：

- width / height
- seed
- sampler 类型
- sigmas
- ref image size
- 各片段：
  - start / end
  - output frames / H3 frames
  - transition
  - continuity
  - 图片 / 视频 / 音频引用数量
  - prompt hash

### 6.2 core graph signature

`director_h3.py`

只对 `td_s*` 节点做 canonicalize，并打印：

```text
[TerryDirector][Diagnostic] Base core_graph_signature=...
[TerryDirector][Diagnostic] Advanced core_graph_signature=...
```

### 6.3 最新新增：Base → Advanced 逐节点 diff

当前代码会：

1. Base 运行时将 canonical core graph 保存到：
   ```text
   ComfyUI/output/.terrydirector_diag/base_core_<input_signature>.json
   ```
2. Advanced 使用相同 `input_signature` 时自动读取 Base snapshot。
3. 自动打印：
   ```text
   [TerryDirector][Diagnostic] Base vs Advanced core graph: EXACT MATCH
   ```
   或：
   ```text
   [TerryDirector][Diagnostic] Base vs Advanced core graph: N difference(s)
   [TerryDirector][Diagnostic] DIFF ...
   ```

**这是本任务下一步第一优先级。**

---

# 7. 本地 Codex 的第一阶段任务

## Task A：确认 core graph hash 差异到底是真的还是假的

### 步骤

使用当前最新代码。

保持：

- 0.2MP
- 608×352
- 3 个活动片段
- seed=9
- 同样资产/提示词
- 默认 ComfyUI 启动参数

### A1. 跑 Base

只需要等诊断信息出现：

```text
Base input_signature=...
Base core_graph_signature=...
Base core graph saved for comparison
```

**不用等采样结束。**

### A2. 跑 Advanced

只需要等：

```text
Advanced input_signature=...
Advanced core_graph_signature=...
Base vs Advanced core graph: ...
```

### A3. 根据结果处理

#### 如果打印 EXACT MATCH

说明旧 hash 差异是诊断 canonicalize 的假差异或旧代码状态造成的。

记录结论：

> Base 与 Advanced 的 H3 核心 `td_s*` 图完全一致。

然后进入 Task B。

#### 如果存在 DIFF

必须逐项判断：

- 是真实节点类型 / input 差异？
- 还是 canonicalizer 没有正确归一化某个运行时对象？

不要看到 hash 不同就直接修改执行逻辑。

输出至少包括：

```text
node id
class_type
input key
Base value
Advanced value
为什么会不同
是否会影响 H3 sampling
```

若是真实差异：

- 找到它从哪里被 Advanced 引入；
- 做最小修复；
- 不动 Base；
- 不动 ComfyUI 环境。

---

# 8. 第二阶段任务：严格 cache_key A/B

只有在 Task A 证明核心 H3 图一致后再做。

## 目标

验证：

> **Advanced 性能差异是否真的由“cache-enabled 执行路径”触发，而不是缓存写盘本身。**

### 要求

在**同一份当前代码**中增加一个临时诊断开关，不要靠切历史 commit。

建议内部常量，例如：

```python
ADVANCED_PERF_DIAGNOSTIC_MODE = "video_only"
# or
ADVANCED_PERF_DIAGNOSTIC_MODE = "cache_enabled"
```

只允许改变：

### Mode 1: video_only

```python
video_export = enabled
cache_key = None
rerun = None
preview_override = None
```

### Mode 2: cache_enabled

```python
video_export = enabled
cache_key = str(unique_id)
rerun = None
preview_override = None
```

除此之外：

- 所有代码路径一致；
- Advanced UI 一致；
- ComfyUI 不重配；
- 测试参数一致。

### 测试参数

优先 0.2MP / 3 段 / seed=9。

每个 mode 至少记录：

```text
input_signature
core_graph_signature
clip1 sampler
clip2 sampler
clip3 sampler
Prompt total
Cache batch total
Video save total
```

如果 0.2MP 下差异不明显，再回到原 9 段配置，但不要先上高分辨率做长测试。

---

# 9. 若 cache_key A/B 明确产生差异，要继续查什么

不要先改算法，先检查执行语义。

重点检查：

### 9.1 TerryDirectorAdvancedFinish 的执行 cache / fingerprint

当前 `cache_key` 是该节点输入之一。

确认：

- 空字符串 vs unique_id 是否改变 ComfyUI 的节点缓存命中；
- 是否改变 terminal node 是否被认为 dirty；
- 是否改变 expanded graph 的 execution list / dependency retention；
- 是否使某些上游节点输出生命周期延长。

### 9.2 PackOutput → AdvancedFinish 的引用关系

当前：

```text
all sampled latents
        ↓
TerryDirectorPackOutput
        ↓ director_output
TerryDirectorAdvancedFinish
```

AdvancedFinish 在 cache-enabled 时会读取：

```python
director_output["segment_latents"]
```

虽然真正 `torch.save` 发生在最后，但需要确认：

- 为了保证这些 latent 最后仍可访问，Comfy executor 是否保持了不同的中间输出生命周期；
- video_only 时虽然也传 director_output，但执行缓存/dirty 状态是否不同。

### 9.3 rerun 隐藏 widget

完整生成时必须明确日志：

```text
rerun_clip_id == ""
rerun is None
```

不要只假设 UI 看起来没有 rerun。

建议临时打印：

```text
cache_key=<...>
rerun_clip_id=<repr>
rerun=<repr>
preview_enabled=<...>
preview_override=<...>
```

---

# 10. VAEDecode / “卡在视频解码”问题

用户在最近 0.2MP Advanced 测试中感到：

> sampler 完成以后，视频解码阶段等待较久。

目前已有日志只能证明：

- sampler 时间；
- Assemble 完成后的 checkpoint；
- terminal cache/save 时间。

**还没有直接测量 VAEDecode / VAEDecodeAudio 本身。**

如果 core graph / cache_key A/B 之后仍有约 30～60 秒无法解释的差额，可以新增“非侵入式节点执行时间诊断”。

优先方式：

- 利用 ComfyUI 已有 execution/progress state 的节点 start/finish timestamp；
- 或服务端执行状态；
- 不要为了计时在 H3 核心图中插大量 passthrough 节点，因为插节点本身会改变图和生命周期。

需要记录：

```text
td_s1_sample
td_s1_decode_video
td_s1_decode_audio
td_s1_assemble

td_s2_...
td_s3_...
```

Base / Advanced 对齐比较。

---

# 11. Advanced 前端目前做过的性能防护

已经修改：

- sampling 期间不再每个 `progress_state` 完整重建 Advanced DOM；
- 片段进度改为原地更新；
- prompt 开始时尝试卸载旧 final video 的媒体资源；
- 生成结束才恢复/加载最终视频。

这些改动目前保留，但：

> **不要把前端当作已经证实的根因。**

之前 Advanced 在这部分修改后仍出现过第一步极慢，而 Base 同环境正常。

所以后续诊断重点仍然是后端图和执行生命周期。

---

# 12. 不要做的事情

本任务期间禁止顺手做以下工作：

- 不改时间线 UI；
- 不改 40px 最小点击宽度；
- 不改滚动条；
- 不改动态预览 UI；
- 不改 suspended clip / trailing gap 语义；
- 不实现 SelfLift；
- 不重构公共时间线 assembly；
- 不更换模型；
- 不调整 ComfyUI 启动参数；
- 不升级/降级 ComfyUI；
- 不改变 seed / prompt / assets 做“近似测试”。

目标是保持控制变量，把 Advanced 的最小性能差异找出来。

---

# 13. 成功标准

最终需要达到：

### 功能

Advanced 仍保留：

- 最终视频审片；
- 文件保存；
- LATENT cache；
- 局部重跑；
- 实时预览；
- workflow 切换后的结果恢复。

### 性能

关闭实时预览时：

> Advanced 的 H3 sampling 性能应与 Base 接近。

可接受的正常波动：

- 单片段 sampler 在 Base 的约 ±10～15% 范围内；
- 不允许再随机出现 5～15 倍的 step 时间；
- 不允许 9 段任务从 Base ~34min 变成 Advanced 1h+。

Advanced 额外时间应该主要来自可解释的：

```text
cache（目前实测 < 1s）
+ video encode/save（目前实测约 6～30s）
+ 很小的 UI/状态管理开销
```

而不是 H3 sampler 本身异常变慢。

---

# 14. 给 Codex 的输出要求

每轮完成后，不要只说“已优化”。

请输出：

1. **本轮唯一假设是什么**
2. **只改了哪些文件 / 哪些代码路径**
3. **Base / Advanced 控制变量是否一致**
4. **关键日志**
5. **测试结果表**
6. **这个结果排除了什么**
7. **下一步唯一要验证什么**
8. Git commit hash

如果发现之前的判断错误，要明确撤回，不要为了维持旧结论继续解释。

---

## 当前第一件事

**先完成 Task A：用最新逐节点 diff 确认 Base / Advanced 的 `td_s*` core graph 是否真实存在差异。**

在得到这个答案之前，不要继续做新的性能优化。
