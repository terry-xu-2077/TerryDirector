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
- **低清预览**：默认工作流③把低清 `denoised_output` 分成视频/音频两路 VAE 解码，接入 `TerryDirector 保存低清审片视频`，将完整有声 MP4 保存到同一个检查点的 `review.mp4`。KJ Model Preview Override 的动画帧由任务管理器接收最后一个预览事件并存为 `sampling_preview.mp4` 或 `.webp`；单帧模式只能保存 JPEG。

`H3SigmaRefiner` 增加一个低噪修整步；在完整 Sigma 日程上从第 6 步分段，因此高清会继续执行余下日程。检查点必须与对应模型、条件、目标分辨率和 Sigma 日程兼容。

**统一输入**：工作流①、③、④使用 `TerryDirector 双采样分辨率选择器`，**只有一个「高清百万像素」浮点输入**；低清 MP 由节点自动按高清 MP ÷ 4 计算，无需额外公式。低清条件和目标高清 Latent 使用同一个时长公式（默认 5 秒 → 124 帧），原生低清采样与检查点共用同一 SeedNode。工作流②从磁盘检查点恢复高清分辨率，因此不另设目标分辨率控件。

## 工作流③使用方式

1. 第一次运行点击蓝色 **「生成低清」** 按钮；低清采样完成后同时保存检查点和独立低清审片视频，高清分支不会执行。
2. 点击 ComfyUI 左侧 **低清任务** →「打开低清任务管理器」；可切换检查点中的 VAE 解码视频与 TAEH3 采样预览。文件位于 `output/TerryDirector/checkpoints/<id>/review.mp4` 与 `sampling_preview.mp4/.webp/.jpg`。通过后点击绿色 **「继续高清」** 按钮或在任务管理器中提交高清续采；均不重跑低清。
3. 工作流中的 LoadImage 节点示例指向 `黄昏盐滩独行宇航员镜头首帧图片生成.jpg`。若本机没有该图片，请替换为自己的参考图，或断开该参考图输入。
4. 工作流①和②可以分开使用，但保存与读取必须对应同一组兼容参数；切换模型、参考条件、分辨率或 Sigma 日程时，请重新生成检查点。

**自定义工作流**：低清视频保存支路从原生 `SamplerCustom` 的 `denoised_output`（干净 x0）出发，经过 `VAEDecode` 与 `VAEDecodeAudio`，最后接 `TerryDirector 保存低清审片视频`（同时把「暂停/继续」的「检查点 ID」接到保存节点），才能自动在检查点目录中形成 `review.mp4`。仍可使用普通 `SaveVideo` 或 `VHS_VideoCombine`，但这两种节点按其自身路径保存、不会自动归档到检查点目录。蓝色按钮执行唯一的低清视频保存终点，绿色按钮不触发这条支路。

## 低清任务管理器（新入口）

ComfyUI 左侧边栏出现「低清任务」入口；点击其中的按钮会打开大浮窗。文件管理以磁盘 **检查点** 为单位，不加载重型张量：

- **创建低清任务**：使用当前画布上的 SelfLift 暂停工作流，或导入一个 ComfyUI 工作流 JSON；在浮窗里修改任务名、工作流中实际未被连线覆盖的提示词输入、LoadImage 图片，支持从本机上传新图片到 ComfyUI input。点击加入队列即可触发低清采样、检查点保存和低清审片视频写盘，不需要再到节点上点击按钮。
- **审片**：在右侧预览区切换「低清解码」与「TAEH3 采样预览」。默认示例③的低清成片保存在 `output/TerryDirector/checkpoints/<checkpoint_id>/review.mp4`。TAEH3 对应 `sampling_preview.mp4` 或 `.webp`；若 KJ 的 `preview_frames=1`，则只会保存 JPEG 静帧。TerryDirector 不改动原版 KJ 节点源码。
- **重跑与多选批量高清**：创建的每个新检查点保存工作流快照与输入覆盖配置。重跑低清会生成新的独立检查点；批量高清逐个读取各自快照、临时准备入队提示并还原用户原画布，确保不把不同镜头的提示词或参考图串用。
- **已存在的旧检查点**：仍能被列表发现；若以前没有保存工作流快照，则只能预览已经存在的媒体，无法直接从管理器无损复现原任务，须先用原工作流重新建立记录。

**当前限制**：任务提交仍通过 ComfyUI 的前端工作流序列化与标准队列，不是脱离画布的独立后端工作流运行引擎。导入工作流时会明确询问是否替换当前画布，建议事先保存现有工作流。批量高清入队时临时载入保存的快照并在每项提交后恢复原画布。KJ 原版动态预览只通过浏览器 websocket 推送；当前的预览归档采用浏览器接收最后一次 KJ 动画帧并上传存盘，若浏览器在采样期间断开连接，`sampling_preview` 可能缺失；检查点和 `review.mp4` 由 Python 节点写盘，不依赖浏览器持续连接。正式 GPU 长队列、浏览器断线、跨模型工作流及多任务并发仍需单独实机回归。

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
