# cu130 周边依赖定向修复报告

日期：2026-10-10  
分支：`feat/selflift-internal`  
TerryDirector 实际提交：`bb09bac138dc5d6d8b950b2071766fd7f5a4bbd2`（包含要求的 `bb09bac`）

## 结论

按实际安装元数据确认并修复了 NumPy 与 Pydantic 冲突。修复后 `pip check` 退出码为 0，Numba/NumPy CPU 检查、llama-cpp 导入、Qwen-TTS 插件导入、完整 ComfyUI 初始化和 CUDA/Kitchen/Sol gate 检查通过。正式 8188 已恢复、监听正常、队列为空。视频生成和模型加载均为 0。

依照用户本轮补充指示，**LTX 插件导入失败不纳入本次修复验收**；没有改 Kornia，也没有禁用该插件。服务启动仍记录 LTXVideo 因 `kornia.geometry.transform.pyramid.pad` 缺失而导入失败。日志中另有一条 `pydantic-settings`/`pyproject.toml` 解析警告；该警告修复前后均存在，本轮没有找到可归属的项目源码位置，作为未解决项记录。

## 真实冲突与修复决策

修复前本机解释器执行 `pip check` 得到三项冲突：

- `llama-cpp-python 0.3.46` 要求 `numpy>=1.21.6,<=2.3.2`，实际 `numpy 2.5.3`。
- `numba 0.66.0` 要求 `numpy>=1.22,<2.5`，实际 `numpy 2.5.3`。Numba 依赖的 `llvmlite` 未改动。
- 本机安装的 `mixpanel 5.2.0` 元数据要求 `pydantic>=2.0.0,<2.12`，实际 `pydantic 2.13.5`。该结论来自本机 `importlib.metadata` 的安装元数据，而不是在线当前版本声明。

最小批准集为 `numpy==2.3.2`、`pydantic==2.11.10`、`pydantic-core==2.33.2`。Pydantic 与 core 按配套版本一起调整。没有修改 Kornia、Numba、llvmlite、llama-cpp-python、Mixpanel 或其他分发包。官方 PyPI dry-run 在修复前与克隆后的新前缀各执行一次；两次均只规划这三个目标，469 项基础依赖约束通过，包版本和 wheel 哈希计划一致。实际仅通过本地 wheelhouse 安装一次，没有使用 `--no-deps`、升级或强制重装。

## 备份和变更范围

停止服务前确认 8188 队列空、8190 未运行。原 cu130 `.venv` 在同卷改名保留为 `.venv_cu130_before_dependency_fix_20261010_180734`，原路径通过外部 Conda 克隆建立新 cu130 环境；旧 `.venv_cu128_backup_20261010_144207` 未触碰。对原 cu130 快照中实际存在的 38 个关键二进制逐项比对，改名后全部匹配；克隆和安装后的受保护核心文件也全部匹配。快照清单中 12 个仅属于 cu128 清单的 DLL 在修复前就不存在，不计作差异。本轮没有执行回退。

实际变化只有：

| 分发包 | 修复前 | 修复后 |
|---|---:|---:|
| NumPy | 2.5.3 | 2.3.2 |
| Pydantic | 2.13.5 | 2.11.10 |
| pydantic-core | 2.41.5 | 2.33.2 |

保护版本保持：Python 3.12.13、Torch 2.11.0+cu130、torchvision 0.26.0+cu130、torchaudio 2.11.0+cu130、comfy-kitchen 0.2.37、SageAttention 2.2.0+cu130torch2.10.0andhigher.post5、triton-windows 3.7.1.post27。安装前后 38/38 个受保护关键二进制 SHA-256 匹配。TerryDirector 工作流/产品代码、ComfyUI/KJNodes 源码、模型和采样参数均未修改。

三个安装 wheel 的 SHA-256 与 pip 下载报告一致：

- NumPy 2.3.2：`9e196ade2400c0c737d93465327d1ae7c06c7cb8a1756121ebf54b06ca183c7f`
- Pydantic 2.11.10：`802a655709d49bd004c31e865ef37da30b540786a46bfce02333e0e24b5fe29a`
- pydantic-core 2.33.2：`f941635f2a3d96b2973e867144fde513665c87f13fe0e193c158ac51bfaaa7b2`

## 验收证据

- 修复后 `pip check`：`No broken requirements found.`，退出码 0；安装态依赖 guard 检查 469 项通过。
- CPU smoke：NumPy/Numba 编译数组加法通过；Torch 与 NumPy CPU 往返通过；`llama_cpp` 导入通过但未加载模型；Pydantic/BaseSettings 小型解析通过；Qwen-TTS Python 包导入通过但未加载模型。
- 轻量后端导入：SageAttention 和 Kitchen CUDA 扩展导入成功；未执行注意力 kernel 或模型前向。
- 完整临时 8190 插件集合初始化通过。实际注册快照显示 cu130、Kitchen CUDA registry available 且未禁用、扩展已加载、Sol 符号存在、RTX 3090 compute capability 8.6 满足 8.0 下限。这里只验证 gate/注册状态，没有声称运行了 Sol kernel。
- 正式 8188 用原启动参数恢复。API/system stats 就绪，唯一监听进程为本轮恢复的服务进程；队列运行/待处理均为 0。注册项从 2759 增至 2979，未移除既有节点；原需保留的 Self-Lift、Director、FFN、ModelAttention、Sol 和 Qwen-TTS 节点均存在。新增 220 项来自启动日志中此前因 Numba/NumPy 导入失败而未加载的 WAS Suite 节点；修复后 WAS Suite 和 Qwen-TTS 启动成功。
- 完整 8188 错误扫描中，Numba/NumPy 和 Qwen-TTS 导入错误已消失。唯一插件导入失败为按用户指示排除的 LTXVideo/Kornia 项；另有前述未定位 `pyproject.toml` 解析警告。
- 临时 8190 已正常停止；8188 保持运行。生成提交数 0、模型加载数 0。

## 交付与限制

`environment/cu130-accepted.constraints.txt` 记录本次已验收的周边版本，并引用 `cu130-core.constraints.txt`。公开 JSON 仅保留必要摘要、提交号和 wheel 哈希；完整日志、安装元数据、冻结清单及环境路径留在本机私有目录。未进行性能或画质结论，也未合并 `main`。