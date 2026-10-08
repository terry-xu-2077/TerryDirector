# Advanced 性能差异诊断报告

> 测试日期：2026-10-09
>
> 被测代码基线：`1e52452b9afe87e5a99a7d13f95368badca5246c`
>
> 任务来源：[`12_ADVANCED_PERFORMANCE_DIAG_TASK.md`](12_ADVANCED_PERFORMANCE_DIAG_TASK.md)
>
> 测试工作流：`Terry导演台.json`
>
> 结论状态：当前最新代码未复现历史随机灾难性采样降速；本轮没有足够证据支持修改 Advanced 执行逻辑。

---

## 1. 结论摘要

本轮验证围绕一个唯一假设展开：

> Advanced 的 `cache_key` 或 cache-enabled 执行路径会改变 H3 核心图、执行生命周期或缓存行为，从而触发随机灾难性 sampling 降速。

测试结果不支持该假设作为当前代码中的稳定触发条件：

1. Base 与 Advanced 在严格相同输入下生成的 `td_s*` H3 核心图完全一致。
2. 0.2MP / 3 段严格 A/B 中，`video_only` 与 `cache_enabled` 的 sampler 时间接近。
3. 0.5MP / 原始 9 段严格 A/B 中，`cache_enabled` 没有变慢，反而比 `video_only` 快 31 秒。
4. 再次运行正式 cache-enabled 路径，总耗时仍处于正常范围。
5. 使用已打开浏览器的 WebSocket `client_id` 直接向 `/prompt` 提交，使 Advanced 前端实际收到执行和进度事件后，9 段任务仍正常完成。
6. 9 段 LATENT cache 总写入约 72.1MB，仅耗时约 0.1 秒；视频保存约 14 秒。

因此，本轮排除了以下因素作为当前版本中的充分条件：

- Base 与 Advanced 的 H3 核心图存在确定性差异；
- `cache_key` 本身稳定触发极慢 sampler；
- LATENT 写盘耗时导致几十分钟差额；
- Advanced 前端接收进度事件本身稳定触发 sampler 降速；
- 最终视频创建和保存路径本身稳定触发 sampler 降速。

本轮没有重现历史上的 5～15 倍 step 时间，不能声称历史问题已经找到根因或永久修复。更准确的结论是：

> 在提交 `1e52452`、当前 ComfyUI 和本报告控制条件下，经过严格 A/B、重复运行以及前端参与运行，历史异常均未复现。

---

## 2. 测试环境与控制变量

### 2.1 环境

- 操作系统：Windows
- ComfyUI：0.39.0
- ComfyUI 启动参数：

```text
--listen 0.0.0.0 --port 8188 --enable-manager --use-sage-attention
```

- 工作流：`Terry导演台.json`
- seed：9
- 实时预览：关闭
- 提交方式：直接调用 ComfyUI `/prompt` API
- 测试期间没有更换模型、VAE、sampler、sigmas、提示词或资产
- 没有修改基础版 TerryDirector
- 没有保存或改写工作流文件

### 2.2 两组测试规模

#### 快速基线

- 百万像素：0.2MP
- 实际分辨率：608×352
- 活动片段：3 段

#### 原始长任务

- 百万像素：0.5MP
- 实际分辨率：960×544
- 活动片段：原始 9 段全部启用

### 2.3 严格 A/B 的唯一变量

`video_only`：

```python
video_export = enabled
cache_key = None
rerun = None
preview_override = None
```

`cache_enabled`：

```python
video_export = enabled
cache_key = str(unique_id)
rerun = None
preview_override = None
```

其余输入和执行路径保持一致。

---

## 3. Task A：核心图一致性

### 3.1 0.2MP / 3 段

```text
input_signature=e487356e623301c5
core_graph_signature=2ebb26167f347144
nodes=50
Base vs Advanced core graph: EXACT MATCH
```

### 3.2 0.5MP / 9 段

```text
input_signature=6966e230b265ac73
core_graph_signature=0580d51b3112ef16
nodes=152
Base vs Advanced core graph: EXACT MATCH
```

### 3.3 工作流配置状态差异

第一次按两个节点各自保存的 `config_json` 比较时，发现一个真实图差异：

```text
td_s3_assemble.gap_after_frames
Base=912
Advanced=906
```

继续检查后确认：工作流内 Base 与 Advanced 保存了略有不同的时间线配置。Advanced 中原本 suspended 的 clip 7～9 整体提前了 6 帧，最终结束帧为 1194；Base 对应结束帧为 1200。

这是工作流节点状态不一致，不是 Base / Advanced 后端生成逻辑在相同输入下产生了不同核心图。后续所有严格比较都将两个分支统一为 Base 节点的同一份 `config_json`，只改变当前实验指定的单一变量。工作流文件本身没有被保存或修改。

### 3.4 Task A 结论

> 当输入真正一致时，Base 与 Advanced 的 H3 `td_s*` 核心图完全一致。旧 hash 差异不能作为当前 Advanced sampling 变慢的证据。

---

## 4. Task B：严格 cache_key A/B

### 4.1 0.2MP / 3 段

| 模式 | clip 1 | clip 2 | clip 3 | Prompt 总时间 | Cache batch | 视频保存 |
|---|---:|---:|---:|---:|---:|---:|
| `video_only` | 00:45 / 11.45s/it | 00:37 / 9.44s/it | 00:53 / 13.43s/it | 225.53s | 禁用 | 3.715s |
| `cache_enabled` | 00:45 / 11.48s/it | 00:37 / 9.44s/it | 00:54 / 13.50s/it | 227.45s | 0.043s / 7.1MB | 3.687s |

两组 sampler 基本重合，总时间相差 1.92 秒，属于正常波动。

### 4.2 0.5MP / 9 段

| 模式 | Prompt 总时间 | Cache batch | 视频保存 | 结果 |
|---|---:|---:|---:|---|
| `video_only` | 36:41 | 禁用 | 13.919s | 正常 |
| `cache_enabled` | 36:10 | 0.095s / 72.1MB | 13.820s | 正常，比对照快 31 秒 |

逐片段 sampler：

| 片段 | `video_only` | `cache_enabled` |
|---:|---:|---:|
| 1 | 02:04 / 31.24s/it | 02:04 / 31.19s/it |
| 2 | 01:39 / 24.94s/it | 01:39 / 24.91s/it |
| 3 | 02:30 / 37.69s/it | 02:30 / 37.59s/it |
| 4 | 03:08 / 47.12s/it | 03:08 / 47.10s/it |
| 5 | 03:29 / 52.31s/it | 03:29 / 52.31s/it |
| 6 | 03:28 / 52.12s/it | 03:28 / 52.10s/it |
| 7 | 03:08 / 47.16s/it | 03:08 / 47.20s/it |
| 8 | 03:08 / 47.19s/it | 03:08 / 47.19s/it |
| 9 | 03:08 / 47.24s/it | 03:08 / 47.23s/it |

两组每个片段的 step 时间都接近，未出现正常、极慢、恢复、再次极慢的历史异常模式。

### 4.3 正式 cache-enabled 重复运行

移除临时 A/B 开关、恢复正式代码后，再次运行 0.5MP / 9 段：

| 指标 | 结果 |
|---|---:|
| Prompt 总时间 | 37:06 |
| Cache batch | 0.098s / 72.1MB |
| 视频保存 | 13.914s |

sampler：

```text
clip 1: 02:04 / 31.08s/it
clip 2: 01:39 / 24.90s/it
clip 3: 02:30 / 37.71s/it
clip 4: 03:08 / 47.25s/it
clip 5: 03:29 / 52.40s/it
clip 6: 03:29 / 52.27s/it
clip 7: 03:09 / 47.27s/it
clip 8: 03:09 / 47.40s/it
clip 9: 03:09 / 47.27s/it
```

重复运行仍未复现异常。

---

## 5. Advanced 前端参与验证

普通 API 测试使用独立 `client_id` 时，浏览器中的 Advanced 前端不会收到该任务的 progress / execution WebSocket 事件。为了验证前端事件处理是否是遗漏变量，本轮增加了一次前端参与运行：

1. 临时读取已打开浏览器的 ComfyUI WebSocket `client_id`；
2. 仍然通过 `/prompt` API 直接提交，不操作画布；
3. 在 `extra_data.client_id` 中使用浏览器客户端标识；
4. 确保 Advanced 前端实际收到完整执行和进度事件；
5. 运行结束后删除临时诊断入口并重启 ComfyUI。

结果：

| 指标 | 结果 |
|---|---:|
| Prompt 总时间 | 36:49 |
| Cache batch | 0.098s / 72.1MB |
| 视频保存 | 14.073s |
| Terminal total | 14.177s |
| 输出视频 | `TerryDirector_00036_.mp4` |

sampler：

```text
clip 1: 02:04 / 31.04s/it
clip 2: 01:39 / 24.90s/it
clip 3: 02:30 / 37.64s/it
clip 4: 03:08 / 47.25s/it
clip 5: 03:29 / 52.45s/it
clip 6: 03:29 / 52.30s/it
clip 7: 03:09 / 47.26s/it
clip 8: 03:09 / 47.26s/it
clip 9: 03:09 / 47.28s/it
```

前端参与时的结果与其他正常运行一致。因此，Advanced 前端接收 progress / execution 事件本身不是当前版本中稳定触发 sampler 灾难性降速的充分条件。

---

## 6. 内存与最终拼接观察

0.5MP / 9 段最终拼接期间，CPU 内存持续上升。前端参与运行的 checkpoint 为：

```text
frames=96   images=573.8MB  rss=14137MB ram=49.7%
frames=168  images=1004.1MB rss=16156MB ram=52.9%
frames=288  images=1721.2MB rss=20458MB ram=59.8%
frames=432  images=2581.9MB rss=26419MB ram=68.9%
frames=600  images=3585.9MB rss=32980MB ram=78.9%
frames=768  images=4590.0MB rss=39771MB ram=89.2%
frames=912  images=5450.6MB rss=43413MB ram=94.7%
frames=1056 images=6311.2MB rss=44198MB ram=96.0%
frames=1200 images=7171.9MB rss=44672MB ram=96.8%
```

其他 `video_only` 和 `cache_enabled` 长任务也出现相近的最终内存峰值，约为系统内存 97.5%～98.2%、进程 RSS 约 45GB。

这是值得继续关注的共享 assembly 资源压力，但当前证据同时表明：

- 两种 A/B 模式都有相似峰值；
- cache 写入本身不足 0.1 秒；
- 九个 sampler 的 step 时间没有随片段序号灾难性增长；
- 历史异常曾表现为极慢后恢复正常，也不符合简单单调内存增长模型。

因此，本报告不把该内存峰值直接认定为历史随机 sampling 降速的根因，也没有在本任务中修改公共 assembly 或 trailing gap 语义。

---

## 7. 本轮临时代码与最终仓库状态

为了严格只改变一个变量，本轮曾在 Advanced 路径增加内部诊断开关，在相同当前代码中切换 `cache_key=None` 和 `cache_key=str(unique_id)`。

为了完成前端参与验证，曾临时增加一个只返回当前 ComfyUI WebSocket 客户端标识的本地诊断路由。

两项临时改动在测试后均已完全删除：

- `director_node.py`：恢复正式 Advanced 行为；
- `server_routes.py`：删除临时客户端诊断路由；
- 临时 API 提交脚本：删除；
- 基础版 TerryDirector：从未修改；
- `Terry导演台.json`：从未保存或修改。

清理后验证：

```text
git status --short: clean
temporary diagnostic route: HTTP 404
ComfyUI /system_stats: ready, version 0.39.0
```

本报告提交前的被测代码仍为：

```text
1e52452b9afe87e5a99a7d13f95368badca5246c
```

---

## 8. 本轮排除项与仍未证明的事项

### 8.1 已排除为当前版本稳定触发条件

- 相同输入下 Base / Advanced 的 `td_s*` 核心图不同；
- cache 写盘耗时造成几十分钟性能差额；
- 设置非空 `cache_key` 必然导致 sampler 变慢；
- Advanced 前端收到进度事件必然导致 sampler 变慢；
- CreateVideo / video save 单独造成灾难性 sampler 退化。

### 8.2 仍未证明

- 历史异常的真实根因；
- 极低概率、依赖时序的 ComfyUI executor 生命周期或缓存状态问题；
- 特定历史代码状态、热启动状态或连续任务序列是否是必要条件；
- 系统内存接近满载是否会在某个额外条件下触发非单调的 sampling 退化。

由于异常未复现，继续改 Advanced 执行逻辑会失去可验证的因果关系，因此本轮没有提交猜测性修复。

---

## 9. 下一步唯一验证建议

如果历史异常再次出现，下一步应只增加非侵入式节点执行计时，不改变 expanded graph：

```text
td_sN_sample start / finish
td_sN_decode_video start / finish
td_sN_decode_audio start / finish
td_sN_assemble start / finish
```

同时在每个边界记录：

```text
process RSS
system RAM used/free
CUDA free/total
torch allocated/reserved
当前 prompt id、node id、client id
```

目标是先确认异常时间实际发生在 sampler、VAE decode、assembly 还是 executor 调度间隙，再针对唯一异常阶段设计下一轮 A/B。异常实际出现前，不建议继续改动 H3 核心图、公共 assembly 或 Advanced 功能路径。

---

## 10. 最终判断

本轮已完成任务文档要求的 Task A、严格 cache_key A/B、原始 0.5MP / 9 段长任务、正式路径重复运行以及前端参与运行。

最终结果为：

> Advanced 在关闭实时预览时，当前所有采样结果均接近正常基线，没有出现 5～15 倍的随机 step 时间，也没有出现 1 小时以上的 9 段任务。当前证据不足以支持修改 Advanced 节点代码。
