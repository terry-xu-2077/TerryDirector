# TerryDirector 成熟实现参考清单

> 首次整理与核对：2026-09-29  
> 用途：后续新增需求、修复和优化时，优先查找现成的节点实现与示例工作流。  
> 本页与 `AGENTS.md` 中“成熟实现优先”约定一起使用；前端仍以 [UI 实现蓝图](06_UI_IMPLEMENTATION_BLUEPRINT.md) 为准。

## 1. 已确认的开发原则

用户明确指定下面四个项目作为有实际生产使用经验的参考。后续提出需求时，先从这些参考中寻找成熟方案，再决定 TerryDirector 需要补充的部分。

1. 先找对应节点、示例工作流和实现函数，确认输入、输出、模型与采样条件。
2. 优先沿用已有运行能力，将已定稿的原生 UI 接入；对真实需求差异作必要适配。
3. 当前普通生成基础已经切换为 **ComfyUI 原生 MiniMax H3 节点 + TerryDirector Timeline Compiler / GraphBuilder**。Songssx TimelineDirector 继续作为长视频连续性、SelfLift 和边界处理的重要参考，但不是运行时依赖。
4. 其他参考按具体问题补充能力，不把几套采样器、缓存或连续性规则未经核对地混在一起。
5. 采用某段实现时，记录来源仓库、固定 commit、文件 / 函数和本项目适配差异；引入代码时保留相应来源及许可证信息。
6. 参考项目有某个功能，不等于本项目自动增加该功能。现有单行时间线、项目资产池和原生 HTML / CSS / JavaScript 继续作为前端基线。

本次完成仓库说明、关键入口与部分源码的核对；尚未在用户机器上进行这四套链路的统一性能测试。实际速度、显存、画质和适用场景随模型、工作流及硬件测试另行记录。

## 2. 四个正式参考仓库

| 仓库 | 在 TerryDirector 中优先查找的方向 | 本次核对版本 | 仓库许可证 |
| --- | --- | --- | --- |
| [Songssx / ComfyUI-MiniMaxH3-TimelineDirector](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector) | 参考：有限分段、AV latent 连续性、Drift-Control、SelfLift、原生 Loop | main · [`a81f13b`](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/commit/a81f13b8af4a162467cec4dc377f40b7354d7ffc) | [GPL-3.0](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/LICENSE) |
| [AIMixer / ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director) · AI 搅拌手 | 选择运行、分段缓存、段间引导、SelfLift、独立二采 / 放大、导演包 | main · [`5c7bdc8`](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/commit/5c7bdc85fcc7e35849a89d0ba805299801fc6282) | [Apache-2.0](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/LICENSE) |
| [yolain / ComfyUI-Easy-Media](https://github.com/yolain/ComfyUI-Easy-Media) · 乱乱呀 | H3 项目分段、保存 / 续跑、双采样、素材按需加载、生成预览 | main · [`672f308`](https://github.com/yolain/ComfyUI-Easy-Media/commit/672f3083e6588ca1d70c2ae0976c85e0e1755a3d) | [GPL-3.0](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/LICENSE) |
| [nkxx188 / ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy) · H3 Easy | 简洁生成入口、片段素材引用、逐片段控制、分段精修与解码 | main · [`4fea600`](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/commit/4fea6000302de9a551505095e5f2153a7ddf2079) | [MIT](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/LICENSE) |

这里的 commit 用于复看本次讨论所依据的版本。真正接入某项能力时，再检查上游更新并锁定实际采用的版本，不把上述链接当作永远不变的“最新版”。

## 3. Songssx TimelineDirector：长视频与 SelfLift 参考

说明入口：[中文 README](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/README_CN.md)。示例入口：[example_workflows/](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/tree/a81f13b8af4a162467cec4dc377f40b7354d7ffc/example_workflows)，优先复看“MiniMaxH3全功能合一完全体导演台工作流”。

主要入口：

| 文件 / 节点 | 复看内容 |
| --- | --- |
| [minimax_h3_timeline_director.py](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/minimax_h3_timeline_director.py) · `MiniMaxH3TimelinePlanner`、`MiniMaxH3TimelineEncoder` | UI 时间线与素材配置如何变成完整分段计划、每段条件及初始 AV latent |
| [minimax_h3_finite_segments.py](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/minimax_h3_finite_segments.py) · `MiniMaxH3FiniteSegmentSampler` | 一次工作流内部展开整组采样、前段 latent 传给后段、解码与合并 |
| 同文件 · `MiniMaxH3FiniteLatentContinuation`、`MiniMaxH3FiniteSegmentFinalize` | 重叠连续性、单帧 guide 分支、音视频 overlap 裁剪与累计 |
| 同文件 · `_selflift_settings` | 二次潜空间放大开关、模型、高清阶段步数及总步数校验 |
| [experimental_latent_guide.py](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/experimental_latent_guide.py)、[drift_control_av.py](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/blob/a81f13b8af4a162467cec4dc377f40b7354d7ffc/drift_control_av.py) | latent 尾部复制、噪声 mask、视频保护与 Soft AV |
| [selflift_runtime/](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/tree/a81f13b8af4a162467cec4dc377f40b7354d7ffc/selflift_runtime) | 低分辨率采样、潜空间放大、高清阶段采样和低分辨率 carry |

### 与我们的 UI 对应

- 生成片段应对接 `segmentConfig.segments`；参考实现的 `videoClips` 是输入参考视频素材。
- 二次潜空间放大配置属于整条计划：`secondPass`、`secondPassModel`、`secondPassHighSteps`。
- 本轮 UI 使用项目级 `latentUpscale` 配置，具体映射见蓝图 §9.2。
- 首尾紧贴时自动引用上一段尾帧、选定片段重跑等需求，先查本页其他参考的对应实现，再对当前链路补充。不能把本项目已设计的 UI 行为误记为此参考已经完整提供的能力。

## 4. AIMixer Director：生成模式、SelfLift 与独立二采

说明入口：[README.md](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/README.md)。示例入口：[example_workflows/](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/tree/5c7bdc85fcc7e35849a89d0ba805299801fc6282/example_workflows)，其中“minimax_h3_director_二采_加速.json”用于复看 Refine 与 H3 latent 放大接线。

根据仓库说明，该导演台把分段计划、官方 H3 条件编码、采样、解码和导出组织在一起；支持多种生成模式、段间引导、原声策略、渐进采样和独立精修。

| 文件 | 优先复看内容 |
| --- | --- |
| [nodes/director.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/nodes/director.py) → [director/executor_core.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/director/executor_core.py) | 主节点定义与导演计划执行入口 |
| [nodes/director_selflift.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/nodes/director_selflift.py)、[director/selflift/sample.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/director/selflift/sample.py) | SelfLift 渐进采样参数及执行 |
| [nodes/director_refine.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/nodes/director_refine.py)、[director/refine_sampling.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/director/refine_sampling.py) | 同尺寸精修、放大后二采、仅潜空间放大；可选二采生成模型 |
| [director/segment_continuity.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/director/segment_continuity.py) | 将上一段尾部运动 / 音频用于下一段生成的引导 |
| [director/segment_cache.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/director/segment_cache.py)、[director/segment_mp4_export.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/director/segment_mp4_export.py) | 分段结果、AV latent 与低清 carry 的磁盘缓存，以及 MP4 导出 |
| [director/pack.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/director/pack.py) | 导演包的数据与素材打包相关实现入口 |

“只运行选中片段、复用其他片段结果”可优先看主执行文件与上述缓存模块：前段上下文先查本次结果，再读取已保存缓存；缺少所需结果时明确报错。后续接入我们 UI 的当前片段生成按钮时，应一并核对缓存指纹、失效与连续性条件。媒体、缓存和项目包接口还可复看 [director/http_routes.py](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/blob/5c7bdc85fcc7e35849a89d0ba805299801fc6282/director/http_routes.py)。

需要分别理解其两个入口：

- **SelfLift**：低分辨率前缀、3D latent lift、高清收尾，导演台分辨率仍是目标画布。
- **Refine**：已有首遍结果之后再精修或放大；`upscale`、`refine`、`latent_upscale` 的行为不同。Refine 的目标尺寸与首遍画布应分别对待。

这些能力可在用户提出精修、检查首遍结果、替换二采模型等需求时优先查阅。当前不自动把这些模式全部增加为 UI 控件。

## 5. Easy Media：项目执行、结果续跑与资源使用

说明入口：[中文 README](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/README_CN.md) / [英文 README](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/README.md)。

Easy Media 是通用媒体工具包，包含独立于模型的多轨编辑器，也包含明确面向 MiniMax H3 的 MultiTrack Project 生成链路。我们重点参考它的 H3 运行、媒体与结果处理，不迁移其完整多轨界面。

| 文件 | 优先复看内容 |
| --- | --- |
| [nodes/project.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/nodes/project.py) · `EasyMultiTrackProject` | 逐段执行、首遍 / 二采 / SelfLift、起始片段与数量、首遍 checkpoint 续跑 |
| [nodes/minimax.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/nodes/minimax.py) | H3 编码、首尾帧 / 多参考输入、音频锁定、H3 latent 放大与高分辨率连续性 |
| [modules/selflift/h3_latent_upscale.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/modules/selflift/h3_latent_upscale.py)、[modules/selflift/sampling.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/modules/selflift/sampling.py) | 潜空间放大、SelfLift、分块与模型释放 |
| [utils/h3_project.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/utils/h3_project.py) | 项目记录、分段结果与上下文保存 / 加载 |
| [utils/h3_conditioning_cache.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/utils/h3_conditioning_cache.py)、[utils/project_memory.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/utils/project_memory.py) | 条件缓存和按段执行时的内存管理 |
| [utils/sampling_preview.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/utils/sampling_preview.py) · `send_preview` | 带任务、节点、片段索引和采样阶段的预览消息 |
| [routes.py](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/routes.py) | 项目和 input 素材相关服务入口 |

优先复看的示例：

- [example_workflows/MiniMaxH3_AllInOne_LatentUpscale.json](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/example_workflows/MiniMaxH3_AllInOne_LatentUpscale.json)
- [example_workflows/MiniMaxH3_v1.3.1_Easy_Project_AllInOne.json](https://github.com/yolain/ComfyUI-Easy-Media/blob/672f3083e6588ca1d70c2ae0976c85e0e1755a3d/example_workflows/MiniMaxH3_v1.3.1_Easy_Project_AllInOne.json)

需要保留的参数区别：

- `dual` 是首遍结果放大后进行第二遍采样；`selflift` 是渐进采样，两者的步数与分辨率语义不同。
- `model_loader_2nd` 是第二阶段的 H3 生成模型；`upscale_model` 是潜空间放大权重。
- 低分辨率与高分辨率阶段分别承接对应的前段结果，不能只把低清接缝放大就视为完成高清连续性。
- 在现有链路上增加分段存盘、断点继续或控制内存时，先查上述实现，再选取适合本项目的部分。

## 6. H3 Easy：片段控制、素材隔离与分段精修

说明入口：[中文 README](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/README_CN.md) / [英文 README](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/README.md)。节点注册见 [__init__.py](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/__init__.py)。

| 文件 / 节点 | 优先复看内容 |
| --- | --- |
| [nodes.py](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/nodes.py) · `MiniMaxH3EasyMediaLoader` | 图像、视频、音频统一输入及参考视频解码缓存 |
| 同文件 · `MiniMaxH3EasyContextSegments` | 每段 prompt、时长、引用素材及连续性计划 |
| 同文件 · `MiniMaxH3EasySegmentSampleSetup`、`MiniMaxH3EasySegmentStep`、`MiniMaxH3EasySegmentCollect` | 共用采样配置、逐段种子 / 可选提示词覆盖、逐片段控制和结果收集 |
| 同文件 · `MiniMaxH3EasySegmentRefine` | 逐片段像素或潜空间放大精修，以及 Low VRAM Tile 选项 |
| 同文件 · `MiniMaxH3EasySegmentDecode` | 分段解码到临时视频，返回完整 VIDEO，减少完整 RGB 时间线驻留 |
| [h3_latent_upscaler.py](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/h3_latent_upscaler.py)、[sampling_strategies.py](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/sampling_strategies.py) | 3D H3 latent upscaler 与 SelfLift 采样策略 |
| [web/minimax_h3_easy_ui.js](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/web/minimax_h3_easy_ui.js) | 素材管理与引用标签转换，可按需查逻辑 |

优先复看的示例：

- [workflow/3.MiniMax_H3_Easy_Context_Segments.json](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/workflow/3.MiniMax_H3_Easy_Context_Segments.json)
- [workflow/4.MiniMax_H3_Easy_Context_Segments_Refine.json](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/workflow/4.MiniMax_H3_Easy_Context_Segments_Refine.json)
- [workflow/5.MiniMax_H3_Easy_Context_Segments_Control.json](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy/blob/4fea6000302de9a551505095e5f2153a7ddf2079/workflow/5.MiniMax_H3_Easy_Context_Segments_Control.json)

它的逐片段素材规则与我们已定的资产池方向很接近：素材可以在项目中共享，但每段只提交该段实际引用的素材，并为该段重新映射模型引用编号。

README 中的逐片段 Step 链支持各段种子与可选 prompt override，选择性重跑属于这个具体工作流能力。后续实现我们自己的“重跑当前片段”时，应先复看该入口及 Easy Media 的持久化执行方式，确认所需缓存与前段上下文。

## 7. 遇到需求时的快速导航

| 需求 | 先查哪里 |
| --- | --- |
| 让当前 UI 驱动整组分段生成 | TerryDirector Timeline Compiler + ComfyUI GraphBuilder；Songssx FiniteSegmentSampler 用于对照边界与连续性 |
| 当前 UI 的二次潜空间放大 | Songssx `_selflift_settings` 与 `selflift_runtime` |
| 独立二采、放大倍率、替换二采生成模型 | AIMixer Refine；Easy Media `dual` |
| 只重跑某段 / 从中间继续 | AIMixer 选择运行 + 分段缓存；H3 Easy Segment Step；Easy Media Project + `utils/h3_project.py` |
| 分段保存、减轻长视频内存占用 | H3 Easy Segment Decode；Easy Media 项目与内存工具 |
| 图片 / 音视频共享池，按段隔离引用 | H3 Easy Media Loader + Context Segments；Songssx 每段素材规划 |
| 生成预览绑定正确片段与采样阶段 | Easy Media `utils/sampling_preview.py`，结合现有 ComfyUI 预览链路 |
| 原声锁定、AV 连续性 | Songssx locked audio / Soft AV；Easy Media H3 编码；H3 Easy Digital Human |

## 8. 本轮采用与后续候选

**当前已确认的 SelfLift UI**为项目共用、默认关闭、自动选择或指定兼容 H3 潜空间放大模型，并使用 `0.0–1.0` 高清占比，默认 `0.25`；执行时再由总步数换算实际高清阶段步数。

参考中的独立二采、低显存分块、首遍确认、选段续跑等先作为候选实现记录。用户提出对应需求时优先查阅，不提前扩大当前 UI。

后续实际采用的实现可在这里追加简短记录：

| 日期 | 本项目能力 | 来源 commit / 文件 | 适配差异与实际验证 |
| --- | --- | --- | --- |
| 2026-09-29 | 二次潜空间放大 UI 配置 | Songssx [`a81f13b`](https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector/commit/a81f13b8af4a162467cec4dc377f40b7354d7ffc) · `_selflift_settings` | 映射为项目级 `latentUpscale`；当前仅 UI 与配置导出，未连接实际采样 |
