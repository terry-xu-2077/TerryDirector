# TerryDirector AI 提示词增强本地验收报告

- 验收日期：2026-10-11（Asia/Shanghai）
- 分支 / HEAD：`feat/ai-prompt-enhancement` / `d53d04e`（与已拉取的 `origin/feat/ai-prompt-enhancement` 一致）
- `main` 未切换或修改；仓库工作树仅新增本报告。
- 总结：**离线结构预检通过；真实 GPU 验收阻塞，未提交 Queue，未声称任何推理或视频项目通过。**

## 实机环境观测

| 项目 | 实测 |
|---|---|
| GPU / 驱动 | NVIDIA GeForce RTX 3090 24GB，驱动 591.74；验收检查时总占用 2822 MiB（桌面进程占用） |
| ComfyUI | `user/comfyui_8188.log` 记录 Python 3.12.13、PyTorch 2.11.0+cu130、CUDA 可用、RTX 3090；服务器启动于 2026-10-11 12:09:05，8188 |
| 当前 ComfyUI 进程可操作性 | ComfyUI 日志证实 12:09:05 启动 8188；本次复核时 8188 已无监听，HTTP API 不可访问，队列无法查询。本会话未重启或打断任何服务 |
| Python 依赖检查 | 实际解释器为 `ComfyUI/.venv/python.exe`（Conda 风格布局）；Python 3.12.13、torch 2.11.0+cu130、CUDA 13.0 可用；`pip check` 返回 `No broken requirements found`；`from llama_cpp import Llama` 和 `Qwen35ChatHandler` 均成功导入。之前按 `Scripts/python.exe` 路径判为解释器缺失，属于误判，现更正 |
| 模型 | Qwen3.8 GGUF 及 mmproj 在 `ComfyUI/models/LLM` 存在，但示例 widget 选择的 `Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf` / `mmproj-F16.gguf` 名称未找到；H3 主模型 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`、编码器 `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`、视频 VAE `minimax_h3_video_vae_int8_convrot.safetensors`、音频 VAE `minimax_h3_audio_vae_fp32.safetensors` 均未在模型目录发现。因此不能以原示例在当前模型配置下完成生成 |
| 输出工具 | `ffprobe` / `ffmpeg` 可执行文件在 ComfyUI venv Scripts 中，但该 venv Python 不存在；没有本轮输出视频供探测 |
| ComfyUI 启动日志 | TerryDirector 列在成功导入节点清单；日志还显示 `ComfyUI-LTXVideo` 导入失败（与本轮目标无关）。没有 AI Queue、Qwen 加载或 H3 采样记录 |
| AI Seed / 视频 Seed | 8888 / 9（示例 JSON 和静态校验） |

## 原始参考图

以下均来自本机既有 `ComfyUI/input/` 原文件；七张图全部成功解码，未复制或替换。完整本机路径不提交到报告以外的位置。

| 文件名 | 大小（字节） | SHA-256 | 解码尺寸 |
|---|---:|---|---|
| `00_特瑞_Terry.jpeg` | 2,300,683 | `353CD43C10431AEFB9B12DB035156B24FD90783DA1036C3F210B7749A0979A27` | 2752×1536 |
| `Generate_vehicle_multi-view_images_2K_202608132251.jpeg` | 2,480,843 | `12462DC2AA2F96EBACBA043EB402FD5B5A1DEA7706626FE1676FF65A560FC2D6` | 2752×1536 |
| `开场遗迹.png` | 4,316,580 | `D7F9954A139F020B5F8F7AAABC5A33F1DE1FECFC8103D4942F00A9EDFC6B528A` | 2752×1536 |
| `荒星地貌.jpeg` | 2,747,132 | `0A12CD63729D57FA38E2FE359962C8D449A53FAFB2DB5D83C6C32EA3DC0DA0FF` | 2752×1536 |
| `codex_9ea39e8314544c10aa7c0e140ba871d5.png` | 6,880,730 | `B2657E277D29C4928ED115F6AB35216AE89902A91797F905F3C0A0EEB214BCBA` | 2752×1536 |
| `Designing_custom_coin_grid_2K_202608170722.jpeg` | 2,797,645 | `678C19A7AA9B1D975C6E77135260186CF020F753D079C75ECA4720ED39666AD2` | 2752×1536 |
| `地下虫群-个体 拷贝.jpg` | 2,166,110 | `9416EF4F0B63902D0D6738C26EE0AA457FACFED2F0F4072BB8ADBAD4C5DC7BB5` | 2048×2048 |

## 验收项目

状态含义：**通过**仅用于实际满足验收标准的项目；**失败**表示执行后结果不符合标准；**阻塞**表示环境/访问条件不允许执行；**未测**表示尚未执行，且无明确失败证据。

| ID | 状态 | 证据 / 原因 |
|---|---|---|
| P0-01 | **阻塞** | 离线 JSON 校验通过：10 节点、10 连线、608×352、24fps、288 帧/12 秒、片段 4/3/5 秒、H3 对齐帧 107/73/124、无 Self-Lift、7 个素材路径、三段模式值 `tail_reference`、后三段编译静态图数量各 7、动态尾帧位为 8。七图实际解码通过。未能在 ComfyUI UI 实际导入，未核实画布连接与下拉模型可见性。结构检查只属静态证据。 |
| P0-02 | **阻塞** | 未 Queue。缺少已核实的 Llama 运行依赖及示例要求的 H3 权重；未实证模型对图像内容的视觉输入、Qwen 单次加载、3/3 增强、卸载后采样。 |
| P0-03 | **未测** | 无本轮 SaveVideo 文件；无 ffprobe/完整解码结果。 |
| P0-04 | **未测** | 没有首轮 AI 结果可用于复用测试。 |
| P0-05 | **未测** | 未执行原文变更后的方案 A 检查。 |
| P0-06 | **未测** | 未运行视频 Seed 变化场景。 |
| P0-07 | **未测** | 未运行 AI Seed 8888→8889；未验证元数据和批量模型加载次数。 |
| P0-08 | **阻塞** | Python Llama 和 Qwen35ChatHandler 导入通过；但 ComfyUI API 在复核时不可访问，未能验证编辑器按钮、HTTP Job 轮询及不触发 Queue。 |
| P0-09 | **未测** | 未执行保存、重开、刷新或重启持久化检查。 |
| P0-10 | **未测** | 未断开 Llama 连接检查按钮状态和错误处理。 |
| P0-11 | **未测** | 未启动推理，因此无法检查取消、异常恢复、并发锁或 Qwen 显存回收。 |
| P0-12 | **阻塞** | 静态编译结构显示首段有效连续模式为 independent，第二/三段 `tail_reference`，全局图数各为 7、动态尾帧图片位为 8。但没有运行期实际帧证据，1→2 与 2→3 均不能判通过。 |

### 显存与耗时

| 阶段 | 时间 / 显存 |
|---|---|
| 冷启动基线检查 | 2026-10-11 12:49 左右；2822 MiB / 24576 MiB（整卡总占用，非 ComfyUI 进程专属） |
| Qwen 加载后 | 未测（未启动） |
| 第三段增强后 | 未测（未启动） |
| Qwen 卸载后 | 未测（未启动） |
| H3 第一段采样期间 | 未测（未启动） |
| 生成完成 | 未测（未启动） |

## 阻塞结论与复跑条件

本次没有对任何模型包、PyTorch、CUDA、ComfyUI 或输入素材作变更。ComfyUI Python 依赖与 Llama 接口现已确认正常；当前剩余实机条件是恢复运行中的 ComfyUI 服务、确认示例实际可选的 Qwen GGUF/mmproj 配置，以及提供示例指定的 H3 主模型、编码器和双 VAE（或在本机导入副本中选择已安装的等价 H3 文件并记录）。满足后仍需从示例 JSON 实际导入并逐项执行 P0。不能用已有旧视频代替本轮 SaveVideo 输出。

- 发现并修复：无；未形成代码修复。
- 修复提交：无。
- 本报告提交：待创建；随后只推送到 `feat/ai-prompt-enhancement`。
