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

### tail_frame

`current.start == previous.end`

- 自动取上一片段最终可见尾帧
- 作为当前片段 frame 0 的视觉 Guide
- 不延续音频 latent
- 不裁当前片段头部

### gap

`current.start > previous.end`

- 当前片段独立生成
- 不读取上一片段 Guide
- 最终输出在空隙位置补黑帧 + 静音

第一片段若不是从 frame 0 开始，同样把前面的时间视为 gap。

### suspended

被挂起的片段仍保留在创作时间线上，但不生成 H3 任务。编译器将其视为空白时间；下一有效片段的连续性关系跳过所有挂起片段，直接与左侧最近的未挂起片段重新计算 overlap / tail_frame / gap。若时间线尾部由挂起片段延长，最终 IMAGE / AUDIO 在对应区间补黑帧与静音。

## 4. 素材编号

导演台使用项目级稳定编号，例如 `<Picture 9>`。

H3 官方 ReferenceToVideo 每个任务按当前输入重新从 1 编号，因此编译层只对 **执行副本** 重写编号：

`<Picture 9> -> <Picture 1>`

导演台保存的原 Prompt、资产编号和 UI 标签不修改。

当前片段只加载 Prompt 实际引用的素材；不同媒体类型分别独立从 1 编号。

## 5. 第一阶段采样

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

## 6. SelfLift

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

## 7. 输出

TerryDirector 保持三个标准输出：

- `分段潜变量`：LATENT 原生列表，每项保留完整原始分段 H3 AV latent
- `合并画面`：IMAGE，已按时间线裁掉 H3 尾部补帧、重叠重复帧并补 gap
- `合并音频`：AUDIO，与最终画面时间线等长

## 8. 实施顺序

1. Timeline Compiler
2. 单片段真实 H3 生成
3. 图片 / 视频 / 音频资产真实加载与局部编号
4. 多片段 tail-frame / overlap / gap
5. 三路正式输出
6. SelfLift
7. 缓存、低显存分块与性能优化

不要跨阶段提前堆兼容层、缓存层或可选模式。

## 9. 中断与显存清理

正常完成时不主动卸载模型，继续使用 ComfyUI 的 Smart Memory / 模型复用策略。

当属于 TerryDirector 的运行收到 `execution_interrupted` 时，前端调用 ComfyUI 原生 `api.freeMemory({freeExecutionCache:true})`。该请求由 prompt worker 在中断收尾后处理，执行模型卸载、执行缓存清理、GC 与 `soft_empty_cache()`，避免中断的动态子图和大模型长期占用资源。

