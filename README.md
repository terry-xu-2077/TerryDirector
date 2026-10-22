# TerryDirector

**ComfyUI 视频导演工作台** · 时间线编排 / 分镜连续生成 / Self-Lift 二采 / 逐镜头 MOV / MP4 输出

TerryDirector 是一套直接运行在 **ComfyUI** 中的视频镜头编排节点。使用内嵌时间线与页内编辑窗口组织多个片段的提示词、参考素材、时长和镜头衔接，将镜头串联生成视频，无须为每个片段手工复制工作流。

当前正式生成适配面向 **MiniMax H3**；循环节点采用模型适配层，**LTX 2.5 仅预留接口，尚不可运行**。

## 主要功能

- **可视化时间线**：片段移动、裁切、吸附、重叠、挂起、单片段状态与采样进度；编排数据随 ComfyUI 工作流保存。
- **提示词与素材管理**：全局／片段提示词、可视化与原文编辑、`@` 引用共享资产池、图片素材导入和灯箱查看。
- **镜头连续性**：尾帧参考、尾帧续接、独立镜头与重叠区条件；自动利用上一片段的实际结果。
- **片段级 Seed**：每个片段可单独指定生成 Seed；留空时继续跟随 TerryDirector 节点的全局 Seed。
- **片段级 AI Seed**：每个片段可单独指定提示词增强 Seed；留空时跟随 TerryDirector Llama 的全局 AI Seed。
- **通用循环器主线**：将兼容的 ComfyUI 视频生成工作流置入循环域，逐段生成。旧 Base / Advanced 已停止注册，旧工作流须使用旧版提交打开或迁移至循环器。
- **Self-Lift**：循环体可接入现有 H3 / Self-Lift 或将来其他已适配的采样节点；独立 TerryDirector SelfLift 采样能力保留，旧版二采配置链已移除。
- **可剪辑镜头交付**：每轮立即保存完整镜头为 MOV / ProRes 422 HQ（默认）或 MP4 / H.264。分段与编号清单直接写在下游 SaveVideo 的目标目录，例如 `timeline_segments_00001_001_镜头名.mov`；结束时可选按重叠帧裁切、音频同步后生成同组 `*_Final.mov` / `*_Final.mp4`，各镜头原文件保留。
- **仅重跑指定镜头**：在时间线编辑器标题栏或右键菜单执行，自动从上一镜头历史 MOV/MP4 提取真实尾帧或重叠音画；找不到来源时拒绝运行，不改变原有挂起关系。重跑另存一个版本，不覆盖旧 Final。
- **实体视频片段**：从已有 ComfyUI input 视频资产插入蓝灰色上下文片段；循环跳过其 AI 采样，允许后续镜头以其尾帧或重叠区域作为条件；目前只作上下文，不参与 Final。

## 安装

在已有 ComfyUI 的 `custom_nodes` 目录执行：

```bash
git clone https://github.com/terry-xu-2077/TerryDirector.git
```

重启 ComfyUI，并在节点搜索中输入 **TerryDirector**。已有安装可在仓库内执行 `git switch main`、`git pull --ff-only` 后重启，浏览器缓存未更新时可按 `Ctrl+F5`。

**环境与模型**：建议使用最新版 ComfyUI（Windows、RTX 3090 实测环境）；需自行提供 MiniMax H3 模型、文本编码器、视频／音频 VAE。Self-Lift 高清放大还需相应的 H3 latent upscaler 权重。外部模型加载、LoRA 和注意力优化节点是否需要安装，由你的实际工作流决定；本项目不会替你安装模型权重。

## 节点一览

已移除 Base / Advanced 及其专属配置与输出节点的新版本注册。**请先备份旧工作流**；若必须打开旧节点，请切换到历史提交 `b751b93` 或使用 Git 历史恢复。新工作流只使用循环器及通用增强节点。

| 节点 | 用途 |
| --- | --- |
| **TerryDirector 循环开始** | 时间线驱动外部生成工作流；支持从历史 MOV/MP4 续跑 |
| **TerryDirector 循环信息** | 输出镜头提示词、Seed、帧数、参考素材和片段数据 |
| **TerryDirector 循环条件** | 为 H3 当前镜头应用尾帧或重叠音画条件 |
| **TerryDirector 循环结束** | 每轮保存 MOV/MP4，按需组合 Final，输出执行报告和片段目录 |
| **TerryDirector Llama** | 共享本地 Llama/VLM 的提示词增强能力 |
| **TerryDirector 提示词增强编辑器** | 连接 Llama 后增强 STRING 提示词 |
| **TerryDirector 双采样分辨率选择器** | 只输入高清目标 MP，低清自动取 1/4；共用宽高比并实时预览两组分辨率 |
| **TerryDirector H3 2X 低内存解码** | 兼容已有 2X VAE 的可选显存／RAM 优化链 |

独立 SelfLift 内部节点仍可被现有工作流按节点 ID 使用，但不再提供 Base / Advanced 的封装式二采配置。

### 分阶段 SelfLift 示例工作流

推荐从 [工作流③：暂停/继续 · 0.2→0.8 MP](examples/TerryDirector_SelfLift_03_Pause_Continue.json) 开始。它使用 FL2VA BF16、Qwen3VL INT8 ConvRot、CFG=1、seed=8 与 H3 Sigma Refiner；先运行低清审片，确认后再续采高清。完整参数和独立工作流见 [SelfLift 示例说明](examples/SELFLIFT_SPLIT_README.md)。

## 怎样连接

### 时间线循环器

```text
TerryDirector 循环开始 ─ 循环上下文 ─→ TerryDirector 循环信息
                                          ├─ 提示词 / 采样帧数 / Seed / 图片
                                          └─ 片段数据 ─→ TerryDirector 循环条件
                                                           │
                           H3 / Self-Lift / 自定义采样链 ←──┘
                                                  │
                                                  ▼
                                      用户自己的解码节点
                                      ├─ IMAGE ─────────┐
                                      └─ AUDIO ───────┐ │
                                                      ▼ ▼
                                       TerryDirector 循环结束
                                                  │
                                                  ├─ 完成镜头 MOV/MP4：逐段自动保存
                                                  ├─ 最终整片 VIDEO（默认合并开启）
                                                  ├─ Markdown 循环性能记录
                                                  └─ 片段输出目录
```

循环开始与循环结束之间会自动绘制一个不参与执行、不写入工作流分组的低透明度 **圆角凸包「TerryDirector 循环域」**，用于像 Houdini For-Each Block 一样直观看出循环体范围；区域会随循环体节点移动和连接关系自动更新。循环信息对齐官方 H3 参考上限，提供 9 个图片、3 个视频和 3 个独立音频参考输出；视频会以 24 fps IMAGE 帧序列交给官方 H3 Reference to Video。循环结束节点内直接设置「片段保存格式」（默认 MOV · ProRes 422 HQ，另有 MP4 · H.264）以及「循环结束合并整片」（默认开启）。片段在每轮结束时立即编码为完整原镜头视频；最终合并按时间线自动裁掉新片段的重叠开头，精准对齐 24fps 视频和 48kHz 音频。下游 SaveVideo 的 `filename_prefix` 同时决定分段目录和任务身份；修改目录或前缀会开始一个新任务。分段、`timeline_segments_00001.json` 和可选 `timeline_segments_00001_Final.mov` 平铺在该可见目录，内部任务哈希只写入 JSON。循环节点发现完全匹配的未完成任务时显示圆圈感叹号，用户在编辑器中选择「继续未完成」后才会跳过已完成片段。报告自动保存在 `output/TerryDirector/reports/`。循环结束只接收用户工作流已经解码完成的 IMAGE/AUDIO；当前片段元数据由循环器内部注入，因此无需再从「循环信息」手动拉一根「片段数据」到循环结束。

## 时间线与编辑

点击节点内的迷你时间线，即可在当前 ComfyUI 页面打开导演编辑窗口；编辑片段、提示词与共享素材后「保存并退出」。挂起片段保留在创作时间线里，但不会提交采样。尾帧参考／续接／独立等行为可在片段接缝处调整，并可在 ComfyUI 的 TerryDirector 设置里配置默认衔接方式。

[在线交互预览](https://raw.githack.com/terry-xu-2077/TerryDirector/main/index.html) 可直接查看最新编辑器布局：网站从 [AI 验收工作流](examples/TerryDirector_AI_3clips_0.2MP.json) 读取三段真实提示词、全局提示词、尾帧参考与七项图片资产信息，并提供“适应／宽／中／窄”的界面宽度预设。**这是静态界面演示**（引用旧 Base 样本只为了保留既有 UI 演示数据，不能直接作为新版本循环工作流运行），不连接 ComfyUI、不运行 LLM；七张参考图片的原文件未公开，图片卡片显示注明的占位缩略图。网站「AI 增强提示词」标签另加载 [H3 Skill 六段式英文增强示例](examples/TerryDirector_AI_3clips_demo_prompts.json)，可与未修改的三段中文原文切换对比；这些文字是**依据内置官方 Skill 手工编写的静态展示稿，不是实际 Qwen 推理输出**。示例仅注入网页显示层，不修改 [GPU 验收用工作流](examples/TerryDirector_AI_3clips_0.2MP.json) 中刻意保留为空的 `aiPrompt`。链接经只读静态代理预览当前主分支。

## 使用边界

TerryDirector 当前以 24 fps 编排视频；不同生成链对帧数和参考素材有各自限制。循环器 MOV/MP4 输出需要足够磁盘空间，不默认生成整段 .pt。Self-Lift 性能、画质和显存占用与模型、分辨率、注意力后端及工作流配置有关。

循环器的模型适配器中，`minimax_h3` 已可运行，`ltx_2_5` 仍是明确禁用的预留实现。不会静默把 LTX 数据按 H3 方式解码。

## 文档

- [使用指南与常见问题](docs/USAGE.md)
- [双采样分辨率选择器](docs/DUAL_SAMPLING_RESOLUTION_SELECTOR.md)
- [当前节点与执行架构](docs/ARCHITECTURE.md)
- [已验收环境、参数与测试基线](docs/STABLE_BASELINES.md)

正式版本以 `main` 为准。仓库保留 Git 提交历史供追溯，当前文件树不再包含历史任务书、实验工程和测试报告。
