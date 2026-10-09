# Advanced 无损分段缓存 + 单次最终编码验收

> 状态：待本地验收  
> 当前代码基线：`380f965` 之后的最新 HEAD  
> 目标：确认 Advanced 不再使用 H.264/AV1 作为中间 segment cache，同时保留已验证的低内存优势。

## 新链路

```text
H3 Sample
→ LATENT checkpoint
→ 单段 VAE Decode
→ float32 IMAGE + 原始 AUDIO 无损 .pt 缓存
→ 只保留下一镜头需要的尾帧 / overlap context
→ 释放完整单段画面

所有片段完成
→ 逐段读取无损 .pt
→ 同一个视频 encoder session 连续编码全部帧
→ AUDIO 最终只编码一次
→ 最终 MP4 / MKV / WebM
→ 成功后删除多 GB 无损 pixel cache
→ 保留 LATENT checkpoint
```

这意味着：

- 中间没有 H.264/AV1 视频压缩；
- 最终视频只发生一次有损编码；
- 音频也只在最终输出时编码一次；
- continuity 继续使用原始 VAE Decode Tensor；
- 最终编码时不创建整条 merged IMAGE Tensor。

## Step A：3 段快速验收

只跑一次 0.2MP / 3 个有效片段 / seed 9 / preview off。

确认：

1. 每段日志出现：
   ```text
   [TerryDirector Advanced][Lossless] Segment ...
   ```
2. 不再出现：
   ```text
   [TerryDirector Advanced][Stream] Segment ... .mkv
   ```
3. 运行中缓存目录为：
   ```text
   output/.terrydirector_cache/<node-id>/lossless/<run_signature>/*.pt
   ```
4. 最终日志出现：
   ```text
   [TerryDirector Advanced][Lossless] Final encode ...
   ```
5. 最终 MP4 正常播放；
6. 最终完成后 lossless pixel cache 已删除；
7. LATENT checkpoint 仍保留，可继续做局部重跑。

### 中断恢复

同样只用 3 段：

- 第一段完成后真实 interrupt；
- lossless segment .pt 应保留；
- “导出已完成部分”直接从 lossless cache 最终编码，不重新 sampling；
- “继续生成”复用已完成 LATENT / lossless cache，只补后续 sampling；
- partial export 后 lossless cache 不删除；
- 完整恢复成功后才删除 lossless pixel cache。

如果 Step A 有任何错误，直接修代码，不跑长任务。

## Step B：一次 50 秒真实验收

仅 Step A 通过后执行一次 0.5MP / 约 50 秒真实 Advanced。

只记录：

- Prompt total；
- Process RSS peak；
- System RAM peak；
- lossless cache 临时磁盘峰值；
- Final encode 时间；
- 最终帧数 / 时长 / 分辨率；
- ffprobe video/audio codec。

历史 file-backed H.264 segment 版基线：

```text
RSS peak ≈ 18.1 GiB
System RAM peak = 56.4%
Prompt total = 34:52.87
```

本轮只确认：

> 去掉中间有损编码以后，内存仍保持在可接受范围，同时最终视频/音频只经历一次有损编码。

不要重跑旧 cumulative / final-cat / preallocation。

## 报告

如 Step B 完成，写：

```text
docs/25_ADVANCED_LOSSLESS_SEGMENT_REPORT.md
```

报告保持简短，只包含：

- 3 段功能结果；
- 中断恢复结果；
- 50 秒一次结果；
- 与 18.1 GiB / 56.4% 历史 streamed 基线的对比；
- 最终 commit hash。
