# TerryDirector AI 提示词增强本地验收报告

验收日期：2026-10-11（Asia/Shanghai）

开发分支：`feat/ai-prompt-enhancement`
结论：**P0-01～P0-12 全部通过实机验收**。其中首轮曾暴露 Qwen 多模态 KV 缓存未清空的问题；修复后重新从空 AI 结果执行一次 Queue，Qwen 3/3、H3 3/3、单条视频保存均成功。没有切换或合并 `main`。

## 环境与执行范围

| 项目 | 实测 |
|---|---|
| 系统 / GPU | Windows，GeForce RTX 3090 24 GiB，驱动 591.74；`nvidia-smi` 总容量 24576 MiB |
| 解释器 | 实际 ComfyUI Python 为 `ComfyUI/.venv/python.exe`，Python 3.12.13 |
| 软件 | ComfyUI 0.39.0；PyTorch 2.11.0+cu130；`torch.version.cuda=13.0`；`pip check` 无依赖错误；`Llama` 和 `Qwen35ChatHandler` 在同一 Python 中导入成功 |
| H3 权重 | 通过既有 `extra_model_paths.yaml` 从外部模型目录读取 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`、`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`、`minimax_h3_video_vae_int8_convrot.safetensors`、`minimax_h3_audio_vae_fp32.safetensors`；未移动或重新下载 |
| Qwen 权重 | 本机已有 `Qwen3.8-27B-Q4_K_M.gguf` 和 `Qwen3.8-27B-mmproj-BF16.gguf`。仓库样例原选项为 `Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf` / `mmproj-F16.gguf`；仅在本机导入副本中改为现有模型名，仓库样例未改 |
| 服务 | 本轮启动本地 ComfyUI 8188；TerryDirector 标准节点与 Llama 配置节点均注册。另有无关的 LTXVideo 自定义节点导入错误，不影响本轮 H3 |

**验收基准：**基础 TerryDirector、10 节点/10 连线、608×352、24fps、三段 4/3/5 秒共 288 帧、8 步 `res_multistep/simple`、视频 Seed 9、AI Seed 8888、`tail_reference`、七张全局参考图、无 Self-Lift、二采输入未连接。离线校验输出 `STATIC_STRUCTURE_VALIDATED_ONLY`；随后把仅改权重名称的副本放入 ComfyUI 用户工作流目录并在真实 UI 载入，所有 10 个节点、各权重下拉值、两个固定 Seed、12 秒时间线与 7 个资产均正常显示。三段原文和全局七个 `<Picture N>` 标签均由原样例保留。

## 七张原始参考图

路径均为既有 `ComfyUI/input/` 下的原文件，未替换。每张均实际打开解码并计算 SHA-256。

| 文件 | 字节 | SHA-256 | 尺寸 |
|---|---:|---|---|
| `00_特瑞_Terry.jpeg` | 2,300,683 | `353CD43C10431AEFB9B12DB035156B24FD90783DA1036C3F210B7749A0979A27` | 2752×1536 |
| `Generate_vehicle_multi-view_images_2K_202608132251.jpeg` | 2,480,843 | `12462DC2AA2F96EBACBA043EB402FD5B5A1DEA7706626FE1676FF65A560FC2D6` | 2752×1536 |
| `开场遗迹.png` | 4,316,580 | `D7F9954A139F020B5F8F7AAABC5A33F1DE1FECFC8103D4942F00A9EDFC6B528A` | 2752×1536 |
| `荒星地貌.jpeg` | 2,747,132 | `0A12CD63729D57FA38E2FE359962C8D449A53FAFB2DB5D83C6C32EA3DC0DA0FF` | 2752×1536 |
| `codex_9ea39e8314544c10aa7c0e140ba871d5.png` | 6,880,730 | `B2657E277D29C4928ED115F6AB35216AE89902A91797F905F3C0A0EEB214BCBA` | 2752×1536 |
| `Designing_custom_coin_grid_2K_202608170722.jpeg` | 2,797,645 | `678C19A7AA9B1D975C6E77135260186CF020F753D079C75ECA4720ED39666AD2` | 2752×1536 |
| `地下虫群-个体 拷贝.jpg` | 2,166,110 | `9416EF4F0B63902D0D6738C26EE0AA457FACFED2F0F4072BB8ADBAD4C5DC7BB5` | 2048×2048 |

## 首轮错误、修复与重跑

首次被 ComfyUI 接收的 Queue `bc88ae8b-d368-4151-ae8f-23e67307f58d` 在片段 1 增强后、片段 2 多模态解码时失败。真实错误为 `decode: failed to find a memory slot for batch of size 720`，继而 `Qwen35ChatHandler ... Media evaluation failed with error code 1`。该次 H3 未启动，失败没有静默回退原文。

定位到 `_LlamaSession.chat` 复用同一 GGUF 时，上一段图像 token 的原生 KV 占位仍保留。修复为每段对话前清空 llama.cpp context memory 并 reset 会话，同时保留已加载的模型。修复提交：`d5df090 fix(ai): clear multimodal KV cache between batch clips`，文件 `director_ai.py`。重启同一 ComfyUI 后重新从原始空 AI 结果 Queue；没有改写七图、提示词、H3 配置或主分支。

重跑 Queue `8fe4cb19-88cd-440b-a3e7-2e3ebccfd2b2` 于 12:58:17 开始，13:03:08 成功，总耗时 **290.79 秒**。日志顺序明确为 Qwen `已增强 1/3`、`2/3`、`3/3`，之后 H3 Base 三段缓存 `96/72/120` 帧，再合并 `288` 帧。一个批量会话连续处理三段，没有 Qwen/H3 交替。VLM 消息包含经真实图片解码和缩放后生成的 JPEG `data:` 内容，而非仅文件名；AI 结果中的 `<Picture N>` 引用合法。没有在日志输出 base64 内容。

## P0 逐项结果

| ID | 状态 | 实测证据 |
|---|---|---|
| P0-01 | **通过** | 离线结构校验通过，七图 7/7 原文件可解码；本机副本实际载入 ComfyUI UI，10 节点正常、权重 Widget 有效、7 个资产缩略图及三段原文可见，二采未接。 |
| P0-02 | **通过** | 修复后一次 Queue 完成 Qwen 3/3 → LLM 显存释放 → H3 3/3；每段均以七张真实图像的内容进入多模态输入，AI 结果保存并激活。 |
| P0-03 | **通过** | 单条 `ComfyUI/output/video/TerryDirector_AI_3clips_0p2MP_00001_.mp4`，2,297,752 字节；`ffprobe`：H.264 608×352、24/1fps、288 帧、12.000 秒；AAC 32kHz 双声道、12.000 秒。`ffmpeg -v error -i ... -f null NUL` 完整解码退出码 0。 |
| P0-04 | **通过** | 相同 AI Seed/原文 Queue `72268c84-a0aa-43c1-84e5-32b03078066e` 成功，176.15 秒，新增 Qwen 增强 **0 次**；H3 三段重新采样并保存另一条视频。 |
| P0-05 | **通过** | 本机测试输入给片段 2 原文追加一行、AI Seed 保持 8888；Queue `d4c542ba-21d2-4491-ab71-bdb4c4e0caec` 成功，170.90 秒，新增 Qwen **0 次**；新原文留在输入文档，旧 `aiPrompt` 与元数据继续使用，符合方案 A。 |
| P0-06 | **通过** | 仅视频 Seed 9→10 的 Queue `732ce9cb-4ed0-42ce-9911-4ad41e623253` 成功，181.90 秒；H3 重新生成，Qwen 增强 **0 次**，AI Seed 仍为 8888。 |
| P0-07 | **通过** | AI Seed 8888→8889 的 Queue `7019dc24-f47e-4ceb-86da-b21d0e81582b` 成功，301.55 秒；Qwen 一次加载后重新增强 3/3，H3 3/3。`output/.terrydirector_ai/7.json` 中三段元数据 seed 均为 8889，原文未被覆盖。 |
| P0-08 | **通过** | 编辑器实际点击单段按钮，HTTP Job 显示完成 1/1；再点击“一键增强所有提示词”，显示完成 3/3。期间 `/queue` 始终为 0/0，没有新视频或 H3 运行；Job 的 202 提交和 GET 轮询亦由独立请求验证。 |
| P0-09 | **通过** | UI 切换“用户提示词”与“AI 增强提示词”，仅给第 1 段 AI 文本追加验收标记，保存退出并保存测试工作流副本；浏览器刷新、重新打开后 AI 标记仍在，原文仍以“镜头类型：特写”开头且无该标记。`promptMode`、`aiMetadata`、`autoAiEnhance` 随工作流持久化；后续手动重增强按预期替换了测试标记。 |
| P0-10 | **通过** | 用仅断开 Llama 连线的本机工作流副本打开编辑器：单段和批量按钮、自动增强开关均为禁用，已保存的旧 AI 文本仍显示。另从原始空 AI 输入强行提交无 Llama 配置 Queue `0111da83-5554-4c4f-859c-41a670811673`，导演节点约 0.24 秒明确报“已开启生成前 AI 增强，请连接 TerryDirector Llama 配置节点”，未进入 H3。 |
| P0-11 | **通过** | Qwen 推理时编辑器可交互、HTTP 继续响应；并发第二份 AI Job 返回 HTTP 409。取消 Job `66e7b65edf0545058c7b4a06ec7d57b2` 后状态 `cancelled`，结果保留 `clip-1` 1/3，原文未损坏；显存回落至 2976 MiB，Queue 0/0。首次异常阻止 H3，修复重跑后未出现 H3 OOM。 |
| P0-12 | **通过** | 实际三段 H3 与最终合成均成功，运行图包含 `td_s2_tail_reference`、`td_s3_tail_reference`，另有每段七个静态 `ref_image_0..6`。Base 每段把**该段实际解码图像最后一帧**克隆为连续性输出，下一段从该输出切出 1 帧接入第 8 个 H3 图片位；首段不请求前帧。实际路径仍为 `tail_reference`，未改为独立或尾帧续写，拼接帧数为 96+72+120=288。 |

P0-12 的尾帧来源由本次成功运行的动态节点、Base 缓存执行日志以及 `director_internal.py` / `director_h3.py` 的实际连线共同确认；本次没有额外导出无损中间帧或逐帧哈希。最终 MP4 是有损 H.264，不能仅以边界解码像素是否逐位相同判断参考帧传递。

## 耗时与显存

`nvidia-smi` 约每 2 秒记录整卡已用显存，数值包括桌面和其它已有进程；以下为首轮**成功** Queue 的真实观测。原始曲线位于本机 `.codex-run/ai-prompt-acceptance/gpu.csv`，未提交 Git。

| 阶段 | 本地时间 | 已用显存 |
|---|---|---:|
| 冷启动前基线 | 约 12:49 | 2822 MiB |
| 成功 Queue 起点 | 12:58:18 | 3348 MiB |
| Qwen 运行中 | 12:59:40～13:00:13 | 约 21666～21694 MiB |
| 第三段增强尾声 | 13:00:15 | 22305 MiB |
| Qwen 卸载后、H3 加载前 | 13:00:17 | **3906 MiB** |
| H3 第一段采样期间 | 13:00:37 起 | 约 23571 MiB；整次成功 Queue 峰值 **24002 MiB** |
| 视频生成完成 | 13:03:07 | 3322 MiB |

Qwen 3/3 集中处理后显存由约 22.3 GiB 降至 3.9 GiB，再进入 H3 权重加载。首轮成功运行 290.79 秒；相同 AI Seed 复用 176.15 秒；原文变化 170.90 秒；视频 Seed 变化 181.90 秒；AI Seed 变化 301.55 秒。手动取消测试约 60.18 秒完成，保留 1/3 结果。

## 交付与证据

- 修复提交：`d5df090`（`director_ai.py`，多模态批量对话之间清空 KV 缓存）。
- 此前两个报告提交 `ba1da29`、`74b2f46` 曾将可运行环境误判为阻塞；本报告以实机复跑结果更正。它们没有改动代码或 `main`。
- 本机原始证据：`.codex-run/ai-prompt-acceptance/stdout2.log`、`stderr2.log`、`gpu.csv`、各次 `prompt_*.json` 与 HTTP Job 结果；视频在 `ComfyUI/output/video/`。大型日志、视频和本机工作流副本未提交。
- **失败：无待修复项目。阻塞：无。未测：无。** 本轮未安装额外自定义节点，未改动原始七图、系统级 CUDA/PyTorch/ComfyUI，也未合并主分支。
