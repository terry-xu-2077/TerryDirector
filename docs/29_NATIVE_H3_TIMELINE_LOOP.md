# TerryDirector 循环器 · 双边界紧凑结构

> 当前实现：ComfyUI 0.39.0 原生循环执行语义 + TerryDirector 动态子图适配。该功能尚待用户本机 GPU 真实生成验收。  
> 目标：用户只面对“循环开始 + 循环信息 + 循环条件 + 普通 H3 生成节点组 + 循环结束”，内部缓存与上下文回传不占画布节点。

## 用户看到的节点

```text
TerryDirector 循环开始
        │片段数据
        ▼
TerryDirector 循环信息 ──→ 提示词 / H3帧数 / Seed / image_0..8
        │片段数据                     │
        │                             ▼
        ├─────────────────→ MiniMaxH3ReferenceToVideo（官方）
        │                             │
        │                             ▼
        └───────────────→ TerryDirector 循环条件（内部决定是否增加 Guide）
                                      │正向条件
                                      ▼
                        BasicGuider / SamplerCustomAdvanced（官方 H3）
                                      │H3采样结果
                                      ▼
                         TerryDirector 循环结束
                            ▲           │
                        片段数据        ├─ 合并画面 ─→ CreateVideo
                            │           └─ 合并音频 ─→ CreateVideo ─→ SaveVideo
                         循环信息
```

所有可见片段信息端口统一叫 **片段数据**；只需从循环开始向循环信息接一条线，再由循环信息向循环条件与循环结束分出两条线。片段数据包内含“当前片段 + 上一轮上下文”，不需要用户手接“当前片段”和“上一片段上下文”。

节点名称：`TerryDirector 循环信息`（原循环媒体）与 `TerryDirector 循环条件`（原循环承接）。

**不再有可见的「循环缓存」「循环合并」节点。**「TerryDirector 循环结束」直接接受 H3 采样 LATENT、视频 VAE、音频 VAE、片段数据，默认输出最终 IMAGE/AUDIO。用户不需要连接 output_value / next_iteration_value / 分段缓存列表。

循环结束保留一个明确的「合并输出」布尔开关（默认开启）。关闭则仅保存逐段无损 .pt，不输出合并画面/音频。开启时，生成全部片段之后释放模型并一次性合并，再用 ComfyUI 原生 CreateVideo/SaveVideo 完成封装；不承担视频编码。

## 执行细节

1. `TerryDirectorLooper` 是一个真正的 `loop_boundary="start"`。时间线通过现有 `compile_timeline` 编译成启用片段列表，保留 Prompt、图片资产、尾帧参考/续接、重叠、空隙与挂起语义。
2. 动态子图按官方 `StartLoop` 的 GraphBuilder 列表循环展开，使用原生 `LoopIteration` / `LoopProgress` / `LoopResult` 与 `execution_list` external block。唯一新增的是把循环输入与前一轮上下文打包到一个 `TerryDirectorLoopFrame` 内部节点。
3. 每轮在用户外部 H3 采样节点组之后自动插入一个**内部** `TerryDirectorLoopCache`，调用已验收的 Base `TerryDirectorDecodeSegmentToCache`，只保留下一段需要的尾帧/重叠内容，通过隐藏 carry 回传到下次 `LoopIteration`。
4. 每个缓存描述按时间线顺序传给原生 `LoopResult`；所有片段完成后，原生 external block 放行 `TerryDirectorLoopEnd.execute`，调用现有 `TerryDirectorMaterializeTimeline` 做一次性合并。
5. 允许不连接下游 SaveVideo（只运行循环并缓存）；编辑器点击「生成」时，若只有一个通过循环结束向下游可达的 SaveVideo，则 partial queue 包含最终保存；否则只运行当前循环结束边界。
6. 用户无需在画布手绘反馈循环线。循环控制节点、无损缓存、上下文依赖由执行层处理。
7. 只有循环开始/信息/条件/结束是用户可查找的公开节点；`TerryDirectorLoopFrame` 与 `TerryDirectorLoopCache` 在内部分类且 `is_dev_only=True`。

## 当前技术范围

- 仅支持已有图片资产作为 H3 参考，未实现外部 LoopInfo 对视频/音频资产的引用。遇到该资产类型显式报错，不静默丢弃。
- 不自动接入二采 SelfLift；自由连接的普通 H3 采样子图仍由用户自己控制。SelfLift 已并入原 Base/Advanced，双方互不覆盖。
- 无损分段缓存是临时 .pt；打开最终合并后缓存会按 Base 原逻辑清理，不合并时将在下一次相同循环实例运行前清理。
- 未移植 Advanced 的分段局部重跑、latent checkpoint、中断恢复或单次流式视频编码。
- 以上是设计与代码实现范围，非 RTX 3090 实机 GPU 验收结果。

## 开发验收

```shell
python -m unittest discover -s tests -p 'test_director_loop.py' -v
python -m unittest discover -s tests -p 'test_loop_integration_contract.py' -v
node --test tests/*.test.cjs
```

重点检查 ComfyUI 0.39.0 原生 loop boundary 校验、单线片段数据映射、三段 4+3+5 秒逐轮不同 Prompt、上一段尾帧参考，以及运行完成后 288 帧/12 秒 IMAGE/AUDIO → SaveVideo。异常保留完整堆栈与 JSON。不要因为这次改节点接口重跑旧 50 秒性能 A/B。

新版 JSON 工作流保存于仓库外的示例附件；原三节点示例不得继续作为新版接线范本。
