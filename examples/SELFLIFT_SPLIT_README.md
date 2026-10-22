# TerryDirector · SelfLift 分阶段工作流

**2026-10-22 起只支持 H3 3D Latent Upscaler 高清转场。** 已彻底移除中间 VAE 解码→放大→重新编码、SelfLift-zero 像素锚、`rho/w_min/w_max` 和 `nearest` 快速档。最终用于保存视频的 VAE 解码仍正常保留。

## 工作流

| 编号 | 文件 | 作用 |
| --- | --- | --- |
| ① | [低清独立保存](TerryDirector_SelfLift_01_Lowres_Checkpoint.json) | 原生低清采样、低清审片视频、保存磁盘检查点 |
| ② | [高清独立读取](TerryDirector_SelfLift_02_Highres_Resume.json) | 从已有检查点恢复，使用 H3 3D Upscaler 完成剩余 Euler |
| ③ | [同画布暂停/继续](TerryDirector_SelfLift_03_Pause_Continue.json) | 蓝色按钮跑低清，柠檬绿暂停图标按钮继续高清 |
| **④** | [0.5→2 MP 参考高清方案](TerryDirector_SelfLift_04_Reference_2MP_Highres.json) | 采用上传的 SelfLift-Avatar 工作流参数：学得的 Upscaler + Spatial 4 块 + 独立高清 MODEL |

## 必需的放大器

`minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` 应放在 ComfyUI 的 `models/latent_upscale_models/` 下。高清节点现在只枚举已安装的 H3 Latent Upscaler 文件；如果模型不存在，会明确报错，不会降级到 `nearest` 或 VAE 往返。

## ③ 同画布暂停/继续

1. 打开工作流③。它预设 8 步 Euler、低清前 6 步、原生 `SamplerCustom`、124 帧。模型与其他资源按本地文件对应。
2. 点击**蓝色向右箭头「生成低清」**，只提交此暂停节点作为局部执行目标，完成后保存独立检查点；高清分支不会运行。
3. 保存成功后，按钮变为**柠檬绿色暂停图标「继续高清」**，节点自动记下检查点 ID；保存画布能保留 ID。
4. 点击绿色按钮时，仅向 ComfyUI 提交该分支的高清视频输出，低清四路输入使用惰性求值，不会重新执行。
5. 如需重新生成低清，使用「重新生成低清」清除当前选择并启动新一轮。

②、③ 的参数虽然是小分辨率技术样例，但都**使用真实 H3 3D Upscaler**。不再提供低质量 `nearest` 路线。

**注意：** 如果同一画布还连接了另一条独立的低清 `SaveVideo` 输出，ComfyUI 可能仍为了那条额外输出执行上游。③ 号示例刻意仅保留高清保存输出，KJ 负责实时低清预览。原生输出若不保存到文件，需要用生成预览审片。

## ④ 正式参考配置

参考用户的 `Self-Lift工作流-爱屋-1020.json` 中**实际启用**的参数，而不是盲目复制所有节点：

- 低清 `960×544`（约 0.52MP）；高清 `1920×1088`（约 2.09MP）；124 帧、24fps
- `BasicScheduler(simple,8)` → `H3SigmaRefiner(extra_steps=1, start_at_sigma=0.7, end_at_sigma=0, spacing=cosine)`
- 低清过渡步 `transition_step=6`，剩余高清约 3 次 Euler
- `CFG=1`；`upscaler_model=minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`
- 高清空间分块 `highres_tiling=true`，`tiling_mode=manual`，`tiling_tiles=4`，`tiling_axis=auto`
- 独立高清模型链：`ModelAttentionBackend(comfy kitchen attention)` → `MiniMaxLowVRAMAttention(8)` → `MiniMaxChunkFeedForward(2,4096)` → 高清续采节点 `high_res_model`

`highres_token_chunk` 和 `highres_weight_cache_gb` 是原工作流 Global 模式参数，**空间分块下不生效**，未引入无效 UI；参考中 Spark 和 Veda 等旁路节点也没有复制。④ 保留独立 ref2va INT8 / 5 秒技术场景，没有把原工作流的 fl2va BF16、15 秒、LoRA、素材和提示词全部替换进去。TerryDirector 自有空间分块还未证明与 selflift-Avatar 数值完全一致。

## 保存与兼容

磁盘检查点仍在 `output/TerryDirector/checkpoints/<uuid>/` 下，保存 `state.safetensors` 与 `manifest.json`。新版本能够读取兼容的旧检查点；模型、条件、分辨率和 Sigma 日程仍必须一致。切换到④ 不可复用由其他分辨率/Sigma 日程生成的低清检查点，需重新生成一次。

**旧版高清节点 UI 必须更新连线。** 现在没有 `vae` 输入，也没有 `rho/w_min/w_max` 控件，且不允许 `nearest` 或 `none`；旧版画布请重新导入本目录已更新的 JSON，或手动重新添加高清续采节点并连接 checkpoint / model / positive / negative / sampler / 可选 high_res_model。

**最终视频输出 VAE 解码**与此次移除的**中途重复 VAE 解码/回编码**不是一回事，`VAEDecode` 和 `VAEDecodeAudio` 等最终输出节点全部保留。

以上是静态迁移与验收要求；GPU 性能和最终画质仍需本机 ComfyUI 验证。

详细架构：[SELFLIFT_SPLIT_NATIVE_SAMPLER_MVP.md](../docs/SELFLIFT_SPLIT_NATIVE_SAMPLER_MVP.md)。
