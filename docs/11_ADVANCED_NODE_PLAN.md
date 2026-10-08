# TerryDirector Advanced · 开发状态

> 2026-10-08：第一阶段 UI 外壳已提交；视频编码、持久缓存与局部重跑尚未接入。不要将现阶段节点理解为完整的高级视频保存节点。

## 与标准版的边界
- 原版 TerryDirector 保留紧凑的只读迷你时间线与共享的大型编排编辑浮窗。
- TerryDirector Advanced 继承相同的多段 H3 编译和执行路径，独立承载审片、定位、按片段重跑与视频文件保存。
- 大型编排浮窗目前不作任何布局调整。

## 第一阶段已实现
1. 独立的 TerryDirectorAdvanced ComfyUI 节点，继承标准版 execute / fingerprint 行为。
2. 视频窗口预先占位，16:9，避免任务运行后再增加占位导致布局突变。
3. 只读时间线横向滚动，单个片段的像素点击区域至少 64px；统一时间比例尺，不独立拉伸短片段。
4. 片段点击选中、拖动 range 定位、定位播放头按钮；浏览器 video 元素已放入节点，但尚无媒体源时保持禁用。
5. 保存路径与前缀已纳入节点可序列化参数，并在自定义 UI 中展示；尚无编码或保存副作用。
6. 重跑按钮暂时禁用，避免错误地触发整段重新生成。

## 下一阶段必要条件
- **媒体**：合并画面 / 音频采用明确格式编码为浏览器可播放的 MP4（H.264）；文件和预览复用同一次编码；先核对本机 ffmpeg 或可用的视频节点接口。切勿仅凭 VAE 解码完成就向视频窗口添加无效 URL。
- **缓存**：按稳定 clip.id 保存和校验分段媒体与下游衔接所需的尾帧；保存索引不能把大数据写入工作流 JSON。注意 ComfyUI 临时节点缓存不能代替持久缓存。
- **重跑**：在编译执行图前计算复用集和必须重跑集；不改变编排时默认仅替换所选片段，其余使用已有结果。任何必要缓存缺失均明确报错，不隐式跑全片。
- **依赖**：重跑本段后，下一段基于旧尾帧的结果保持不变；接缝提醒用户检查。另提供后续依赖重跑入口。
- **任务**：节点仅在本节点执行时设只读；其他 Advanced/标准版节点仍可编辑。
- **预览时间映射**：重叠/空隙时基于最终合并时长和片段实际映射，而不是简单累加原始生成时长。
- **交互**：播放跟随在用户手动滚动后暂停，点击定位按钮恢复；重跑后保留 scrollLeft 和选中片段。
- **测试**：ComfyUI 0.39.0 实机验证；同画布多个 Advanced 节点分别运行、停止、重载工作流、改变节点宽度和 1 秒短片段场景。

## 当前暂不支持
- 自动文件保存/编码
- 真实媒体预览
- 片段持久化复用
- 局部重跑执行

这些 UI 控件不得展示虚假的成功状态。

## 2026-10-08 · 原生视频输出链路（待实机验收）
- Advanced 执行图新增 `CreateVideo → SaveVideo`，通过 `TerryDirectorAdvancedFinish` 保证保存完成后才输出导演结果。
- 复用原生 `SaveVideo` 的文件名前缀、格式和编解码器；视频帧率仍使用时间线 FPS=24。
- 前端监听原生 SaveVideo 完成事件并尝试将输出文件接入播放器。
- **尚未完成 ComfyUI 0.39.0 实机验收**：需要确认 SaveVideo 扩展子图节点的 `executed` 事件及输出文件 URL 能否被父节点准确识别。不能宣称自动预览已经验证可用。
- 分段持久缓存和局部重跑仍未实现，按钮保持禁用。


## 2026-10-08 · 三段实机反馈后修复
- 修复播放头：轨道未铺满视口时，Seek 按 `pixelsPerSecond` 对应真实片段长度计算，并补偿 LiteGraph 缩放，不再使用整个可见轨道宽度映射总时长。
- 补充 KJ Model Preview Override 对应的配置 UI：启用开关、最大预览分辨率、JPEG 质量、每步预览帧数、预览 FPS、屏蔽默认预览。**注意这轮仅配置/交互，KJ 的采样包装器和实时图像事件尚未接入；折叠栏显式标记待接入。**
- 原保存链使用展开图中的独立 `SaveVideo` 子节点，在用户提供的三段运行日志中没有证明已保存文件。当前改为 `TerryDirectorAdvancedFinish` 中直接执行 ComfyUI 原生 `SaveVideo.execute`，并将返回的 `PreviewVideo` UI 元数据透出，保存失败不得标记 Advanced 成功。
- 新增 `[TerryDirector Advanced] Saving video via native SaveVideo...` 与 `Native SaveVideo completed` 日志，便于通过短片段独立验证。未运行用户本机，不能声称真实保存已通过验收。
- 下一阶段：集成独立实时采样预览通道，不能把最终 MP4 播放混同于 KJ 每步 latent 预览；分段持久缓存和局部重跑仍未做。


## 2026-10-08 · 局部重跑第一版
- Advanced 完整生成时，每个活动片段的采样后 LATENT 写入 `output/.terrydirector_cache/<node-id>/<clip-id>.pt`。
- 选中片段重跑时，只对目标片段执行 H3 conditioning / sampling；其他片段从磁盘读取 LATENT，仅重新解码、时间线拼接和最终视频保存。
- 目标片段使用独立的“重跑 Seed”。前端默认跟随节点顶部全局 Seed；用户修改后仅作用于当前选中片段，“全局”按钮恢复跟随。
- 重跑成功后覆盖目标片段 LATENT 缓存；后续片段仍保留之前生成结果，因此不会因为尾帧依赖自动连锁重跑。
- 缓存签名当前校验生成宽高、H3 对齐帧数和输出帧数。尺寸/时长变化后尝试局部重跑会明确要求先完整生成。
- 缓存读节点 fingerprint 使用文件 mtime/size，防止 ComfyUI execution cache 返回旧 LATENT。
- 第一次更新到此版本后必须先完整生成一次，旧版本运行结果没有 LATENT 磁盘缓存。
- 尚未实机验收：需要确认 CPU 落盘 LATENT 可被当前 MiniMax H3 VAE 正常重新解码，以及多段尾帧参考时仅目标采样器执行。
\n
## 2026-10-08 · KJ 实时采样预览接入
- Advanced 在“启用预览”开启时，会在展开执行图中插入 `ModelPreviewOverrideKJ`，使用同一份 H3 model 包装采样器。
- 参数直接映射到 KJ 源节点：`max_resolution`、`jpeg_quality`、`suppress_default_preview`、`preview_fps`；MiniMax H3 的 `audio_vae` 同步传入。
- 未安装 KJNodes 时不阻断生成，只在控制台提示并跳过实时预览。
- 前端监听 `kj_preview_override`，Expanded GraphBuilder ID（如 `321.0.0.td_advanced_preview_override`）解析回 Advanced 父节点。
- 实时 JPEG / Animated WebP / MP4 都显示在 Advanced 顶部同一个预览容器里；采样过程中禁止点击播放/暂停。
- 最终视频保存完成后，实时预览状态清空，同一个窗口切回最终视频。
- 最终视频支持点击画面播放/暂停；左侧播放按钮根据 `play/pause/ended` 事件同步显示 ▶ / ⏸。
- 这一轮尚需 ComfyUI 0.39.0 + KJNodes 实机验证。
\n
## 2026-10-08 · 工作流切换恢复与预览档位
- Advanced 最终保存完成后在 `output/.terrydirector_cache/<node-id>/state.json` 持久化最新视频文件与活动片段 ID。
- 节点重新挂载（包括切换到其他工作流后再切回来）时，从 `/terrydirector/api/advanced-state` 恢复最终视频、片段完成状态和局部重跑可用状态，不再依赖完成瞬间前端是否处于当前工作流。
- “启用预览”关闭时隐藏整个“视频预览”折叠栏；开启后才显示 KJ Preview Override 参数。
- 预览采用连续 FPS 控制，默认 12 FPS；1 FPS 为单帧预览，多帧模式按目标 FPS 映射 H3 temporal latent token 密度。
- 新增 `Tiny VAE` 选择，直接读取 `models/vae_approx`；若检测到 `taeh3.safetensors` 则作为新节点默认值，否则为 `none`。
- KJ Preview Override 改为按采样片段单独包装 model，因此不同长度片段可以使用各自的首帧/半数/全帧预览采样数量。


## 2026-10-08 · 预览模式收敛
- 预览 UI 不暴露底层实现名称。
- “首帧”始终可用；Advanced 在该模式下直接接收 ComfyUI 的带节点元数据采样预览，并显示在顶部共用窗口。
- ComfyUI 0.39.0 默认 sampler preview method 为 none，因此 Advanced 在启用“首帧”预览时主动开启 H3 内置 TAESD preview 路径；若 taeh3 不可用，核心可回退到 H3 自带 Latent2RGB 因子。
- “半数帧”（默认）与“所有帧”仅在检测到多帧预览能力时可选；能力缺失时两项在 UI 中禁用并自动回退到“首帧”。
- 多帧模式内部固定屏蔽普通单帧 sampler preview，不再向用户暴露“屏蔽默认预览”选项。
- “预览模型”仅在多帧模式显示；首帧模式隐藏多帧专属参数。


## 2026-10-08 · 预览 FPS 控制
- 移除“首帧 / 半数帧 / 所有帧”三档 UI，改为一个整数“预览 FPS”，范围 1–24，默认 12。
- 预览 FPS = 1 时走单帧预览；FPS > 1 时走多帧预览。
- 多帧预览将目标 FPS 映射到 H3 temporal latent token 密度：约按 `target_fps / 24` 抽取 latent-time tokens，12 FPS 等价于约半数时间密度，24 FPS 为全密度。
- 未检测到多帧预览能力时，预览 FPS 自动锁定为 1 且输入禁用，不额外向用户解释底层实现。
- 最大分辨率、JPEG 质量、预览模型仅在 FPS > 1 且多帧能力可用时显示。


## 2026-10-08 · 提示词参考资产预算
- 全局提示词与片段提示词共享同一套 MiniMax H3 参考资产额度，按最终合并后的唯一资产计数；同一资产重复引用只占一个位置。
- 图片参考上限 9；视频参考上限 3；音频参考上限 3。
- 仅真正形成 `tail_reference` 的片段会额外预留 1 个图片参考位，因此普通图片引用最多 8 个；重叠与尾帧续接走 AddGuide，不占 `ref_images` 槽位。
- 片段提示词和全局提示词的 @ 资产菜单都会实时计算当前预算，超限项置灰不可选；资产池“插入引用”同样受此限制。
- 全局提示词编辑时，以所有启用全局提示词的活动片段中最严格的剩余额度为准。
- 从“未使用全局”切换为“使用全局”时先验证合并后的引用预算；若超限，保持关闭并弹窗说明原因。
- 切换片段承接模式为尾帧参考时也会先验证预算，避免模式切换后产生不可执行配置。
- 后端编译期额度校验继续保留，作为最终保护。


## 2026-10-08 · Advanced 缓存热路径优化
- 完整生成不再在每个片段的 `SamplerCustomAdvanced -> Decode` 之间同步执行 LATENT 缓存。
- Advanced 主生成链恢复为与基础版一致的 `Sample -> Decode -> Assemble` 节奏；所有片段完成后，由终端步骤统一将分段 LATENT 写入缓存。
- 局部重跑时仍从磁盘加载未重跑片段；目标片段重新采样后，仅在终端阶段覆盖该片段的缓存，不重写其他片段。
- H3 AV LATENT 的 `NestedTensor` 现在显式搬到 CPU 后再 `torch.save`，避免把 CUDA-backed NestedTensor 直接交给序列化。
- 新增性能日志：每个缓存的 CPU copy / disk save / 文件大小、缓存批次总耗时、视频保存耗时、Advanced 终端总耗时。
