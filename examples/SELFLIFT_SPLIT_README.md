# TerryDirector · SelfLift 分阶段工作流

**默认示例已更新（2026-10-22）**：低清先审片，确认后再运行高清；高清转场只使用学习式 H3 3D Latent Upscaler，不执行中间 VAE 解码→放大→重新编码，不提供 SelfLift-zero 像素锚或 `nearest` 降级路线。

## 示例工作流

| 编号 | 文件 | 用途 |
| --- | --- | --- |
| **③ 默认推荐** | [暂停/继续 · 0.2→0.8 MP](TerryDirector_SelfLift_03_Pause_Continue.json) | 推荐主工作流；低清生成后保存检查点，审片通过再点击绿色按钮继续高清 |
| ① | [低清独立保存](TerryDirector_SelfLift_01_Lowres_Checkpoint.json) | 单独生成并保存低清检查点，同时保存低清审片视频 |
| ② | [高清独立读取](TerryDirector_SelfLift_02_Highres_Resume.json) | 从已有兼容检查点恢复高清，不重跑低清 |
| ④ | [0.5→2.0 MP 参考方案](TerryDirector_SelfLift_04_Reference_2MP_Highres.json) | 较高分辨率方案；开启高清空间分块，并连接独立高清 MODEL 优化链 |

## 默认参数（工作流③）

- **模型**：`minimax_h3_fl2va_bf16.safetensors`
- **CLIP**：`qwen3vl_32b_minimax_h3_int8_convrot.safetensors`
- **视频 VAE**：`minimax_h3_video_vae_int8_convrot.safetensors`
- **音频 VAE**：`minimax_h3_audio_vae_fp32.safetensors`
- **分辨率**：16:9；只输入高清目标 0.8 MP，自动推导低清 0.2 MP；预览低清 608×352、高清 1216×672；124 帧
- **采样**：`BasicScheduler(simple, 8)` → `H3SigmaRefiner(extra_steps=1, start_at_sigma=0.7, end_at_sigma=0, spacing=cosine)` → `SplitSigmas(step=6)`
- **Seed / CFG**：固定 seed=8，CFG=1。低清原生采样器和检查点节点共用同一个 SeedNode，避免两处种子不一致。
- **高清转场**：`minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`
- **高清空间分块**：默认关闭；模式 manual、4 块、axis auto（只有开启开关后才生效）
- **低清预览**：默认工作流③把低清 `denoised_output` 分成视频/音频两路 VAE 解码，接入 `TerryDirector 保存低清审片视频`，将完整有声 MP4 保存到同一个检查点的 `review.mp4`。KJ Model Preview Override 的动画帧由任务管理器接收最后一个预览事件并存为 `sampling_preview.mp4` 或 `.webp`；单帧模式只能保存 JPEG。

`H3SigmaRefiner` 增加一个低噪修整步；在完整 Sigma 日程上从第 6 步分段，因此高清会继续执行余下日程。检查点必须与对应模型、条件、目标分辨率和 Sigma 日程兼容。

**统一输入**：工作流①、③、④使用 `TerryDirector 双采样分辨率选择器`，**只有一个「高清百万像素」浮点输入**；低清 MP 由节点自动按高清 MP ÷ 4 计算，无需额外公式。低清条件和目标高清 Latent 使用同一个时长公式（默认 5 秒 → 124 帧），原生低清采样与检查点共用同一 SeedNode。工作流②从磁盘检查点恢复高清分辨率，因此不另设目标分辨率控件。

## 工作流③使用方式

1. 第一次运行点击蓝色 **「生成预演」** 按钮；低清采样完成后同时保存检查点和独立低清审片视频，高清分支不会执行。
2. 点击 ComfyUI 左侧 **预演台** →「打开预演台」；可切换检查点中的 VAE 解码视频与 TAEH3 采样预览。文件位于 `output/TerryDirector/checkpoints/<id>/review.mp4` 与 `sampling_preview.mp4/.webp/.jpg`。通过后点击绿色 **「继续高清」** 按钮或在任务管理器中提交高清续采；均不重跑低清。
3. 工作流中的 LoadImage 节点示例指向 `黄昏盐滩独行宇航员镜头首帧图片生成.jpg`。若本机没有该图片，请替换为自己的参考图，或断开该参考图输入。
4. 工作流①和②可以分开使用，但保存与读取必须对应同一组兼容参数；切换模型、参考条件、分辨率或 Sigma 日程时，请重新生成检查点。

**自定义工作流**：低清视频保存支路从原生 `SamplerCustom` 的 `denoised_output`（干净 x0）出发，经过 `VAEDecode` 与 `VAEDecodeAudio`，最后接 `TerryDirector 保存低清审片视频`（同时把「暂停/继续」的「检查点 ID」接到保存节点），才能自动在检查点目录中形成 `review.mp4`。仍可使用普通 `SaveVideo` 或 `VHS_VideoCombine`，但这两种节点按其自身路径保存、不会自动归档到检查点目录。蓝色按钮执行唯一的低清视频保存终点，绿色按钮不触发这条支路。

## 预演台（侧边栏入口）

ComfyUI 左侧边栏的「预演台」打开任务浮窗；旁边新增独立的「配置工作流」入口。
工作流设置只做一次，日常新建任务不用接触节点映射：

1. **配置工作流**：导入 ComfyUI 工作流 JSON，或直接使用当前画布；选择 SelfLift 暂停/继续节点，明确指定一个可编辑的**提示词输入节点**和**种子输入节点**，保存为工作流模板。每份配置独立保存在 `output/TerryDirector/preview_stage/templates/<配置ID>/` 下的 `config.json`、`workflow.json` 和 `api_prompt.json`，并由同级 `templates/index.json` 管理列表及默认项。支持多套工作流并列保存、改名、设置默认和单独删除；删除配置不会影响已生成的检查点。配置时一次性编译 API 工作流，后续任务只覆盖提交数据里的提示词、资产、种子及输出目标；不改 rgthree Seed / 采样器节点，也不打开新工作流标签。种子范围从实际 ComfyUI 节点定义读取，并取种子源、SamplerCustom 和暂停节点允许范围的交集。对经 SetNode/GetNode 与 TerryXu 无线总线传递的种子，也沿实际频道和 lane 追踪到采样器，不再误将总线里的「SEED」通道当作采样器。
   - **提示词映射**：配置工作流不再扫描所有文本控件猜测提示词；从实际 H3 生成节点的 `prompt` 接口沿连线反向查找可编辑的 STRING 源。反向追踪能够穿过 TerryXuMemoryCleanup、TerryXuWirelessBusPack/Unpack（按频道与 lane ID 映射）以及 TerryXuBoolSwitch（依据启用状态选择当前分支）。未接线时直接使用 H3 自身的提示词；不确定或多个来源时禁止误选，并在配置窗口显示原因。配置保存失败的具体错误也会显示在窗口内，方便定位无效映射。\n2. **新建预演**：仅需填写镜头名称、提示词、参考资产和种子，并切换一种预览视频类型。多个 LoadImage 用紧凑的图片网格展示，点缩略图可在资产选择器中搜索和更换，也可上传新图片。默认 **TAEH3 采样预览**，此时只执行低阶段采样和检查点保存，不执行额外的视频/音频 VAE 解码支路；选择 **VAE 解码预览** 才执行检查点目录里的 `review.mp4` 保存节点。两种预览不同时保存。
   - **完整 H3 富文本编辑**：预演台复用 TerryXu H3 编辑器的富文本标签渲染与共享菜单。左侧扩展编辑区显示可点击的 Subject / Picture / Video / Audio / Shot / Speaker / 时间戳 / 运镜 / 保留关系等标签；`<Picture N>` 显示当前任务参考图片的**行内缩略图**。对白块可在标签内修改语言、编辑台词，镜头编号、说话人、时间戳与运镜标签可点击修改。右侧为独立滚动的资产缩略图网格，修改图片时行内引用随任务重新渲染更新。支持 `@`（含全角 `＠`）资产菜单、`\\` / `/`（含全角字符）H3 全分类命令菜单、中文输入法与键盘导航。
   - **富文本 / 原文**：切换仅改变编辑呈现，提交仍通过原版 H3 序列化规则生成纯 STRING，绝不把 HTML 或缩略图写入采样器。完整富文本逻辑来自同一用户仓库 TerryXu-nodes 的 `h3_rich_text.js` / `h3_shared_menus.js`，在 TerryDirector 内独立适配并记录上游来源，避免运行时强依赖另一个节点包。
3. **继承已有任务**：新建预演时可把已由预演台生成、且保留完整工作流快照的任务作为来源，继承该任务的工作流、提示词、资产、Seed 和预览类型，并编辑出新版本；原检查点不变。
4. **管理与批量操作**：勾选任务可批量高清续采、批量删除。删除前二次确认；10 条及以上需要输入「删除」，正在被 ComfyUI 运行或排队使用的检查点禁止删除。

每次预演都存一份 `state.safetensors` 和 `manifest.json`。仅当用户选了相应预览类型且生成成功时，检查点文件夹会增加 `sampling_preview.mp4/.webp/.jpg` 或 `review.mp4`。
TAEH3 视频要求 KJ `Model Preview Override` 输出多帧（`preview_frames>1`）；若原工作流配置为单帧，只能得到 JPEG。TerryDirector 不修改 KJNodes 源码。原有检查点中如果没有保存 `task.json` 工作流快照，则无法无损继承旧任务的提示词和资产，但仍能在预演台中查看检查点。

**运行边界**：任务经 ComfyUI 标准队列执行；管理器从预先编译的独立 API 工作流克隆本次输入，并通过 `partial_execution_targets` 指定首阶段/二阶段目标，不再反复载入和还原当前画布。TAEH3 预览存档依赖浏览器实时接收到 KJ 事件，浏览器在采样过程中断线可能缺失预览媒体；检查点不受其影响。多任务真实 GPU 生成、浏览器断线、跨模型模板等需要本机继续回归。

## 高清 MODEL 输入口

`TerryDirectorSelfLiftHighres` 现只有一个 **「高清采样 MODEL」**。工作流 ②/③ 直接连接基础 H3 MODEL；工作流 ④ 将 `MiniMaxChunkFeedForward` 的最终优化 MODEL 直接连接此输入。要换模型或注意力优化策略，只需调整上游连线，不需要第二个 MODEL 插口。旧版含两个 MODEL 口的画布请重新导入已更新的示例，或手动删掉并重建高清节点以避免旧槽位错接。

## 独立工作流

- **① 低清保存**：同样使用 BF16 FL2VA、INT8 ConvRot CLIP、CFG=1、seed=8、8 步 simple 日程 + H3 Sigma Refiner，低清采样约 0.2 MP，保存目标 0.8 MP latent 检查点。
- **② 高清读取**：加载与检查点兼容的 BF16 FL2VA 和 INT8 ConvRot CLIP；提示词条件使用低清 0.2 MP 尺寸；高清节点默认关闭空间分块。
- **④ 0.5→2 MP**：实际取整为低清 960×544、高清 1888×1088；保留独立高清 MODEL 链 `ModelAttentionBackend → MiniMaxLowVRAMAttention(8) → MiniMaxChunkFeedForward(2,4096)`，并启用 4 块空间分块。该工作流的目标尺寸与显存压力更高，不作为默认审片样例。

## 模型要求

Upscaler 权重 `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` 应放在 ComfyUI 的 `models/latent_upscale_models/` 下。高清节点只使用有效的 H3 3D Latent Upscaler；不会自动回退到 `nearest` 或 VAE 往返。

最终用于导出视频和音频的 VAE 解码仍然保留；本次移除的是高清采样前的中间 VAE 往返。

详细架构：[SELFLIFT_SPLIT_NATIVE_SAMPLER_MVP.md](../docs/SELFLIFT_SPLIT_NATIVE_SAMPLER_MVP.md)。


## 工作流节点命名

示例工作流保留 ComfyUI 节点的默认名称，不通过自定义节点标题解释用途。每个工作流内的 **Markdown Note** 节点负责说明用途、关键参数与运行顺序；实际参数仍以节点控件和本机可用模型为准。
