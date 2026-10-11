# TerryDirector AI 提示词增强 · 本地 Codex 验收任务

> **执行对象：本机 Codex。** 请在已安装 ComfyUI 的 Windows / RTX 3090 环境完成真实运行验收，发现问题直接修复并推送开发分支。**不合并、不改动 `main`**。不能用静态检查代替 GPU 验收。

**开发分支：** `feat/ai-prompt-enhancement`  
**示例工作流：** [TerryDirector_AI_3clips_0.2MP.json](../examples/TerryDirector_AI_3clips_0.2MP.json)  
**离线校验：** `python examples/validate_ai_3clip_workflow.py`

## 一、验收范围与目标

只验收**基础 TerryDirector 节点**的完整一键生成：

`ComfyUI Queue → 一次加载 Qwen3.8 → 逐段增强 3 份提示词 → 卸载 LLM → H3 分段采样 → Base 画面/音频合并 → CreateVideo → SaveVideo`。

另验收编辑窗口的单段「AI 提示增强」和「一键增强所有提示词」通过 **HTTP Job，不走 ComfyUI Queue**，不启动 H3 采样。

**本轮禁止增加或改造：** Self-Lift / 二采配置、Advanced、循环器、LTX 2.5、尾帧续接（tail_continuation）、镜头重叠或其它性能实验。**本轮必须验收既有的尾帧参考（tail_reference）模式，不要把三段改成独立生成。**不要破坏现有 H3 生成链路。示例工作流只使用基础导演时间线节点，不安装两个参考仓库的 ComfyUI 自定义节点。

### 已验收工作流的真实创作素材（本轮复用，不得替换为虚构场景）

本示例的全局提示词、前三个片段的原始提示词与七张参考图路径，**逐字/逐路径来自此前测试的** `TerryDirector_循环器_官方H3_示例工作流.json`，而不是临时编写的咖啡馆提示词。该旧工作流有九段和七张图片；本验收**仅取前三段**。原文中的 Sony Venice 2、2.39:1 艺术描述予以保留，但工作流的实际输出仍固定为 16:9 0.2MP。

前三段为「特瑞的面部与粗糙的手」（4s）→「破损的电子屏幕」（3s）→「“蚂蚱”载具驶入」（5s）；原来第二、第三段已使用 `tail_reference`，本次将第一段的模式显示值也统一设为 `tail_reference`（首段没有前一段尾帧，因此不会凭空附加尾帧图片）。

以下七张图**不是 Git 仓库自带的二进制素材**，必须由 Codex 检查用户既有 `ComfyUI/input/` 并复用**原文件**，不能以空白图、随机图片或其它同名替代品蒙混过关：

| 资产标签 | ComfyUI input 文件路径 | 来自旧工作流的含义 |
|---|---|---|
| `<Picture 1>` | `00_特瑞_Terry.jpeg` | 主角，黄色头发、橙色披风 |
| `<Picture 2>` | `Generate_vehicle_multi-view_images_2K_202608132251.jpeg` | 单人载具 |
| `<Picture 3>` | `开场遗迹.png` | 荒原遗迹和矿运飞船 |
| `<Picture 4>` | `荒星地貌.jpeg` | 荒原氛围 |
| `<Picture 5>` | `codex_9ea39e8314544c10aa7c0e140ba871d5.png` | 避难所全貌 |
| `<Picture 6>` | `Designing_custom_coin_grid_2K_202608170722.jpeg` | 圆子 |
| `<Picture 7>` | `地下虫群-个体 拷贝.jpg` | 地下甲壳类虫子 |

七张图均由全局提示词的原始 `<Picture N>` 标签引用，对三个片段生效。第二、第三段生成时**还需额外占用一个尾帧参考位**，因此每段最多使用 7 张全局图 + 1 张动态尾帧 = 8/9 个 H3 图片位。AI 增强只读取原文、全局约束和静态参考图，不提前处理尾帧；动态尾帧仍由原有 H3 编译/执行逻辑负责。

### 固定验收基准

| 项目 | 数值 |
|---|---|
| 分辨率 | 16:9 / 0.2MP / multiple 32 → **608 × 352** |
| 总时长 / FPS | **12 秒 / 24fps / 288 帧** |
| 三片段 | 4 秒、3 秒、5 秒 |
| 时间线帧边界 | `0–96`、`96–168`、`168–288` |
| H3 生成帧数（裁切前） | 107、73、124 |
| 片段衔接 | **尾帧参考**（三段 `transitionMode=tail_reference`）；2→3 段均承接上一段实际尾帧；无重叠 |
| H3 普通采样 | `res_multistep` / `simple` / 8 步；无 Self-Lift |
| 视频 Seed | **9**，生成后保持 fixed |
| AI Seed | **8888**，生成后保持 fixed |
| 默认状态 | `autoAiEnhance=true`；三个片段沿用旧原文、`aiPrompt` 均为空；**七张参考图均在资产池且全局启用** |
| 输出 | TerryDirector → TerryDirector 输出 → CreateVideo(24fps) → SaveVideo |

画布只有 10 个节点和 10 条连线：四个 H3 模型/编码器/VAE 加载节点、TerryDirector 配置、TerryDirector Llama 配置、基础 TerryDirector、导演输出、CreateVideo、SaveVideo。**二采配置端口必须未连接。**

## 二、准备工作（先查环境，避免破坏可用安装）

1. 在 TerryDirector 仓库检查 `git status --short`。如果本地存在未提交修改，先记录和保护；不得强制 reset 或覆盖。
2. 执行 `git fetch origin`、`git switch feat/ai-prompt-enhancement`、`git pull --ff-only`。记录 HEAD 与远端一致；不要修改 `main`。
3. 检查真实 `sys.executable`、Python、ComfyUI、PyTorch/cu 版本、NVIDIA 驱动、`nvidia-smi` 与 `pip check`。历史用户基线为 Windows 10 / RTX 3090 24GB / Python 3.12.13 / ComfyUI 0.39.0 / torch cu130，**但以当前实机为准**。
4. 在启动 ComfyUI 的**同一个 Python**里确认 `from llama_cpp import Llama` 以及 `from llama_cpp.llama_chat_format import Qwen35ChatHandler` 能正常导入。若没有兼容的 `llama-cpp-python`，先确认 Python/CUDA Wheel 匹配再安装；**不得盲目升级 PyTorch、CUDA、SageAttention、triton 或 ComfyUI**。缺少兼容 Wheel 时应记录环境阻塞，不能伪称完成。
5. 检查本机 H3 模型、CLIP、视频/音频 VAE、Qwen3.8 GGUF、`mmproj`。本示例的 H3 模型/CLIP/VAE 名称来自上述已测旧工作流（不强制复刻它的循环器、LoRA、Sage 链路）；Llama 名称取自之前提供的 Qwen 实测工作流。若安装路径有差异，可在**本机导入副本**的下拉框中选择实际模型，并记录更改；不得更改 0.2MP / 3 段 / 尾帧参考 / 无 Self-Lift 约束。
6. **逐项检查七张旧参考图**在 `ComfyUI/input/` 下能读取且图片未损坏，并在报告记录实际文件路径、文件大小、SHA-256。若图片仅在其它已经验证的旧 input 目录，应复制原文件到本机当前 input，记录来源和哈希；缺图则标记「阻塞」，不要伪造图片、跳过图片或擅自移除全局标签。
7. ComfyUI 启动日志不得有 TerryDirector 导入异常，检查新 `TerryDirectorLlamaConfig` 与标准 `TerryDirectorConfig`、`TerryDirector`、`TerryDirectorOutput` 均已注册。

## 三、运行前结构预检

- 运行 `python examples/validate_ai_3clip_workflow.py`，应该报告 `STATIC_STRUCTURE_VALIDATED_ONLY`、608×352、288 帧、7 张旧参考图、三段尾帧参考、AI Seed 8888、无 Self-Lift。**这仅表示 JSON 结构有效，不表示图片二进制存在、ComfyUI 已能导入或 GPU 采样成功。**
- 在 ComfyUI 菜单导入示例 JSON，确认没有红色未识别节点、错连线、无效 Widget，Seed 控制行为为 fixed。
- 打开导演时间线编辑窗口，确认原来三段「特瑞…… / 破损…… / 蚂蚱……」的**完整原始提示词**、七张参考图缩略图、全局 Prompt 中七个标签全部正确；第 2/3 段接缝为「尾帧参考」、各片段均启用全局提示词，顶部「生成前 AI 增强」已开启并连接 Llama 配置。
- 如果原生 ComfyUI V3 节点/Widget 序列化不兼容当前 JSON，需**修正仓库示例 JSON**并重新运行离线检查；不能只临时手工画一条能跑的链路冒充样例导入通过。

## 四、真实验收项目（P0 必测）

| ID | 操作 | 合格标准 |
|---|---|---|
| **P0-01** | 静态校验与真实 ComfyUI 导入、校验七张图片 | 10 节点/10 连线；基础导演 3 段；0.2MP；七张旧参考图存在且可解码；二采配置未连接 |
| **P0-02** | **首轮一键运行**：七张图片全部在 input、原始 `aiPrompt` 为空、AI Seed=8888、自动增强开启，提交**一次 Queue** | Qwen 只加载一次，逐段增强 3/3；确认 VLM 确实接收七张参考图**图像内容**（不是只有名字）；结果保持合法 `<Picture N>` 引用；LLM 释放后才进入 H3；H3 生成 3/3 成功 |
| **P0-03** | 验证 SaveVideo 最终文件 | 可以完整解码；**608×352、24fps、288 帧、约 12 秒**；是一条合成视频而不是三个独立文件；记录视频与音频流信息 |
| **P0-04** | 不改 AI Seed 和原文，再 Queue | 直接复用 3 份 AI 增强文本，**0 次 Qwen 增强**；允许基础导演重新采样视频，不要求 Base 视频缓存命中 |
| **P0-05** | 修改第 2 段原文，不改 AI Seed，运行自动增强 | 按已确认的**方案 A**：显示原文变化/旧 AI 状态，**不会重做 Qwen**，仍使用保存的旧 AI 文本；原始用户输入保持新内容 |
| **P0-06** | 仅更改视频 Seed（9→10），AI Seed 不变 | 视频重新抽样，**不重做 AI 增强**；两个 Seed 不混用 |
| **P0-07** | 更改 **AI Seed 8888→8889**，运行 | 三段全部重新增强，元数据统一变成 8889，原文不被覆盖，批量过程中 Qwen 不重复加载 |
| **P0-08** | 编辑器点击单段增强，再点击增强全部 | 使用 `POST /terrydirector/api/ai-enhance` 和 `GET /terrydirector/api/ai-jobs/{id}`；成功返回 AI 标签；**不增加 Queue、不启动视频模型** |
| **P0-09** | 切换原文/AI 标签、编辑 AI 文本，保存退出、重新打开、必要时刷新浏览器/重启 | `prompt`、`aiPrompt`、`promptMode`、`aiMetadata`、`autoAiEnhance` 不丢失，AI 修改不覆盖原文 |
| **P0-10** | 断开 Llama 配置输入 | 两个增强按钮与自动增强开关变灰；旧 AI 文本依然可查看。若已开启自动增强且缺少配置仍执行 Queue，必须明确报错、不得进入 H3 |
| **P0-11** | 观察长时推理、取消、异常与资源回收 | 编辑器可响应；取消不会损坏原文，已完成片段可保留；没有长期驻留的 Qwen 显存导致 H3 OOM；多个导演节点不能并发加载两个 Qwen |
| **P0-12** | **真实尾帧参考衔接** | 第 1 段不需要前序尾帧；第 2 段拿到第 1 段**实际生成的尾帧**；第 3 段拿到第 2 段**实际生成的尾帧**；每段七张全局参考图不丢失，且尾帧占独立参考位。不得将 `tail_reference` 偷换为 `independent` 或 `tail_continuation`，不得让 AI 自行编写虚构的尾帧描述 |

**Seed 规则特别强调：** 首次没有结果时增强；已有结果且 Seed 相同就复用；**修改原文、全局提示词、时长、引用素材、模型参数不会自动重做**，只能标记旧结果状态；**只有改变 AI Seed 或显式手动点击增强**才重新运行。不得引入 hash 驱动的自动增强。已有有效 AI 结果可以在没有 Llama 连接时继续用于视频生成（自动增强开启但无配置时应有明确错误）。

**参考图与尾帧校验：** 编译后的三个片段均包含原来的七张静态参考图；第二、三段各追加一张**运行时动态尾帧**作为参考，不能超出 H3 图片位上限。AI 输入不涉及前一片段结果，也不能篡改 H3 的动态尾帧编号。日志可记录素材数量、标签与尺寸，但不应打印七张图的 base64 全文。

**失败处理：** LLM 某段失败必须阻止 H3 继续浪费算力；不可静默回退原文。采样失败必须记录详细日志，不能报整体成功。测试应保持任务可重复，不让上一次缓存/Queue 残留混淆验收。

## 五、真实显存与时长记录

请在冷启动阶段分别记录 **开始前、Qwen 加载后、第三段增强结束后、Qwen 卸载后、H3 第 1 段采样期间、生成完成后** 的 `nvidia-smi` 显存数值；记录真实阶段起止时刻、模型实际加载次数，以及日志中是否出现重复加载/卸载。

重点确认：**Qwen 三段增强集中完成后才启动 H3**，不能发生「增强片段 1 → H3 生成 1 → 重新加载 Qwen 增强片段 2」的低效交替。如果 CUDA Wheel 与 ComfyUI cu130 冲突，提供可复现错误和解决建议，但不要破坏当前能跑的 H3。

最终视频用本机 `ffprobe` / `ffmpeg` 或实际解码检查，**不要仅凭播放器显示 12s 宣称帧数合格**。输出可能在 `ComfyUI/output/video/` 下；以真实文件路径为准，记录文件大小、视频编码、音频流、帧数、FPS、时长。

## 六、修复权限与交付

- 允许 Codex 在 **`feat/ai-prompt-enhancement`** 分支修复发现的接口、序列化、LLM 调度、Seed 复用、保存与显存问题，并编写针对性回归检查；所有修复提交推送该分支。**禁止合并 main**。
- 不需要安装 `ComfyUI_Qwen_H3_Prompt` 或 `ComfyUI-llama-cpp_vlm` 自定义节点。TerryDirector 只依赖兼容的底层 `llama-cpp-python`，未启用 AI 时不应成为普通 H3 启动的硬依赖。
- 建立 `docs/AI_PROMPT_ENHANCEMENT_ACCEPTANCE_REPORT.md`：逐项用「**通过 / 失败 / 阻塞 / 未测**」标注，不得把静态检查冒充 GPU 验证。附**真实**运行版本、使用的权重、Queue/LLM/H3 日志摘要、视频元数据、Qwen 卸载证据、修复 commit。
- 视频、截图和大型日志保存在本机输出/测试目录，**不提交至 Git**；可在报告中给出脱敏本地证据路径。不得提交私人绝对路径、日志中的环境密钥。
- 若本机缺少权重、GPU 或兼容 Wheel，记录阻塞并尽可能完成离线预检；不要杜撰性能数值，不要声称实际运行通过。

### 给用户的最终反馈格式

```text
分支 / HEAD：
ComfyUI / Python / torch / CUDA / GPU：
示例工作流导入：通过 / 失败
P0-01～P0-12：逐项状态
原始素材：7/7 可读取，实际 input 路径和 SHA-256
首轮 AI 增强：_ / 3
首轮 H3 视频生成：_ / 3
尾帧参考：1→2 通过/失败；2→3 通过/失败
最终视频：真实路径、608×352、24fps、帧数、时长、音频流
相同 AI Seed 复用：通过 / 失败 / 未测
更改 AI Seed 重增强：通过 / 失败 / 未测
Qwen→H3 显存回收：真实观测
修复提交 / 文件：
遗留阻塞：
```
