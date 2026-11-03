# 当前架构（TerryDirector `main`）

本文只描述当前仍在使用的节点、接口和文件。历史设计稿、任务书和逐次性能实验已从当前文件树移除；验证依据集中在 [稳定基线](STABLE_BASELINES.md)。需要追溯旧实现可使用 Git 历史。

## 节点和运行路径

TerryDirector 是一个 ComfyUI 扩展，入口为根目录 `__init__.py` 的 `comfy_entrypoint()`。目前唯一的正式导演生成路径是：

**时间线循环器：** `TerryDirectorLooper` → `TerryDirectorLoopInfo` → 用户自己的 H3 / Self-Lift / 解码节点组及 `TerryDirectorLoopCondition` → `TerryDirectorLoopEnd`。循环器依托 ComfyUI 原生 LoopIteration / LoopProgress / LoopResult 展开，隐藏缓存及上下文回传。循环体必须自行完成解码并向循环结束提交最终 `IMAGE + AUDIO`；LoopEnd 不再接收 VAE 或 LATENT，也不执行解码，只输出流式 `VIDEO`。

**通用功能节点：** `TerryDirectorSelfLiftSampler`、`TerryDirectorH3X2LowRAMDecode`、`TerryDirectorLlamaConfig` 与提示词增强编辑器。循环器内部以 LoopFrame、LoopReuse、LoopCache 等节点完成连续性和流式输出；不再注册旧版 Base/Advanced 专属缓存及封装节点。

## 目录结构

根目录仅保留 Python 扩展入口 `__init__.py`。节点实现、采样／缓存支持模块和 HTTP 路由统一位于 `nodes/`，内部使用包内相对导入；`web/`、`src/`、`assets/`、`ai_skills/` 和 `index.html` 保持资源目录。资源定位以项目根目录为准，不随节点文件位置变化。

## 模块职责

| 路径 | 运行职责 |
| --- | --- |
| `__init__.py` | 注册节点与前端资源、加载 HTTP 路由 |
| `nodes/director_core.py` | 时间线文档、配置校验和序列化（保留部分历史数据格式供兼容读取） |
| `nodes/director_compile.py` | H3 的提示词、素材映射、片段时长、帧数和首尾关系编译 |
| `nodes/director_selflift*.py` | 内置 Self-Lift 采样、潜空间放大、数学和高清分块 |
| `nodes/director_selflift_stage_nodes.py`、`nodes/director_selflift_stages.py` | 独立低清／高清采样及各自步数控制，通过 LATENT 元数据承接过渡 |
| `nodes/director_pause_resume.py`、`nodes/director_latent_checkpoint.py` | 模型无关的 lazy LATENT 暂停边界；safetensors 与类型化 JSON 缓存，普通 Tensor／NestedTensor 原样恢复 |
| `nodes/director_loop.py` | 循环开始、循环信息／条件／结束及动态子图 |
| `nodes/director_loop_adapters.py` | 模型适配器注册与 H3 模型专属策略；LTX 2.5 仅占位 |
| `nodes/director_loop_media.py` | 每轮编码完整 ProRes MOV / H.264 MP4、保存轻量承接数据和 timeline.json；按时间线重叠剪辑 Final |
| `nodes/director_loop_report.py` | 对外部循环执行进行独立采集；以真实循环/采样进度与周期资源快照生成 Markdown 报告，不承担模型生成或解码 |
| `nodes/server_routes.py` | 编辑器入口、ComfyUI input 资产与磁盘空间只读查询 |
| `web/` | ComfyUI 节点内控件、迷你时间线、弹窗及事件监听 |
| `src/`、`assets/`、`index.html` | 正式浮窗复用的 UI 资源和静态预览入口 |

正式入口不依赖仓库的测试目录或实验运行时。可选诊断型工具与实验采样路径已从产品源码树清理，生产节点不自动加载实验插件。

## 时间线与状态

- 创作数据保存在当前节点的 `config_json` 中，包括全局/片段 Prompt、素材引用、时间范围、首尾关系、挂起状态。
- 每段的具体生成参数由编译器产生；ComfyUI 运行时使用唯一子图 ID 维护片段执行状态，生成过程的进度不写回创作文档。
- 用户编辑界面与 ComfyUI 画布共享节点内容，运行中的节点编辑器只读；不同 TerryDirector 节点之间状态隔离。
- H3 默认编译以 `5 + 17n` 帧数对齐，再按时间线长度裁切；此规则不能直接推广到其他视频模型。


## 可选 AI 提示词增强

用户界面中的 **TerryDirector Llama** 是共享 AI 推理能力提供节点：它集中声明 GGUF / VLM、系统提示词、AI Seed 与采样参数，循环开始以及其它 Terry 系列编辑器通过其输出获得同一套 AI Runtime 能力。内部类型和输入名仍使用 `TerryDirectorLlamaConfig` / `llama_config` 作为实现标识，但它们不代表产品层只是“配置文件节点”。

节点本身不在普通 `execute()` 阶段长期持有一个 Llama 模型对象；真正的模型加载、会话复用、推理锁、流式 token、中断和结果校验统一由 `nodes/director_ai.py` / `AIManager` 管理。这样多个消费者不会各自复制或重复加载一套 Llama 后端。**TerryDirector 提示词增强编辑器**是第一个通用消费者：Python 节点本身只透传 STRING，前端 ✦ 按钮通过共享 `globalThis.TerryDirectorAI` provider 调用同一个 HTTP Job / AIManager；后续其它 Terry 编辑器应复用该 provider，而不是复制 GGUF 加载逻辑。`TerryDirectorLlamaConfig` 同时提供系统提示词预设与可连接的多行自定义 system prompt：自定义值会先 `strip()`，非空时完整替换 system role；空白值回退到预设，默认预设为 H3 Skill。`nodes/director_ai_node.py` 负责能力节点定义，
`nodes/director_ai_core.py` 负责 AI Seed 独占的自动重做规则，`nodes/director_ai.py` 负责本地
`llama-cpp-python` 加载、系统提示词选择、多模态资产编码、结果校验以及 Queue / 编辑器增强运行，
`nodes/director_ai_jobs.py` 与 `nodes/server_routes.py` 负责编辑器独立 HTTP Job、进度与取消。

全局提示词的原始文本、AI 文本和当前选择独立保存为 `globalPrompt`、`aiGlobalPrompt` 和 `globalPromptMode`；编译器与片段 AI 增强读取同一个 effective 全局版本。全局手动增强使用独立 `scope=global` HTTP Job，加载一次 Qwen/VLM 检查原始参考标签，不经过 ComfyUI Queue；其结果为跨片段约束，不包含单段的六节 Ref2VA 镜头结构。全局结果只由手动增强刷新，现有自动增强开关不自动重写全局内容。

Queue 自动模式先统一执行 `prepare_document_for_queue()`，冻结本次片段 AI 文本后才调用
原来的 `compile_timeline()`；不修改循环器的 Self-Lift、重叠或尾帧上下文执行规则。
`config_json` 保存 `autoAiEnhance`、片段 `aiPrompt`、`promptMode`、`aiMetadata`。
后端 Queue 增强回写采用专用更新路径，避免调用正常编辑器 `writeConfig()` 时清空
循环器的执行中活动状态。AI Seed 是自动重新增强的唯一版本判定条件，源文 Hash
只用于标记提示词过期。

依赖在真正增强时才延迟导入；不改写全局 ComfyUI 模型卸载函数、不引入第二个
自定义 Llama 节点包。显存回收先于 H3 执行，且在批量任务期间复用同一 GGUF 实例。
历史三段 Base AI→H3 链路曾通过 Windows / RTX 3090 实机验收（见 `docs/AI_PROMPT_ENHANCEMENT_ACCEPTANCE_REPORT.md`）；新增的全局增强请求需要独立的实机回归。

## 预演台边界

预演台前端位于 `web/td_preview_task_manager.js`，任务库存储位于 `nodes/director_preview_task_store.py`，HTTP 接口统一使用 `/terrydirector/api/preview/`。新任务使用通用 LATENT 暂停节点生成的缓存；任务库存仅索引文件和清单，不解析采样状态或导入采样器实现。已有任务的视频和元数据继续可读，执行时由通用缓存模块独立验证格式。种子范围和采样进度按工作流输入识别，原生 SaveVideo / VHS 结果按本次执行编号关联。H3 时长、参考资产和轻量预览仍由单独的 H3 适配处理。

任务与工作流预设继续保存在原来的 `output/TerryDirector/preview_stage` 及通用 `checkpoints` 目录，接口和文件改名不迁移或删除用户数据。旧接口别名已移除，浏览器需重新加载新版扩展。

## Self-Lift 边界

公开的低清与高清采样节点分别设置 `low_steps` / `high_steps`，低清 LATENT 包含完整过渡上下文；高清原样执行剩余 Sigma 日程，`low_steps + high_steps` 必须等于完整 SIGMAS 的区间数。v3 过渡上下文保存实际低清输入尺寸、末次 callback 的原始 x/x0 及低清音频／噪声缩放，避免音频在 VAE 空间来回转换；不存种子、不绑定高清目标宽高。高清节点通过显式 width/height 构造目标视频网格，保留区域与 mask 从低清 source 缩放，时间和音频不变。长片放大器使用 reflect 时间 halo 与 Avatar 相同的重叠权重。分拆节点启用空间分块时，正向条件注入低清全幅参考并使用 overlap=6 与同源内容评分；旧单节点与 native checkpoint 路径继续使用各自原有分块参数。混用关键帧与独立参考时，裁剪后的 cond_video_latents 与 PackedLayout 同步重建。通用 `TerryDirectorPauseResume` 不导入 SelfLift 实现、不校验 H3 日程、不保存或恢复独立种子参数。它只负责 lazy 上游求值、磁盘缓存和下游 ExecutionBlocker；旧专用暂停节点不再注册。

旧版 Base/Advanced 的二采配置节点已移除。仍保留 `TerryDirectorSelfLiftSampler` 与 `nodes/director_selflift*.py` 共享实现，用户可在循环体或已有工作流中按需使用；也可使用第三方 Self-Lift 节点。TerryDirector 不主动修改外部模型或采样设置。

权重文件、MODEL patch、注意力后端与内存优化参数由上游 ComfyUI 工作流提供，不在插件启动时自动下载、注入或替换用户环境。

## 流式缓存与输出

独立循环器：每段由用户工作流自行完成采样与解码，循环结束只接收最终 IMAGE/AUDIO；当前片段元数据由 LoopFrame 直接注入隐藏 LoopCache。LoopCache **先从未压缩的原始画面／声音提取下一段承接上下文**，再逐段编码完整的 MOV / ProRes 422 HQ（默认）或 MP4 / H.264。保存位置从循环结束下游的 SaveVideo `filename_prefix` 推导，同一次运行的编号 JSON、分段和可选 Final 平铺在该目录；文件名使用可读前缀、五位运行序号、三位镜头序号和镜头名，随机任务 ID 只写入 JSON。LoopEnd 可选按时间线裁掉重叠开头并重组 `*_Final.mov` / `*_Final.mp4`。失败后通过相同工作流签名和保存前缀找到连续完成段，显式续跑时跳过这些段；普通提交始终分配新编号。

**资源边界：** 不保存完整 .pt 节省磁盘空间及最后重复编码，但无法消除当前单段 VAE 解码的 IMAGE 内存峰值。输出目录需要 FFmpeg（或 imageio-ffmpeg），ProRes 422 HQ 是高质量有损中间编码，不是对原 Float32 IMAGE 的数学无损。最终 MP4 存在 GOP 时需重新编码视频才能做到精确帧级裁切。

## 模型适配器

`nodes/director_loop_adapters.py` 目前登记 `minimax_h3`（默认、可运行）与 `ltx_2_5`（预留、`ready=False`）。

适配器负责：`compile_plan`、`sampling_frames`、`reference_media`、`apply_continuity`。MiniMax H3 的 `reference_media` 对齐官方参考额度：9 图片、3 视频、3 独立音频；视频资产在循环信息阶段解码为 24 fps IMAGE 帧序列。生成结果的最终解码不属于适配器或 LoopEnd，而是用户可编辑的循环体。

**LTX 2.5 尚不能运行。** 新增适配器必须先满足自己的合法帧数、参考输入与连续性条件构造，再允许注册为可用；未知模型不能静默复用 H3 Guide 语义。

## TerryTools 总线互操作

TerryDirector 前端的静态上游追踪会识别 TerryTools `TerryWireBusUnpack` / `TerryWirelessBusUnpack` 的虚拟输出解析接口。分辨率等静态参数即使经过 TerryTools 总线，也应回溯到真实来源节点（例如 `ResolutionSelector`），而不是在 Bus-Out 处停止。TerryTools 对 Bus-Out 暴露版本化的 `__terryBusResolveOutput(slot)` 接口；TerryDirector 同时保留对通用 `resolveVirtualOutput(slot)` 的兼容。总线重新接线时会触发循环输出检查刷新。

## 公共资产选择器

`web/td_asset_picker.js` 导出 `openAssetPicker({fetchApi, kind, onSelect, onClose?, source?, parent?})`，返回可幂等调用的 `{close}`。窗口自带样式、input/output 来源切换、按媒体类型过滤、搜索、分页、上传及关闭期间的异步回调保护，不依赖预演台状态。`onSelect` 接收 `{path, name, kind, source, preview_url}`；调用方负责写入自己的节点或任务。预演台通过 `openPreviewAssetPicker()` 接入单任务与批量参考槽位。

`nodes/director_assets.py` 统一媒体扩展名、目录约束、列表和导入，`nodes/server_routes.py` 提供 `GET /terrydirector/api/assets`（`source/kind/q/offset/limit`）及 `POST /terrydirector/api/assets/import`（`source/path/kind`）。列表按子目录相对路径搜索，默认每页 150 项；目录快照共享缓存 10 秒，搜索和分页复用快照，`refresh=1` 强制重扫，上传与导入立即使 input 快照失效。output 文件选中后以流式复制导入 `input/TerryDirector/imported`，使用唯一文件名，返回 input 相对路径，兼容只接受 input 的现有工作流加载器；原 output 文件保持原样。磁盘扫描及复制在线程中执行，不占用 HTTP 事件循环。原 `input-files` 与 `upload` 接口保留兼容。

图片及视频记录额外返回 `thumbnail_url`，原始 `preview_url` 与绑定路径保持独立。`GET /terrydirector/api/assets/thumbnail` 按需生成最长边 384 像素的 WebP，保留比例、透明度及 EXIF 朝向；JPEG 优先 draft 降采样，动画取首帧，小图不放大。缓存位于 ComfyUI user 目录的 `TerryDirector/asset_thumbnails`，按源路径、修改时间与大小区分版本；磁盘命中不解码原图，最多同时生成两张，同一源并发请求合并，支持 ETag。视频通过 FFmpeg 仅提取第一帧并在解码端缩小，不读取整段帧序列，共享相同的 WebP 缓存、并发上限和源文件版本判定；提取有 25 秒超时，失败时前端退回播放图标，仍可打开播放器。SVG 沿用原图预览。

`web/td_asset_grid.js` 提供纯 DOM 虚拟网格，只挂载可见区域及前后两行卡片，接近底部自动取下一页，保留手动「加载更多」。窗口关闭时清理滚动／尺寸监听和待执行绘制；快速搜索会取消旧列表请求。刷新按钮可立即读取外部新生成或改动的文件。视频列表卡片显示首帧缩略图，音频显示类型图标；点击后按需创建单个原生 `video/audio` 播放器（`controls`、`preload=metadata`）；预览使用原始 `preview_url`，确认「使用此资产」后才调用导入／选择回调。预览期间背景窗口 inert，关闭预览／窗口会暂停播放器、移除 src 并调用 load 释放资源，Esc 优先返回列表。播放错误保留选择入口，不强制转码。

## 兼容与维护

已实测的环境、默认采样数值、原始工作流 SHA 与可信提交基线汇总在 [STABLE_BASELINES.md](STABLE_BASELINES.md)。已退休的 Base / Advanced 源码仍可通过 Git 历史的 `b751b93` 追溯；Self-Lift 通用节点保持可用。循环器是否兼容更多模型，以相应适配器的独立实测为准。

界面配色、间距和时间线渲染以当前 `src/` 与 `web/` 代码为准；如需追溯恢复，时间线早期 UI 的固定提交基线为 `408395e7620fe368775515ca515d04fae7a8daed`。

诊断报告：`nodes/director_loop_report.py` 在循环执行旁路采集逐片段时间、原生节点/步数事件和 RAM/VRAM 时序，`nodes/director_loop_logmetrics.py` 在循环结束时按真实时间戳关联 Self-Lift 低清、升采样、高清与模型加载日志。自动导出同名 Markdown 和 JSON；不注入采样器、不额外解码 LATENT。报告不记录原始提示词/资产路径，未观测的数据明确显示未采集。

SelfLift 示例仅保留低清、高清、暂停继续三份。低清与高清均由原生 CreateVideo → SaveVideo 保存；预演台按低清 prompt ID 和 decoded_target 从执行历史关联结果，只保存文件引用，不复制或重编码视频。保存缓存按钮同时执行同源 LATENT 的旁路输出，继续按钮仅执行缓存之后的输出。暂停节点仍只缓存 LATENT。示例控件序列包括前端自动生成的固定值选项。
