# 内置 Self-Lift · 3 段 1080P 最小验收

> 交给本地 Codex 执行；状态：待实机验收。  
> 仓库：`terry-xu-2077/TerryDirector`；分支：`feat/selflift-internal`；实现基线：`f59059b`。  
> 本轮只提交一次三段真实生成任务，不执行旧文档的完整 Case A–F。

## 1. 复用原工作流

使用“重跑镜头交互设计”中已经实测的 **`Terry导演台.json`**。来源可核对 `docs/13_ADVANCED_PERFORMANCE_DIAG_REPORT.md`、`docs/15_ADVANCED_REAL_QUEUE_EQUIVALENCE_REPORT.md` 和 `docs/27_POST_STABILIZATION_CLEANUP_REPORT.md`。

在本机原测试目录或 ComfyUI 用户工作流目录定位该文件，读取后深拷贝为验收副本；记录完整路径及原文件 SHA-256，结束后确认原文件未改变。找不到原文件或其引用资产时记为 **BLOCKED**，不要换用本轮上传的 selflift-Avatar 演示工作流，也不要编造提示词或下载替代素材。

保留原来的主模型、LoRA/模型补丁、CLIP、视频/音频 VAE，以及**完整 globalPrompt、前三段各自 prompt、useGlobalPrompt、资产池、稳定编号和 source.path**。原工作流依赖全局提示词中的资产引用，不能因为片段 refs 为空就丢弃资产。以本机文件实际内容为准，不按文档手工重建故事。

## 2. 只生成前三段

复用原 `TerryDirector Advanced` 节点，接线固定为：

```text
TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector Advanced
```

在验收副本的 `config_json.document.clips` 中只保留按时间排序的前三个有效片段，保留其 ID、提示词和原时长，首尾贴合、无 overlap/gap；第 4 段及以后的片段必须从副本中移除，不能只设为 suspended，以免仍输出原 50 秒时间线的尾部黑场。

原测试的前三段为：

| 片段 | 时间 / 帧范围（右端不含） | 衔接 |
|---|---|---|
| 1 | 0–4 秒 / [0, 96) | 首段 |
| 2 | 4–7 秒 / [96, 168) | `tail_continuation` |
| 3 | 7–12 秒 / [168, 288) | `tail_continuation` |

FPS=24，Seed=9 固定；`preview_enabled=false`，`rerun_clip_id=""`，`recovery_mode=""`。使用新的测试节点/缓存标识，避免覆盖原节点的中断缓存或复用旧结果。若原文件前三段时长不同，不截短或改写其提示词来硬凑 12 秒；记录实际时长，重新计算预期总帧数。

只提交当前 Advanced 及其上游依赖。不要同时执行 Base、其他导演分支，或连接会强制物化 Advanced 全片 IMAGE/AUDIO 的 `TerryDirector 输出`。

## 3. 固定生成参数与 1080P 口径

| 归属 | 本轮值 |
|---|---|
| 导演配置分辨率 | `aspect_ratio="16:9 (Widescreen)"`，`megapixels=2.0`，`multiple=32` |
| 参考图尺寸 | 保留原值 |
| 二采 CFG / 低清步数 / 低清比例 | `1 / 5 / 0.5` |
| 二采基础步数 / Denoise | `6 / 1.0`，Euler + simple |
| Sigma 精修 | 开；加 1 步；起始 0.7、结束 0、cosine |
| rho / w_min / w_max | `0 / 0.5 / 1` |
| Latent 放大权重 | `minimax_h3_latent_upscaler_3d_fp16.safetensors`，使用本机实际子路径 |
| 高清模型 / 高清分块 | 高清模型不另接、复用主模型；分块关闭 |

接入二采后使用二采节点的日程，导演配置的普通采样器/总步数不控制 Self-Lift。预检记录实际 Sigma 数组及低清/高清步数，默认预期为 5+2。

**最终验收视频必须是 1920×1080。当前 H3 的原生二采画布使用 1920×1088，解码后仅上下各裁 4 像素；不进行像素缩放、补帧或后期超分。**

原因：当前 `_resolution()` 的 2MP/16:9/multiple=32 实际得到 1920×1088；H3 空 latent 按 `height//16` 创建，直接填写 1080 不能得到精确 1080 高度。预期低清 latent 空间为 **34×60**（约 960×544），高清为 **68×120**（1920×1088），维度顺序均为 H×W。必须记录真实 tensor/解码尺寸，不能只检查 UI 标签。

不要为本次验收修改生产代码。若 Advanced 原样保存 1920×1088，保留该原始视频，再用本机已有工具另存 1080P 验收裁切件。例如使用已有 ffmpeg（输入/输出替换为实际路径）：

```bash
ffmpeg -n -i "原始视频.mp4" -map 0:v:0 -map 0:a:0 -vf "crop=1920:1080:0:4" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy "验收1080p.mp4"
```

这一步是明确记录的验收后处理，会重编码视频；不把它冒充原生 1080 高度采样，也不计入 Advanced 本身的单次最终编码。禁止从低分辨率结果拉伸成 1080P来判通过。

## 4. 执行与判定

拉取本分支，在保留本地未提交改动的前提下确认运行的是本分支代码，重启原 ComfyUI 服务。沿用本机已验证的环境和启动方式；不要升级 ComfyUI、换模型、改启动参数或清空其他任务队列。

预检节点注册、三级接线、资产路径和放大权重均可用，然后通过已验证的 `/prompt` 提交方式运行上述三段，保存 prompt_id、提交 payload、history 和对应控制台日志。执行图必须包含三段自有 `TerryDirectorSelfLiftSampler`，不得调用或导入外部 `SelfLiftAvatarH3Sampler`；不要求卸载本机已有插件。

| 检查 | 通过条件 |
|---|---|
| 真正三段二采 | 三段都实际完成低清→latent lift→高清采样，不是缓存读取或普通采样替代；日志能对应三个片段和目标尺寸 |
| 连续性 | 第 2、3 段经 `MiniMaxH3AddGuide` 使用上一段最终可见尾帧；不是三个独立任务拼接，也不是 `tail_reference` 模式 |
| 输出规格 | 原始解码/视频为 1920×1088，裁切件为 1920×1080、24fps；原前三段应为 288 帧/12 秒；无原时间线尾部补黑 |
| 音画有效 | 视频完整可解码，音轨存在且可解码、并非全零，音画时长差不超过 0.1 秒；不得用补静音掩盖音频丢失 |
| 可观察质量 | 抽取两处接缝前后帧检查明显黑帧、花屏、构图突跳；保留接缝截图。未实际听看时将声音/主观连续性写为“待人工确认”，不能凭文件存在判正常 |
| Advanced 收尾 | 正常完成并产出原始视频；该次 lossless pixel cache 清理，三段 LATENT checkpoint 保留 |

遇到 OOM、导入失败、缺资产或采样异常，保存完整 traceback，写明出错片段和阶段后停止；不自动降分辨率、开分块、改 Seed 或反复重跑。不测中断恢复、局部重跑、Base A/B、分块矩阵、50 秒长任务、提示词增强、DLSSNR 或补帧。

## 5. 只交一份简短报告

写入 **`docs/32_SELFLIFT_1080P_MINIMAL_REPORT.md`**：记录实际代码 commit、原工作流路径及前后哈希、三段 ID/帧数、关键二采参数和实际尺寸、prompt_id、逐项 PASS/FAIL/BLOCKED/待人工确认、总生成时间、原始视频与 1080P 裁切件及日志路径。失败附 traceback，不把失败重跑覆盖掉。

视频、模型权重和大型缓存留在本机，不提交仓库；本轮不修改产品代码、不合并 main。
