# QuantFunc 调研与暂缓接入决策

> 记录日期：2026-10-02  
> 状态：**候选加速方案 / 暂缓接入 / 等待用户明确指令**  
> 范围：归档本轮对话已完成的一手资料与源码调研，不是实施任务，也不是兼容性或性能验收报告。

## 1. 用户决定与当前开发边界

用户已确认：**这部分先记录，等待时机成熟后，由用户另行提出加入导演台。**

因此，QuantFunc 当前不进入 TerryDirector 的实际开发范围：

- 不安装插件、引擎或模型，不引入依赖，不编写接入代码。
- 不新增 QuantFunc 开关、模型选择、授权或其他 UI 占位，不改变项目配置格式。
- 不替换当前选定的 Songssx 规划、编码、有限分段采样及连续性链路；原二次潜空间放大 / SelfLift 方向保持不变。
- 不因为上游发布新版、某项限制解除或看起来已经成熟，就自动开始集成。**重新评估及接入以用户明确要求为起点。**

当前四个主要运行参考继续见 [成熟实现参考清单](07_REFERENCE_IMPLEMENTATIONS.md)。QuantFunc 单独作为待评估的加速候选，不与已经选定的运行基础混为一谈。

前端继续遵循 [UI 实现蓝图](06_UI_IMPLEMENTATION_BLUEPRINT.md) 及已确认补充：创作数据、时间线和操作习惯保持稳定，生成实现可在以后按需演进；不为这项候选技术提前增加通用引擎框架或外部分段调度器。

## 2. 调研依据与验证范围

本记录基于前一轮已读取的官方源码和说明，不表示持续跟踪了上游后续变化。

| 来源 | 本轮依据 |
| --- | --- |
| QuantFunc 官方插件 | [QuantFunc / ComfyUI-QuantFunc](https://github.com/QuantFunc/ComfyUI-QuantFunc)，固定提交 [`8ca647255365f6bdca5d00450aa3603f730f3c79`](https://github.com/QuantFunc/ComfyUI-QuantFunc/commit/8ca647255365f6bdca5d00450aa3603f730f3c79)，提交日期 2026-10-01 |
| 当前生成基础 | [Songssx / ComfyUI-MiniMaxH3-TimelineDirector](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector)，固定提交 [`a81f13b8af4a162467cec4dc377f40b7354d7ffc`](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/commit/a81f13b8af4a162467cec4dc377f40b7354d7ffc) |
| 用户提供的文章线索 | [微信文章](https://mp.weixin.qq.com/s/o2mo0t1KvePKFJxSY2r8RQ)：上轮未成功读取，不作为本文技术结论的证据 |

版本注意：QuantFunc 上述提交说明已涉及 **0.0.17 引擎接入与 H3 连续 sigma 双采工作流**，但同版本 README 的部分说明仍写较早的 **0.0.13**。以后复查应记录实际插件 commit、安装的引擎版本、模型文件及 ComfyUI 版本，不能只依赖 README 中的版本表。依据：[提交说明](https://github.com/QuantFunc/ComfyUI-QuantFunc/commit/8ca647255365f6bdca5d00450aa3603f730f3c79)、[README](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/README.md)。

**已完成：**官方说明、加载器、H3 模型适配、遮罩路径、潜空间放大节点、授权字段处理与部分 Songssx 对应源码的静态核对。

**未完成：**用户 Windows / RTX 3090 / 64GB 环境的安装与 GPU 运行、统一性能比较、完整连续分段兼容验证、画质及音频验收。不能把官方示例、源码推断或供应商性能数据写成 TerryDirector 的实测结果。

## 3. 候选定位：模型推理加速，而非重做导演台

QuantFunc 的插件通过原生 C++ / CUDA 引擎执行量化模型推理。该版本的 `QuantFuncH3Loader` 输出 ComfyUI `MODEL`，由现有采样节点驱动；文本编码器和 VAE 可继续使用 ComfyUI 原有节点。旧的 `QuantFuncGenerate` / `QuantFuncBuildPipeline` 路径已被新的模型家族加载器替代，不应按旧教程规划新接入。依据：[官方用法与迁移说明](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/README.md)、[加载器源码](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/__init__.py)。

未来可能的最小接入位置：

```text
TerryDirector 原有 UI 与项目数据
            ↓
现有片段规划、提示词和素材编码
            ↓
现有分段采样链路 ← 标准 MODEL / QuantFunc MODEL
            ↓
现有解码、进度和结果回填
```

这是候选接入方向，**不是“替换加载器就已全部兼容”的结论**。模型接口类型相同，并不保证其底层执行了原链路的所有条件、遮罩、包装器及连续性规则。

QuantFunc、减少采样步数的方案、低清到高清的渐进采样分别作用于不同成本；不能直接相乘宣传加速倍数。下一轮性能结论应以用户已跑通的 `int8_convrot` 为实际对照，同时控制模型变体、采样步数、调度、分辨率、帧数和 LoRA 条件。

## 4. 已识别的关键兼容边界

### 4.1 重叠续接、Drift-Control 与音频遮罩

Songssx 并非只复制上一段 latent：`drift_control_av.py` 会安装动态遮罩函数，并在模型调用中注入 `denoise_mask` 与 `audio_denoise_mask`，使采样器的输入约束与 H3 的模型侧处理相互匹配。依据：[Drift-Control 源码](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/drift_control_av.py)、[latent 续接源码](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/experimental_latent_guide.py)。

QuantFunc 的 H3 适配包含遮罩类条件的拒绝逻辑，`scale_latent_inpaint()` 明确拒绝该遮罩路径；其 `_begin()` / `_apply_model()` 的关键帧和参考输入桥接，不能视为上述动态视频 / 音频遮罩的等价实现。依据：[qf_h3_modelpatcher.py](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/qf_h3_modelpatcher.py)。

**静态分析结论：完整重叠续接不能直接宣称兼容。** 具体接线究竟在哪一步报错、哪些外部补丁是否被真正消费，需要实跑与上游接口确认。不能为了让任务完成而移除原链路的遮罩、锁定区域或接缝保护；“输出了视频”不等于连续性正确。

### 4.2 官方双采示例不等于当前 SelfLift

QuantFunc 的官方 H3 双阶段示例在一条采样调度中执行低清阶段、latent 放大和高清阶段。其 `QuantFuncH3LatentUpscale` 调用 `comfy.utils.common_upscale`，默认 `bilinear`，保持音频 latent，并明确拒绝带 `noise_mask` 的输入；该节点没有加载我们 UI 所指的 H3 3D 潜空间放大权重。依据：[放大节点实现](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/__init__.py)、[官方双采示例](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/example_workflows/QuantFunc-MiniMaxH3-ref2va-double-sampling.json)。

Songssx 的 SelfLift 还包含转接预测、放大、高清采样，以及分段低清 carry、音视频遮罩与接缝处理。依据：[SelfLift 运行代码](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/selflift_runtime/nodes.py)、[H3 放大模型接入](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/selflift_runtime/h3_upscaler.py)。

**保留原有二次潜空间放大的产品含义。** 未来应验证 QuantFunc MODEL 能否参与原 SelfLift，而不是静默把已选放大模型替换成插值节点。官方双阶段示例跑通，也不能作为“我们的 SelfLift 和连续分段已通过”的证据。

### 4.3 音频增强不是音频锁定或承接

该版 QuantFunc 的 `audio_enhance` 不支持双阶段采样，相关路径会忽略它并提示。此开关不能代替锁定原配音、保留原声或前后片段音频连续性。依据：[README](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/README.md)、[H3 双阶段判定](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/qf_h3_modelpatcher.py)。

### 4.4 权重、LoRA、内存与版本不能混用

正式验证需要选择适合 QuantFunc 加载器的权重，不假定用户现有 INT8 文件直接兼容。`QuantFuncNativeLoRA` 有自己的格式验证和加载路径，不能默认普通 LoRA 节点或所有变体都可用。第一轮先运行官方示例，再核对权重是否已经融合加速 LoRA，避免重复叠加。依据：[加载与 LoRA 代码](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/__init__.py)；以后需复查的[官方 H3 模型卡](https://huggingface.co/QuantFunc/Minimax-H3-Quantfunc-4bit)。

`pinned_memory` 在该版说明中有会话级持续生效的行为，可能占用较多锁页系统内存；不因用户有 64GB 内存就默认开启。驱动、PyTorch CUDA、cuDNN 与引擎架构必须按实际 ComfyUI 环境核对。依据：[官方环境、内存和开关说明](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/README.md)。

## 5. 授权、网络与可选依赖

上轮读取的 `LICENSE` 将可查看的插件源码与专有引擎二进制分开；引擎使用需要有效授权 Key，且插件源码的精确许可证标识及部分 EULA 信息仍有待维护者确认的占位。此处只记录文件状态，不替代许可证审查。依据：[固定版本 LICENSE](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/LICENSE)。

未来若采用，应优先作为用户自行安装的可选依赖：TerryDirector 不打包该引擎，不把项目使用权或正常生成绑定在 QuantFunc 上；保留标准生成路径。安装、授权、费用和联网条件需在当时重新确认，不能把测试期间说明当作长期免费或完全离线承诺。

Key 不应写进项目 JSON、工作流导出、日志或生成媒体元数据。优先复用官方 `qf_api_key.py` 中的服务端保存与会话引用机制，不另造明文授权字段。依据：[qf_api_key.py](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/qf_api_key.py)。

官方源码中的引擎安装流程会获取兼容版本并校验文件完整性。后续测试须记实际引擎版本及文件校验值，不把“插件 commit 固定”误写成“运行二进制永远固定”。依据：[README 的引擎安装说明](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/README.md)。

尚需确认：授权服务不可用时的行为、隐私 / 网络文档是否完整、长期使用与分发条件、多片段 / 多阶段调用的额度语义（若采用计费或额度机制）。本轮没有联网行为实测。

## 6. 以后重新评估时的验证顺序

**以下是备忘，不是现在获准执行的任务。** 用户提出接入后，先复查当前官方版本和四个成熟参考是否已有对应方案，再按顺序判断。

| 阶段 | 验证内容 | 通过标准 |
| --- | --- | --- |
| 官方最小链路 | 单片段 FL2VA / Ref2VA、官方双阶段示例 | 用户机器稳定生成；记录首跑和热跑的完整耗时、显存、系统内存、画面与声音质量 |
| 本项目最小对接 | 现有 UI 数据驱动已验证的 QuantFunc 路径 | 提示词、素材、尺寸、进度与结果对应正确；不新增外部分段调度系统 |
| 现有生产能力 | 首尾帧、重叠 AV latent、Drift-Control、音轨锁定、原 SelfLift 与 H3 放大模型 | 约束确实执行，接缝和音画效果达标；取消、重跑及再次提交不残留错误状态 |
| 决定是否采用 | 兼容边界、端到端收益、授权条件与维护成本 | 用户确认接入范围；不支持的组合提交前明确提示，不静默降级 |

可作为未来对照实验起点的配置：`quality_enhance=true`、`attention_backend=auto`、`sol_tau=1.0`、`step_cache=0`、`block_cache=0`、`pinned_memory=false`、`audio_enhance=false`。这是隔离量化推理影响的测试建议，不是已验证的最佳配置，也不是当前 UI 默认值；正式使用前复查字段语义。然后分别开启近似注意力、缓存等选项观察收益和画质。依据：[开关定义](https://github.com/QuantFunc/ComfyUI-QuantFunc/blob/8ca647255365f6bdca5d00450aa3603f730f3c79/__init__.py)。

性能应对照已跑通的 `int8_convrot`；若模型权重、Turbo 融合或采样调度不能完全匹配，应明确记为方案比较，不能把全部差异归因于量化引擎。官方模型卡的其他显卡单步成绩不等于 RTX 3090 成绩，也不等于完整导演项目的端到端速度；本记录不设定承诺加速倍数。

如最终适合开放给用户，优先只在既有参数区域补一个可选推理方式入口，详细控制按需展开。**现在不增加入口；将来具体 UI 仍需确认。** 不支持的任务应说明原因并让用户选择标准路径，不暗中丢弃连续性条件。

## 7. 何谓“成熟”：技术条件与用户确认分开

重新采用时需要有足够证据表明：用户机器上收益真实且质量可接受；准备开放的任务组合都经过验证；关键遮罩 / 连续性问题有等价实现或清楚的范围限制；原 SelfLift 语义没有被替换；授权、网络、版本和回退路径可接受。

这些是重新评估时的检查条件，**不是自动触发集成的条件**。即使条件满足，仍等待用户明确要求加入导演台。

## 8. 归档结论

QuantFunc 保留为模型推理层的可选加速候选。当前继续按 Songssx 的成熟链路开发 TerryDirector，并保持已定稿的前端和原二次潜空间放大方向。

本次仅归档研究、增加文档入口和开发约定。没有安装或接入 QuantFunc，没有修改运行代码、UI、依赖、工作流模板或项目数据格式，没有新增自动监控 / 提醒任务。后续由用户提出时再复查与启动。
