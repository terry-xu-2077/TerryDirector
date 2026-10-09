# Base 分段释放 + 最终低峰值合并验收

> 状态：待本地验收  
> 当前代码基线：`8f800d2`  
> 目标：Base 保持原“分段潜变量 / 合并画面 / 合并音频”输出协议，但生成阶段不再累计整条 IMAGE/AUDIO。

## 新执行链

```text
每段 Sample
→ 单段 VAE Decode
→ 按原规则 trim / gap
→ 无损写入临时 .pt
→ 只保留下一镜头需要的尾帧 / overlap 上下文
→ 释放完整单段画面

所有片段完成
→ unload_all_models()
→ soft_empty_cache()
→ 一次性预分配最终 IMAGE / AUDIO
→ 逐段读取 .pt → copy 到最终 Tensor → 释放当前段
→ TerryDirectorPackOutput
```

Base 中间缓存是 **float32 无损 Tensor**，不是 H.264/MKV，因此不改变 Base 原始 IMAGE/AUDIO 质量语义。

成功完成最终合并后，Base 临时分段缓存立即删除。

## Step A：只跑一次 3 段快速验收

优先 0.2MP / 3 个有效片段 / preview 无关 / seed 9。

确认：

1. 三段都生成成功；
2. 日志每段出现：
   ```text
   [TerryDirector Base][Stream] Segment ...
   ```
3. 最后出现：
   ```text
   [TerryDirector Base][Stream] Final merge ...
   ```
4. `TerryDirector 输出` 正常得到：
   - 分段潜变量
   - 合并画面
   - 合并音频
5. 最终 frame count / audio duration 与时间线一致；
6. tail_reference / tail_continuation 按当前工作流实际模式正常；
7. Advanced 不受影响。

如果 Step A 失败，直接修功能，不跑长任务。

## Step B：只跑一次约 50 秒 Base

只有 Step A 通过后才执行一次 0.5MP / 约 50 秒。

只记录：

- Prompt total；
- sampling/decode 阶段 RSS peak；
- Final merge 前后 RSS；
- Final merge 前后 CUDA free / torch allocated；
- system RAM peak；
- 最终 IMAGE logical size；
- 最终帧数 / 音频时长。

历史旧 Base 长任务曾出现随累计 IMAGE 增长的高内存压力。本次只需要确认：

> 生成阶段不再随已完成片段持续累积；最终只在 Final merge 阶段出现完整 IMAGE/AUDIO 的一次性成本。

不要再跑 cumulative / final-cat / preallocation A/B。

## 验收报告

如执行 Step B，写：

```text
docs/23_BASE_STREAMED_FINAL_MERGE_REPORT.md
```

报告保持简短，只写：

- 3 段功能结果；
- 50 秒一次结果；
- Final merge 峰值；
- 最终输出正确性；
- 最终 commit hash。
