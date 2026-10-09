# 稳定版收口清理 · 3 段回归

> 状态：待本地 Codex 执行  
> 当前目标：只确认代码清理没有破坏 Base / Advanced，不再做长任务或性能 A/B。

## 本轮已清理

- 删除旧 Advanced H.264/AV1 segment MKV 内部节点；
- 删除旧 `TerryDirectorAdvancedFinish`；
- 删除旧 file-backed segment helper；
- 保留 `TerryDirectorAssembleMedia`，仅作为 Base 兼容路径；
- 删除 Base/Advanced graph signature 对比与磁盘 diagnostic snapshot；
- 删除历史 `[Diagnostic]` / `[Perf]` 生产日志；
- 保留真正有产品意义的：
  - Base 无损分段缓存；
  - Base Final merge；
  - Advanced LATENT checkpoint；
  - Advanced 无损 pixel cache；
  - Advanced 单次最终编码；
  - 中断恢复 / partial export；
  - preview 状态。

## 只做 0.2MP / 3 段

不要跑 0.5MP / 50 秒。

### Case A：ComfyUI 启动

重启 ComfyUI，确认：

- 插件无 import / node registration 报错；
- 不再注册以下退休内部节点：
  - `TerryDirectorAdvancedFinish`
  - `TerryDirectorDecodeSegmentToFile`
  - `TerryDirectorLoadSegmentVideo`
  - `TerryDirectorConcatSegmentVideos`
- 仍注册：
  - `TerryDirectorAssembleMedia`（兼容保留）
  - `TerryDirectorDecodeSegmentToCache`
  - `TerryDirectorMaterializeTimeline`
  - `TerryDirectorDecodeAdvancedSegmentToCache`
  - `TerryDirectorLoadAdvancedSegmentContext`
  - `TerryDirectorAdvancedLosslessFinish`

### Case B：Base 3 段

0.2MP / 3 个有效片段 / seed 9。

确认：

- 3 段正常完成；
- `TerryDirector 输出` 正常得到：
  - 分段潜变量
  - 合并画面
  - 合并音频
- 最终 288 帧 / 12 秒；
- 日志出现 Base Segment / Final merge；
- 不出现历史 graph-signature diagnostic / Assemble checkpoint perf 日志。

### Case C：Advanced 3 段

同样 0.2MP / 3 段 / seed 9 / preview off。

确认：

- 3 段正常生成；
- 使用 lossless `.pt` segment cache；
- 最终只编码一次；
- 最终 288 帧 / 12 秒；
- lossless pixel cache 完成后删除；
- LATENT checkpoint 保留；
- 不生成旧 segment MKV；
- 不出现历史 `[Diagnostic]` / `[Perf]` 日志。

### Case D：一次短中断恢复

只做 Advanced：

1. 第一段完成后 interrupt；
2. 确认 checkpoint 与 lossless 第一段缓存保留；
3. 点“继续生成”；
4. 确认只补后两段并最终完成。

不需要再测 partial export，本功能已在上一轮通过，本轮只确认 run_signature 清理没有破坏恢复身份。

## 通过标准

以上全部通过即可结束。

不要：
- 跑 50 秒；
- 重做任何性能 A/B；
- 修改采样参数；
- 顺手做新功能。

如需报告，只写一份很短的：

```text
docs/27_POST_STABILIZATION_CLEANUP_REPORT.md
```

记录 Case A-D 是否通过、发现的问题和最终 commit hash。
