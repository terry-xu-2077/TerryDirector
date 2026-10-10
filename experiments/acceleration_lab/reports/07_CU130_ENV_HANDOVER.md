# cu130 环境交接报告

## 结论

环境交接完成，标记为 **PASS_WITH_NOTES**。旧 Conda prefix 已改名封存，新 cu130 prefix 已在原 `.venv` 路径创建。PyTorch / Kitchen CUDA gate 在导入 Comfy `quant_ops` 前后及完整 8190 ComfyUI 实例中均保持可用；Sol regular 与 chunked、Kitchen attention、SageAttention、Kitchen INT8 linear 的有界微张量调用均成功。8188 正式服务已用原命令恢复，最终 API 可用且队列为空。**本轮视频生成次数为 0**，未排 B0/B1，没有合并 main，也没有改节点、工作流或驱动。

报告06 `AUDIT_SOL_RUNTIME_GATE_AUDIT.md` 记录的 cu128 实际 8190 环境中，`torch.version.cuda=12.8` 后 Kitchen CUDA 注册为 disabled、Sol unavailable。它触发了本文的环境交接；本文未把迁移后的状态回写为旧环境结论。

## 环境与备份

- 原环境是 Conda prefix：`ComfyUI/.venv`，存在 `conda-meta`，没有 `pyvenv.cfg`，不是链接目录。
- 停机前 8188 队列为 running=0、pending=0。原服务 PID 37276 已退出。
- 原目录同卷改名为 `ComfyUI/.venv_cu128_backup_20261010_144207`；没有在备份中安装或修改包。改名后重新核对的 48 个关键二进制 SHA-256 全部匹配停机前清单，备份保留在本机。
- Conda 25.11.1 位于备份目录之外，用其 `--clone` 在原 `ComfyUI/.venv` 前缀创建新环境。Python 仍为 3.12.13。
- 源码版本：TerryDirector 审计提交 c68aa00a088a7d0bfd8d9c4c60cafddd9d3a62c5；ComfyUI b26625f23a888367b92153b28d93e159e83e677b；KJNodes 3f20054214fec9f9234fd3841ae6f1e4287948f6。这些源码保持不变。
- cu130 PyTorch wheel 由用户放入本机 wheelhouse，按文件 SHA-256 校验后从本地安装；只更换 torch 三件套，没有升级整套依赖。

| 包 | 迁移前 | 迁移后 |
|---|---|---|
| torch | 2.11.0+cu128 | 2.11.0+cu130 |
| torchvision | 0.26.0+cu128 | 0.26.0+cu130 |
| torchaudio | 2.11.0+cu128 | 2.11.0+cu130 |
| comfy-kitchen | 0.2.37 | 0.2.37 |
| SageAttention | 2.2.0+cu130torch2.10.0andhigher.post5 | 同左 |
| triton-windows | 3.7.1.post27 | 同左 |

三件套 wheel 为 Python 3.12 / Windows x64。SHA-256：

- `torch-2.11.0+cu130-cp312-cp312-win_amd64.whl` — `ef8beae16d781c3244ef28dc7bee6d8871c26bbde65d5bf66e902cb61972c4ab`
- `torchvision-0.26.0+cu130-cp312-cp312-win_amd64.whl` — `a3578f7c8e8a2724306c68c56873a1675fa7ce45471e18235c720a2ed242fe44`
- `torchaudio-2.11.0+cu130-cp312-cp312-win_amd64.whl` — `f74949f9ace1e4a6cf9468bdb3211b9cfa0af6ea348125471ac71c8621d6c77d`

版本组合依据 [PyTorch 官方历史版本安装说明](https://pytorch.org/get-started/previous-versions/)；wheel 来自用户提供的官方 cu130 Windows wheel 文件。没有升级驱动或系统 CUDA Toolkit。只读驱动检查为 RTX 3090、驱动 591.74、Compute Capability 8.6。

## 迁移后验收

| 检查 | 结果 |
|---|---|
| 解释器与 CUDA build | 新进程使用原路径 `.venv\python.exe`；Python 3.12.13；torch 2.11.0+cu130；`torch.version.cuda=13.0`；CUDA 可用，设备 RTX 3090 / sm86 |
| `pip check` | 迁移前后相同的 3 条既有冲突，无新增项：llama-cpp-python 对 NumPy 上限、mixpanel 对 Pydantic 上限、numba 对 NumPy 上限 |
| 关键扩展 | comfy-kitchen 0.2.37、SageAttention、triton-windows 均可导入；完整 ComfyUI 启动日志识别 Torch cu130 / Kitchen 0.2.37 |
| 实验测试 | `unittest discover`：67 tests，全部通过 |
| Git 隔离检查 | `check_isolation.py` 成功；`production_files_unchanged=true`，`forbidden_changed_paths=[]` |
| Kitchen 导入顺序 | 新子进程中，Kitchen 导入后及 Comfy `quant_ops` 导入后 Sol 均为 available；CUDA 未 disabled，扩展与 `sol_attn` 符号已加载；两次快照无 gate 变化、无异常 |
| 完整 8190 初始化 | 实际 Lab ComfyUI 进程 PID 30804；`torch.version.cuda=13.0`、CUDA registry enabled、扩展已加载、Sol available；审计无错误。`/object_info` 返回 1246 个键，Self-Lift、Sol bridge、MiniMaxChunkFeedForward 和 ModelAttentionBackend 已注册。未调用 `/prompt` |
| 微张量 | 5 条路径一次调用、有限值返回：见下表。只用于能力检查，不是性能对比 |
| 正式 8188 服务 | 使用原启动参数恢复；最终只有 8188 监听，API 可用，队列 running=0 / pending=0；临时 8190 已停止 |

微张量运行在 RTX 3090 `cuda:0`，BF16；规模刻意保持很小。记录的一次调用耗时包含首次调用/初始化，不应用作性能结论。

| 路径 | 输入规格 | 输出规格 | 有限值 | 单次记录 |
|---|---|---|---|---:|
| Kitchen Sol regular | Q/K/V `[1,64,1,128]` | `[1,64,1,128]` | 是 | 12.024 ms |
| Kitchen Sol chunked | QKV `[64,384]`，T=64、H=1 | 输出 `[1,64,1,128]`，并返回两组 `[1,128]` 状态 | 是 | 28.908 ms |
| Comfy Kitchen INT8 attention | Q/K/V `[1,1,64,128]` | `[1,1,64,128]` | 是 | 12.468 ms |
| SageAttention | Q/K/V `[1,1,64,128]` | `[1,1,64,128]` | 是 | 473.887 ms |
| Comfy Kitchen INT8 linear | X `[4,64]`、量化权重 `[32,64]` | `[4,32]` | 是 | 4.283 ms |

## 保留的问题与边界

- 8188 恢复日志里出现一次 `Port 8188 is already in use`，随后出现 ComfyUI server ready。最终 `netstat` 确认唯一监听进程 PID 33652 使用原 `.venv\python.exe` 路径和原启动参数，API 检查成功、队列为空；该瞬时端口日志保留在本机证据中。
- 8188 启动日志还记录到可选插件导入错误：一个插件从 Kornia pyramid 模块导入 `pad` 失败；Qwen-TTS 相关路径因 Numba 拒绝 NumPy 2.5.3 而导入失败。Numba/NumPy 冲突在迁移前 `pip check` 已存在；Kornia 项没有可用的旧正式服务 stderr 作逐行对照，因此不判断它是迁移新增还是原有问题。未为修复这些可选插件升级或变更依赖。核心服务已就绪，关键 Self-Lift/Sol 节点注册成功。
- 本次只证明 CUDA 13.0 构建、完整后端初始化和小张量算子可执行；不证明 H3 长序列、画质或速度。旧 `.venv` 备份保留，可按交接文档回退；本轮没有执行回退。

## 本机私有原始证据

清单、完整私有路径、wheel、环境快照及原始日志均保存在 `experiments/acceleration_lab/local/env_handover/20261010_144207/`；本机 8190 服务日志在 `experiments/acceleration_lab/local/runs/cu130_handover_20261010/`。这些私有文件没有提交。公开 evidence JSON 使用相对路径并包含三件套哈希、gate 摘要、测试结果、微张量摘要、服务 PID 与最终队列状态。
