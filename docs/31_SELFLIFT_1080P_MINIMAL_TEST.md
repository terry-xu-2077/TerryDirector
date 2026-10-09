# 内置 Self-Lift · 3 段 1080P 档最小验收（不裁剪）

> 交给本地 Codex 执行；状态：待实机验收。  
> 仓库：`terry-xu-2077/TerryDirector`；分支：`feat/selflift-internal`；实现基线：`f59059b`。  
> 用户最新确认：不裁剪；Self-Lift 默认参数以最初上传工作流的实际保存值为准。只提交一次三段真实生成任务，不执行旧文档的完整 Case A–F。

## 1. 两份工作流的用途

**生成内容**复用“重跑镜头交互设计”中已经实测的 **`Terry导演台.json`**。来源可核对 `docs/13_ADVANCED_PERFORMANCE_DIAG_REPORT.md`、`docs/15_ADVANCED_REAL_QUEUE_EQUIVALENCE_REPORT.md` 和 `docs/27_POST_STABILIZATION_CLEANUP_REPORT.md`。

在本机原测试目录或 ComfyUI 用户工作流目录定位它，读取后深拷贝为验收副本；记录完整路径及原文件 SHA-256，结束后确认原文件未改变。保留原主模型、LoRA/模型补丁、CLIP、视频/音频 VAE，以及完整 `globalPrompt`、前三段各自 `prompt`、`useGlobalPrompt`、资产池、稳定编号和 `source.path`。不要因片段 refs 为空而丢弃全局提示词引用的资产。找不到原文件或其资产时记为 BLOCKED，不编造提示词或下载替代素材。

**Self-Lift 默认参数**参考用户最初上传的 **`Unsaved Workflow (2)(1).json`**，不是上述导演工作流的旧采样参数，也不是第三方节点源码的通用默认值。第 3 节已逐项提取附件中的实际值，本地执行不需要为了读参数安装或运行外部 Self-Lift 插件。

来源节点为 `244 / SelfLiftAvatarH3Sampler`、`123 / KSamplerSelect`、`124 / BasicScheduler`、`147 / H3SigmaRefiner`、`115 / ResolutionSelector`。附件 SHA-256：`709a0c227765999bbe38a29fc1df21f01dca0c5accd6777a17266fefc190f842`。

两份文件不能混用：保留导演工作流的提示词、资产和模型链，仅使用最初附件的 Self-Lift 参数及分辨率设置；不引入其提示词增强、DLSSNR、DLSS 放大、补帧、额外预览或清理节点。

## 2. 只生成前三段

复用原 `TerryDirector Advanced` 节点，接线固定为：

```text
TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector Advanced
```

在验收副本的 `config_json.document.clips` 中只保留按时间排序的前三个有效片段，保留其 ID、提示词和原时长，首尾贴合、无 overlap/gap。第 4 段及之后从副本移除，不能只设为 suspended，以免仍输出原长时间线的尾部黑场。

| 片段 | 原测试时间 / 帧范围（右端不含） | 衔接 |
|---|---|---|
| 1 | 0–4 秒 / [0, 96) | 首段 |
| 2 | 4–7 秒 / [96, 168) | `tail_continuation` |
| 3 | 7–12 秒 / [168, 288) | `tail_continuation` |

FPS=24；Seed 按第 3 节设为 **1000 / fixed**，不再沿用上一版验收文档的 9。保持 `preview_enabled=false`、`rerun_clip_id=""`、`recovery_mode=""`。使用新的测试节点/缓存标识，避免覆盖原中断缓存或复用旧结果。若本机原文件前三段时长不同，保留实际时长并重算预期总帧数，不改写提示词来硬凑 12 秒。

只提交当前 Advanced 及上游依赖。不同时运行 Base 或其他导演分支，不接需要物化 Advanced 全片 IMAGE/AUDIO 的 `TerryDirector 输出`。

## 3. 按最初附件设置参数，直接保存原始尺寸

| 参数 / 归属 | 附件保存值 / 本轮设置 | 来源节点 |
|---|---|---|
| 导演配置分辨率 | `aspect_ratio="16:9 (Widescreen)"`，`megapixels=2.0`，`multiple=32` | 115 |
| Seed / 生成后控制（仍在导演时间线） | `1000 / fixed` | 244 |
| CFG / 低清阶段步数 / 低清比例 | `1 / 5 / 0.5` | 244 |
| 采样器 | `euler` | 123 |
| 调度器 / 基础步数 / Denoise | `simple / 6 / 1.0` | 124 |
| Sigma 精修 | 开；`extra_steps=1`，`start_at_sigma=0.7`，`end_at_sigma=0`，`spacing="cosine"` | 147（启用） |
| rho / w_min / w_max | `0 / 0.5 / 1` | 244 |
| Latent 放大权重 | `minimax_h3_latent_upscaler_3d_fp16.safetensors`；使用本机该文件的实际子路径 | 244 |
| 高清模型 | 不另接，复用导演配置中的主模型 | 244 |
| 高清分块 | `highres_tiling=false` | 244 |
| 分块模式 / 手动块数 / 分块方向 | `auto / 2 / auto`（关闭分块时不启用） | 244 |

二采节点的上述数值与枚举默认值已核对与附件一致；本轮不改采样算法或全局节点默认 Seed。Seed=1000 只设置在本次验收副本的导演时间线，参数归属不变。缺少指定放大权重记为 BLOCKED，不选其他模型代替。

接入二采后使用二采节点日程，导演配置的普通采样器/总步数不控制 Self-Lift。记录实际 Sigma 数组与低清/高清步数，默认预期 5+2。参考图尺寸继续保留导演工作流原值。

**本轮直接验收原始 1920×1088、24fps 视频；不裁剪，不缩放，不补边，不额外转码，不另外制作 1920×1080 文件。** “1080P 档”是任务称呼，报告实际宽高必须写 1920×1088，不能写成精确 1920×1080。

按当前 `_resolution()`，附件的 2MP / 16:9 / multiple=32 得到 1920×1088。预期低清 latent 空间为 **34×60**（对应 960×544），高清为 **68×120**（1920×1088），这里 latent 尺寸顺序为 H×W。核对真实 tensor、解码和保存尺寸，不只看 UI 标签。

## 4. 执行与判定

拉取本分支，保留本地未提交改动并确认实际运行提交，重启原 ComfyUI 服务；沿用已验证的环境和启动方式，不升级环境、换主模型、改启动参数或清空其他任务队列。

预检节点注册、三级接线、资产与放大权重，通过已验证的 `/prompt` 方式运行三段，保留 prompt_id、提交 payload、history 和控制台日志。三段均使用自有 `TerryDirectorSelfLiftSampler`，不得调用或导入外部 `SelfLiftAvatarH3Sampler`；不要求卸载本机已有插件。

| 检查 | 通过条件 |
|---|---|
| 真正三段二采 | 三段都完成低清→latent lift→高清采样，不是缓存读取或普通采样替代；日志对应各片段与目标尺寸 |
| 连续性 | 第 2、3 段经 `MiniMaxH3AddGuide` 使用上一段最终可见尾帧；不是独立生成，也不是 `tail_reference` |
| 输出规格 | 解码和最终保存均为 1920×1088、24fps，无尺寸后处理；原测试前三段应为 288 帧/12 秒，无长时间线尾部补黑 |
| 音画有效 | 视频和音轨可完整解码，音频并非全零，音画时长差不超过 0.1 秒；不用补静音掩盖音频丢失 |
| 可观察质量 | 抽取两处接缝前后帧，检查明显黑帧、花屏、构图突跳，保留截图；未实际听看时，声音/主观连续性写“待人工确认” |
| Advanced 收尾 | 正常完成，仅正常最终编码；该次 lossless pixel cache 清理，三段 LATENT checkpoint 保留 |

遇到 OOM、导入失败、缺资产或采样异常，保存完整 traceback、出错片段和阶段后停止；不自动降分辨率、开分块、改 Seed 或反复重跑。不测中断恢复、局部重跑、Base A/B、分块矩阵或 50 秒长任务。

## 5. 只交一份简短报告

写入 **`docs/32_SELFLIFT_1080P_MINIMAL_REPORT.md`**：实际代码 commit、原导演工作流路径与前后哈希、三段 ID/帧数、实际 Self-Lift 参数（含 Seed=1000）、低清/高清及最终视频尺寸、prompt_id、逐项 PASS/FAIL/BLOCKED/待人工确认、总生成时间、原始视频与日志路径。明确写“不裁剪、无尺寸后处理”；失败附完整 traceback。

视频、模型权重和大型缓存留在本机，不提交仓库；本轮不修改产品代码、不合并 main。
