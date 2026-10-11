# TerryDirector

**ComfyUI 视频导演工作台** · 时间线编排 / 分镜连续生成 / Self-Lift 二采 / 长视频流式输出

TerryDirector 是一套直接运行在 **ComfyUI** 中的视频镜头编排节点。使用内嵌时间线与页内编辑窗口组织多个片段的提示词、参考素材、时长和镜头衔接，将镜头串联生成视频，无须为每个片段手工复制工作流。

当前正式生成适配面向 **MiniMax H3**；循环节点采用模型适配层，**LTX 2.5 仅预留接口，尚不可运行**。

## 主要功能

- **可视化时间线**：片段移动、裁切、吸附、重叠、挂起、单片段状态与采样进度；编排数据随 ComfyUI 工作流保存。
- **提示词与素材管理**：全局／片段提示词、可视化与原文编辑、`@` 引用共享资产池、图片素材导入和灯箱查看。
- **镜头连续性**：尾帧参考、尾帧续接、独立镜头与重叠区条件；自动利用上一片段的实际结果。
- **三种生成工作方式**：标准 TerryDirector、带审片／局部重跑／中断恢复的 Advanced，以及使用普通 ComfyUI 采样节点组的时间线循环器。
- **内置 Self-Lift**：独立「二采配置」节点，连接到「TerryDirector 配置」后启用；不需要另装外部 Self-Lift 采样器。
- **长视频输出**：Advanced 与循环器使用无损分段缓存和单次最终视频编码，避免在生成阶段累积完整时间线的画面张量。

## 安装

在已有 ComfyUI 的 `custom_nodes` 目录执行：

```bash
git clone https://github.com/terry-xu-2077/TerryDirector.git
```

重启 ComfyUI，并在节点搜索中输入 **TerryDirector**。已有安装可在仓库内执行 `git switch main`、`git pull --ff-only` 后重启，浏览器缓存未更新时可按 `Ctrl+F5`。

**环境与模型**：已验证的环境为 ComfyUI **0.39.0**（Windows、RTX 3090）；需自行提供 MiniMax H3 模型、文本编码器、视频／音频 VAE。Self-Lift 高清放大还需相应的 H3 latent upscaler 权重。外部模型加载、LoRA 和注意力优化节点是否需要安装，由你的实际工作流决定；本项目不会替你安装模型权重。

## 节点一览

| 节点 | 用途 |
| --- | --- |
| **TerryDirector 配置** | 汇集模型、CLIP、视频／音频 VAE、分辨率和普通采样参数 |
| **TerryDirector 二采配置** | 配置内置 Self-Lift；可选连接到导演配置 |
| **TerryDirector** | 基础时间线生成节点，提供导演输出 |
| **TerryDirector Advanced** | 高级生成、视频审片、无损分段缓存、局部重跑与中断恢复 |
| **TerryDirector 输出** | 将基础导演输出转换为分段 LATENT、合并 IMAGE、合并 AUDIO |
| **TerryDirector 循环开始** | 按时间线驱动普通视频生成节点组 |
| **TerryDirector 循环信息** | 输出提示词、采样帧数、Seed、片段数据与参考图片 |
| **TerryDirector 循环条件** | 将前一段实际画面／声音应用于当前段的 H3 条件 |
| **TerryDirector 循环结束** | 收集分段缓存，输出流式 VIDEO 和可选分段 LATENT |

部分内部节点会自动注册供执行图使用，不需要手动添加到画布。

## 怎样连接

### 标准模式

```text
模型 / CLIP / 视频VAE / 音频VAE ─→ TerryDirector 配置
                                      │
                                      ▼
                                TerryDirector
                                      │ 导演输出
                                      ▼
                              TerryDirector 输出
                              ├─ 分段潜变量
                              ├─ 合并画面 ─┐
                              └─ 合并音频 ─┴─→ CreateVideo → SaveVideo
```

启用 Self-Lift 时，在「TerryDirector 配置」之前接入 **TerryDirector 二采配置**；普通采样参数会在二采接管后置灰。标准与 Advanced 共用二采配置体系。

### Advanced 模式

将上图中的主节点换成 **TerryDirector Advanced**；视频由 Advanced 自行保存，支持审片、已生成片段重跑和中断恢复。Advanced 的文件化输出**不等同于**基础模式的完整 IMAGE / AUDIO；需要编辑完整画面时请使用基础模式。

### 时间线循环器

```text
TerryDirector 循环开始 ─ 循环上下文 ─→ TerryDirector 循环信息
                                          ├─ 提示词 / 采样帧数 / Seed / 图片
                                          └─ 片段数据
                                                  ↓
                             官方 H3 生成节点组 + TerryDirector 循环条件
                                                  │ 采样结果
                                                  ▼
                                       TerryDirector 循环结束
                                       ├─ 视频 VIDEO ─→ 官方 SaveVideo
                                       └─ 分段潜变量（可选）
```

循环器直接输出 **VIDEO**，无需再连接 CreateVideo。循环结束会显示时长、分辨率、预计临时磁盘占用与剩余空间；最终封装格式、编码器和保存路径由下游 SaveVideo 决定。当前循环信息可对接 H3 图片参考，**不支持直接将其他模型采样结果接入并期望自动解码**。

## 时间线与编辑

点击节点内的迷你时间线，即可在当前 ComfyUI 页面打开导演编辑窗口；编辑片段、提示词与共享素材后「保存并退出」。挂起片段保留在创作时间线里，但不会提交采样。尾帧参考／续接／独立等行为可在片段接缝处调整，并可在 ComfyUI 的 TerryDirector 设置里配置默认衔接方式。

开发分支的 [在线交互预览](https://raw.githack.com/terry-xu-2077/TerryDirector/feat%2Fai-prompt-enhancement/index.html) 可直接查看最新编辑器布局：网站从 [AI 验收工作流](examples/TerryDirector_AI_3clips_0.2MP.json) 读取三段真实提示词、全局提示词、尾帧参考与七项图片资产信息，并提供“适应／宽／中／窄”的界面宽度预设。**这是静态界面演示**，不连接 ComfyUI、不运行 LLM；七张参考图片的原文件未公开，图片卡片显示注明的占位缩略图。链接经只读静态代理预览当前开发分支，正式 GitHub Pages 站点在合并主分支之前可能仍显示旧版。

## 使用边界

TerryDirector 当前以 24 fps 编排视频；不同生成链对帧数和参考素材有各自限制。标准模式的完整 IMAGE 输出仍需要足够系统内存；高级和循环器的流式输出依赖临时磁盘空间。Self-Lift 性能、画质和显存占用与模型、分辨率、注意力后端及工作流配置有关。

循环器的模型适配器中，`minimax_h3` 已可运行，`ltx_2_5` 仍是明确禁用的预留实现。不会静默把 LTX 数据按 H3 方式解码。

## 文档

- [使用指南与常见问题](docs/USAGE.md)
- [当前节点与执行架构](docs/ARCHITECTURE.md)
- [已验收环境、参数与测试基线](docs/STABLE_BASELINES.md)

正式版本以 `main` 为准。仓库保留 Git 提交历史供追溯，当前文件树不再包含历史任务书、实验工程和测试报告。
