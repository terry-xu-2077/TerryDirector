# 审计完成后的 cu130 环境切换与 cu128 回退

> 用户于 2026-10-10 明确要求：先让 Codex 跑现有任务；如果仍无进展，就切换到 130，并将旧环境备份改名。  
> 编写时分支 HEAD：`c9d0e1609121b79ce362157fd16ec9a22d96a96e`。本文不代表本机审计、备份或安装已经完成。

## 1. 顺序与授权范围

先完整执行 `AUDIT_SOL_RUNTIME.md`，保存并提交 `reports/06_SOL_RUNTIME_GATE_AUDIT.md` 和对应 evidence；不打断正在进行的审计，不把安装前后两种环境混写成同一次审计。报告06缺失或任务仍运行时不执行迁移。

审计结束后：若完整 ComfyUI 初始化后的 Sol 仍不可用，或现环境仍无法解除该阻塞，可按本次用户授权进行一次可回退的 cu130 环境迁移。若已证明现环境正常可用，则本次迁移标为 NOT_NEEDED，不为得到不同结果强行升级。若根因仍未知，明确记为“环境替换实验”，不得把升级后的变化追写成旧问题的已证实根因。

本授权仅在审计结束、触发迁移条件后，覆盖旧实验规则中“不升级 Python 依赖／不重启正式服务”的对应限制：允许备份并重建实际共享 Python 环境、为此在队列空闲时停止和恢复使用该环境的本项目服务。**不授权终止进行中的任务、清队列、驱动或系统 CUDA Toolkit 升级、修改现有节点／ComfyUI／KJ 源码、绕过 CUDA 版本检查或合并 main。** 模型、LoRA、VAE、提示词、资产、已有工作流及独立测试链保留不变。

现有生产代码继续冻结在 `0c82cd7bfb2de963304479eda86e02513e106da0`。新增记录或必要的本地管理辅助脚本只放本实验目录；不改根启动脚本或根注册入口。

## 2. 停机前先准备完整回退依据

从真实服务进程及其解释器取得绝对环境路径，不只凭文件夹名猜测。历史记录为 `G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe`；这是核对线索，不是标准 venv 布局的保证。

记录实际 `sys.executable`、`sys.prefix`、`sys.base_prefix`、Python 版本、`pyvenv.cfg`／`conda-meta` 是否存在，确认是标准 venv、Conda prefix 或其他布局。检查是否是 junction/symlink；未知链接目标不得直接重命名。先确认可用的环境重建工具和基础 Python 位于待备份目录之外，避免改名后连重建工具也失效。

用旧环境的绝对解释器加 `-m pip` 导出 `freeze --all`、`list --format=json`、`check` 结果和可用的安装来源信息；Conda 环境另导出其原生环境与显式包清单。记录 ComfyUI/KJ 提交、torch/torchvision/torchaudio/Kitchen/Sage/Triton 版本、关键扩展哈希、相关进程PID及原启动命令。保存本次迁移前已有依赖冲突，不能把旧冲突写成新迁移错误，亦不能用它放行新增冲突。

检查空余磁盘足以同时保留旧环境、新环境及安装包缓存；先取得必要安装包／确认下载可用，保留自编译或非标准来源的 wheel。清单和完整私有路径留 `local/env_handover/<执行时刻>/`，不要提交整套环境、wheel 或可能含凭据的URL。

## 3. 按用户要求将旧环境原样改名备份

先确认8188、8190及其他使用目标环境的本项目进程均无执行／待处理任务；若有人正在使用，记录延后状态，不杀任务。暂停会自动重启这些服务的本地启动器，再正常退出相应进程，确认不再占用目标 Python/DLL，随后退出旧激活环境。不得用“结束所有 python.exe”的方式停机。

按实际叶目录创建唯一备份名，例如：

```text
原实际路径：...\ComfyUI\.venv
旧环境备份：...\ComfyUI\.venv_cu128_backup_YYYYMMDD_HHMMSS
新环境位置：...\ComfyUI\.venv
```

时间戳使用本次执行的当地时间，不覆盖同名备份。旧目录只做同卷改名，记录目录清单及关键文件前后哈希；**不卸载、不清理、不在备份内安装或修复任何包**。保留外部基础Python/Conda及所需本地源路径，不删除原依赖所引用的文件。

备份是供恢复原路径使用的封存目录，不承诺能从改名后的路径直接启动。Python venv 的脚本可能包含绝对解释器路径；不要复制整个新环境到另一个名字后就假定可用。新的环境应使用已核对的管理器，在最终使用路径重新创建；Conda prefix 使用其受支持的创建／克隆方法处理前缀，不能把标准 `python -m venv` 当成所有布局的替代。创建后重新核对解释器位置；若改变了原来的 `python.exe` 布局而使既有启动器不适用，停止并回退，不靠修改正式启动器隐藏问题。

## 4. cu130 目标与安装边界

这里的130是 **PyTorch CUDA 13.0构建**，验收读取 `torch.version.cuda == "13.0"`。只安装系统CUDA Toolkit、只看驱动面板或 `nvcc --version`，不算完成迁移。

优先保持 Python 3.12 与 PyTorch 主版本2.11不变，仅改CUDA构建。官方给出的Windows/Linux配套是：

```text
torch==2.11.0
torchvision==0.26.0
torchaudio==2.11.0
index-url: https://download.pytorch.org/whl/cu130
```

2026-10-10查证官方索引存在 `torch-2.11.0+cu130-cp312-cp312-win_amd64.whl`。本地执行时仍核对下载包平台、来源与哈希。以新环境的绝对Python执行安装，例如：

```powershell
& $NewPython -m pip install torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu130
```

`$NewPython` 必须由上一节实际新建环境解析，不使用当前shell的裸pip。此命令仅安装torch配套，不是完整环境恢复脚本。其他依赖按旧清单恢复，不无差别 `pip install -U`，不把旧 `+cu128` 条目或其CUDA依赖再次装回。保持 ComfyUI、KJ、Kitchen 0.2.37及既有扩展版本；若匹配cu130必须更换二进制wheel，记录相同版本的构建差异和来源。出现无法用同版本配套解决的大范围依赖冲突时停止并回退，不继续升级整套插件碰运气。

检查本机驱动是否满足所选官方cu130包的要求；不满足则BLOCKED，保留或恢复旧环境，本授权不包含驱动升级。不得手工 `registry.enable("cuda")`、修改availability返回值、删版本判断，或直接绕过Gate调用长序列内核。

## 5. 迁移后先验证环境，不排视频

本次安装交付仍是 **0次视频生成**。允许为新环境兼容性进行有界微张量检查，不加载H3大模型、不做速度基准、不触发 `/prompt`：

1. 核对新进程实际解释器、三件套版本、torch CUDA build、GPU名称及sm86，检查 `pip check` 相较旧环境无新增未解释冲突。验证所用Sage、Kitchen、Triton等扩展能正常导入；简单导入不冒称所有内核已兼容。
2. 在新环境跑既有实验测试和Git隔离检查，保留全部失败项；不修改冻结源码或跳过测试来放行。
3. 复用 `sol_runtime_audit.py` 记录Kitchen导入后、Comfy quant_ops导入后的同进程状态；再用新环境启动8190完整独立实验实例，记录实际进程状态，确认CUDA注册未禁用、扩展/符号/约束符合、Sol可用。启动其他插件后还需复核，不以“只import Kitchen的小进程为true”替代完整初始化。
4. 仅在上述Gate正常后，在同样初始化语义下用已有的小张量常规／chunked Sol能力冒烟各执行一次，记录shape/dtype/设备和有限值、实际调用来源。另对本流程所用密集Kitchen/Sage及INT8线性路径做有界微张量兼容检查。失败保留原始异常，不重试不同参数，不用CPU回退冒充通过。
5. 新环境就绪后，按原命令恢复8188正式服务，诊断默认关闭，验证原节点注册和关键扩展导入相对旧服务没有新增错误，确认队列为空；不追加导演生成来“顺便验收”。正式服务恢复失败或Sol仍不可用则封存失败环境并回退。成功也只标记环境检查通过，不标记H3长序列、画质或速度通过。

切换环境会同时影响稀疏、量化及其他算子，**以后测试Sol必须在cu130里重新建立密集B0和稀疏B1对照**。cu128旧B0仍保留作历史，不把CUDA构建变化的收益全记成Sol收益。本文件不授权立即新增这两条完整生成任务。

## 6. 回退与交付

迁移失败时先停止使用新环境的本项目进程，确认无任务，再将新目录改名为唯一的 `.venv_cu130_failed_<执行时刻>` 留存诊断；不删除备份。将旧 `.venv_cu128_backup_<原时间戳>` **恢复为原来的确切 `.venv` 路径**，使用原启动命令恢复服务，核对解释器、`torch.version.cuda`、节点注册与队列状态。备份从未写入；回退以恢复原前缀为准，不从改名备份路径运行pip或服务。若回退本身失败，保留两份目录并明确报告，不宣称恢复成功。

只新增：

```text
experiments/acceleration_lab/reports/07_CU130_ENV_HANDOVER.md
experiments/acceleration_lab/evidence/cu130_env_handover.json
```

记录报告06引用／触发理由、迁移是否执行、环境类型、原目录与备份映射（公开JSON用相对路径）、旧／新依赖差异、wheel来源及哈希、停止和恢复的本项目PID、两阶段Gate状态、微张量结果、正式服务恢复结果、回退是否执行／结果，以及视频提交数0。旧审计和01–06报告均不覆盖；明确安装失败、根因未知或依赖阻塞，不以“pip安装成功”代替运行验收。

## 查证来源与本次交付范围

- 官方PyTorch配套：https://pytorch.org/get-started/previous-versions/ （v2.11.0 CUDA13.0的Windows/Linux命令）。
- 官方Windows wheel索引：https://download.pytorch.org/whl/cu130/torch/ 。
- Python3.12 venv可移植性说明：https://docs.python.org/3.12/library/venv.html （环境通常不可直接移动；脚本包含绝对路径）。
- 本项目 `AUDIT_SOL_RUNTIME.md` 为审计前置任务；本文件只在其完成且用户条件满足后启用迁移授权，不改写其旧执行结论。

交付侧仅查证官方版本并提交本文；没有访问本机磁盘、停止服务、重命名环境、安装依赖、执行微张量或生成视频。
