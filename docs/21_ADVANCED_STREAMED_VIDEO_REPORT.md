# Advanced 分段文件化 / 流式 Assembly 验收报告

## 结论

验收通过。

Advanced streamed video 架构在原始 0.5MP、9 段、1200 帧真实时间线中，将 ComfyUI 进程 RSS 峰值从历史约 44.6 GB 降到 18,517 MB（约 18.1 GiB），约下降 59%；系统 RAM 峰值从 98.3% 降到 56.4%，下降 41.9 个百分点。运行期间 RSS 随单段采样/解码波动，没有随着整条时间线的已完成帧数持续累积。

测试提交：`a851904d5d039dbf8908699a5db136f5f079017c`。

## 环境与约束

- ComfyUI 0.39.0，RTX 3090，64 GiB system RAM。
- 启动参数保持原配置：`--listen 127.0.0.1 --port 8188 --enable-manager --use-sage-attention`。
- 模型、VAE、sampler、sigmas、seed 9 和 preview off 均保持原工作流设置。
- 用户原始工作流未写回；测试前后 SHA-256 均为 `CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7`。
- Step B 只执行一次，没有重跑旧 cumulative / final-cat / preallocation A/B。

## Step A：0.2MP 三段功能验收

### 完整 Advanced

| 项目 | 结果 |
|---|---:|
| Prompt total | 204.16 s |
| Process RSS peak | 8,984.3 MB |
| System RAM peak | 39.3% |
| Segment files | 3 个 MKV |
| 最终视频 | `TerryDirector_00046_.mp4` |
| 视频 metadata | 608×352，288 帧，11.996 s |

日志对每一段都输出了 `[TerryDirector Advanced][Stream] Segment ...`，并在 `output/.terrydirector_cache/328/segments/` 生成对应 MKV。

原始三段实际执行了第二、三段的 `tail_reference` continuity。第一段虽然在配置中写有 `tail_continuation`，但它没有前驱，因此该字段在第一段不会进入 continuity 分支。为完整覆盖该模式，额外在测试请求副本中把第二段设为 `tail_continuation`；该 0.2MP 三段运行成功，Prompt total 198.70 s，最终同为 608×352、288 帧、11.996 s。用户工作流没有修改。当前工作流没有 overlap 段，因此未增加虚构的 overlap 用例。

### Base 回归

Base 0.2MP 三段运行成功：

| 项目 | 结果 |
|---|---:|
| Prompt total | 199.36 s |
| Process RSS peak | 11,650.4 MB |
| System RAM peak | 43.7% |
| 结果 | 成功完成 288 帧原 merged IMAGE/AUDIO 路径 |

Base 仍使用原 `TerryDirectorAssembleMedia` 与 `TerryDirectorPackOutput` 协议。streamed Advanced 没有改变 Base 输出路径。

### 中断恢复

执行了真实中断，不是手工修改 checkpoint：

1. 重启 ComfyUI 清空执行缓存，重新提交 0.2MP 三段 Advanced。
2. 第一段 MKV 落盘后调用 ComfyUI interrupt。
3. checkpoint 状态为 `partial`，且 `completed_segment_ids` 精确为 `["clip-1"]`。
4. “导出已完成部分”成功，直接复用已有 segment file。
5. “继续生成”识别 `completed=1/3`，只补剩余两段，最终 checkpoint 为 `complete`。

| 恢复动作 | Prompt total | RSS peak | RAM peak | 输出 |
|---|---:|---:|---:|---|
| 导出已完成部分 | 0.24 s | 8,061.7 MB | 38.3% | `TerryDirector_partial_00001_.mp4`，96 帧，3.998 s |
| 继续生成 | 147.29 s | 8,566.5 MB | 38.9% | `TerryDirector_00047_.mp4`，288 帧，11.996 s |

中断瞬间外部监控脚本的一次 history 请求收到本地 API 502；ComfyUI 队列随即正常清空，checkpoint 和后续两种恢复均成功，因此该 502 属于中断窗口的监控请求，不是恢复功能失败。

## Step B：0.5MP / 50 秒真实验收

输入为用户原始 9 段时间线：0.5MP、960×544、seed 9、preview off，时间线终点 frame 1200。

| 项目 | 实测 |
|---|---:|
| Prompt total | 2,092.87 s（34:52.87） |
| Process RSS peak | 18,517.0 MB（约 18.1 GiB） |
| System RAM peak | 56.4% |
| Minimum available RAM | 28,450.3 MB |
| 最终帧数 | 1200 |
| 最终时长 | 49.991 s |
| 最终分辨率 | 960×544 |
| 最终文件 | `output/video/TerryDirector_00048_.mp4` |
| 最终文件大小 | 23,379,350 bytes |

`ffprobe` 确认最终 MP4 包含：

- H.264 video，960×544，24 fps；
- AAC audio，32 kHz，双声道；
- container duration 49.991 s。

### Segment files

| Segment | Frames | MKV | Size |
|---|---:|---|---:|
| clip-1 | 96 | `clip-1_1aba795c8540.mkv` | 1.39 MiB |
| clip-2 | 72 | `clip-2_cd255c1dda92.mkv` | 1.34 MiB |
| clip-3 | 120 | `clip-3_5fc35014bcbd.mkv` | 1.86 MiB |
| clip-4 | 144 | `clip-4_4b5df3100465.mkv` | 3.39 MiB |
| clip-5 | 168 | `clip-5_8826a4e8a22b.mkv` | 3.78 MiB |
| clip-6 | 168 | `clip-6_8826a4e8a22b.mkv` | 3.01 MiB |
| clip-7 | 144 | `clip-7_4b5df3100465.mkv` | 2.68 MiB |
| clip-8 | 144 | `clip-8_4b5df3100465.mkv` | 2.48 MiB |
| clip-9 | 144 | `clip-9_4b5df3100465.mkv` | 2.32 MiB |

所有九段均在 segment 日志后进入 checkpoint；最终 checkpoint 包含全部九个 segment id，状态为 `complete`。

## 与历史基线对比

| 指标 | 历史 merged IMAGE 架构 | Streamed Advanced | 变化 |
|---|---:|---:|---:|
| Process RSS peak | 约 44.6 GB | 18,517 MB（约 18.1 GiB） | 约下降 59% |
| System RAM peak | 98.3% | 56.4% | 下降 41.9 个百分点 |
| 最终完整 IMAGE 常驻 | 是 | 否 | 已移除 |
| 中断恢复 segment file 复用 | 无 | 正常 | 通过 |

新架构已经让 50 秒任务不再逼近 64 GB 系统内存上限，且 Base、部分导出、继续生成和最终音视频输出均正常，因此接受该架构。

## 附加测试说明

现有 Python 单元测试中 18 项通过；另 1 个测试模块在独立 unittest 入口导入插件时，因为 `PromptServer.instance` 尚未由 ComfyUI 创建而无法收集。真实 ComfyUI 启动后 streamed 内部节点均成功注册，所有本报告中的真实队列测试均通过，未因该测试入口问题修改产品代码。
