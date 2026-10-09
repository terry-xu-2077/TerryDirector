# 稳定版收口清理 · 3 段回归报告

测试提交：`ba991737033f915512fb6dd91e6db982bf6c176b`。

## 结果

| Case | 结果 | 说明 |
|---|---|---|
| A：ComfyUI 启动 | 通过 | TerryDirector 无 import / registration 错误；4 个退休节点均未注册，6 个要求保留的内部节点均已注册 |
| B：Base 3 段 | 通过 | 0.2MP、seed 9；3 个 Segment 日志和 1 个 Final merge；最终 288 帧 / 12 秒，Base 缓存完成后删除 |
| C：Advanced 3 段 | 通过 | 0.2MP、seed 9、preview off；3 个 lossless `.pt` segment，最终只编码一次；输出 608×352、288 帧 / 12 秒 |
| D：Advanced 中断恢复 | 通过 | 第一段后真实 interrupt；checkpoint 与 236.1 MiB lossless 缓存保留；恢复识别 `completed=1/3`，只补 `clip-2`、`clip-3` |

## 清理项确认

- Advanced 完成和恢复完成后 lossless pixel cache 均为 0，LATENT checkpoint 保留。
- Case C、D 均未新增旧 segment MKV。
- Base/Advanced 日志中没有历史 `[Diagnostic]`、`[Perf]`、graph-signature 或旧 Advanced `[Stream]` 日志。
- Case D 恢复后 checkpoint 为 `complete`，包含 `clip-1, clip-2, clip-3`；最终输出为 H.264 + AAC、608×352、288 帧、12.000 秒。
- 没有运行 0.5MP / 50 秒任务或性能 A/B，也没有修改采样参数和产品代码。

## 发现的问题

未发现 TerryDirector 回归问题。ComfyUI 启动日志仍包含其他插件的既有依赖错误：ComfyUI-LTXVideo、ComfyUI-Qwen-TTS 和 was-ns；这些错误与本次 TerryDirector 清理无关。

用户原始工作流未写回，测试前后 SHA-256 均为 `CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7`。
