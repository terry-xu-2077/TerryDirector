# TerryDirector · SelfLift 分阶段工作流

**默认示例已更新（2026-10-22）**：低清先审片，确认后再运行高清；高清转场只使用学习式 H3 3D Latent Upscaler，不执行中间 VAE 解码→放大→重新编码，不提供 SelfLift-zero 像素锚或 `nearest` 降级路线。

## 示例工作流

| 编号 | 文件 | 用途 |
| --- | --- | --- |
| **③ 默认推荐** | [暂停/继续 · 0.2→0.8 MP](TerryDirector_SelfLift_03_Pause_Continue.json) | 推荐主工作流；低清生成后保存检查点，审片通过再点击绿色按钮继续高清 |
| ① | [低清独立保存](TerryDirector_SelfLift_01_Lowres_Checkpoint.json) | 单独生成并保存低清检查点，同时保存低清审片视频 |
| ② | [高清独立读取](TerryDirector_SelfLift_02_Highres_Resume.json) | 从已有兼容检查点恢复高清，不重跑低清 |
| ④ | [0.5→2.0 MP 参考方案](TerryDirector_SelfLift_04_Reference_2MP_Highres.json) | 较高分辨率方案；开启高清空间分块，并连接独立高清 MODEL 优化链 |

## 默认参数（工作流③）

- **模型**：`minimax_h3_fl2va_bf16.safetensors`
- **CLIP**：`qwen3vl_32b_minimax_h3_int8_convrot.safetensors`
- **视频 VAE**：`minimax_h3_video_vae_int8_convrot.safetensors`
- **音频 VAE**：`minimax_h3_audio_vae_fp32.safetensors`
- **分辨率**：16:9；只输入高清目标 0.8 MP，自动推导低清 0.2 MP；预览低清 608×352、高清 1216×672；124 帧
- **采样**：`BasicScheduler(simple, 8)` → `H3SigmaRefiner(extra_steps=1, start_at_sigma=0.7, end_at_sigma=0, spacing=cosine)` → `SplitSigmas(step=6)`
- **Seed / CFG**：固定 seed=8，CFG=1。低清原生采样器和检查点节点共用同一个 SeedNode，避免两处种子不一致。
- **高清转场**：`minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`
- **高清空间分块**：默认关闭；模式 manual、4 块、axis auto（只有开启开关后才生效）
- **低清预览**：KJ 采样预览仍为 1 帧、12 fps；蓝色「生成低清」按钮还会执行低清 `denoised_output` → 视频/音频 VAE 解码 → `CreateVideo` → `SaveVideo`，保存完整有声审片视频。

`H3SigmaRefiner` 增加一个低噪修整步；在完整 Sigma 日程上从第 6 步分段，因此高清会继续执行余下日程。检查点必须与对应模型、条件、目标分辨率和 Sigma 日程兼容。

**统一输入**：工作流①、③、④使用 `TerryDirector 双采样分辨率选择器`，**只有一个「高清百万像素」浮点输入**；低清 MP 由节点自动按高清 MP ÷ 4 计算，无需额外公式。低清条件和目标高清 Latent 使用同一个时长公式（默认 5 秒 → 124 帧），原生低清采样与检查点共用同一 SeedNode。工作流②从磁盘检查点恢复高清分辨率，因此不另设目标分辨率控件。

## 工作流③使用方式

1. 第一次运行点击蓝色 **「生成低清」** 按钮；低清采样完成后同时保存检查点和独立低清审片视频，高清分支不会执行。
2. 在 ComfyUI `output/video/` 下找到前缀 `TerryDirector_SelfLift_PauseResume_lowres` 的低清视频并审片。通过后点击绿色 **「继续高清」** 按钮；仅执行高清输出，不重跑低清采样或低清保存支路。
3. 工作流中的 LoadImage 节点示例指向 `黄昏盐滩独行宇航员镜头首帧图片生成.jpg`。若本机没有该图片，请替换为自己的参考图，或断开该参考图输入。
4. 工作流①和②可以分开使用，但保存与读取必须对应同一组兼容参数；切换模型、参考条件、分辨率或 Sigma 日程时，请重新生成检查点。

**自定义工作流**：低清视频保存支路必须从原生 `SamplerCustom` 的 `denoised_output`（干净 x0）出发，经过 `VAEDecode` 与 `VAEDecodeAudio`，最后到 `SaveVideo` 或 `VHS_VideoCombine`。蓝色按钮自动发现并执行这一支路；若没接则保持原有的只存检查点行为。只允许一个低清视频保存终点。绿色按钮不触发这条支路。

## 高清 MODEL 输入口

`TerryDirectorSelfLiftHighres` 现只有一个 **「高清采样 MODEL」**。工作流 ②/③ 直接连接基础 H3 MODEL；工作流 ④ 将 `MiniMaxChunkFeedForward` 的最终优化 MODEL 直接连接此输入。要换模型或注意力优化策略，只需调整上游连线，不需要第二个 MODEL 插口。旧版含两个 MODEL 口的画布请重新导入已更新的示例，或手动删掉并重建高清节点以避免旧槽位错接。

## 独立工作流

- **① 低清保存**：同样使用 BF16 FL2VA、INT8 ConvRot CLIP、CFG=1、seed=8、8 步 simple 日程 + H3 Sigma Refiner，低清采样约 0.2 MP，保存目标 0.8 MP latent 检查点。
- **② 高清读取**：加载与检查点兼容的 BF16 FL2VA 和 INT8 ConvRot CLIP；提示词条件使用低清 0.2 MP 尺寸；高清节点默认关闭空间分块。
- **④ 0.5→2 MP**：实际取整为低清 960×544、高清 1888×1088；保留独立高清 MODEL 链 `ModelAttentionBackend → MiniMaxLowVRAMAttention(8) → MiniMaxChunkFeedForward(2,4096)`，并启用 4 块空间分块。该工作流的目标尺寸与显存压力更高，不作为默认审片样例。

## 模型要求

Upscaler 权重 `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` 应放在 ComfyUI 的 `models/latent_upscale_models/` 下。高清节点只使用有效的 H3 3D Latent Upscaler；不会自动回退到 `nearest` 或 VAE 往返。

最终用于导出视频和音频的 VAE 解码仍然保留；本次移除的是高清采样前的中间 VAE 往返。

详细架构：[SELFLIFT_SPLIT_NATIVE_SAMPLER_MVP.md](../docs/SELFLIFT_SPLIT_NATIVE_SAMPLER_MVP.md)。


## 工作流节点命名

示例工作流保留 ComfyUI 节点的默认名称，不通过自定义节点标题解释用途。每个工作流内的 **Markdown Note** 节点负责说明用途、关键参数与运行顺序；实际参数仍以节点控件和本机可用模型为准。
