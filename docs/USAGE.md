# 使用指南

此文档描述当前 `main` 的实际接口和接线方式。基础模式、Advanced、循环器可分别使用，不要求把三种模式串在同一个工作流中。

## 1. 首次配置

1. 将 TerryDirector 安装在 ComfyUI 的 `custom_nodes/TerryDirector`，重启后搜索节点名。
2. 使用本机已有的 MiniMax H3 模型、CLIP、视频 VAE、音频 VAE 建立模型加载链。
3. 新建「TerryDirector 配置」，连入上述四类依赖，并选择宽高比、百万像素、采样器等参数。
4. 在主导演节点中点击迷你时间线，编辑提示词、图片资产与片段时间，然后保存并退出。
5. 第一次生成建议只启用一个短片段，再逐步测试多片段、尾帧参考和重叠衔接。

节点的配置随 ComfyUI 工作流保存；建议保留自己的 JSON 工作流副本。仓库不附带模型权重。

## 2. 基础 TerryDirector

连接顺序：

```text
模型 / CLIP / 视频 VAE / 音频 VAE
                 ↓
       TerryDirector 配置
                 ↓
          TerryDirector
                 ↓
       TerryDirector 输出
          ├─ 分段潜变量（LATENT 列表）
          ├─ 合并画面（IMAGE）──┐
          └─ 合并音频（AUDIO）──┴─→ CreateVideo → SaveVideo
```

基础模式适合还需要在 ComfyUI 下游继续处理完整画面／音频的工作流。分段在生成期间可以写盘、释放内存，但最终完整 IMAGE 仍需足够系统 RAM。

## 3. 内置 Self-Lift 二采

```text
TerryDirector 二采配置
          ↓
TerryDirector 配置
          ↓
TerryDirector / TerryDirector Advanced
```

只用本节点包内置 Self-Lift，不需要外部 selflift-Avatar 采样插件或额外打补丁脚本。主模型、CLIP、音视频 VAE 与目标分辨率继续由「TerryDirector 配置」提供，Seed 属于时间线节点。

连接有效二采配置后，普通采样器、调度器、总步数和 Denoise 会显示「二采接管」并变为不可编辑；断开二采后恢复原值。未连接二采配置时保持普通生成。

二采需要适配的放大模型权重；如果配置里没有所需权重，请检查 ComfyUI 的 latent upscale 模型目录。RTX 3090 参考的已验收参数见 [稳定基线](STABLE_BASELINES.md)。提高分辨率、启用高清空间分块或更换注意力后端，都会改变显存需求。

## 4. Advanced 高级导演

以 **TerryDirector Advanced** 代替基础主节点，同样接入「导演配置」。Advanced 自带视频保存设置和审片功能，支持选中片段局部重跑、中断后恢复，并采用无损分段缓存和最终单次编码以降低长视频生成期间的内存峰值。

Advanced 已使用分段文件化视频输出，不应该再将其导演输出当成完整的 IMAGE/AUDIO 使用。「TerryDirector 输出」的标准 IMAGE/AUDIO 拆包功能主要面向基础模式。

## 5. 时间线循环器（普通官方 H3 生成链）

循环器面向需要自己搭建或替换普通 ComfyUI 生成节点组的用户；它并非独立的 H3 模型采样器。

```text
TerryDirector 循环开始
          │ 循环上下文
          ▼
TerryDirector 循环信息
          │ 提示词、采样帧数、Seed、image_0..8
          ├──────────────────────────────→ 官方 MiniMaxH3ReferenceToVideo
          │ 片段数据                             │
          ├─→ TerryDirector 循环条件 ←────────────┘
          │             │ 正向条件
          │             ▼
          │        官方 H3 采样链
          │             │ 采样结果 LATENT
          └─────────────┴──→ TerryDirector 循环结束
                                      │ 视频 VIDEO
                                      ▼
                               官方 SaveVideo
```

「循环上下文」和「片段数据」是两种不同的接口，不要混接。循环开始只输出循环上下文，循环信息解析成每段的提示词、帧数、Seed、素材及片段数据。循环条件决定如何使用上一段的尾帧和重叠上下文；实际 H3 的模型、条件、潜变量、采样器和 Sigmas 等仍由用户在循环体中连接。

循环结束对外固定只有 **视频 VIDEO（第一个输出）** 与 **分段潜变量 LATENT 列表（第二个输出）**。它不输出完整 IMAGE/AUDIO，也无需 A/B 模式或 CreateVideo。视频下游直接连官方 SaveVideo。分段潜变量只在输出端被下游使用时额外缓存。

循环结束的「视频输出检查」可以查看预计临时缓存空间及该磁盘剩余容量。保存视频成功后，无损片段临时文件会自动清理；异常中断可能保留缓存供排查。这里显示的占用是**无损片段缓存预测**，不是最终 MP4 文件大小。

**当前范围**：默认适配器是 MiniMax H3；最多 9 个图片参考输入。LTX 2.5 虽有预留适配器，但未接通生成、条件和解码，因此不可用。循环体不自动沿用主导演 Self-Lift 配置。

## 6. 片段与素材

在节点内点击时间线打开编辑窗口。时间线支持时长调整、首尾吸附、片段重叠与挂起；「全局提示词」和「片段提示词」可以共同构成每段的生成提示。

将图片放在共享资产池，通过 `@` 菜单引用。镜头首尾关系包括「尾帧参考」「尾帧续接」「独立」，重叠关系由时间线计算。正在运行的节点编辑窗口会转为只读，但可以继续浏览片段与素材；未运行的其他节点仍可编辑。

ComfyUI → Settings → TerryDirector → 时间线 中可调整默认镜头衔接和尾帧参考提示词模板。


## 可选：AI 提示词增强（开发分支，尚未本机 GPU 验收）

本功能不依赖额外安装 `ComfyUI_Qwen_H3_Prompt` 或 `ComfyUI-llama-cpp_vlm` 自定义节点。
仅在使用增强时才需要本机 Qwen3.8 GGUF 权重、对应的 `mmproj` 视觉投影器和兼容的 `llama-cpp-python` Python 包。
默认的 H3 文本/视频生成不要求安装这个 Python 依赖。

1. 将 GGUF 主模型及 `mmproj` 放在 `ComfyUI/models/LLM/`（可使用子文件夹），重启 ComfyUI。
2. 在运行 ComfyUI 的**同一个 Python 环境**中安装与本机系统/Python/CUDA 匹配的 `llama-cpp-python`。Qwen3.8 视觉功能需要支持 `Qwen35ChatHandler` 的构建，可参考 [JamePeng 发布包](https://github.com/JamePeng/llama-cpp-python/releases)；不要在已有 cu130 环境直接覆盖 torch。
3. 添加 **TerryDirector Llama 配置** 节点，选择 GGUF、mmproj、AI Seed（与视频 Seed 独立）。
4. 连接该节点的「Llama 配置」输出到 **TerryDirector** 或 **TerryDirector Advanced** 的可选输入。
5. 编辑器的「AI 提示增强」和「一键增强所有提示词」直接通过 ComfyUI 本地 HTTP 接口运行 Llama，**不提交 Queue**。原文与 AI 结果分开保存，可在两者间切换。
6. 如需一次 Queue 完成增强和生成，可开启编辑器顶部的「生成前 AI 增强」。系统在编译 H3 时间线前集中增强缺失或 AI Seed 已变化的片段，完成后释放 Qwen，再执行原有分段 H3 / Self-Lift 流程。

**AI Seed 规则：** 首次没有结果时增强；已有 AI 结果且 Seed 相同则复用；修改原文、全局提示词、时长或模型只显示旧结果状态，不自动重做。更换 AI Seed 会重新增强；手动按增强按钮则始终强制重做。挂起片段和用户明确选择只使用原文的片段不参与 Queue 自动增强。

AI 仅处理当前片段自身的提示词、时长、当前引用的媒体及启用的全局约束；不提前模拟尾帧、重叠或相邻片段连续性。尾帧/重叠仍由既有时间线编译与采样过程处理。

**媒体边界：** 图片通过 VLM 读取；视频在可使用 OpenCV 时抽样最多四帧供 VLM 观察（未安装解码器时只传媒体名称，不假称已经分析视频）；音频文件目前只传名称，不做听觉内容分析。

**资源提示：** Qwen3.8 27B Q4 会占用大量显存。默认一次只允许一个 AI 推理任务，批量运行只加载一次模型，完成后清理资源。实际 CUDA Wheel 与 GPU 显存释放、Base/Advanced 兼容性需在用户机器验证，不能把当前静态语法检查当作 GPU 验收。

## 7. 常见问题

**节点缺失／导入失败**：先核对 ComfyUI 版本、模型和官方生成节点是否安装。已验证的系统版本在稳定基线文档中；其它环境需要自行验证兼容性。

**分段时长与采样帧数不同**：H3 采样长度必须按自己的合法帧数规则对齐，生成后再裁切至时间线需要的帧数，这是正常现象。

**视频输出占用很多磁盘**：流式 VIDEO 会将未压缩画面和音频先存为无损分段缓存，长视频需要足够临时磁盘；无需把完整时间线图像常驻内存，但仍需容纳当前片段解码与编码器的 RAM/VRAM。

**循环器无法直接接入 LTX 2.5**：目前仅预留 `ltx_2_5` 注册项，未实现帧数规则、Guide、音视频潜变量解码；不能把通用端口名称视为 LTX 已兼容。

**静态演示页无法生成**：根目录 `index.html` 用于预览创作 UI，正式生成请在 ComfyUI 节点图中执行。

生产模块和调用关系见 [架构说明](ARCHITECTURE.md)，稳定运行参数与来源见 [稳定基线](STABLE_BASELINES.md)。
