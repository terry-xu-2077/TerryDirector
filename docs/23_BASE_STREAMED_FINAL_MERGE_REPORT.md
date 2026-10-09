# Base 分段释放 + 最终低峰值合并验收报告

## 结论

验收通过。Base 在生成阶段逐段写入无损 `.pt`，已完成段不再以完整 IMAGE/AUDIO 常驻内存；9 段完成后释放模型，再一次性合并最终 IMAGE/AUDIO。成功合并后 run 目录及分段缓存已删除。

测试提交：`4ec7d30f7260ffe528727bc74557dcc97eb21704`。本轮没有运行 Advanced。

## Step A：0.2MP 三段功能验收

固定参数为 3 个有效片段、seed 9，输出尺寸 608×352、24 fps。

| 项目 | 结果 |
|---|---:|
| Prompt total | 216.83 s |
| Process RSS peak | 9,759.6 MB |
| System RAM peak | 40.5% |
| Segment cache | 96 + 72 + 120 帧，共 708.3 MiB |
| Final merge | 288 帧，705.4 MiB IMAGE，2.053 s |

三段均输出 `[TerryDirector Base][Stream] Segment ...`，最后输出 `[TerryDirector Base][Stream] Final merge ...`。`TerryDirector 输出` 成功完成分段潜变量、合并画面和合并音频协议；画面为 288 帧，音频逻辑时长为 12.000 s。首段的 `tail_continuation` 因没有前驱按设计跳过，后两段 `tail_reference` 正常执行。成功后 Base `.pt` 文件数为 0。

## Step B：0.5MP / 50 秒 Base

正式结果只采用服务日志确认 `size=960x544 segments=9 seed=9` 的一次运行。

| 项目 | 实测 |
|---|---:|
| Prompt total | 2,029.33 s（33:49.33） |
| Sampling/decode RSS peak | 18,462.6 MB（约 18.03 GiB） |
| System RAM peak | 55.8% |
| Minimum available RAM | 28,853.4 MB |
| Base 临时缓存峰值 | 7,533,075,413 bytes（7,184.1 MiB，约 7.02 GiB） |
| Final merge | 8.557 s |
| 最终 IMAGE | 960×544，1200 帧，7,171.9 MiB logical size |
| 最终 AUDIO | 32 kHz 双声道，1,600,000 samples，50.000 s |

9 段帧数依次为 `96 / 72 / 120 / 144 / 168 / 168 / 144 / 144 / 144`，合计 1200 帧。最终合并日志确认 `frames=1200`，Base 输出链成功完成；结束后分段缓存文件数为 0，run signature 子目录已删除。

## Final merge 峰值

以下为外部监控以 0.25 秒间隔记录的完整 9 文件缓存首次稳定快照，以及缓存删除后的首个快照：

| 阶段 | RSS | System RAM | CUDA free | Torch allocated |
|---|---:|---:|---:|---:|
| Final merge 前 | 16,654.5 MB | 52.3% | 9,072.7 MB | 23.3 MB |
| Final merge 后 | 14,864.4 MB | 49.4% | 23,190.3 MB | 17.7 MB |

Final merge 区间 RSS 峰值为 16,654.5 MB，低于 sampling/decode 阶段的 18,462.6 MB。完整 IMAGE/AUDIO 的一次性成本只出现在最终合并阶段；生成阶段 RSS 随当前片段采样和解码波动，没有按已完成片段数量持续累积。

用户原始工作流未写回，测试前后 SHA-256 均为 `CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7`。
