# Sol 运行时 Gate 审计（零生成）

## 结论

**已在本轮直接复现：`torch.version.cuda=12.8` 经 ComfyUI `comfy.quant_ops` 导入后禁用 comfy-kitchen CUDA registry，使 `ck.sol_attn_is_available(cuda:0)` 从 true 变为 false。** 实际 8190 实验服务扩展注册时也处于同一状态。

这是 **CUDA backend 已注册、扩展和符号已加载，但 registry disabled**。不是 CUDA 扩展缺失，也不是 GPU 架构不满足：RTX 3090 的 SM 8.6 高于记录的 Sol 最小 SM 8.0。Kernel 可用性为 false，因此本轮没有运行稀疏 kernel。

| 证据场景 | `torch.version.cuda` | CUDA backend | 扩展/符号 | 架构门槛 | Sol 可用性 |
|---|---|---|---|---|---|
| 新子进程，导入 Kitchen 后 | 12.8 | registered；enabled | 存在 | SM 8.6 ≥ 8.0 | `true` |
| 同一 PID，随后导入 `comfy.quant_ops` 后 | 12.8 | registered；**disabled** | 存在 | 满足 | `false` |
| 实际 8190 服务注册时 | 12.8 | registered；**disabled** | 存在 | 满足 | `false` |

本轮生成提交数 **0**。没有运行 B0/B1/VAE/Veda、模型前向、稀疏微基准或 kernel smoke。没有强制启用 backend、升级依赖或修改正式服务/导演节点。8190 实验实例采集后已停止；8188 正式服务未重启。

## 测试与隔离

拉取 `feat/selflift-internal` 后确认包含 `c9d0e1609121b79ce362157fd16ec9a22d96a96e`。原 ComfyUI `.venv` 中实验测试 **67/67 通过**；`check_isolation.py` 在采集前后均通过，`forbidden_changed_paths=[]`，生产文件未改。

本机环境：Python 3.12.13、torch `2.11.0+cu128`，所以 `torch.version.cuda` 为 `12.8`；comfy-kitchen `0.2.37`；NVIDIA GeForce RTX 3090 / compute capability 8.6。ComfyUI 提交 `b26625f23a888367b92153b28d93e159e83e677b`。

## 同一子进程的导入前后快照

全新子进程 PID **18124**，先导入 comfy-kitchen 并读取工具快照，再导入本机 `comfy.quant_ops` 并在相同 PID 再读快照；两个快照时间相隔约47毫秒。详细完整 JSON 留本机：`local/sol_runtime_audit/import_order.json`，SHA-256 `5bc0fa68ef48332deb732587886564f30b0b80fb17906f27ed1fb5584e8663c4`。

| Gate 字段 | 导入 quant_ops 前 | 导入 quant_ops 后 |
|---|---|---|
| CUDA 设备可用 | true | true |
| `registry.is_available("cuda")`（已注册且启用） | true | **false** |
| `list_backends()["cuda"].available / disabled` | `true / false` | **`true / true`** |
| 扩展 `_EXT_AVAILABLE` | true | true |
| `_C.sol_attn` 符号 | 存在 | 存在 |
| Sol constraints | 存在 | 存在 |
| 设备满足最小架构 | true，SM 8.6 ≥ 8.0 | true，SM 8.6 ≥ 8.0 |
| `sol_attn_is_available(cuda:0)` | true | **false** |

`available=true` 与 `disabled=true` 可以同时存在：前者说明 backend 信息/能力已经注册，后者意味着 registry 不会允许它参与可用 backend 选择。工具还记录了 cu130 版本警告。这个子进程只复现导入次序，不是完整服务启动。

## 实际 8190 实验服务注册快照

采集实例 PID **22032**，启动于本地时间 2026-10-10 14:35:31；扩展注册快照时间 14:35:40。日志写明 `[TerryAccelLab] sol_runtime_audit ... status=CUDA_REGISTRY_DISABLED sol_available=False ... generation_allowed=false`。`/object_info` 确认实验桥接节点注册；审计从服务进程读取已加载对象，没有重新导入或更改 backend 状态。

该进程的实际 gate 与导入后快照一致：torch CUDA build 12.8；CUDA backend 条目存在，`available=true/disabled=true`；`registry.is_available("cuda")=false`；CUDA 扩展已加载且 `_C.sol_attn` 存在；约束存在，SM 8.6 满足最低 SM 8.0；最终 `sol_attn_is_available=false`。stderr 在启动时有 `You need pytorch with cu130 or higher to use optimized CUDA operations.` 警告。快照记录 `model_forwards=0`、`kernel_smoke_executed=false`。

完整私人快照留在 `local/runs/sol_runtime_audit/runtime/output/.acceleration_lab/sol-runtime-audit-22032-20261010T063540654264Z.json`，SHA-256 `3410dbfb8553a6957178dd02f4b4f35b56ae491de44a2128acdbc78cb1c7fe5d`。实际 stdout/stderr 完整保留在同目录的 run 根；摘要只公开哈希和必要状态，不包含绝对路径。

## 源码判断与历史记录边界

本机 `comfy/quant_ops.py` SHA-256 `8e094d4f29226d50ceb2014f3c0cfe5cabe85a1ed9ce70f0adfe5d943e0ef587`。第22–27行在 Kitchen 导入后检查 `torch.version.cuda`：build 为 `None` 或版本低于 `(13,)` 时调用 `ck.registry.disable("cuda")`；12.8 满足“低于13”条件。服务 stderr 的 cu130 警告和前后实际快照与这段判断吻合。

本机 comfy-kitchen `__init__.py` SHA-256 `a6cc073c46db51f1ff055065daa809ab217d642adfc8b0f552be049bbe18b4a3`，`registry.py` SHA-256 `e7eb061c1d52222af2a8d738102bfe9f4e85d5cc5a9f9fe4bd443d0185b0f77f`，CUDA backend 模块 SHA-256 `27ef9c1063a3dcdee6e05928e07588ed82f076b64c07c131d987d065ab4c50ac`，扩展 `_C.abi3.pyd` SHA-256 `d41adbb507c46868446beb1d756d3953a4fc5b9187970baf83f7abe5993c58b9`。comfy-kitchen 版本 `0.2.37`。扩展文件存在、已加载且有 `sol_attn` 符号；因此分类不是“扩展缺失”。

这次导入顺序的**直接观测**可以解释报告01中 Kitchen 单独导入时曾测得 Sol available=true、而报告05实际服务日志提示无可用 Sol kernel 的差异：`quant_ops` 在真实服务初始化顺序中禁用了 CUDA registry。它不重建报告01或报告05当时各自进程的全部状态；旧进程没有完整快照，所以不把本轮结果冒充为对历史每个进程的回溯观测。报告05只是 backend fallback 的历史直接日志，不能据此认为密集 Kitchen attention 也不可用、整个模型在 CPU 上运行，或推断更换环境后的速度收益。

各来源和结论标签：

- **本轮直接观测：** 同一新子进程导入前后状态变化；实际 8190 注册时 CUDA registry disabled、扩展与符号存在、架构满足；服务版本警告。
- **本机源码判断：** `quant_ops.py` 的 CUDA build 版本门槛解释了 registry 为什么被禁用；Kitchen availability 同时依赖 registry enabled 状态。
- **历史运行证据：** 报告01曾记录 Kitchen 单独导入后的 available=true；报告05记录实际稀疏路径没有可用 Sol kernel。未补造旧 PID/初始化快照。
- **未知项：** 本轮没有模型/kernel smoke，故不证明真实 H3 前向在别的 CUDA build、独立虚拟环境或其他机器上的可用性/性能，也不测 Kitchen dense 路径速度。

后续若评估 CUDA 13 build，应另建隔离环境并重新验证依赖兼容性；本轮不执行安装。`evidence/sol_runtime_gate_audit.json` 提供脱敏状态与哈希。旧报告01–05及旧失败记录均保留。
