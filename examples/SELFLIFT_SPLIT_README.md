# TerryDirector · SelfLift 分阶段示例工作流

这两份 **ComfyUI 可导入的画布 JSON** 展示最小实现：原生低清采样 + KJ 实时预览 → 持久化检查点 → 另一个工作流读取检查点 → SelfLift 高清续采。

| 顺序 | 文件 | 运行结果 |
| --- | --- | --- |
| ① | [TerryDirector_SelfLift_01_Lowres_Checkpoint.json](TerryDirector_SelfLift_01_Lowres_Checkpoint.json) | 生成 `state.safetensors` / `manifest.json`，同时输出低清审片视频 |
| ② | [TerryDirector_SelfLift_02_Highres_Resume.json](TerryDirector_SelfLift_02_Highres_Resume.json) | 从之前的检查点恢复，跳过低清阶段，输出高清 MP4（含音频） |

## 运行顺序

1. 切换到 `feature/selflift-native-lowres-checkpoints`，重启 ComfyUI，导入工作流①。
2. 将 **H3 模型、Qwen H3 文本编码器、视频 VAE、音频 VAE** 修改成你电脑上实际存在的文件；示例模型名来自公开 H3 工作流，不自动下载模型。准备好可运行的 MiniMax H3 ComfyUI 环境与可选的 KJNodes。
3. 工作流①预设 **8 步总日程、6 步低清、Euler、Seed=42021、CFG=5、384×224 低清、768×448 目标、124 帧（约 5.2 秒）**。原生 `SamplerCustom` 的两个输出必须分别接入保存节点；目标分辨率的 `EmptyMiniMaxH3LatentAV` 只供检查点使用，**不要把它接给低清采样器**。
4. 运行①，查看 KJ 实时预览及保存到 `output/video/TerryDirector_SelfLift_Lowres*.mp4` 的低清 `x0` 审片视频。检查点存于 `output/TerryDirector/checkpoints/<uuid>/`。本 MVP **不会自动审核、也没有“审片通过”按钮**；审片由人确认，合格时在第二份工作流主动选择检查点。
5. 打开工作流②。选择 `TerryDirector 读取低清检查点` 的任务下拉项（显示镜头名 + ID），连接 `TerryDirector SelfLift 高清续采`。**若下拉仍显示“暂无检查点”，重启 ComfyUI 并重新添加读取节点，再选择刚保存的记录**；这一版尚没有动态视频任务浏览器。
6. 确认工作流②的模型、提示词与引用资源和工作流①一致，再运行。它从存储的 SIGMAS 第 6 步开始，执行剩余 2 次 Euler 计算，随后用普通 H3 视频/音频 VAE 解码保存。

## 模型与分辨率注意事项

- 示例使用 `MiniMaxH3ReferenceToVideo`（ref2va）与同一段英文提示词，**没有强制连接参考图**，主要用于检查分阶段机制；人物一致性、视频质量是否适合正式制作还需真机验收。如果使用参考图/视频/音频，必须在高清工作流重新提供相同的对应条件，并检查参考尺寸策略；现有检查点并不保存 CONDITIONING 张量、模型权重或素材文件。
- ComfyUI 原生 `SplitSigmas` 的第一个输出名叫 `high_sigmas`，但源码实际值是 `sigmas[:step+1]`，所以**工作流①将它作为低清前 6 步的 Sigmas**；完整 8 步的 Sigmas 另接保存节点。不要误用第二个输出。
- KJ `Model Preview Override` 预设动态预览 12 帧、12 FPS、Tiny VAE=`none`；若已安装兼容的 `taeh3.safetensors`，可在 KJ 节点里切换，以改善预览效果。KJ 节点只参与实时预览，并不负责生成持久审片视频。
- 高清示例预设 **SelfLift-zero**（`rho=0.6`、`upscaler_model=none`），不额外依赖 H3 Latent Upscaler 权重。想与 SelfLift-Avatar 常用的“外部 H3 放大”路线比较，可以将 `rho=0`，并改用你已安装的 H3 Latent Upscaler 权重。
- 示例中的相同 Seed、CFG、Prompt、模型、目标分辨率以及参考条件都是**手动保持一致**。现阶段没有完整模型或提示词指纹校验，使用错误条件可能仍然运行但产生与预期不一致的结果。
- 这里的“可导入”表示 JSON 按实际 ComfyUI 节点 ID、输入槽和连接结构构建并完成静态检查；**未在你的 RTX 3090 上运行 GPU 验收**。若 ComfyUI 本地版本更旧或扩展版本不同，请以实际节点报错与接口为准。

## 当前范围

这两个工作流刻意没有接入 TerryDirector 时间线循环、任务卡浮窗、多选批量二采或后台状态卡；它们是第一阶段的技术闭环验收样例。

详细设计与检查点约束参见 [SELFLIFT_SPLIT_NATIVE_SAMPLER_MVP.md](../docs/SELFLIFT_SPLIT_NATIVE_SAMPLER_MVP.md)。
