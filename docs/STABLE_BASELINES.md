# 稳定运行基线与验收索引

本页是精简后的唯一验收索引：记录能复现的环境、运行参数、历史源码和**实际确认过的结论**。不是新的测试报告，不因归档而追加未经执行的验收结论。

## 已合并版本

| 基线 | 提交 | 说明 |
| --- | --- | --- |
| 当前发布合并 | `a3348dce26ca016f0ca5a4d0fc29bde453861d58` | 主分支包含 Self-Lift、独立循环器和模型适配层的合并点 |
| 循环器整合提交 | `9b8c4671aa07c6b8d751084f6e6415c5d74f5446` | H3 适配器已参与循环、LTX 2.5 保留 `ready=False` |
| Self-Lift 正式集成 | PR [#1](https://github.com/terry-xu-2077/TerryDirector/pull/1) | 内置二采、默认参数和 Self-Lift 稳定链路 |
| 循环器正式集成 | PR [#2](https://github.com/terry-xu-2077/TerryDirector/pull/2) | 低内存流式 VIDEO、LoopStart/End、UI 和条件承接 |
| 时间线 UI 恢复参考 | `408395e7620fe368775515ca515d04fae7a8daed` | 历史 Demo 06.11，供 UI 几何/布局回溯 |

用户已确认此前的 H3 循环工作流能够正常运行，因此授权将整合分支并入主分支。**这属于用户本机验收反馈；仓库没有存储对应的完整 GPU 日志和原工作流可重放请求。** 最近新增的模型适配层经过独立 CPU／静态检查，但没有因此声明 LTX 2.5 可用，也不伪称进行了新的 GPU 重跑。

## 经验证的运行环境

这是 2026-10-10 在 Windows / RTX 3090 上得到的 cu130 基线，**不是安装器或要求所有用户完全匹配的全环境锁**。

| 组件 | 已记录版本 |
| --- | --- |
| GPU / 显存 | NVIDIA RTX 3090 / 24GB，驱动 591.74 |
| 系统 / Python | Windows 10 / Python 3.12.13 |
| ComfyUI | 0.39.0，`b26625f23a888367b92153b28d93e159e83e677b` |
| PyTorch / CUDA | `torch==2.11.0+cu130`，CUDA 13.0 |
| torchvision / torchaudio | `0.26.0+cu130` / `2.11.0+cu130` |
| comfy-kitchen | 0.2.37 |
| SageAttention | `2.2.0+cu130torch2.10.0andhigher.post5` |
| triton-windows | `3.7.1.post27` |
| KJNodes | `3f20054214fec9f9234fd3841ae6f1e4287948f6` |
| 周边依赖修复 | `numpy==2.3.2`、`pydantic==2.11.10`、`pydantic-core==2.33.2` |

周边依赖修复后 `pip check` 曾返回无冲突、ComfyUI 正常启动；**当时 LTXVideo/Kornia 导入错误被明确排除在验收之外**，不代表 LTX 环境已验证。环境固化不自动启用 Kitchen、Sol 或其它实验后端。

## H3 普通生成（Base / Advanced）

- 三段短任务：0.2 MP、608×352、24 fps、Seed 9，编排 4+3+5 秒，最终 288 帧、12 秒。Base 输出 IMAGE/AUDIO，Advanced 只做一次最终编码；Advanced 首段中断恢复确认只补剩余两段。
- 九段长任务：0.5 MP、960×544、24 fps、Seed 9、1200 帧、50 秒；工作流使用同一组七项参考素材与片段提示词。常用验收工作流 SHA-256：
  `CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7`。
- Base 无损缓存最终合并：历史运行提交 `4ec7d30f7260ffe528727bc74557dcc97eb21704`；50 秒完成，分段缓存不会在采样期间累加成完整 IMAGE，合并后临时缓存清理。
- Advanced 无损分段＋单次最终编码：历史运行提交 `d1cf6110d222c210a677d6075e6f2c11560db3c4`；50 秒完整任务，九份无损 .pt，中间没有有损 MKV，最终视频 1200 帧 / 50 秒 / 24 fps；运行缓存峰值约 **7.02 GiB**，完成后清理，LATENT checkpoint 保留。
- 相同场景的 cu130 独立回归：九段 50 秒、960×544 完整通过、视频音频均能解码，历史任务约 **1106.336 秒**；用户人工确认**整体画面质量保持**，但内容存在细微差异，并非跨环境逐帧一致。声音内容、逐个接缝与声画同步未单独人工确认。

上述速度数据是历史单次任务记录，不能用于承诺其他模型、分辨率或驱动版本的速度收益。

## 内置 Self-Lift（已确认参数与效果）

> **2026-10-22 实现口径更新**：本节以下性能记录属于历史测试。现有 SelfLift 运行时已删除中间 VAE 往返、像素锚参数及最近邻高清分支，统一通过 H3 3D Latent Upscaler。历史耗时不代表本次新版的性能验收。


二采配置入口：`TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector / TerryDirector Advanced`。不依赖外部 SelfLiftAvatarH3Sampler。

| 参数 | 验证过的默认设置 |
| --- | --- |
| CFG / 采样 Denoise | 1.0 / 1.0 |
| sampling_steps / transition_step | 6 / 5 |
| lowres_scale | 0.5 |
| sampler / scheduler | Euler / simple |
| sigma refine | 开启；附加步数 1、start 0.7、end 0、cosine |
| 高清分块 | 关闭（`highres_tiling=false`） |
| 目标放大模型 | `minimax_h3_latent_upscaler_3d_fp16.safetensors`（需自行提供） |
| 独立高清 MODEL | 可不接，复用主模型 |

在已确认 H3 日程里实际是**低清 5 次＋高清 1 次**，不能把 UI 的“附加步 1”误认为无条件执行更多迭代。

三段 12 秒 Self-Lift 复测在 1920×1088、24fps、288 帧下完成；用户确认画质无问题。历史样本采用 `MiniMaxChunkFeedForward(chunks=2, seq_threshold=4096)` 规避最初的高清阶段 OOM，`highres_tiling=false`。单段 Kitchen 后端验证过的 MODEL 链是：
`模型/LoRA → ModelAttentionBackend(comfy kitchen attention) → MiniMaxLowVRAMAttention(head_chunks=4) → MiniMaxChunkFeedForward(chunks=2, seq_threshold=4096) → TerryDirector 配置.model`。
**该链是特定测试环境的参考，不是插件自动安装／强制注入，也不保证其它分辨率不会 OOM。**

单段 Kitchen 样本的历史整任务从约 804.3 秒变为 704.1 秒，只能视为一次测试对照，不能宣传普遍加速。Self-Lift 的音频内容与音画同步仍需按具体作品单独确认。

## 循环器与模型适配

**现行循环器**使用 ComfyUI 原生循环控制，驱动用户自行搭建的 H3/SelfLift 等生成链。每段生成完成立即编码为 MOV / ProRes 422 HQ（默认）或 MP4 / H.264，不再默认保存完整 `.pt`；循环结束可选按时间线重叠裁切并合并为 `Final.mov` / `Final.mp4`。循环结束输出最终 `VIDEO`（关闭合并时为空）、性能记录 Markdown、片段目录；无需再依赖下游 SaveVideo 执行最终编码。支持根据历史视频或实体视频承接单镜头重跑，片段采样进度来自 ComfyUI 执行事件。输出盘需要预留镜头文件及合并临时文件空间。

`minimax_h3` 为默认适配器；`ltx_2_5` 为未完成的注册占位，`ready=False`，不会静默退回 H3 解码。模型选择 UI 尚未对 LTX 开放，后续适配需独立 GPU 验收。

### SelfLift + 2X FastDecode 长循环 RAM 回归（2026-10-14）

- 故障基线：14 段、153.5 秒工作流此前连续两次在后期失败；最近一次前 12 段完成，第 13 段 `clip-15` 的 SelfLift 已完成，但整段 `F.pixel_shuffle()` 申请 6,091,407,360 字节时 CPU OOM。旧报告采样到系统 RAM 63.57/63.75 GiB。工作流中的 `RAMCleanup` 被禁用；启用的 `TerryXuMemoryCleanup` 位于循环入口，并非每段解码后执行。
- 修复：循环在下一段采样前定向释放上一段的 ComfyUI 输出缓存和已完成执行引用，在 LoopEnd 释放最后一段；FastDecode 将 PixelShuffle 限制为 4 帧一块，直接填充唯一的最终 BHWC IMAGE，时间分块模式预分配输出而不在末尾 `torch.cat()`。没有改变采样、帧率、分辨率或输出精度。对应本仓库提交 `f47ba8c3ddaf720f1944f0d53e04684ca6dad94c`，第三方 FastDecode 本地仓库提交 `03d377e40bc222c24dcb54a9f234ef2d00f32924`。
- 小规模验收：10 秒单段为 240 帧；10+15 秒两段最终为 600 帧、25 秒、1920×1088、24 fps，AAC 立体声可解码且非静音。合成像素测试中，旧整段 PixelShuffle 路径与新分块路径的 Float16/Float32 输出逐像素相同。
- 长回归：沿用原 SelfLift/2X VAE 核心参数，只运行前 13 段（141.5 秒）；API 转换绕过了循环入口的 `TerryXuMemoryCleanup`。13/13 段完成，最终 MP4 可完整解码 3396 帧、1920×1088、24 fps、141.5 秒，AAC 32 kHz 立体声非静音；没有运行第 14 段。原故障段 `clip-15` 的 PixelShuffle 完成时 RSS 39.60 GiB、系统可用内存 8.01 GiB，随后 240 帧写盘成功。
- RAM 证据：第 2–13 段采样前 RSS 为 27.18–29.25 GiB，第 13 段为 27.89 GiB；进入第 13 段时节点缓存从 7.89 GiB 降至 0.28 GiB，LoopEnd 又将最后一段缓存从 6.36 GiB 降至 0.30 GiB。全程最大解码阶段日志 RSS 45.68 GiB、最低系统可用内存 2.05 GiB，发生在 15 秒段。独立 0.5 秒采样得到峰值 RSS 45.09 GiB、最低可用 2.63 GiB；不同采样点不能直接与旧报告的进程 RSS 比值。原始运行报告位于 `ComfyUI/output/TerryDirector/reports/loop_20261014_104823_6bc53ef518.md`（同名 JSON），半秒采样 CSV 位于工作区 `recovery_backup_20261014/ram_fix_13clips_ram.csv`。
- 边界：现有 IMAGE 输出接口仍要求完整解码缓冲区与最终 IMAGE 同时存在；15 秒段只余约 2 GiB 系统可用内存，其他进程占用或更长的单段仍可能 OOM。持久化失败缓存路径已改到 output 目录并在 ComfyUI 重启后加载，但自动从中断片段续跑、实际 BF16 工作流与完整 14 段尚未验证。
- 后续兼容方案：新增 TerryDirector 自带的可选 `TerryDirector H3 2X 低内存解码`，使用原版第三方 `MiniMaxH3VAEDecodeFast` 公开接口按 51 帧（含 39 帧因果上下文）的小窗口处理并写入唯一最终 IMAGE 缓冲区，**不要求也不修改第三方解码器源码**。此方案与上面的 13 段验收配置不是同一实现；目前仅有窗口分割和模拟后端的离线回归，仍需新的 GPU 实测，不得把之前的 13 段结果算作该适配器通过。另已修复成功保存后新路径的运行缓存清理，失败/中断缓存仍保留。

### 单片段重跑与实体视频 RTX 3090 验收（2026-10-14，本地验证记录）

- 源码基点：`origin/main` 的 `1024b5a58c47351df03e8782d9889cfbea3df72f`；测试提交所在分支 `validation/rerun-physical-gpu-20261014`（验收时尚未合并 main）。启动器运行 ID `39108-1791960961870-7`，ComfyUI `b26625f`，RTX 3090、PyTorch `2.11.0+cu130`。以现有 H3/SelfLift API 工作流 `recovery_backup_20261014/ram_fix_10s_api.json` 为链路，改为普通 H3 VAE 解码、608×352（约 0.2 MP）、每段 48 输出帧（H3 合法采样 56 帧）、24 fps；保留原模型、LoRA、8 步调度、SelfLift 与 CFG 设置。生成前 AI、额外 VHS/SaveVideo 支路关闭，以避免第二次编码。提交的是等价于编辑器 `rerun_clip_id` 的 API 请求；本轮未人工点击编辑器按钮，也未运行可选 2X VAE。
- 输出根目录：`ComfyUI/output/TerryDirector/renders/loop-295/`；同名 JSON 性能报告位于 `ComfyUI/output/TerryDirector/reports/`，本机可重放 API 请求位于工作区 `.codex-run/td_clip_acceptance/`。下表耗时和峰值取各次 TerryDirector JSON 报告，RAM 为全系统已用、RSS 为 ComfyUI 进程、VRAM 为 NVML 全设备已用，单位 GiB；这些采样峰值不等于模型独占分配。

| 任务 / 运行目录前缀 | 实际耗时 | RAM / RSS / VRAM 峰值 | 结果 |
| --- | ---: | ---: | --- |
| A+B+C 基线 `5e40c1ea25` | 92.90 s | 45.95 / 29.70 / 24.00 | 各 48 帧 MOV；Final 144 帧、6.0 s |
| 仅重跑 B·尾帧参考 `f8600e6ec9` | 37.54 s | 45.79 / 29.50 / 23.66 | 新 B MOV，`continuity=tail_reference` |
| 仅重跑 B·尾帧续接 `61d22bf78e` | 35.25 s | 45.53 / 29.41 / 23.64 | 新 B MOV，`continuity=tail_frame` |
| 仅重跑 B·重叠 12 帧 `29212782dd` | 37.45 s | 45.51 / 29.50 / 23.66 | 新 B MOV，`trim_head_frames=12` |
| 实体 A → B `217b8df40d` | 39.04 s | 45.50 / 29.42 / 23.64 | A 不采样、不合并；Final 仅 B 的 48 帧 |
| 实体 A 重叠 12 帧 → B `1a8a383eab` | 37.74 s | 45.53 / 29.42 / 23.65 | B 接受重叠上下文，Final 仍为 B 的完整 48 帧 |
| 无音轨实体 A → B `79bc968215` | 38.41 s | 45.47 / 29.36 / 23.60 | 静音上下文正常，Final 仅 B 的 48 帧 |
| A+B+C 完整重叠合并 `6b0844a755` | 89.42 s | 45.75 / 29.65 / 24.00 | B 去头 12 帧；Final 132 帧、5.5 s |

- 上下文与同步：独立调用实际读取代码，对 A.mov 的最后 1 帧、最后 12 帧及对应 2,000 / 24,000 个每声道音频样本，与 FFmpeg 整片解码逐值相同；无音轨 A 的 12 帧音频上下文为全零。完整重叠 Final 的 RGB16 解码画面逐值等于 A[0:48]+B[12:48]+C[0:48]，PCM 音频逐值等于 A[0:96000]+B[24000:96000]+C[0:96000]；Final 为 132 帧、48 kHz 双声道每声道 264,000 样本，视频和音频均 5.5 s。
- 记录与资源：三次重跑的 `timeline.json` 都只含 B，Seed `922`、原时间线 `authored_index=1`、正确的承接类型/上游 A.mov、`final=null`；重跑目录均无 A/C，旧基线 A/C/Final 的修改时间保持初次生成时间，新 B 分别写入独立目录。实体 A 的 manifest 只含 B，仍保留原编排序号 1。所有成功运行目录没有完整 `.pt` 或残留 `next_context.npz`；最终循环体节点缓存从约 0.14–0.18 GiB 释放到约 0.00–0.03 GiB。RSS 保留约 29 GiB，包含已加载模型，不能据此宣称模型内存全数释放。
- 失败路径：前驱 MOV 文件缺失、manifest 要求 60 帧而历史 A 仅 48 帧，均在约 0.02 s 内拒绝 B 重跑且不采样；另以 manifest 标 48 帧、实际只有 47 帧的视频测试，约 0.23 s 拒绝并明确报告 `时间线需要 48 帧，文件约有 47 帧`。没有生成新的 B/Final。发现的唯一仓库问题是 `tests/test_loop_media.py` 测试夹具缺少新增的 Seed，且将单片段 MP4 的索引设为 2，导致媒体测试在真正断言前失败；修复提交 `deaf4e94ad1fcbd98631c4755f7220503cdebbcb` 补齐 Seed、索引与断言，未改生产代码或第三方节点。相关 CPU 测试 11/11 通过，真实 GPU 项均完成；本次未发现需修改的生产缺陷。

## 历史证据如何追溯

本次清理仅移除旧文档、测试及实验文件在**当前 `main` 文件树**中的副本，不会改写既有 Git 提交对象。删除前的汇总参考点：

`a3348dce26ca016f0ca5a4d0fc29bde453861d58`

如需查看旧报告或测试代码，可从 Git 历史定位（不必重新把旧文件放回 `main`）：

```bash
git show a3348dc:docs/25_ADVANCED_LOSSLESS_SEGMENT_REPORT.md
git show a3348dc:docs/48_SELFLIFT_MAIN_RELEASE.md
git show a3348dc:experiments/acceleration_lab/ENVIRONMENT_BASELINE.md
git show a3348dc:tests/test_selflift_internal.py
```

删除前旧开发分支 HEAD（仅供追溯历史，**并非建议重新部署**）：

| 分支历史标识 | 原 HEAD |
| --- | --- |
| `feat/selflift-internal` | `e58ddd95605d6d15b6fc5f55e185b90dc30b872b` |
| `selflift-internal-20261010` | `6b6e0e982c3f4302a04d6881ffb41aa53843b04b` |
| `feat/timeline-loop-native-h3` | `8f2ba299c1f8cd2b4e90629b2de9b16a45c9c29b` |
| `integrate/selflift-native-h3-loop` | `9b8c4671aa07c6b8d751084f6e6415c5d74f5446` |

*旧测试报告提供的是特定硬件、输入与版本下的观测。新模型、更高分辨率、新驱动或新功能变更，都需要新的运行验证；历史验证不应被理解为全环境保证。*


## 分阶段 SelfLift 审片工作流基线（2026-10-22）

当前示例③、④已改用独立低清／高清采样节点与通用 LATENT 暂停节点，低清和高清分别设置步数。下列耗时及用户确认属于改接前的历史工作流；新链路的 CPU 回归及 512×288 实际 GPU 数值对照见下方 2026-11-03 记录；尚未重做原分辨率的 GPU 画质／性能验收，不沿用历史耗时作为新链路的测量结果。

- 默认示例：`examples/TerryDirector_SelfLift_03_Pause_Continue.json`；低清审片约 0.2 MP（608×352），高清目标约 0.8 MP（1216×672），124 帧。
- 模型栈：`minimax_h3_fl2va_bf16.safetensors` + `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`；视频 VAE INT8 ConvRot、音频 VAE FP32。
- 采样：固定 seed=8、CFG=1；`BasicScheduler(simple,8)` → `H3SigmaRefiner(1,0.7,0,cosine)` → `SplitSigmas(step=6)`；H3 3D Latent Upscaler BF16；高清空间分块默认关闭。
- 用户实测该对齐工作流一次高清任务显示 `Prompt executed in 160.42 seconds`，并确认画面正常、耗时较先前任务短。此为单次用户实测，不是受控基准，也不代表不同硬件或配置的速度承诺。

## 分拆 SelfLift 与 Avatar 数值对照（2026-11-03）

对照本机 fork `selflift-Avatar` 合并提交 `41289a62828d4fc6b87192a5b4711a8a139bfa37`。分拆节点现原样切分完整 SIGMAS：低清 K 次、高清 N−K 次，不对后段插值；末次低清 callback 的 x/x0 原样缓存，过渡保留低清音频缩放与 CONST noise_scale。v1 分拆过渡缓存须重新生成低清；通用暂停节点仍无种子控件或种子缓存职责。

RTX 3090、Torch 2.11.0+cu130，Cobijada H3 Hybrid 精炼 INT8、32B INT8 ConvRot CLIP、BF16 3D Upscaler、512×288、seed=123456、CFG=1、simple 8 步、rho=0、关闭空间分块：22 帧（6+2）、124 帧（5+3，37 个 latent 时间帧，实际触发双时间窗口放大）及短片磁盘恢复续采，最终视频／音频 LATENT 均与 Avatar 逐值相同，最大绝对误差 0。短片开启手动 4 块空间分块（低清全幅参考、6 patch overlap）后也逐值相同；权重在 GPU 计算再转 CPU 拼接，避免跨设备舍入差异。CPU 原生 Euler 对照也逐值比较每步状态，覆盖不同切分、batch_index、软 mask、保留音频、不同高清音频 shift、磁盘恢复；放大器同权重短／长片、batch 1/2、注意力开关均逐值相同。

机器可读结果、实际参数与 Tensor SHA256：`ComfyUI/output/TerryDirector/reports/selflift_avatar_parity_20261103.json`。这是本机相同配置下、VAE 解码之前的音画 LATENT 对照；不扩展为任意硬件／模型或 Avatar 像素 VAE 锚定或 global 实验模式的保证。历史 0.8／2 MP 性能与用户画质验收仍按上方原记录理解。

### 高清直接接宽高（2026-11-03）

分拆采样的 v3 接口改为低清按输入 LATENT 实际尺寸采样（不再使用 lowres_scale），高清接目标 width/height，继承低清时间／音频。示例③④移除独立 EmptyMiniMaxH3LatentAV，参考节点的 LATENT 直连低清，分辨率选择器高清输出直连高清；旧 v1/v2 分拆缓存需要重新生成低清。

同上本机模型栈，124 帧、低清 256×128→高清 512×288、6+2 步、手动 4 块空间分块，最终视频／音频 LATENT 与 Avatar 再次逐值相同，最大误差 0。低清尺寸与参考实现一致是此对照的条件；低清 mask／原图向高清的保留内容按空间缩放定义，不能反推已丢失的高清原图细节。记录：`ComfyUI/output/TerryDirector/reports/selflift_explicit_size_20261103.json`。

### 三份 SelfLift 示例重写（2026-11-03）

仅保留低清、高清、暂停继续三份 SelfLift 示例，移除旧④。按当前控件顺序重建 JSON，种子和整数控件均保留前端固定值选项，浏览器实际导入三份后确认 CFG=1、目标宽高与放大器／分块下拉值无错位。此轮初版使用专用低清审片保存节点；随后改为原生 CreateVideo → SaveVideo，低清视频由预演台按确切执行编号与保存终点关联。继续执行通过部分执行目标排除低清支路。

RTX 3090 小尺寸实机验证：22 帧，低清 256×128、高清 512×288；三条路径均成功，三个 MP4 均可解码画面并包含音轨。暂停继续测试将上游 low_steps 改成不可能执行的 10000，仍从已有缓存成功生成高清，证明该分支没有重跑低清。测试覆盖当前图结构；默认 BF16 模型及 0.8 MP 目标的性能未作为本轮测量。记录：`ComfyUI/output/TerryDirector/reports/selflift_examples_rewrite_20261103.json`。

原生 SaveVideo 支路验收：22 帧低清 256×128、高清 512×288 均成功并含音轨，预演台媒体接口能直接读取原生输出。Windows 子目录分隔符归一化；低清引用在高清提交后保留。高清部分执行只产生暂停节点与高清 SaveVideo 输出，上游 low_steps=10000 未触发。记录：`ComfyUI/output/TerryDirector/reports/native_savevideo_acceptance_20261103.json`。

### 预演台与原生工作流执行等价性（2026-11-03）

RTX 3090、Cobijada H3 Hybrid 精炼 INT8，原生 SamplerCustom / Euler 两段各 2 步、seed=123456、CFG=1、256×128、22 帧。工作流不含 SelfLift 节点；分别实际重采样直接执行及预演台编译的暂停／磁盘恢复继续路径。两段音视频 LATENT 均逐值相同，最大绝对误差 0；原生 SaveVideo 文件解码后的 RGB 帧和 PCM 音轨逐字节相同。另行去掉 taeh3 实时预览模型包装再次执行，LATENT、画面及音轨仍完全相同。此为本机这一原生工作流的对照，不扩展为跨硬件或任意非确定性节点的保证；文件名及 MP4 容器元数据不作为像素一致性的判据。

预演台保留工作流的预览实现、提示词处理、参考素材预处理及秒数转帧数表达式，仅覆盖明确编辑的输入源；任务存档使用实际提交的 API 图。数值哈希与执行编号：`ComfyUI/output/TerryDirector/reports/preview_workflow_parity_20261103.json`。测试缓存已归档到系统临时目录并从任务列表移除。
