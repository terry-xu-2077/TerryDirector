# TerryDirector 原生 H3 循环器 · 循环上下文 / 片段数据

> 分支：integrate/selflift-native-h3-loop。基于 ComfyUI 0.39.0 原生循环语义与 TerryDirector Base 无损分段缓存。尚未完成 RTX 3090 真机 H3 循环验收。

## 节点接线

TerryDirector 循环开始
  └─ 【循环上下文】(TERRYDIRECTOR_LOOP_CONTEXT)
       ↓
TerryDirector 循环信息
  ├─ 【片段数据】(TERRYDIRECTOR_SEGMENT_DATA) → 循环条件 / 循环结束
  ├─ 提示词 / H3 帧数 → MiniMaxH3ReferenceToVideo（官方）
  ├─ Seed → RandomNoise（官方）
  └─ image_0..8 → MiniMaxH3ReferenceToVideo（官方）

MiniMaxH3ReferenceToVideo (positive / latent)
  ↓
TerryDirector 循环条件 (正向条件 / 潜变量 / 两种 VAE / 片段数据)
  ↓
BasicGuider + SamplerCustomAdvanced（官方）
  ↓ H3采样结果
TerryDirector 循环结束 (H3采样结果 / 视频VAE / 音频VAE / 片段数据)
  ├─ 合并画面 ─┐
  └─ 合并音频 ─┴─→ CreateVideo → SaveVideo（官方）

循环缓存、上一段上下文回传与无损最终合并全都在循环结束的动态内部图里，不再需要可见的缓存/合并节点，也不需要画回环线。

## 两种数据的严格区别

**循环上下文**（仅由「循环开始」产生）是整个当前循环轮次的信封：

- 类型：TERRYDIRECTOR_LOOP_CONTEXT；
- 运行期标记：_type = terrydirector.loop_context；
- current_segment：时间线编译好的当前片段，含 prompt、h3_frames、assets、continuity、assembly、_loop 等；
- previous_context：上一轮缓存返回的紧凑尾帧 / 重叠区图像及音频；首段为空。

**片段数据**（由「循环信息」解析、整理后产生）是供生成图使用的扁平化片段参数：

- 类型：TERRYDIRECTOR_SEGMENT_DATA；
- 运行期标记：_type = terrydirector.segment_data；
- 直接包含当前片段的 id、prompt、h3_frames、assets、continuity、assembly、_loop、output_frames 等字段；
- 仍携带 previous_context，仅用于镜头连续性判断与后续缓存处理；
- 配套输出 Prompt / H3帧数 / Seed / 当前需要的参考图片；
- 只允许连接「循环条件」「循环结束」的片段数据输入，不可拿循环上下文代替。

这不只是重命名。两个 ComfyUI Custom IO 类型不同，运行时结构也不同；接口接反会在 ComfyUI 连线时暴露类型不匹配，运行时另有 _type 校验。

## 原生循环与缓存生命周期

- 循环开始持有原时间线/浮窗 UI，将启用片段编译为 List 轮次，挂起片段由已有编译器处理；
- 内部 TerryDirectorLoopFrame 组装包含本轮片段与上一轮 carry 的循环上下文；
- 循环信息将其转成片段数据，保留官方 H3 图片参考索引与尾帧参考语义；
- 每轮由 TerryDirectorLoopCache 自动调用现有 TerryDirectorDecodeSegmentToCache，将生成帧与原始音频无损写入 .pt，只回传下一轮必需的紧凑上下文；
- 内部使用 ComfyUI LoopIteration、LoopProgress、LoopResult 及 execution_list external block，最终结束节点由此放行；
- 「合并输出」默认开启，所有片段完成后使用 TerryDirectorMaterializeTimeline 释放模型、分段载入并一次性合并 IMAGE / AUDIO；用户可自行在下游 CreateVideo / SaveVideo 封装。
- 关闭「合并输出」时保留当次 .pt 缓存，不产生合并媒体；下一次运行当前循环实例前按已有 Base 规则清理缓存。

## 当前边界

- 当前「循环信息」只支持图片作为参考素材，遇到视频/音频资产引用明确报错；还没有做这些资产的外部适配。
- 这套循环器不自动接入导演二采配置，外部官方 H3 节点组可由用户自由更换；已验收的内置 SelfLift 仍独立保留在原 Base / Advanced。
- 当前没有迁入 Advanced 的断点恢复、分段重跑、LATENT checkpoint 或一次性流式最终编码。
- 不修改原 SelfLift 算法、Base / Advanced 生成逻辑、时间线编辑 UI 样式、Prompt/资产池文件。
- 示例必须使用具有循环上下文 / 片段数据专用端口类型的新版 JSON，旧版 AnyType 端口 JSON 不应继续作为验收依据。

## 验证

静态与隔离测试：

    python -m unittest discover -s tests -p "test_director_loop.py" -v
    python -m unittest discover -s tests -p "test_loop_integration_contract.py" -v
    node --test tests/*.test.cjs

真实验收依然以已提供的 9 片段 / 7 图片、仅前三段启用的 4+3+5 秒工作流为基准。预期 3 次不同 Prompt 的官方 H3 采样、上一片段真实尾帧承接、3 段无损缓存以及一次 Final merge，合计 288 帧、12 秒。GPU 执行与图像质量待用户本机实测。
