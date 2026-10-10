# TerryDirector 外部 H3 时间线循环器

分支：feat/timeline-loop-native-h3。本功能与原 TerryDirector / TerryDirectorAdvanced 并存，不覆盖 Base / Advanced 的现有执行图和内存策略。

## 1. 图形连接与职责

TerryDirector 循环开始
→ 输出当前片段（输出 3）与上一片段上下文（输出 4）
→ TerryDirector 循环媒体（Prompt / H3 帧数 / Seed / 图片 0–8 / 当前片段数据）
→ MiniMaxH3ReferenceToVideo（ComfyUI 原生）
→ TerryDirector 循环承接（条件调用官方 MiniMaxH3AddGuide）
→ BasicGuider、RandomNoise、KSamplerSelect、BasicScheduler、SamplerCustomAdvanced（ComfyUI 原生）
→ TerryDirector 循环缓存（原 Base 无损分段缓存实现）
→ TerryDirector 循环结束（output_value=分段缓存；next_iteration_value=下一段上下文）
→ 分段缓存列表
→ 可选 TerryDirector 循环合并
→ 可选官方 CreateVideo、SaveVideo

注意：前后两个循环边界是 TerryDirector 循环开始/结束；媒体、承接、缓存为普通适配节点。中间原生 H3 子图必须通过缓存节点的数据依赖实际连到循环结束，而不仅仅是画在两个节点之间。

## 2. 实现原理

- 继承 ComfyUI 0.39.0 内置 StartLoop / EndLoop，复用其 loop_boundary / GraphBuilder / execution_list；不重新复制循环引擎。
- 将现有 director_compile.compile_timeline 输出的有效片段转为官方循环的 List mode，挂起镜头由原编译器跳过。
- 内部初始上下文（initial_iteration_value）设置为 '{}'，保障第一轮不会因为空列表 carry 而漏执行。
- 现有 UI 扩展将 Looper 识别为导演节点，直接复用同一套迷你时间线、编辑浮窗、提示词/资产池；不修改 Canvas 时间线核心。
- 浮窗「生成」找到唯一对应的循环结束节点，用 Partial Execution 只执行此循环链。
- 每轮真实开始/分段写盘完成向前端报告状态；不虚构采样百分比。

## 3. 衔接与缓存

- independent、gap：不引用上一段 Guide。
- tail_reference：上一段真实最后一帧插入当前 H3 图片参考位置，标签编号沿用编译结果。
- tail_frame：调用官方 MiniMaxH3AddGuide 锚定第 0 帧。
- overlap：使用相应的上一段尾部多帧/音频 Guide，并在必要时加边界帧 Guide。
- 每段调用现有 TerryDirectorDecodeSegmentToCache：立即解码、trim/gap、保存 float32 无损 .pt、返回极小上一段上下文。
- 最终合并直接调用 TerryDirectorMaterializeTimeline，在全部片段完成后卸载生成模型、预分配一次性 IMAGE/AUDIO，并删除临时 .pt；保存视频交给官方 CreateVideo / SaveVideo。
- 不连接循环合并也能单独执行结束节点；.pt 缓存暂存于 ComfyUI temp/terrydirector_base/loop-节点ID，下次同节点运行之前会清理。

## 4. 示例内容

示例由用户上传的 Terry导演台(2).json 派生：

- 完整保留全局 Prompt、9 段镜头 Prompt、7 张 ComfyUI input 图片参考及原始路径；
- 沿用原始 MiniMax H3 pruned int8 convrot 主模型、4 步 Turbo LoRA、KJ SageAttention、Qwen3-VL 32B NVFP4 AWQ、视频 int8 VAE、音频 FP32 VAE；
- Seed 9、608×352、KSamplerSelect res_multistep、BasicScheduler simple / 4 steps / denoise 1；
- 保留原 Base 时间线挂起状态：前三段分别 4 秒 / 3 秒 / 5 秒，后六段挂起；总实际生成 12 秒。

工作流 JSON 不包含图片二进制。请确保七张图片真实存在于测试机器的 ComfyUI input 目录。模型与 KJ 节点也需事先安装，和上传时的原工作流一致。

## 5. 第一轮交付边界

- 此轮循环媒体接口只实现图片资产适配；视频和音频资产引用将明确报错，不会假装成功。
- 此轮复用 Base 无损分段 + 可选最终合并；未移植 Advanced LATENT checkpoint、局部重跑、中断恢复、Advanced 逐帧最终编码。这些原功能仍留在旧 Advanced，不做重复实现。
- 不含 SelfLift、图像增强、DLSSNR、AI Prompt 增强等新依赖。
- 已核对 ComfyUI 官方 0.39.0 循环定义和原生 H3 Reference / Sampler 接口、生成了静态校验连线的示例；尚未在用户 RTX 3090 本机执行。不得把静态核对表述为 GPU 验收通过。

## 6. 本地验收

1. 切换到 feat/timeline-loop-native-h3 并重启 ComfyUI 0.39.0。
2. 导入示例 JSON，确认 Looper 浮窗中完整保留九个 Prompt、七张参考图，且只有前三段启用。
3. 运行后确认产生三次原生 H3 采样，分别最终输出 96 / 72 / 120 帧；内部生成帧长遵守 5+17n 网格。
4. 观察三次 [TerryDirector Base][Stream] Segment 日志及一次 Final merge，最终视频应为 288 帧、12 秒、24fps。
5. 检查第二、三段的尾帧参考效果；更改第二段提示词后重跑，确认逐轮 Prompt 生效。
6. 断开「循环合并」下游，单独运行「循环结束」确认 .pt 缓存；可再次连接最终合并。
7. 任何异常请附完整 ComfyUI 日志和错误堆栈；本轮不重复长时内存性能 A/B 测试。

参考源码：ComfyUI/comfy_extras/nodes_loop.py、nodes_minimax_h3.py；本仓库 director_compile.py、director_internal.py。
