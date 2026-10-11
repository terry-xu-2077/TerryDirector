# TerryDirector AI 提示词增强 · 本地 Codex 验收任务

> **执行对象：本机 Codex。** 请在已安装 ComfyUI 的 Windows / RTX 3090 环境完成真实运行验收，发现问题直接修复并推送开发分支。**不合并、不改动 `main`**。不能用静态检查代替 GPU 验收。

**开发分支：** `feat/ai-prompt-enhancement`  
**示例工作流：** [TerryDirector_AI_3clips_0.2MP.json](../examples/TerryDirector_AI_3clips_0.2MP.json)  
**离线校验：** `python examples/validate_ai_3clip_workflow.py`

## 一、验收范围与目标

只验收**基础 TerryDirector 节点**的完整一键生成：

`ComfyUI Queue → 一次加载 Qwen3.8 → 逐段增强 3 份提示词 → 卸载 LLM → H3 分段采样 → Base 画面/音频合并 → CreateVideo → SaveVideo`。

另验收编辑窗口的单段「AI 提示增强」和「一键增强所有提示词」通过 **HTTP Job，不走 ComfyUI Queue**，不启动 H3 采样。

**本轮禁止增加或改造：** Self-Lift / 二采配置、Advanced、循环器、LTX 2.5、尾帧承接、镜头重叠或其它性能实验。不要破坏现有 H3 生成链路。示例工作流**只用基础导演时间线节点**，不安装两个参考仓库的 ComfyUI 自定义节点。

### 固定验收基准

| 项目 | 数值 |
|---|---|
| 分辨率 | 16:9 / 0.2MP / multiple 32 → **608 × 352** |
| 总时长 / FPS | **12 秒 / 24fps / 288 帧** |
| 三片段 | 4 秒、3 秒、5 秒 |
| 时间线帧边界 | `0–96`、`96–168`、`168–288` |
| H3 生成帧数（裁切前） | 107、73、124 |
| 片段衔接 | 全部独立、无重叠，无额外参考素材 |
| H3 普通采样 | `res_multistep` / `simple` / 8 步；无 Self-Lift |
| 视频 Seed | **9**，生成后保持 fixed |
| AI Seed | **8888**，生成后保持 fixed |
| 默认状态 | `autoAiEnhance=true`；三段有原文、`aiPrompt` 均为空 |
| 输出 | TerryDirector → TerryDirector 输出 → CreateVideo(24fps) → SaveVideo |

画布只有 10 个节点和 10 条连线：四个 H3 模型/编码器/VAE 加载节点、TerryDirector 配置、TerryDirector Llama 配置、基础 TerryDirector、导演输出、CreateVideo、SaveVideo。**二采配置端口必须未连接。**

## 二、准备工作（先查环境，避免破坏可用安装）

1. 在 TerryDirector 仓库检查 `git status --short`。如果本地存在未提交修改，先记录和保护；不得强制 reset 或覆盖。
2. 执行 `git fetch origin`、`git switch feat/ai-prompt-enhancement`、`git pull --ff-only`。记录 HEAD 与远端一致；不要修改 `main`。
3. 检查真实 `sys.executable`、Python、ComfyUI、PyTorch/cu 版本、NVIDIA 驱动、`nvidia-smi` 与 `pip check`。历史用户基线为 Windows 10 / RTX 3090 24GB / Python 3.12.13 / ComfyUI 0.39.0 / torch cu130，**但以当前实机为准**。
4. 在启动 ComfyUI 的**同一个 Python**里确认 `from llama_cpp import Llama` 以及 `from llama_cpp.llama_chat_format import Qwen35ChatHandler` 能正常导入。若没有兼容的 `llama-cpp-python`，先确认 Python/CUDA Wheel 匹配再安装；**不得盲目升级 PyTorch、CUDA、SageAttention、triton 或 ComfyUI**。缺少兼容 Wheel 时应记录环境阻塞，不能伪称完成。
5. 检查本机 H3 模型、CLIP、视频/音频 VAE、Qwen3.8 GGUF、`mmproj`。示例预置的模型文件名来自此前提供的工作流，可能与当前机器不同：可在**本机导入副本**的下拉框中更换为真实已安装文件，并在报告记录实际使用的文件名；不要悄悄改变 canonical 工作流的 0.2MP / 3 段 / 无 Self-Lift 约束。
6. ComfyUI 启动日志不得有 TerryDirector 导入异常，检查新 `TerryDirectorLlamaConfig` 与标准 `TerryDirectorConfig`、`TerryDirector`、`TerryDirectorOutput` 均已注册。

## 三、运行前结构预检

- 运行 `python examples/validate_ai_3clip_workflow.py`，应该报告 `STATIC_STRUCTURE_VALIDATED_ONLY`、608×352、288 帧、AI Seed 8888、无 Self-Lift。**这仅表示 JSON 结构有效。**
- 在 ComfyUI 菜单导入示例 JSON，确认没有红色未识别节点、错连线、无效 Widget，Seed 控制行为为 fixed。
- 打开导演时间线编辑窗口，确认三段及原文正确，顶部「生成前 AI 增强」为开，且连接了 Llama 配置。
- 如果原生 ComfyUI V3 节点/Widget 序列化不兼容当前 JSON，需**修正仓库示例 JSON**并重新运行离线检查；不能只临时手工画一条能跑的链路冒充样例导入通过。

## 四、真实验收项目（P0 必测）

| ID | 操作 | 合格标准 |
|---|---|---|
| **P0-01** | 静态校验与真实 ComfyUI 导入 | 10 节点/10 连线；基础导演 3 段；0.2MP；二采配置未连接 |
| **P0-02** | **首轮一键运行**：原始 `aiPrompt` 为空、AI Seed=8888、自动增强开启，提交**一次 Queue** | 只加载一次 Qwen，逐段增强 3/3；每段 AI 元数据 Seed=8888；原文保留；LLM 释放后才进入 H3；H3 生成 3/3 成功 |
| **P0-03** | 验证 SaveVideo 最终文件 | 可以完整解码；**608×352、24fps、288 帧、约 12 秒**；是一条合成视频而不是三个独立文件；记录视频与音频流信息 |
| **P0-04** | 不改 AI Seed 和原文，再 Queue | 直接复用 3 份 AI 增强文本，**0 次 Qwen 增强**；允许基础导演重新采样视频，不要求 Base 视频缓存命中 |
| **P0-05** | 修改第 2 段原文，不改 AI Seed，运行自动增强 | 按已确认的**方案 A**：显示原文变化/旧 AI 状态，**不会重做 Qwen**，仍使用保存的旧 AI 文本；原始用户输入保持新内容 |
| **P0-06** | 仅更改视频 Seed（9→10），AI Seed 不变 | 视频重新抽样，**不重做 AI 增强**；两个 Seed 不混用 |
| **P0-07** | 更改 **AI Seed 8888→8889**，运行 | 三段全部重新增强，元数据统一变成 8889，原文不被覆盖，批量过程中 Qwen 不重复加载 |
| **P0-08** | 编辑器点击单段增强，再点击增强全部 | 使用 `POST /terrydirector/api/ai-enhance` 和 `GET /terrydirector/api/ai-jobs/{id}`；成功返回 AI 标签；**不增加 Queue、不启动视频模型** |
| **P0-09** | 切换原文/AI 标签、编辑 AI 文本，保存退出、重新打开、必要时刷新浏览器/重启 | `prompt`、`aiPrompt`、`promptMode`、`aiMetadata`、`autoAiEnhance` 不丢失，AI 修改不覆盖原文 |
| **P0-10** | 断开 Llama 配置输入 | 两个增强按钮与自动增强开关变灰；旧 AI 文本依然可查看。若已开启自动增强且缺少配置仍执行 Queue，必须明确报错、不得进入 H3 |
| **P0-11** | 观察长时推理、取消、异常与资源回收 | 编辑器可响应；取消不会损坏原文，已完成片段可保留；没有长期驻留的 Qwen 显存导致 H3 OOM；多个导演节点不能并发加载两个 Qwen |

**Seed 规则特别强调：** 首次没有结果时增强；已有结果且 Seed 相同就复用；**修改原文、全局提示词、时长、引用素材、模型参数不会自动重做**，只能标记旧结果状态；**只有改变 AI Seed 或显式手动点击增强**才重新运行。不得引入 hash 驱动的自动增强。已有有效 AI 结果可以在没有 Llama 连接时继续用于视频生成（自动增强开启但无配置时应有明确错误）。

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
P0-01～P0-11：逐项状态
首轮 AI 增强：_ / 3
首轮 H3 视频生成：_ / 3
最终视频：真实路径、608×352、24fps、帧数、时长、音频流
相同 AI Seed 复用：通过 / 失败 / 未测
更改 AI Seed 重增强：通过 / 失败 / 未测
Qwen→H3 显存回收：真实观测
修复提交 / 文件：
遗留阻塞：
```
