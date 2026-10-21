# TerryDirector · Native Low-Res → SelfLift Hi-Res（最小开发版）

日期：2026-10-21 · 分支：feature/selflift-native-lowres-checkpoints

## 决策

**不另写低清采样器。** 使用 ComfyUI 原生 `SamplerCustom` 或 `SamplerCustomAdvanced` + `Euler`，KJ `Model Preview Override` 仍直接放在低清 MODEL 链路上。TerryDirector 只负责保留用于 SelfLift 的原生两路采样输出，随后读取并执行剩余高清部分。不修改、不导入 selflift-Avatar 源码。

本阶段仅增加三个可见节点：

- **TerryDirector 保存低清检查点**：保存原生 `output` 与 `denoised_output`、原始目标分辨率 AV LATENT、完整 SIGMAS、Seed 和 CFG。
- **TerryDirector 读取低清检查点**：按镜头名和 ID 选择已有记录，输出轻量引用（不会立刻把所有 Latent 加载到 RAM）。
- **TerryDirector SelfLift 高清续采**：内部加载检查点，采用现有 TerryDirector SelfLift 分辨率提升代码，执行剩余 Euler 步数。

原本的一体式 `TerryDirector SelfLift (Internal)` 保持不变，以便 A/B 对照。

## ComfyUI 接线

```text
[H3 模型] → [KJ Model Preview Override，可选] → [SamplerCustom MODEL]
[完整 SIGMAS] → [SplitSigmas，step=k] → 第一个 high_sigmas 输出（实际上是 sigmas[:k+1]）
[低清 H3 AV LATENT] → [SamplerCustom latent_image]
[KSamplerSelect=euler] → [SamplerCustom sampler]
[相同的正负提示词、CFG、Seed] → [SamplerCustom 其他输入]

SamplerCustom output            → 保存低清检查点.low_state
SamplerCustom denoised_output   → 保存低清检查点.low_clean
[目标分辨率的原始 H3 AV LATENT] → 保存低清检查点.source
[完整 SIGMAS]                   → 保存低清检查点.sigmas
[k、Seed、CFG]                   → 保存低清检查点.对应参数

                                （停止、审片、关闭 ComfyUI、下次另开工作流）

[读取低清检查点] ── checkpoint ─→ [SelfLift 高清续采]
[相同或兼容的 H3 模型] ─────────→ [SelfLift 高清续采.model]
[相同正负条件] ─────────────────→ [SelfLift 高清续采.positive / negative]
[视频 VAE] / [KSamplerSelect=euler] → [SelfLift 高清续采]
[SelfLift 高清续采.latent] → H3 原生视频/音频解码 → SaveVideo
```

- `SplitSigmas` 的 **第一个**输出虽然官方命名为 `high_sigmas`，实际上是 `sigmas[:k+1]`。选它给低清采样器。不要把完整 `sigmas` 给低清阶段，否则会直接采样到零。
- **低清用于采样的 H3 AV LATENT** 应由原生节点创建在实际低清尺寸；**保存节点的 source** 必须是相同时长/音频流、目标高分辨率的原始 AV LATENT。低清和高清两路的音频潜变量形状必须一致。
- **审片**可把 `denoised_output` 接入原生 H3 视频/音频解码输出，保存一个低清 MP4。它不是 SelfLift 后续计算的检查点，只是供人工审片的视觉/音频参考。
- 若用 H3 的参考图、尾帧、输入音频、遮罩：低清端须正确应用与低分辨率匹配的条件；高清端须提供与原生成一致的 Conditioning。检查点存储原始目标 Latent（含静态遮罩），**并不存储序列化 CONDITIONING 或模型权重**。
- `rho=0.6, upscaler_model=none` 是 SelfLift-zero / pixel-anchor 验证入口；若使用 H3 外部 Latent Upscaler，优先尝试 `rho=0` 并从下拉框选择 Upscaler，尽量保持与原一体式工作流参数一致。
- 只支持标准 Euler / `s_churn=0`、H3 双流 Latent 与非终止 Sigma 检查点。其余采样器或仅有普通最终 Latent 的视频均不能当作有效 SelfLift 恢复点。

## 持久化边界

`output/TerryDirector/checkpoints/<uuid>/state.safetensors` + `manifest.json`。

- `state_0/1`：低清 `output`（视频和音频在 sigma[k] 的状态）。
- `clean_0/1`：低清 `denoised_output`（末步 x0，视频为过渡提升基准）。
- `source_0/1`：高清目标尺寸的原始视频/音频 Latent（用于 masked anchor）。
- `mask_0/1`：原始目标 latent 有遮罩时才存在。
- `sigmas`：完整的、非终止部分不归零的采样日程。
- `manifest.json`：检查点 ID、镜头名称、Seed、CFG、过渡步数、目标形状、SHA256 校验和，暂时状态为 `draft`。

每次保存创建新 UUID 文件夹，避免覆盖历史生成。加载之前重新校验哈希与形状；输出节点不隐式创建预览影片或审核通过状态。

## 第一阶段验收

1. CPU：检查点序列化、H3 AV 双流拆包/组包、Sigma 非终止校验、损坏文件拒绝、版本隔离。
2. 本地 ComfyUI 0.39+ / 3090：原生低清 5/8 步、KJ 12 FPS 采样预览、最终 x0 解码、保存检查点。
3. **关闭再打开 ComfyUI**，独立新工作流选择同一检查点，高清节点执行剩余 3 步。
4. 与现有一体式 `TerryDirectorSelfLiftSampler` 在同一 Model、Prompt、Seed、Sigma、分辨率、放大器、CFG 下 A/B 比较。重点确认**画面、音频、口型和剩余步数**。
5. 测试异常：错误模型、原始条件发生变化、遮罩、错误参考尺寸、磁盘不足、坏文件、执行中断后再次加载。

**限制（本次不做）：** 卡片式视频任务浏览浮窗、审核确认、高清多选队列、后台运行状态卡、自动模型/Conditioning 指纹校验、保存审片视频到任务包。当前节点名列表仅作为技术闭环入口，不能当作正式审片任务系统。

## 技术来源

- SelfLift 原始论文：https://arxiv.org/abs/2609.02036
- 原始社区 ComfyUI 实现：https://github.com/facok/comfyui-SelfLift
- H3 参考工作流：https://github.com/slmonker/selflift-Avatar
- KJ 预览：https://github.com/kijai/ComfyUI-KJNodes
- ComfyUI 官方 `SamplerCustom` / `SamplerCustomAdvanced` / `SplitSigmas`：https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_custom_sampler.py
