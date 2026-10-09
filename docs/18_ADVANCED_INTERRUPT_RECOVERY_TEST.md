# Advanced 中断恢复与已完成片段导出测试任务

> 状态：待本地测试  
> 当前代码基线：`e4689ba`  
> 目标：验证 Advanced 在任务中途终止后，已经完成采样的片段不会丢失，并支持“继续生成”和“导出已完成部分”。

---

## 1. 功能语义

本轮实现后，Advanced 不再等整条任务结束才保存 LATENT。

每个片段采样完成后立即：

```text
sample 完成
→ TerryDirectorCacheLatent
→ 保存 clip-N.pt
→ 更新 checkpoint.json
→ 再继续 decode / assemble
```

因此即使后续任务被用户终止，已经 checkpoint 的片段仍保留。

中断后 UI 应显示：

```text
已保留 N / 总片段数 段
[继续生成]
[导出已完成部分]
```

---

## 2. 测试规模

不要跑 9 段。

统一：

```text
3 个有效片段
preview off
seed=9
0.2MP 优先
```

如需确认更接近正式负载，可额外跑一次 0.5MP / 3 段，但不是必须。

---

## 3. Case A：中断后 checkpoint 保留

1. 启动 Advanced 3 段任务。
2. 等 clip 1、clip 2 已经完成采样/checkpoint。
3. clip 3 开始后立即终止任务。
4. 检查：

```text
ComfyUI/output/.terrydirector_cache/<node-id>/
```

应至少存在：

```text
clip-1.pt
clip-2.pt
checkpoint.json
```

checkpoint 应包含：

```json
{
  "status": "partial",
  "completed_segment_ids": ["clip-1", "clip-2"],
  "run_seed": 9
}
```

UI 应恢复：

```text
clip 1 ✓
clip 2 ✓
clip 3 未完成
已保留 2/3 段
```

### 通过标准

- clip 1/2 不因 interrupt 丢失；
- 不需要整条任务走到 AdvancedFinish；
- 中断后可以重新打开工作流仍看到可恢复状态。

---

## 4. Case B：继续生成

在 Case A 后直接点：

```text
继续生成
```

预期：

```text
clip 1 → TerryDirectorLoadCachedLatent
clip 2 → TerryDirectorLoadCachedLatent
clip 3 → 正常 H3 sampler
```

检查日志：

- clip 1/2 不应再次出现 H3 sampler 进度；
- clip 3 正常采样；
- 原任务 seed 自动恢复为 checkpoint 中的 seed；
- 最终正常保存完整视频；
- checkpoint 状态变为 `complete`；
- 最终 UI 三段全部 completed；
- 本地重跑缓存仍正常可用。

---

## 5. Case C：导出已完成部分

重新制造一次 2/3 段中断状态，然后点：

```text
导出已完成部分
```

预期：

- 不进行任何新的 H3 sampling；
- 只加载 clip 1 / clip 2 LATENT；
- VAE decode；
- 按原时间线 continuity / trim / gap 规则拼接；
- 保存 partial 视频；
- 文件名前缀追加 `_partial`；
- checkpoint 仍保持 `partial`；
- UI 仍显示“已保留 2/3 段”；
- 顶部可以播放导出的 partial 视频。

检查：

```text
checkpoint.json
```

应增加：

```json
{
  "partial_video": {
    "filename": "...",
    "subfolder": "...",
    "type": "output"
  }
}
```

---

## 6. Case D：时间线改变后禁止错误复用

制造中断 checkpoint 后，修改任一项：

- prompt；
- 分辨率；
- 片段时长；
- 有效片段结构。

再尝试“继续生成”。

预期应拒绝，并提示当前时间线/生成参数已经变化，不能复用旧 checkpoint。

不得静默把旧 LATENT 拼到新任务中。

---

## 7. Case E：seed 恢复

1. 原始任务 seed=9。
2. 中断后将 UI seed 手动改成其他值。
3. 点“继续生成”。

预期：

- UI 在提交恢复任务前自动恢复 seed=9；
- backend 也使用 checkpoint 的原始 seed；
- 不因 control-after-generate 或用户改动导致后半段换 seed。

---

## 8. Case F：挂起片段兼容

测试：

```text
clip 1 有效
clip 2 挂起
clip 3 有效
clip 4 有效
```

确认执行链为：

```text
clip 1 → clip 3 → clip 4
```

挂起 clip 2：

- 不生成；
- 不补黑帧；
- 不占 checkpoint；
- clip 3 自动承接 clip 1；
- 中断恢复的 completed_segment_ids 只记录有效片段。

---

## 9. 性能观察

记录每个 checkpoint：

```text
cpu copy seconds
disk seconds
size MB
```

预期仍为毫秒级 / 数 MB 级。

如果 per-segment checkpoint 明显改变 sampler 性能，再单独报告，不要直接回滚整个恢复功能。

---

## 10. 测试报告

完成后创建：

```text
docs/19_ADVANCED_INTERRUPT_RECOVERY_REPORT.md
```

至少记录：

- 中断发生在哪一段；
- checkpoint 中保留了哪些片段；
- Continue 是否跳过已完成 sampler；
- Partial Export 是否完全无 sampler；
- partial video 是否正确；
- seed 是否恢复；
- workflow reload 后恢复状态是否仍存在；
- 挂起片段兼容；
- checkpoint 写盘耗时；
- 发现的 bug；
- 最终 commit hash。
