# 独立加速实验台：V0 当前视频 VAE / V1 指定 INT8 VAE

## 判定

| 维度 | 本轮结论 |
|---|---|
| 技术 | **ALREADY_ACTIVE。** 报告46成功请求中的当前视频 VAE 已是指定官方 INT8 文件，实际本地文件 SHA-256 完全相同、路径也相同；不能构造“当前 VAE 对新 INT8”的不同权重对照。B0 在采样前失败，未产出可信完整 AV latent，V0/V1 解码均未提交。 |
| 速度 | **没有有效 VAE A/B 数据。** 解码、权重加载、保存/编码的分项时间和峰值显存均未测得；不能拿报告46的 `decode_cache` 总耗时冒充纯 VAE 时间。 |
| 画质 | **本轮未解码。** 同源像素对照、运动、曝光与细节均无新结果；声音和声画同步未实际听看，待人工确认。 |

## 权重、文件与输入

报告46真实请求的节点330为 `VAELoader(vae_name="minimax_h3_video_vae_int8_convrot.safetensors")`。本机实际文件大小 **2,811,065,184 bytes**，SHA-256 `52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e`，与文档47锁定的 `Comfy-Org/MiniMax-H3` revision `0d21e5fdcfd05eb679dcca8573c1960a8f87ddf7` 候选完全一致。当前与候选指向同一本机路径；本轮下载0次、未升级依赖、未替换其它 VAE。音频 VAE 保持 `minimax_h3_audio_vae_fp32.safetensors`。

独立 V0/V1 UI/API 配对文件已生成于本机 `local/workflows/`：`Lab_V0_CurrentVAE_Decode.{json,api.json}` 与 `Lab_V1_INT8VAE_Decode.{json,api.json}`。两图只有固定的 `B0_AV.pt` 加载、同一视频 VAE 加载、完整 video latent 解码、前96帧裁切、24fps 保存；不含 UNET、CLIP、条件编码、采样器或音频解码。四份文件的哈希见 `evidence/vae_int8.json`。它们使用的是**同一权重**，仅留作界面与输入路径核对，不能作为 VAE A/B 排队获得虚假的差值。

实验 AV 格式辅助器已用真实 `comfy.nested_tensor.NestedTensor` 小张量验证视频/音频双流、mask 与元数据逐值往返，且未消耗 RNG。B0 唯一提交在 Sigma helper 处失败，没有生成 `B0_AV.pt`；所以本轮 V0/V1 提交数分别为 **0/0**。没有从 MP4 反编码，也没有把 B1 的潜变量拿作 V1 输入。

VAE 候选实际已用于报告46的成功成片；这只能证明旧导演任务使用过该权重，**不能证明本轮独立实验台的纯解码速度或质量**。若日后要比较视频 VAE，应先明确一个不同的合法基线权重与同一可信完整 AV latent，再单独授权解码测试。本轮不自动把结果植入导演节点或合并 main。
