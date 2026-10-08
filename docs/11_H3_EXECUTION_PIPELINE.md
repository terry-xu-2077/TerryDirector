# TerryDirector H3 真实执行链

> 决策日期：2026-10-07  
> 本文是 TerryDirector 真实生成逻辑的实现 Source of Truth。UI / 参数归属继续以 `docs/10_CONFIG_NODE_ARCHITECTURE.md` 为准。

## 1. 总原则

TerryDirector 是 **时间线编译器 + ComfyUI 原生执行图展开器**，不是一套新的 H3 sampler。

真实执行优先复用 ComfyUI 当前原生能力：

- `MiniMaxH3ReferenceToVideo`
- `MiniMaxH3AddGuide`
- `RandomNoise`
- `BasicGuider`
- `SamplerCustomAdvanced`
- `VAEDecode`
- `VAEDecodeAudio`

MODEL 在进入 TerryDirector 前可以已经挂接 LoRA、Sparse Attention、ControlNet 或其他 MODEL patch。TerryDirector 不识别、不复制这些功能，只继续使用传入的 MODEL 对象。

## 2. Timeline Compiler

TerryDirector 主节点的 `fingerprint_inputs()` 返回 `NaN`，因此每次 Queue 都重新执行 Timeline Compiler 并重新展开 ephemeral H3 子图。这样中断后的下一次运行不会命中上一轮动态子图的旧缓存。此规则只强制 TerryDirector 编排层重新展开；上游 MODEL / CLIP / VAE 仍按 ComfyUI 自身缓存策略复用。

`director_compile.py` 是后续所有执行逻辑的唯一时间线语义来源。

每个片段编译为：

- `start_frame / end_frame`
- 用户实际输出长度 `output_frames`
- H3 内部生成长度 `h3_frames`
- 当前片段局部素材编号与执行 Prompt
- 与前一片段的 continuity
- 最终合并所需的 gap / head trim / tail trim

H3 长度始终向上对齐到：

`5 + 17*n`

UI 不暴露这个限制；生成完成后裁回用户时间线长度。

## 3. 相邻片段关系

### overlap

`current.start < previous.end`

- 使用上一片段重叠区作为连续性 Guide
- 视频多帧 Guide 使用不超过重叠长度的最大合法 `5 + 17*n`
- 若重叠长度不是合法 Guide 长度，再在重叠末端追加单帧边界 Guide
- 音频 Guide 覆盖完整重叠时长
- 合并时裁掉当前片段开头的重叠帧

### touch / 首尾贴合

`current.start == previous.end`

首尾贴合只表示时间上连续，实际镜头关系由后一个片段的 `transitionMode` 决定：

- `tail_reference` / **尾帧参考**（新建接缝默认）
  - 自动取上一片段最终可见尾帧
  - 作为当前片段额外的 H3 图片参考
  - 只用于人物 / 场景状态、色彩、光线和整体基调连续
  - 当前片段仍按自己的 Prompt 重新构图、重新运镜
  - 不作为 frame 0 Guide，不延续音频 latent，不裁当前片段头部
  - 尾帧参考占用一个 H3 图片参考位，因此当前片段最多再引用 8 张普通图片
  - ComfyUI Settings 提供“尾帧参考提示词”模板；`{picture}` 在编译时替换为尾帧实际的 `<Picture N>`，`{picture_number}` 替换为数字 N
  - 编译器先完成普通图片引用的局部编号，再把尾帧放在下一张图片槽位；例如当前片段已有 `<Picture 1> / <Picture 2> / <Picture 3>`，尾帧就占 `<Picture 4>` 与 `ref_image_3`
  - 最终槽位写入 `continuity.picture_number`，GraphBuilder 必须使用该值连接尾帧；Prompt 编号与实际 ref_image 顺序不得各自重新计算
  - 模板缺少 `{picture}` 时自动前置正确 `<Picture N>`；模板中硬编码的 `<Picture n>` 会归一化为实际尾帧槽位
- `tail_continuation` / **尾帧续接**
  - 自动取上一片段最终可见尾帧
  - 作为当前片段 frame 0 的视觉 Guide
  - 用于无缝续接 / 一镜到底式连续镜头
  - 不延续音频 latent，不裁当前片段头部
- `independent` / **独立**
  - 时间上仍首尾贴合
  - 生成时完全不读取上一片段

兼容规则：旧工作流没有 `transitionMode` 字段时继续按 `tail_continuation` 解释，保留此前已验证通过的尾帧续接行为。新建片段的默认值来自 ComfyUI Settings 中 TerryDirector 的“默认镜头衔接”，产品默认 `tail_reference`。Settings 只影响新片段，不批量改写已有时间线。

### gap

`current.start > previous.end`

- 当前片段独立生成
- 不读取上一片段 Guide
- 最终输出在空隙位置补黑帧 + 静音

第一片段若不是从 frame 0 开始，同样把前面的时间视为 gap。

### suspended

被挂起的片段仍保留在创作时间线上，但不生成 H3 任务。编译器将其视为空白时间；下一有效片段的连续性关系跳过所有挂起片段，直接与左侧最近的未挂起片段重新计算 overlap / tail_frame / gap。若时间线尾部由挂起片段延长，最终 IMAGE / AUDIO 在对应区间补黑帧与静音。

## 4. 全局提示词

TerryDirector 文档保存一份节点级全局提示词。每个片段保存独立的“使用全局提示词”状态，默认开启。

编译单个片段时：

```text
启用：全局 Prompt + 空行 + 片段 Prompt
关闭：仅片段 Prompt
```

全局 Prompt 放在片段 Prompt 前。随后才执行素材标签扫描与本地编号重写，因此人物、场景、服装、声音等公共参考可以只在全局 Prompt 中写一次；片段本身可以完全不含 `<Picture n> / <Video n> / <Audio n>`。只要片段启用全局提示词，这些全局引用就会正常进入该片段 H3 任务；关闭后不得加载。

素材数量上限同样针对合并后的单片段最终 Prompt 计算。

## 5. 素材编号

导演台使用项目级稳定编号，例如 `<Picture 9>`。

H3 官方 ReferenceToVideo 每个任务按当前输入重新从 1 编号，因此编译层只对 **执行副本** 重写编号：

`<Picture 9> -> <Picture 1>`

导演台保存的原 Prompt、资产编号和 UI 标签不修改。

当前片段只加载 Prompt 实际引用的素材；不同媒体类型分别独立从 1 编号。

## 6. 第一阶段采样

普通片段执行链：

```text
当前片段素材
    ↓
MiniMaxH3ReferenceToVideo
    ↓
[可选 MiniMaxH3AddGuide]
    ↓
BasicGuider
    ↓
RandomNoise
    ↓
SamplerCustomAdvanced
    ↓
H3 AV LATENT
    ├─ VAEDecode
    └─ VAEDecodeAudio
```

不在 TerryDirector 内重新实现 H3 video/audio sigma 映射，也不自定义普通 sampler。

## 7. SelfLift

SelfLift 在普通链完全跑通后接入。

配置：

- 总步数
- 高清占比（0.0–1.0，默认 0.25）
- H3 Latent Upscaler

执行层根据总步数计算实际高清阶段步数，并保证至少保留低清阶段和高清阶段各一步。

SelfLift 是一次渐进采样：

```text
低清前段采样
→ H3 Latent Lift
→ 高清后段采样
```

不是完整采样两次。

Lift 后立即卸载 Upscaler；高清阶段首尾 / Guide 关键帧按目标分辨率重新 VAE Encode，不直接插值低清关键帧 latent。

## 8. 输出

TerryDirector 不为导演台 UI 额外写视频预览文件，也不在主节点或配套输出节点中承担 VIDEO 创建 / 编码 / 封装职责。

主节点内部仍完成：

- 分段 H3 AV latent 收集
- 最终 IMAGE 合并
- 最终 AUDIO 合并
- overlap 去重、H3 尾部裁切、gap 黑帧 / 静音填充

随后通过内部打包节点组成一个 `TERRYDIRECTOR_OUTPUT`，TerryDirector 主节点右侧只输出一个用户可见端口：**导演输出**。

配套可见节点 **TerryDirector 输出** 接收该对象，并只输出：

- `分段潜变量`：LATENT 原生列表，每项保留完整原始分段 H3 AV latent
- `合并画面`：IMAGE
- `合并音频`：AUDIO

该节点只做解包，不创建 VIDEO。视频封装、编码、预览与保存由工作流下游的 ComfyUI 视频节点负责。

导演台内的局部运行继续使用 Partial Execution 选择当前 TerryDirector 主节点本身作为执行目标。

## 9. 实施顺序

1. Timeline Compiler
2. 单片段真实 H3 生成
3. 图片 / 视频 / 音频资产真实加载与局部编号
4. 多片段 tail-frame / overlap / gap
5. 单一导演输出 + 配套 LATENT / IMAGE / AUDIO 解包输出
6. SelfLift
7. 缓存、低显存分块与性能优化

不要跨阶段提前堆兼容层、缓存层或可选模式。

## 10. 中断与显存清理

正常完成时不主动卸载模型，继续使用 ComfyUI 的 Smart Memory / 模型复用策略。

当属于 TerryDirector 的运行收到 `execution_interrupted` 时，前端调用 ComfyUI 原生 `api.freeMemory({freeExecutionCache:true})`。该请求由 prompt worker 在中断收尾后处理，执行模型卸载、执行缓存清理、GC 与 `soft_empty_cache()`，避免中断的动态子图和大模型长期占用资源。

