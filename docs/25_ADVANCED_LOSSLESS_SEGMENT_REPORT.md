# Advanced 无损分段缓存 + 单次最终编码验收报告

## 结论

验收通过。Advanced 在分段阶段只生成无损 `.pt` 缓存，日志中没有旧的 `[Stream] Segment ... .mkv` 路径；全部片段完成后只出现一次 `Final encode`。完整任务结束后对应 `run_signature` 目录已删除，LATENT checkpoint 保留。

测试提交：`d1cf6110d222c210a677d6075e6f2c11560db3c4`。

## Step A：0.2MP 三段功能验收

固定参数为 3 个有效片段、seed 9、preview off，输出 608×352、24 fps。

| 项目 | 结果 |
|---|---:|
| Prompt total | 207.22 s |
| Process RSS peak | 9,350.9 MB |
| System RAM peak | 41.8% |
| lossless cache 峰值 | 742,717,767 bytes（708.3 MiB） |
| Final encode | 2.487 s |
| 最终视频 | 288 帧，12.000 s，H.264 + AAC |

三段均输出 `[TerryDirector Advanced][Lossless] Segment ...`，运行中缓存位于 `output/.terrydirector_cache/328/lossless/e487356e623301c5/*.pt`。最终输出 `TerryDirector_00050_.mp4` 正常，完成后该 run 目录及其中 `.pt` 均已删除，LATENT checkpoint 仍保留。旧 `[TerryDirector Advanced][Stream]` 日志数量为 0。

## 中断恢复

第一段无损缓存落盘后调用 ComfyUI interrupt，checkpoint 精确记录 `completed_segment_ids=["clip-1"]`，并保留 247,572,589 bytes（236.1 MiB）的 `clip-1` 无损缓存。

| 动作 | Prompt total | 结果 |
|---|---:|---|
| 导出已完成部分 | 2.03 s | 未重新 sampling；直接最终编码为 96 帧、4.000 s，缓存继续保留 |
| 继续生成 | 139.05 s | 日志显示 `completed=1/3`，只生成 `clip-2`、`clip-3`；输出 288 帧、12.000 s |

完整恢复的 Final encode 为 2.416 s。恢复成功后 lossless 文件数为 0，9 个现有 LATENT checkpoint 仍保留。

## Step B：0.5MP / 50 秒真实验收

本轮只运行一次 9 段真实 Advanced；输入为 960×544、seed 9、preview off，时间线终点 frame 1200。

| 项目 | 实测 |
|---|---:|
| Prompt total | 2,012.94 s（33:32.94） |
| Process RSS peak | 18,725.9 MB（约 18.29 GiB） |
| System RAM peak | 56.9% |
| Minimum available RAM | 28,166.3 MB |
| lossless cache 临时磁盘峰值 | 7,533,075,413 bytes（7,184.1 MiB，约 7.02 GiB） |
| Final encode | 20.949 s |
| 最终视频 | 960×544，1200 帧，50.000 s，24 fps |
| ffprobe video/audio | H.264；AAC 32 kHz 双声道 |
| 最终文件 | `output/video/TerryDirector_00052_.mp4`，23,472,882 bytes |

9 段全部输出 Lossless Segment 日志，旧 Stream Segment 日志数量为 0。最终编码后 `lossless/6966e230b265ac73` 已删除，lossless 文件和子目录数量均为 0；LATENT checkpoint 保留。

## 与历史 streamed 基线对比

| 指标 | H.264 segment 基线 | Lossless segment | 变化 |
|---|---:|---:|---:|
| Prompt total | 34:52.87 | 33:32.94 | 减少 79.93 s（约 3.8%） |
| Process RSS peak | 18,517.0 MB（约 18.1 GiB） | 18,725.9 MB（约 18.29 GiB） | 增加 208.9 MB（约 1.1%） |
| System RAM peak | 56.4% | 56.9% | 增加 0.5 个百分点 |
| 中间缓存 | H.264 MKV | float32 IMAGE + 原始 AUDIO `.pt` | 无中间有损编码 |

移除中间有损编码后，RSS 与系统 RAM 仍保持在原 streamed 架构的同一范围，Prompt 时间略有下降。运行日志证明 9 段使用无损缓存，最终视频和音频只进行一次有损编码。

用户原始工作流未写回，测试前后 SHA-256 保持为 `CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7`。
