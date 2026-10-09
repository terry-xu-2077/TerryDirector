# Advanced 分段文件化 / 流式 Assembly 实现与验收

> 状态：已实现，待本地验收  
> 当前代码基线：`a27daf8`  
> 目标：让 Advanced 的内存占用不再随整条时间线累计完整 IMAGE Tensor。

## 1. 为什么改架构

历史 0.5MP / 约 50 秒 / 1194 帧任务曾达到：

```text
merged IMAGE ≈ 7.1 GB
ComfyUI RSS ≈ 44.6 GB
system RAM ≈ 98.3%
```

3 段 A/B 已经说明：

- cumulative cat
- single final cat
- preallocation

没有显示值得继续投入的 RSS 收益。

因此停止继续优化 `torch.cat` 写法，直接改变 Advanced 的媒体生命周期。

Base 不改。

## 2. 新 Advanced 执行链

旧：

```text
segment decode
→ cumulative merged IMAGE/AUDIO
→ ...
→ 整条 merged IMAGE/AUDIO
→ CreateVideo
→ SaveVideo
```

新：

```text
segment sample
→ LATENT checkpoint
→ 在单个内部节点里 decode video/audio
→ 处理本段 trim / gap
→ 立即编码为持久化 segment MKV
→ 只返回下一镜头所需的极小 continuity context
→ 释放完整本段像素 Tensor

所有 segment file
→ file-backed VideoFromList
→ 最终视频流式 remux / audio mux
→ Save
```

片段文件位置：

```text
output/.terrydirector_cache/<node-id>/segments/
```

文件名包含 segment id + 当前尺寸/时长 signature hash。

## 3. continuity 不再要求保留完整上一段

每段 Decode-to-file 后只保留下一段真正需要的上下文：

- independent / gap：不需要上一段完整媒体；
- tail_reference：只保留上一段最后 1 帧；
- tail_continuation：只保留上一段最后 1 帧；
- overlap：只保留 overlap 所需的尾部图像帧和对应音频。

因此 Advanced 不再为了镜头承接把整段 decoded IMAGE 持有到后续时间线。

Base 仍保持原行为和原输出协议。

## 4. 恢复 / 局部重跑

新结构与中断恢复共用 segment file：

- 正常完整生成：每段即时写入 segment file；
- 中断后“导出已完成部分”：优先直接拼接已有 segment file，不重新 sampling；如果某段只完成 LATENT checkpoint、还没来得及生成 segment file，则只补该段 decode/encode；
- “继续生成”：已完成前缀直接复用 segment file；只有为了给第一个未完成片段提供 tail/overlap continuity 时，最多重新 decode 必要的前一段；
- 局部重跑：未重跑片段优先复用 segment file；目标片段重新 sample + 写回自己的 segment file。

## 5. Advanced 与 Base 输出协议正式分开

Base：

```text
segment LATENT list
merged IMAGE
merged AUDIO
```

Advanced：

```text
segment LATENT list
file-backed final video
```

Advanced 不再物化整条 merged IMAGE/AUDIO。

如果把 Advanced 的导演输出接到 `TerryDirector 输出` 节点试图取 merged IMAGE/AUDIO，现在会明确报错，而不是重新把整条视频解码进内存。

## 6. 本地验收：只做两步

不要再做 clone / single-cat / preallocation A/B。

### Step A：3 段快速功能验收

优先 0.2MP，3 个有效片段，preview off。

只确认：

1. 3 段都能正常生成；
2. 日志出现：
   ```text
   [TerryDirector Advanced][Stream] Segment ...
   ```
3. cache/segments 下生成 3 个 MKV；
4. 最终 MP4 正常；
5. tail_reference / tail_continuation / overlap 至少覆盖当前测试工作流实际使用的模式；
6. 中断恢复的“继续生成”和“导出已完成部分”仍正常；
7. Base 节点不受影响。

如果 Step A 有功能错误，直接修代码，不跑长任务。

### Step B：一次 50 秒真实验收

只有 Step A 通过后跑一次。

使用用户原本约 50 秒、0.5MP 的真实时间线。

只记录：

```text
Prompt total
process RSS peak
system RAM peak
最终视频帧数/时长
每个 segment file 大小
```

不再跑旧 cumulative / final-cat / preallocation 做对照。

历史基线已经有：

```text
RSS ≈ 44.6 GB
system RAM ≈ 98.3%
```

这一次只回答：

> 新架构是否让 50 秒任务不再逼近 64GB 系统内存上限。

如果明显下降，即接受架构。

## 7. 不再做的测试

- clone on/off；
- single final cat；
- preallocation；
- 9 段短时反复 A/B；
- 为了几百 MB 差异重复跑 GPU 长任务；
- 把历史随机 sampler 卡顿重新混入本任务。

## 8. 验收报告

如果 Step B 执行，写：

```text
docs/21_ADVANCED_STREAMED_VIDEO_REPORT.md
```

报告只需要：

- 3 段功能结果；
- 50 秒一次真实结果；
- RSS / RAM 与历史 44.6GB / 98.3% 对比；
- 中断恢复是否工作；
- 最终 commit hash。
