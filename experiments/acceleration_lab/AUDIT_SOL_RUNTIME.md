# Sol 运行环境核对：零生成，不绕过 CUDA 版本检查

> 分支：`feat/selflift-internal`；本次复核基线 `f3d2a8a0e75849d14a7edbd8920a0b64d5e9e287`。
> 覆盖前一续测任务的排队授权：**本轮生成提交数必须为 0**，B0/B1/VAE/Veda 均不排队。
> 生产代码仍冻结在 `0c82cd7bfb2de963304479eda86e02513e106da0`。只改实验目录，不升级环境、不重启正式8188、不合并main。

## 1. 已有证据与这次源码推导必须分开

报告05的B1完成条件编码、一个低清callback后被中断：239.197秒是执行到中断，不是生成速度。Sol chunked调用0，高清未开始，无视频或checkpoint。旧attention参数错误已越过，但未验证稀疏前向。

报告01/evidence/sol_attn.json曾记录 `ck.sol_attn_is_available(cuda:0)=true`，并称常规及chunked微张量成功；报告05的实际后端却打印 `no compiled sol_attn kernel for this GPU`。两份历史记录均保留，**不直接把旧微张量记录删除或把后者改写成“3090硬件不支持”**。旧记录没有提供足以比较进程初始化状态的完整证据，本轮要补足。

交付侧读取了以下固定上游代码（不是本机历史进程直接观测）：

1. ComfyUI `b26625f23a888367b92153b28d93e159e83e677b` 的 `comfy/quant_ops.py`，Git blob `0b0f4f863699a9f6e001bb5c9a0d75dcc7587837`：导入时检查 **`torch.version.cuda`**；低于13时执行 `ck.registry.disable("cuda")` 并发cu130警告。本项目最近记录的torch是 `2.11.0+cu128`，即该判断所用CUDA build为12.8，不是系统nvcc或驱动显示的“CUDA Version”。本机quant_ops源码及哈希尚须本轮复核。
2. comfy-kitchen `v0.2.37` 的 `comfy_kitchen/__init__.py`，blob `bc63befefa0e59cd88081ba748d25cf3d0e0afe1`：`sol_attn_is_available()`同时检查CUDA设备、`registry.is_available("cuda")`、扩展加载标志、`_C.sol_attn`符号、已注册约束与架构门槛，并不只看是否存在编译文件。
3. 同tag的 `comfy_kitchen/registry.py`，blob `9c93d93aa34c7a0febe72d282ed88030f5d21d35`：`is_available()`要求已注册且未禁用；`list_backends()`的 `available=True` 与 `disabled=True` 可以同时成立。

**可检验推导：**仅import Kitchen的小进程可以判可用，而随后import Comfy quant_ops的同一进程会因cu128将注册后端禁用，继而使原生Sol返回不可用。它能解释旧微张量与正式初始化后状态的矛盾，但当前没有那两个历史进程的全套快照，不把推导写成历史根因已逐次观测。

Kitchen密集attention此前真实运行过，不能由Sol不可用推翻报告46；它有独立的API/扩展调用路径。不能据本次日志认定整个模型或注意力在CPU上运行，也不能预测换运行环境后的提速倍数。

## 2. 新工具的范围

`sol_runtime_audit.py`无顶层torch/Comfy导入，有两种只读模式：

- 命令行在一个新的子进程先import Kitchen记录快照，再import本机 `comfy.quant_ops`记录同PID快照；不启动服务器、不加载权重、不运行模型或attention。它只复现导入顺序，**不是完整服务启动复现**。
- 独立实验扩展注册时，只有 `TERRY_ACCEL_LAB_SOL_AUDIT=1` 才读取当前服务器已经加载的torch/Kitchen/quant_ops对象，记录实际PID、解释器、CUDA build、后端available/disabled、约束、架构、扩展标志/符号、关键源码与.pyd的路径/哈希。不得改注册状态。此快照只证明扩展注册时的状态，不保证之后别的扩展不会修改它。

工具不分配测试张量、不运行稀疏微基准、不enable/disable后端、不改变优先级或函数，不改工作流。设备查询可能初始化CUDA运行时；不能说它完全不触碰CUDA。完整快照有本机路径，留在local目录，提交报告前脱敏。

所有输出明确 `generation_allowed=false`。退出码0只表示诊断记录完成，**不等于Sol可用或可以排视频**。错误保留traceback；不覆盖旧输出文件。

## 3. 本地Codex执行（本轮0次生成）

保留现有未提交改动，拉取后用实际ComfyUI `.venv` 从仓库根执行实验测试和隔离检查，检查各自退出码。生产测试不修改、不skip。

```powershell
& "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe" -m unittest discover `
  -s experiments/acceleration_lab/tests -p "test_*.py" -v
& "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe" `
  experiments/acceleration_lab/check_isolation.py --repo .
```

### A. 同一子进程的导入前后快照

```powershell
& "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe" `
  experiments/acceleration_lab/sol_runtime_audit.py `
  --comfy-root "G:\AIGC\ComfyUI_Codex\ComfyUI" `
  --output "experiments/acceleration_lab/local/sol_runtime_audit/import_order.json"
```

使用新的输出文件，失败保留记录。阅读两份snapshot，记录可用性/disabled是否变化、每项判定及来源；读取本机quant_ops对应行与hash。纯import的默认CLI状态不同于实际服务器，本轮继续B确认，不把A替代B。

### B. 实际实验进程注册时的快照

先确认8190空闲且没有另一GPU任务；不得停止或改动8188。用PowerShell 7，在一个新RunName的实验实例启动前设置：

```powershell
$env:TERRY_ACCEL_LAB_SOL_AUDIT = "1"
try {
    ./experiments/acceleration_lab/start_lab.ps1 -Port 8190 -RunName sol_runtime_audit
} finally {
    Remove-Item Env:TERRY_ACCEL_LAB_SOL_AUDIT -ErrorAction SilentlyContinue
}
```

确认服务实际PID和`[TerryAccelLab] sol_runtime_audit`日志；完整JSON在该实验运行输出的 `.acceleration_lab/sol-runtime-audit-*.json`。如RunName已存在，用新的独立名称，不覆盖旧证据。启动器继续关闭旧导演trace/OP_PROFILE/backend verify。不调用 `/prompt`，不运行B0/B1，也不因为检查为true就额外跑微张量。采集后仅停止本次实验PID，检查正式服务与生产文件仍未改变。

运行时`sol_available=false`时，区分：

- 扩展和符号存在、约束和架构通过，**registry disabled**；
- 真正的扩展未加载、缺符号、无约束、设备架构不满足；
- 查不到来源、查询报错或进程证据不一致，标UNKNOWN。

如果A由true变false、B也disabled，且本机quant_ops同一条件执行能解释这一变化，可记为“本轮导入实验直接复现，当前实验进程状态吻合”。历史两次微张量/生成的详细进程仍不能补造。若结果不吻合，不为迁就推导改字段；继续记录当前实际证据与未知项，但不修改依赖或排生成。

## 4. 禁止作为修复的动作

不调用 `ck.enable_backend("cuda")`、`registry.enable("cuda")`，不把availability强改true，不绕过Comfy CUDA版本保护，不删除版本条件。没有确认匹配的运行时/扩展前，这些不能当作安全兼容修复。

不在正式或共享`.venv`中升级torch/CUDA/Kitchen，不更新驱动，不开Triton来掩盖失败，也不关闭保护条件行或减参考/尺寸。不绕过Gate直调长序列稀疏内核。

若版本禁用链被证实，后续候选才是**新建隔离Python环境、匹配受支持的PyTorch CUDA build和扩展**。本轮只写明确证据与依赖影响，不执行安装。切换环境将改变对照条件，旧B0只能是历史参考，不能把环境收益全记成Sol收益；下一轮测试预算须另定。

## 5. 交付

只新增到实验目录：

```text
reports/06_SOL_RUNTIME_GATE_AUDIT.md
evidence/sol_runtime_gate_audit.json
```

记录本轮实际commit、解释器/包版本、A前后与B的PID/时间/来源hash、每个gate项、backend registered/disabled、编译符号与最小架构、实际quant_ops判断和warnings。表格明确历史报告结论、本轮直接观测、源码推导、未知项。旧01–05及所有失败原文不改。

提交精简脱敏JSON，不提交含私人路径的完整快照、模型/视频或环境文件。生成次数必须0；预检报错也要提交其证据。结束停止实验实例，不合并main，不把技术失败冒充已经提速。

## 交付侧验证范围

Linux/Python标准库的15项新测试通过，覆盖可用但不放行生成、registered但disabled、扩展/符号/约束缺失、架构门槛、查询异常、默认关闭、实际已加载对象模式、同进程前后差异、异常保存和旧文件保护；3个Python文件语法检查通过。测试用接口替身，不是本机Comfy/Kitchen/CUDA执行，没有重跑完整实验测试集，没有生成或升级依赖。

固定来源：
- https://github.com/Comfy-Org/ComfyUI/blob/b26625f23a888367b92153b28d93e159e83e677b/comfy/quant_ops.py
- https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.37/comfy_kitchen/__init__.py
- https://github.com/Comfy-Org/comfy-kitchen/blob/v0.2.37/comfy_kitchen/registry.py
