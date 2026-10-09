# TerryDirector Assembly 内存优化任务

> 状态：待执行  
> 建议执行者：本地 Codex  
> 当前代码基线：`24a3afc607d2005d6ff9ab17fd2864f97610b591`  
> 性能诊断背景：
> - `13_ADVANCED_PERFORMANCE_DIAG_REPORT.md`
> - `15_ADVANCED_REAL_QUEUE_EQUIVALENCE_REPORT.md`

---

## 1. 任务目标

本任务只处理一个已经被反复实测确认的结构性问题：

> **TerryDirector 多片段时间线在最终 IMAGE/AUDIO assembly 过程中占用大量系统内存。**

当前 0.5MP / 960×544 / 约 50 秒 / 9 段测试中，最终合并阶段达到：

```text
frames=1194
images≈7136 MB
process RSS≈44647 MB
system RAM≈98.3%
RAM free≈1080 MB
```

机器为 64GB RAM。

这意味着即使历史 Advanced sampler 随机卡顿与此没有被证明存在直接因果关系，**assembly 本身已经是确定的生产风险**。

---

## 2. 不要把本任务和历史 Advanced 随机卡顿混在一起

之前历史问题表现为：

```text
正常 sampler
→ 某一片段突然几百秒/step
→ 后续可能恢复正常
→ 再次极慢
```

最近多轮严格 A/B 已确认：

- Base / Advanced 相同输入时 H3 核心图一致；
- cache_key 不是稳定触发条件；
- cache 写盘只有约 0.1 秒；
- video save 不是灾难性 sampler 慢的稳定来源；
- UI queue 与 exact API replay sampler 性能一致；
- 真实 UI 9 段任务已正常完成约 37～38 分钟。

所以本任务的成功标准不是“修复历史随机 sampler 卡顿”。

本任务只关注：

> **降低 timeline assembly 的 CPU 内存峰值和无意义的数据复制。**

---

# 3. 当前实现

核心代码：

```text
director_internal.py
TerryDirectorAssembleMedia
```

当前每个片段都会：

```python
current_images = images[trim:].clone()

if gap:
    current_images = torch.cat((black, current_images), dim=0)

if accumulated_images is not None:
    current_images = torch.cat(
        (accumulated_images, current_images),
        dim=0,
    )

if gap_after:
    current_images = torch.cat(
        (current_images, black),
        dim=0,
    )
```

音频也采用相同的逐段 `torch.cat` 累积方式。

expanded graph 中每个片段都生成：

```text
segment decode
→ AssembleMedia(segment 1)
→ AssembleMedia(segment 2, accumulated=segment 1 output)
→ AssembleMedia(segment 3, accumulated=segment 2 output)
→ ...
→ final merged images/audio
```

因此存在两个不同层面的内存成本。

---

# 4. 必须先区分的两种成本

## 4.1 不可避免的最终 IMAGE 本体

ComfyUI 的 `IMAGE` 当前是完整 Tensor。

960×544、1194 帧、RGB、float32 时理论尺寸已经是数 GB。

本轮观察：

```text
final images≈7.1GB
```

只要 TerryDirector 最终仍输出：

```text
完整 merged IMAGE
```

这部分就不能凭空消失。

因此禁止以：

> “把 7GB 最终 Tensor 降到几十 MB”

作为当前任务目标。

如果要彻底避免最终 IMAGE 本体，意味着产品输出协议需要从完整 IMAGE 改为：

- 流式视频；
- file-backed video；
- segment list；
- lazy media；
- 或其他数据类型。

那是另一个架构任务。

## 4.2 可以优化的重复复制 / 瞬时峰值

当前 RSS 约 44GB，远高于最终 7.1GB Tensor 本身。

主要怀疑：

- 多级 `torch.cat` 每次复制全部历史帧；
- 旧 accumulated tensor 与新 tensor 在 executor/cache 生命周期中同时存活；
- `clone()` 进一步制造副本；
- decode output、trim output、assembled output 同时存在；
- 每段 expanded node output 被 ComfyUI executor/cache 保留；
- audio 同样重复 concat；
- 最终 PackOutput + CreateVideo + AdvancedFinish 又继续持有 merged media。

本任务应优先减少这些**可避免副本**。

---

# 5. 第一阶段：建立真实内存基线

先不要改算法。

使用：

```text
0.5MP
960×544
9 段
preview off
seed=9
```

分别跑：

- Base；
- Advanced。

记录每个片段：

```text
decode_video 完成后
decode_audio 完成后
assemble 前
assemble 后
```

至少记录：

```text
segment index
frames
tensor shape
dtype
tensor logical MB
process RSS
system RAM used/free
CUDA free
torch allocated/reserved
```

如果可以通过非侵入方式获取 Python object / tensor storage 信息，再增加：

```text
storage data_ptr
is_contiguous
storage size
view/base relation
```

目的：

> 明确 RSS 是在哪一步跳升，而不是只看 Assemble 后 checkpoint。

不要插 passthrough 图节点来计时/测内存。

优先直接在已有内部节点内部记录。

---

# 6. 第二阶段：量化逐段 cat 的复制成本

对 `TerryDirectorAssembleMedia.execute` 增加临时精确 timing：

```text
trim/clone
gap prepend
image accumulated cat
audio accumulated cat
gap_after append
total
```

并记录 cat 前后的：

```text
input logical MB
output logical MB
RSS delta
```

目标是得到类似：

| segment | accumulated MB | new MB | cat time | RSS before | RSS after |
|---:|---:|---:|---:|---:|---:|
| 1 | 0 | | | | |
| 2 | | | | | |
| ... | | | | | |
| 9 | | | | | |

确认是否真的存在明显 O(n²) 内存复制和时间复制。

---

# 7. 优化方向 A：只在最后一次统一拼接

这是第一优先研究方向，但**先做原型/分支，不直接改正式图**。

思路：

当前：

```text
segment1 → cat
segment2 → cat(history+2)
segment3 → cat(history+3)
...
```

候选：

```text
segment1 prepared
segment2 prepared
segment3 prepared
...
→ final assembler
→ torch.cat once
```

理想收益：

- 避免每个中间阶段复制完整历史帧；
- 将 image concat 从 N 次大复制降到 1 次；
- audio 同理；
- 减少中间 accumulated IMAGE 输出。

## 7.1 注意

之前性能排查阶段曾短暂做过“一次性 final assembly”，后来因为那次改动被错误地拿来解释 Advanced-only sampler 问题而撤回。

本任务可以重新研究这个方向，但必须把目标说清楚：

> 现在不是为了修 Advanced-only sampler，而是为了降低共享 assembly 内存。

不要因为之前撤回过就直接否定这个结构。

---

# 8. 优化方向 B：预分配最终 Tensor

如果已经可以在 compile 阶段确定：

```text
final frame count
height
width
channels
dtype
```

可评估：

```python
output = torch.empty(final_shape, ...)
output[start:end].copy_(segment)
```

相比：

```python
torch.cat([...])
```

潜在收益：

- 只申请一次最终大块内存；
- 避免 cat 同时持有输入 + 输出造成瞬时双倍峰值；
- 拷贝行为更可控。

但必须证明：

- ComfyUI executor 中 segment tensor 生命周期是否允许及时释放；
- 是否因为所有 segment 仍作为 graph node output 被 cache 而保留；
- 最终预分配 node 是否必须一次性接受所有 segment inputs，从而仍导致所有 decoded frames 同时存活。

因此需要 A/B，而不是凭理论直接采用。

---

# 9. 优化方向 C：减少无意义 clone

当前：

```python
current_images = images[trim:].clone()
current_waveform = waveform[..., trim_samples:].clone()
```

要验证：

- `clone()` 是否真的必要；
- 后续是否有 in-place 修改；
- 如果只是 cat 输入，view 是否足够；
- 去除 clone 是否减少 RSS；
- 是否导致 ComfyUI tensor 生命周期或连续性问题。

先单独做一个控制实验：

```text
现有 clone
vs
slice/view without clone
```

不要同时改 cat 结构。

---

# 10. 优化方向 D：Advanced 与 Base 是否需要同样的 merged IMAGE

这是后续架构阶段，不作为第一轮直接实现。

Base 当前产品语义需要：

```text
segment LATENT list
merged IMAGE
merged AUDIO
```

Advanced 自己已经：

- 保存最终视频；
- 有顶部视频播放器；
- 有分段 latent cache；
- 是 output node。

因此需要单独评估：

> Advanced 是否必须在整个 terminal 生命周期中继续保留完整 merged IMAGE 作为 `director_output`。

潜在未来方案：

```text
Base:
  保持 merged IMAGE/AUDIO output

Advanced:
  segment media → video/file-backed representation
  + latent cache
  + final video result
  不再强制长期持有 full merged IMAGE
```

但这会改变数据协议 / 下游兼容性。

除非用户明确同意，不在本任务第一轮实现。

---

# 11. 优化方向 E：利用 ComfyUI 原生 Video accumulation / file-backed video

当前 ComfyUI 已有：

- `CreateVideo`
- `ConcatenateVideo`
- file-backed Video 类型

需要调研：

1. 是否可以每个 segment decode 后直接转为 Video；
2. 多 segment 用 `ConcatenateVideo` 聚合；
3. 最终只在 SaveVideo 时编码；
4. 已编码片段是否能无重新解码拼接；
5. audio continuity/gap/overlap 是否能准确复现当前时间线；
6. 是否可以避免完整 1194 帧 IMAGE Tensor 常驻 RAM。

如果可行，这可能是长期最优方向。

但这是架构探索，不要和第一轮“减少重复 cat”混做。

---

# 12. 性能/内存验收基线

当前 0.5MP / 1194 帧：

```text
final IMAGE logical size ≈ 7.1GB
process RSS ≈ 44.6GB
system RAM ≈ 98.3%
```

第一阶段现实目标：

> 在不改变 Base/Advanced 输出语义、不改变画面/音频结果的前提下，把 process RSS 峰值显著降低。

建议验收：

### 最低合格

```text
RSS peak < 30GB
system RAM < 80%
```

### 理想目标

```text
RSS peak < 20GB
system RAM < 70%
```

如果最终 merged IMAGE 仍为 float32 7.1GB，不能用不现实的 2～3GB RSS 目标。

---

# 13. 结果一致性要求

优化前后必须验证：

- 最终 frame count 完全一致；
- 最终视频时长一致；
- resolution 一致；
- gap 黑帧数量一致；
- overlap trim 一致；
- tail_reference/tail_continuation 行为不变；
- audio sample rate 一致；
- audio duration 一致；
- 最终编码视频可正常播放；
- Base 输出 socket 数据结构不变；
- Advanced local rerun 不被破坏。

如果方便，可以对无随机后处理的最终 tensors 做 hash/统计比较：

```text
shape
dtype
min/max/mean
selected frame checksum
audio selected-range checksum
```

---

# 14. 不要做的事情

本任务禁止：

- 调整 ComfyUI 启动参数；
- 换模型；
- 换 VAE；
- 改 sampler/sigmas；
- 改 preview；
- 改 cache 语义；
- 顺手修 suspended trailing gap；
- 顺手改时间线 UI；
- 用降低分辨率冒充内存优化；
- 改 IMAGE dtype 来“节省内存”而不先证明输出兼容；
- 用磁盘 swap/分页作为优化方案；
- 把历史 Advanced sampler 异常作为本任务成功标准。

---

# 15. 建议实施顺序

严格按顺序：

1. **Baseline memory instrumentation**
2. **单独去 clone A/B**
3. **single final cat 原型**
4. **预分配 Tensor 原型**
5. 比较 3/4 哪个对 ComfyUI executor 生命周期更友好
6. 只选择一种最小风险方案落正式代码
7. Base 回归
8. Advanced 回归
9. 9 段 0.5MP 内存验收
10. 写报告

---

# 16. 输出报告

创建：

```text
docs/17_ASSEMBLY_MEMORY_OPTIMIZATION_REPORT.md
```

至少包含：

- 原始内存生命周期表；
- clone A/B；
- final-cat A/B；
- preallocation A/B；
- 采用方案及原因；
- peak RSS；
- system RAM peak；
- 最终 IMAGE logical size；
- 运行总时间；
- Base / Advanced 正确性；
- 视频/音频一致性；
- 被否决方案；
- 最终 commit hash。

---

# 17. 本任务成功标准

成功不是“代码更漂亮”。

成功必须同时满足：

1. **RSS 峰值有明显下降**；
2. 最终 timeline 视觉/音频结果不变；
3. Base / Advanced 都正常；
4. 不重新引入历史性能异常；
5. 代码路径比现有逐段 cumulative cat 更可解释；
6. 有完整量化报告支持采用该方案。
