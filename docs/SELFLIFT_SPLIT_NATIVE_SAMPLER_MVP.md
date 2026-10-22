# TerryDirector · Native Low-Res → SelfLift Hi-Res（最小开发版）

日期：2026-10-21 · 分支：feature/selflift-native-lowres-checkpoints

## 决策

**不另写低清采样器。** 使用 ComfyUI 原生 `SamplerCustom` 或 `SamplerCustomAdvanced` + `Euler`，KJ `Model Preview Override` 仍直接放在低清 MODEL 链路上。TerryDirector 只负责保留用于 SelfLift 的原生两路采样输出，随后读取并执行剩余高清部分。不修改、不导入 selflift-Avatar 源码。

本阶段增加三个底层节点，并额外提供一个不重复造采样器的便捷节点：

- **TerryDirector 保存低清检查点**：保存原生 `output` 与 `denoised_output`、原始目标分辨率 AV LATENT、完整 SIGMAS、Seed 和 CFG。
- **TerryDirector 读取低清检查点**：按镜头名和 ID 选择已有记录，输出轻量引用（不会立刻把所有 Latent 加载到 RAM）。
- **TerryDirector SelfLift 高清续采**：内部加载检查点，必经 H3 3D Latent Upscaler 后执行剩余 Euler 步数。
- **TerryDirector SelfLift 暂停/继续**：封装保存与恢复，单工作流通过模式切换完成两阶段执行。暂停后软阻断高清下游；继续时四路低清输入使用 ComfyUI 原生惰性求值，不会再次触发低清采样。

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
[H3 3D Latent Upscaler 模型名] / [KSamplerSelect=euler] → [SelfLift 高清续采]
[SelfLift 高清续采.latent] → H3 原生视频/音频解码 → SaveVideo
```

- `SplitSigmas` 的 **第一个**输出虽然官方命名为 `high_sigmas`，实际上是 `sigmas[:k+1]`。选它给低清采样器。不要把完整 `sigmas` 给低清阶段，否则会直接采样到零。
- **低清用于采样的 H3 AV LATENT** 应由原生节点创建在实际低清尺寸；**保存节点的 source** 必须是相同时长/音频流、目标高分辨率的原始 AV LATENT。低清和高清两路的音频潜变量形状必须一致。
- **审片**可把 `denoised_output` 接入原生 H3 视频/音频解码输出，保存一个低清 MP4。它不是 SelfLift 后续计算的检查点，只是供人工审片的视觉/音频参考。
- 若用 H3 的参考图、尾帧、输入音频、遮罩：低清端须正确应用与低分辨率匹配的条件；高清端须提供与原生成一致的 Conditioning。检查点存储原始目标 Latent（含静态遮罩），**并不存储序列化 CONDITIONING 或模型权重**。
- **唯一高清转场路线：H3 3D Latent Upscaler**。从低清预测的 x0 直接在 Latent 空间放大，再按检查点 Sigma 恢复剩余 Euler；不执行中间视频 VAE 解码、插值后重新编码。
- **不再支持**：`nearest`、`none`、SelfLift-zero 像素锚、`rho/w_min/w_max`。这些选项和对应计算函数已从节点 UI 和实际采样路径移除；模型文件必须放入 `models/latent_upscale_models/`。
- **最终 VAE 输出保留**：正常 `VAEDecode` / `VAEDecodeAudio` 把最终音视频 Latent 变成媒体，不属于被删除的中间重复编解码。
- 只支持标准 Euler / `s_churn=0`、H3 双流 Latent 与非终止 Sigma 检查点。其余采样器或仅有普通最终 Latent 的视频均不能当作有效 SelfLift 恢复点。

## 来自已验证工作流的高清参考参数（2026-10-22）

用户提供的 `Self-Lift工作流-爱屋-1020.json` 使用 SelfLift-Avatar 的 `SelfLiftAvatarH3Sampler`，实际配置：

```text
CFG=1, transition_step=6, lowres_scale=0.5
upscaler_model=minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors
highres_tiling=true, tiling_mode=manual, tiling_tiles=4, tiling_axis=auto
highres_tiling_mode=spatial
```

- 高清节点只保留一个 **「高清采样 MODEL」** 输入口。工作流 ③ 直接接基础 H3 MODEL；工作流 ④ 可将 `ModelAttentionBackend(comfy kitchen attention)` → `MiniMaxLowVRAMAttention(head_chunks=8)` → `MiniMaxChunkFeedForward(chunks=2, seq_threshold=4096)` 的最终 MODEL 直接接入同一个口。节点内部不再区分基础/独立高清模型，也不做覆盖优先级判断。**旧版带两根 MODEL 输入的工作流须重新接线**，不可依赖旧槽位自动迁移。
- 参考中虽然出现 Spark/Veda 节点，但两者 `mode=4`（bypass），因此未把它们当作实际生效的加速配置。
- `BasicScheduler` 为 simple/8 步，后面使用 `H3SigmaRefiner(extra_steps=1, start_at_sigma=0.7, end_at_sigma=0, spacing=cosine)`；它对低噪尾段增加一步后，低清先走 6 步，高清续采剩余步数。
- `highres_tiling_mode=spatial` 与 TerryDirector 现有 `director_selflift_tiling.py` 的空间切块方向一致，但实现未经过逐像素数值一致性验证。`highres_token_chunk=4096` / `highres_weight_cache_gb=4` 不在 spatial 模式下使用，暂不引入冗余 UI。
- 正式参考样例放在 `examples/TerryDirector_SelfLift_04_Reference_2MP_Highres.json`：低清 960×544、高清 1920×1088、5 秒/124 帧。原参考的 15 秒、fl2va BF16 基础模型和 LoRA **没有无条件复制**；样例仍用现有 ref2va INT8 以限制同时变化的变量。03 号工作流已改为 H3 3D Upscaler，小分辨率下也不再使用 nearest。
- 实际高分辨率提升仅由学得的 H3 3D Latent Upscaler 承担；不再存在中间 VAE 往返支路或低质量最近邻降级路径。

## 便捷节点：TerryDirector SelfLift 暂停/继续

在保留显式保存/读取节点的同时，新增一个紧凑的中转节点，示例见 [单工作流 03](../examples/TerryDirector_SelfLift_03_Pause_Continue.json)：

```text
SamplerCustom 的 output / denoised_output
              │
              ▼
TerryDirector SelfLift 暂停/继续
              │
              ▼
TerryDirector SelfLift 高清续采
              │
              ▼
           SaveVideo
```

- **暂停并保存**：要求 `low_state`、`low_clean`、`source`、完整 `sigmas`，调用已有保存函数创建新的检查点。返回本次检查点 ID，`checkpoint` 插口输出一个**无错误的 ExecutionBlocker**，下游高清和视频编码不会执行。
- **继续高清**：直接从节点的 `checkpoint_id` 读取并校验检查点；四个低清插口都标记为 `lazy=True`，不请求输入值，所以即使连线还在，ComfyUI 也不会计算低清采样节点。读取成功才把真实检查点交给高清续采节点。
- **ID 持久化**：ComfyUI 的 `executed` UI 事件带回保存成功的 UUID；TerryDirector Web 扩展把它写回同一节点的 `checkpoint_id` widget，并同步更新节点标题。**暂停完成后请保存工作流**，保证关闭/重新打开 ComfyUI 时该 ID 仍保留。
- 切回暂停并重新运行，将创建新的检查点，旧版本不被覆盖；原来的「保存」和「读取」两个节点仍可跨工作流使用。
- **执行边界**：惰性求值只跳过暂停节点的上游低清依赖。如果同一画布另有低清 `SaveVideo` 等独立输出节点，ComfyUI 仍会按其连接独立运行低清。03 号示例刻意不包含这条独立输出分支，以保证“继续高清不重跑低清”。
- 如果暂停执行时浏览器已经断线，工作流 widget 可能没有收到自动更新；检查点仍在磁盘上，可以通过显式读取节点找回 ID。第一版没有另外引入全局任务库。

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
2. 本地最新版 ComfyUI / RTX 3090：原生低清 5/8 步、KJ 12 FPS 采样预览、最终 x0 解码、保存检查点。
3. **关闭再打开 ComfyUI**，独立新工作流选择同一检查点，高清节点执行剩余 3 步。
4. 与现有一体式 `TerryDirectorSelfLiftSampler` 在同一 Model、Prompt、Seed、Sigma、分辨率、放大器、CFG 下 A/B 比较。重点确认**画面、音频、口型和剩余步数**。
5. 测试异常：错误模型、原始条件发生变化、遮罩、错误参考尺寸、磁盘不足、坏文件、执行中断后再次加载。

**限制（本次不做）：** 卡片式视频任务浏览浮窗、审核确认、高清多选队列、后台运行状态卡、自动模型/Conditioning 指纹校验、保存审片视频到任务包。当前节点名列表仅作为技术闭环入口，不能当作正式审片任务系统。

## 旧工作流迁移提示

以前的 `TerryDirectorSelfLiftHighres` 含有 `vae / rho / w_min / w_max` 输入，现在已全部移除。请重新导入已经更新的 02/03/04 号 JSON，或手工删除并重建高清续采节点连线；不要沿用旧的输入槽顺序。

一体式 `TerryDirectorSelfLiftSampler`（Internal）同样已移除中间 VAE 输入与像素锚参数，仅允许真实 Upscaler 权重。已有合法低清检查点的磁盘格式不变，能否继续仍取决于模型、条件、Sigma 和 Latent 形状一致。

## 技术来源

- SelfLift 原始论文：https://arxiv.org/abs/2609.02036
- 原始社区 ComfyUI 实现：https://github.com/facok/comfyui-SelfLift
- H3 参考工作流：https://github.com/slmonker/selflift-Avatar
- KJ 预览：https://github.com/kijai/ComfyUI-KJNodes
- ComfyUI 官方 `SamplerCustom` / `SamplerCustomAdvanced` / `SplitSigmas`：https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_custom_sampler.py
