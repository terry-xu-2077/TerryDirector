# 当前架构（TerryDirector `main`）

本文只描述当前仍在使用的节点、接口和文件。历史设计稿、任务书和逐次性能实验已从当前文件树移除；验证依据集中在 [稳定基线](STABLE_BASELINES.md)。需要追溯旧实现可使用 Git 历史。

## 节点和运行路径

TerryDirector 是一个 ComfyUI 扩展，入口为根目录 `__init__.py` 的 `comfy_entrypoint()`。正式注册的节点分为三组：

**标准导演：** `TerryDirectorSecondPassConfig`（可选）→ `TerryDirectorConfig` → `TerryDirector` / `TerryDirectorAdvanced`，基础版另接 `TerryDirectorOutput`。这条链负责模型、尺寸、音视频 VAE 与普通/二采参数。所有片段使用共享时间线、Seed、提示词与素材配置。

**独立循环器：** `TerryDirectorLooper` → `TerryDirectorLoopInfo` → 用户自己的官方 H3 生成节点组及 `TerryDirectorLoopCondition` → `TerryDirectorLoopEnd`。循环器依托 ComfyUI 原生 LoopIteration / LoopProgress / LoopResult 展开，隐藏缓存及上下文回传。循环结束只输出流式 `VIDEO` 与可选分段 `LATENT`；直接连接官方 SaveVideo。

**内部节点：** 负责分段缓存、潜变量加载、输出包装和素材重新采样；标记为内部用途，不需要用户在画布上手工连接。

## 模块职责

| 路径 | 运行职责 |
| --- | --- |
| `__init__.py` | 注册节点与前端资源、加载 HTTP 路由 |
| `director_core.py` | 时间线文档、配置和二采参数校验／序列化 |
| `director_compile.py` | H3 的提示词、素材映射、片段时长、帧数和首尾关系编译 |
| `director_h3.py` | 标准导演生成链的动态执行子图 |
| `director_node.py` | 配置、二采、基础／Advanced、输出节点 |
| `director_internal.py` | Base / Advanced 分段无损缓存、尾帧上下文、最终物化或编码 |
| `director_selflift*.py` | 内置 Self-Lift 采样、潜空间放大、数学和高清分块 |
| `director_loop.py` | 循环开始、循环信息／条件／结束及动态子图 |
| `director_loop_adapters.py` | 模型适配器注册与 H3 模型专属策略；LTX 2.5 仅占位 |
| `director_loop_video.py` | 从分段 .pt 缓存延迟读取并在 SaveVideo 中流式编码 VIDEO |
| `server_routes.py` | 编辑器入口、ComfyUI input 资产与磁盘空间只读查询 |
| `web/` | ComfyUI 节点内控件、迷你时间线、弹窗及事件监听 |
| `src/`、`assets/`、`index.html` | 正式浮窗复用的 UI 资源和静态预览入口 |

正式入口不依赖仓库的测试目录或实验运行时。可选诊断型工具与实验采样路径已从产品源码树清理，生产节点不自动加载实验插件。

## 时间线与状态

- 创作数据保存在当前节点的 `config_json` 中，包括全局/片段 Prompt、素材引用、时间范围、首尾关系、挂起状态。
- 每段的具体生成参数由编译器产生；ComfyUI 运行时使用唯一子图 ID 维护片段执行状态，生成过程的进度不写回创作文档。
- 用户编辑界面与 ComfyUI 画布共享节点内容，运行中的节点编辑器只读；不同 TerryDirector 节点之间状态隔离。
- H3 默认编译以 `5 + 17n` 帧数对齐，再按时间线长度裁切；此规则不能直接推广到其他视频模型。


## 可选 AI 提示词增强（开发分支）

`TerryDirectorLlamaConfig` 节点输出配置数据，不在节点执行时加载 Qwen；
Base / Advanced 多一个可选的 `llama_config` 输入。`director_ai_node.py` 负责节点定义，
`director_ai_core.py` 负责 AI Seed 独占的自动重做规则，`director_ai.py` 负责本地
`llama-cpp-python` 加载、H3 Skill、多模态资产编码、结果校验以及按片段保存 Queue 增强结果，
`director_ai_jobs.py` 与 `server_routes.py` 负责编辑器独立 HTTP Job、进度与取消。

全局提示词的原始文本、AI 文本和当前选择独立保存为 `globalPrompt`、`aiGlobalPrompt` 和 `globalPromptMode`；编译器与片段 AI 增强读取同一个 effective 全局版本。全局手动增强使用独立 `scope=global` HTTP Job，加载一次 Qwen/VLM 检查原始参考标签，不经过 ComfyUI Queue；其结果为跨片段约束，不包含单段的六节 Ref2VA 镜头结构。全局结果只由手动增强刷新，现有自动增强开关不自动重写全局内容。

Queue 自动模式先统一执行 `prepare_document_for_queue()`，冻结本次片段 AI 文本后才调用
原来的 `compile_timeline()`；不修改 `director_h3.py`、Self-Lift、重叠或尾帧上下文的执行规则。
`config_json` 保存 `autoAiEnhance`、片段 `aiPrompt`、`promptMode`、`aiMetadata`。
后端 Queue 增强回写采用专用更新路径，避免调用正常编辑器 `writeConfig()` 时清空
Advanced 的执行中活动状态。AI Seed 是自动重新增强的唯一版本判定条件，源文 Hash
只用于标记提示词过期。

依赖在真正增强时才延迟导入；不改写全局 ComfyUI 模型卸载函数、不引入第二个
自定义 Llama 节点包。显存回收先于 H3 执行，且在批量任务期间复用同一 GGUF 实例。
原三段 Base AI→H3 链路已通过 Windows / RTX 3090 实机验收（见 `docs/AI_PROMPT_ENHANCEMENT_ACCEPTANCE_REPORT.md`）；新增的全局增强请求需要独立的实机回归。

## Self-Lift 边界

当 `TerryDirectorSecondPassConfig` 接入 `TerryDirectorConfig` 后，采样日程由二采配置接管，普通采样器/调度器/步数/Denoise 在 UI 中置灰。Self-Lift 的低清采样、潜空间放大和可选高清精修在节点包内部完成，不要求安装外部 selflift-Avatar 采样节点。

权重文件、MODEL patch、注意力后端与内存优化参数由上游 ComfyUI 工作流提供，不在插件启动时自动下载、注入或替换用户环境。

## 流式缓存与输出

基础导演：完成各段后释放生成资源，最终物化一次完整的 IMAGE / AUDIO，由下游 CreateVideo / SaveVideo 处理，适合仍要对整条画面执行图像后处理的任务。

Advanced：每段存入无损 .pt 和可复用 LATENT 信息，支持断点恢复／片段重跑，最终一次性编码视频，避免中间 H.264 有损压缩。保存成功后清理生成时的分段画面缓存，保留必要的 checkpoint。

独立循环器：最后一个节点返回惰性 VIDEO 对象；官方 SaveVideo 请求 `save_to()` 时才逐段读取无损缓存，统一编码音频与视频，不先创建完整 IMAGE/AUDIO；最终保存成功清理对应运行目录。失败时保留缓存以便排查。分段 LATENT 只有被外部连线使用时才额外缓存。

**资源边界：** 文件化缓存减少时间线累积，但无法消除当前单段解码、VAE 与编码器的 RAM/显存需求。长时间线仍需足够的 ComfyUI 临时目录磁盘空间。

## 模型适配器

`director_loop_adapters.py` 目前登记 `minimax_h3`（默认、可运行）与 `ltx_2_5`（预留、`ready=False`）。

适配器负责：`compile_plan`、`sampling_frames`、`reference_images`、`apply_continuity`、`cache_segment`。这些职责把模型特定的帧数、参考图、Guide 和解码行为与通用循环框架区分开。

**LTX 2.5 尚不能运行。** 新增适配器必须先满足自己的合法帧数、条件构造与联合音视频解码，再允许注册为可用；未知模型不能静默复用 H3 实现。

## 兼容与维护

已实测的环境、默认采样数值、原始工作流 SHA 与可信提交基线汇总在 [STABLE_BASELINES.md](STABLE_BASELINES.md)。原 Base、Advanced 与 Self-Lift 的已验收行为是后续重构时必须保持的契约；循环器是否兼容更多模型，以相应适配器的独立实测为准。

界面配色、间距和时间线渲染以当前 `src/` 与 `web/` 代码为准；如需追溯恢复，时间线早期 UI 的固定提交基线为 `408395e7620fe368775515ca515d04fae7a8daed`。
