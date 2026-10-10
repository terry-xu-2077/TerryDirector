# cu130 9 段 / 50 秒 / 不二采复测

## 结论

本轮在独立 8190 实例用 `d1cf6110d222c210a677d6075e6f2c11560db3c4` 稳定源码完成了一次完整九段任务。history 状态为 `success`，9 段均完成，最终视频通过完整音视频解码。

| 指标 | 报告25 Step B | 本轮 cu130 |
|---|---:|---:|
| Prompt 总耗时 | 2012.94 秒 | 1106.336 秒（18:26.336）|
| 减少 | — | 906.604 秒 / **45.0388%** |
| 速度倍数 | — | **1.8195×** |
| 最终编码 | 20.949 秒 | 21.284 秒（多 0.335 秒，约 1.60%）|
| 输出 | 960×544，24fps，1200 帧，50 秒 | 960×544，24fps，1200 帧，50 秒 |

收益是本次同稳定源码、同工作流内容的跨环境观测值；报告25的依赖版本、冷热状态和后台负载没有完整记录，不能把 45.0388% 精确归因于 CUDA/cu130。请求未启用 Sol，因此不包含 Sol 收益。

## 输入与隔离

- 任务分支：`feat/selflift-internal`，本轮提交 `7890a1cdb957aa1fc3d23ab93b6825669761baf4`，包含指定提交 `7890a1c`。没有合并 `main`。
- 被测源码：独立 detached worktree，提交 `d1cf6110d222c210a677d6075e6f2c11560db3c4`；没有回滚当前工作目录。
- 报告25没有保存可重放的原始 API payload。本轮按任务文档使用与报告25原工作流 SHA-256 一致的本机 `Terry导演台.json` 建立了新的私有测试副本，不称为字节级 payload 重放。
- 原工作流 SHA-256：`CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7`。测试副本 SHA-256：`DA4617B150FBDCE0D242224EB1091539F24375536178FCDCC3E90877A81D1357`。逐字段比较确认唯一工作流差异是本轮要求的 `megapixels: 0.2 → 0.5`；提示词、7 项资产、各段配置和连接未变。
- 九段均为活动段，时间线 `0–1200` 帧，24fps；Seed 9；960×544；预览关闭。二采设置为“无”，未接入 upscaler。活动 MODEL 链为原 UNET → 原 LoRA（强度 1）→ `PathchSageAttentionKJ(auto, allow_compile=false)` → 导演配置；没有 Sol 节点或 Sol MODEL 链。
- 实际模型文件保持原值：UNET `minimax_h3_ref2va_pruned_int8_convrot.safetensors`；LoRA `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`（强度 1）；CLIP `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`；视频 VAE `minimax_h3_video_vae_int8_convrot.safetensors`；音频 VAE `minimax_h3_audio_vae_fp32.safetensors`。普通采样为 `res_multistep` / `simple`、4 步、denoise 1.0；参考尺寸 `match`。
- 生成 API 图只包含 Advanced 节点及其 7 个依赖节点；工作流中原有禁用的 Basic/SaveVideo 支路没有提交执行。8190 注册表仅使用稳定版 TerryDirector 与原 KJNodes，没有 `TerryAccelLab*` 节点。Comfy Kitchen CUDA 后端在该环境报告具备 `sol_attn` capability，但本轮请求没有选择或调用它。
- 原工作流文件和正式 8188 服务未改动、未重启；提交前隔离检查通过，生产文件相对冻结基线 `0c82cd7bfb2de963304479eda86e02513e106da0` 未变。旧 `.venv_cu128_backup_20261010_144207` 未触碰，未升级依赖。

## 环境

| 项目 | 实际运行环境 |
|---|---|
| Python / PyTorch / CUDA runtime | 3.12.13 / 2.11.0+cu130 / 13.0 |
| ComfyUI | 0.39.0，提交 `b26625f23a888367b92153b28d93e159e83e677b` |
| KJNodes | `3f20054214fec9f9234fd3841ae6f1e4287948f6` |
| comfy-kitchen | 0.2.37 |
| SageAttention | `2.2.0+cu130torch2.10.0andhigher.post5`；启动参数 `--use-sage-attention`，请求节点 `auto` |
| GPU | RTX 3090，驱动 591.74，24,576 MiB |

8190 进程 PID `20772` 的启动日志记录了 cu130、`Using sage attention`，且从隔离 junction 导入 `stable_d1cf611_source`。运行完成后只停止了该实验进程；8190 监听已消失，8188 队列仍为空。

## 分段与运行日志

时间范围来自同一 Advanced 配置。所有段均使用全局提示词并保留原承接模式。表中 “Lossless Segment” 数值是程序原始日志字段，不与 Prompt 总耗时重复相加。

| 段 | 帧范围 | 帧数 | 承接 | checkpoint 大小 | Lossless Segment 日志：cache / time |
|---|---:|---:|---|---:|---:|
| clip-1 | 0–96 | 96 | tail_continuation | 6,314,501 B | 574.7 MB / 8.981 s |
| clip-2 | 96–168 | 72 | tail_reference | 4,341,765 B | 431.0 MB / 6.386 s |
| clip-3 | 168–288 | 120 | tail_reference | 7,301,125 B | 718.4 MB / 10.039 s |
| clip-4 | 288–432 | 144 | tail_reference | 9,273,861 B | 862.1 MB / 12.418 s |
| clip-5 | 432–600 | 168 | tail_reference | 10,260,485 B | 1005.8 MB / 13.771 s |
| clip-6 | 600–768 | 168 | tail_reference | 10,260,485 B | 1005.8 MB / 13.789 s |
| clip-7 | 768–912 | 144 | tail_reference | 9,273,861 B | 862.1 MB / 12.492 s |
| clip-8 | 912–1056 | 144 | tail_reference | 9,273,861 B | 862.1 MB / 12.483 s |
| clip-9 | 1056–1200 | 144 | tail_reference | 9,273,861 B | 862.1 MB / 12.486 s |

ComfyUI `/history` 的原始事件为：`execution_start=1791621459590 ms`（2026-10-10 16:37:39.590 +08:00），`execution_success=1791622565926 ms`（16:56:05.926 +08:00），差值 **1106.336 秒**。响应 `prompt_id=25572e77-ff47-4d02-aa27-f4412150b67d`，`number=0`，`node_errors={}`。stdout 另记 `Prompt executed in 00:18:26`，以及 `Final encode: frames=1200 time=21.284s`。

报告25给出的 2012.94 秒作为规定的比较分母。已有报告25历史摘要的 `execution_start → execution_success` 差值为 2011.110 秒，与报告的 Prompt total 相差 1.830 秒；本报告按任务指定使用 2012.94 秒计算百分比和速度倍数。

### 外部资源采样

- 对独立 ComfyUI PID 使用约 10 秒间隔采样：观察到 RSS 峰值 11,618,287,616 B（11,080.1 MiB），整卡显存峰值 23,826 / 24,576 MiB，GPU 利用率采样峰值 100%。
- Windows `\Memory\Available MBytes` 采样观察到系统内存使用峰值 52.92%（可用内存最低 30,732 MB）。这两项分别与报告25的 RSS 18,725.9 MB、系统 RAM 56.9% 同列供参考；报告25环境与采样背景不完整，单位/采样覆盖也不完全一致。
- 从本次运行目录递归采样到的文件总量峰值为 7,608,649,878 B；成功完成并清理无损像素缓存后，目录总量约 99,457,296 B，保留 9 个 `.pt` checkpoint、状态文件及最终视频。该目录采样约从任务开始 79 秒后启动，RAM 采样约从开始 2 分 14 秒后启动，因此这里是采样窗口观察值，不宣称覆盖启动瞬间绝对峰值。

## 输出与验收

- 视频：`G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\TerryDirector\experiments\acceleration_lab\local\runs\cu130_9clip_50s_20261010_162752\runtime\output\video\TerryDirector_00001_.mp4`
- 大小：23,882,424 B；SHA-256：`BA56CCFA089EF2CD0B4D8E1B93D185A7DBFB3C35AFA316B4A2B3CB57BEA7302F`。
- History metadata：960×544，24fps，1200 帧，50.000 秒。FFmpeg 识别为 H.264 High / AAC-LC、32 kHz 双声道；全片音视频解码退出码为 0，stderr 无错误。
- 九个 LATENT checkpoint 均保留在本机隔离输出目录 `runtime\output\.terrydirector_cache\328\clip-1.pt` 至 `clip-9.pt`。任务结束后大型无损像素缓存已清理。
- **画面质量、8 处片段边界、声音内容与音画同步：待人工确认。**本轮只做了容器/编码信息和完整解码核验，未实际听看。

## 本机原始证据

完整私人请求、工作流副本、提交响应、history 与原始日志保留在：

`G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\TerryDirector\experiments\acceleration_lab\local\runs\cu130_9clip_50s_20261010_162752\`

包括 `request.json`、`submit_response.json`、`history.json`、`lab_stdout.log`、`lab_stderr.log`、`monitor_corrected.csv`、`ram_monitor.csv`、`ffmpeg_info.txt` 和 `ffmpeg_full_decode.log`。完整私人工作流、提示词、模型与素材没有加入提交。
