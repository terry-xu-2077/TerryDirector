# cu130 对照继续：先启动实验实例，再校验实验节点

> 复核提交：`04367a687ac0b2618924528b2c1c630ba853ca8a`；分支 `feat/selflift-internal`。
> 继续 `RESUME_SOL_CU130.md` 的原 B0/B1 任务，只修正启动与校验顺序。保留报告08及所有旧证据。
> 不修改导演节点、Self-Lift 数学核心、正式服务、工作流内容或依赖；不合并 main。

## 1. 报告08不是新的环境或 Sol 失败

`reports/08_SOL_CU130_COMPARISON.md` 与 `evidence/sol_cu130_comparison.json` 记录：67项实验测试、隔离检查、API哈希及B1动态绑定通过。但没有启动8190实验实例，转而用8188的节点注册表校验实验图，缺少 `TerryAccelLabCondition` 后停止；B0/B1提交均为0。环境就绪字段来自报告07，不是本轮新进程观测。

正式8188没有实验节点是当前隔离设计的正常情况，不能据此判定实验图或cu130安装失败，也不得为解决此错误把实验节点装到正式服务。8190在上轮结束后已按要求关闭；**它未启动时应先按既定授权启动，而不是把其运行态节点检查当作启动前条件。** 若实际启动遇到权限、端口或导入失败，记录该真实错误，不改查8188。

正确顺序：

```text
离线测试/隔离/文件哈希/动态绑定
→ 检查正式队列与GPU空闲、8190端口所有权
→ 启动新的独立8190实验实例
→ 核对新PID、解释器、模块路径、该PID的Sol gate和启动日志
→ 对同一8190校验本条API/UI
→ 提交一次本条任务
```

## 2. 校验工具的实验侧修正

`validate_workflows.py` 的CLI现在仅接受本机8190，拒绝8188、代理和HTTP重定向，不会自动换端点。新增 `--api ... --ui ...`，可单独校验位于不同目录的现成B0或B1，不必复制/重建四份图。原 `--directory` 仍仅为四文件的只读检查，不能拿来隐式增加生成任务。

缺少上游注册时返回具体错误，不再抛 `KeyError`；保留DynamicCombo、固定Sol预设及UI/API一致性校验。8190不可达返回 `LAB_UNREACHABLE_OR_NOT_READY` 并提示启动/检查实验进程，不解释为GPU不支持。该工具只GET节点表，不启动、停止服务、不运行模型、不调用 `/prompt`。

**注册表通过仍不证明进程身份或Sol运行能力。** CLI输出 `runtime_identity_verified=false` 明确这一边界；PID、解释器、源码/输出目录和Sol gate另按下一节检查。审计工具原有 `generation_allowed=false` 也仍是审计自身的范围；本文件与 `RESUME_SOL_CU130.md` 给出后续有界任务授权，不修改这些字段来放行。

## 3. 本地Codex直接继续，无需再次询问是否可以启动8190

保留未提交改动，拉取本分支。用报告07确认的原路径cu130解释器运行全部实验测试、Git隔离检查及既有绑定预检，逐条检查退出码；不能修改/跳过失败断言。API来源及参数保持 `RESUME_SOL_CU130.md` 不变：

- B0：`local/workflows/Lab_B0_Dense_Clip1.api.json`，SHA-256 `d867be9289b4f91e4d61feb6b9ee4e3172a61370fcbad9a35dd7c5912083e864`。
- B1：`local/workflows/sol_forward_bridge/Lab_B1_SolAttn_Clip1.api.json`，SHA-256 `b1cfd6576406102d31bc2868c605a24a9adf72edab213135398d5ac0daf911b5`。

对应UI为同目录去掉`.api`的文件。仍保留七项原资产/顺序、原提示词、1920×1088不裁剪、4秒/96输出帧/H3对齐107帧、Seed1000、Kitchen/LowVRAM4/FFN2-4096、全部Self-Lift参数和B1原Sol保护配置；不重建故事。VAE已是INT8，不排重复VAE测试，不排Veda。

确认8188队列与GPU空闲。只读查询8188仅供正式服务状态检查，绝不将其节点表或队列用作实验目标。若8190已被未知进程占用，停止并记录，不杀进程或换去8188。8190空闲则用PowerShell 7在仓库根执行现有启动器，先启动B0实例：

```powershell
$Python = 'G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe'
$Lab = 'experiments/acceleration_lab'
$RunName = 'sol_cu130_b0_' + (Get-Date -Format 'yyyyMMdd_HHmmss')
$PreviousAudit = [Environment]::GetEnvironmentVariable('TERRY_ACCEL_LAB_SOL_AUDIT', 'Process')
$env:TERRY_ACCEL_LAB_SOL_AUDIT = '1'
try {
    & "$Lab/start_lab.ps1" -Port 8190 -RunName $RunName
} finally {
    [Environment]::SetEnvironmentVariable('TERRY_ACCEL_LAB_SOL_AUDIT', $PreviousAudit, 'Process')
}
```

`Start-Process`返回不等于后端已就绪。读取该RunName的PID文件及stdout/stderr，确认其监听8190、使用原路径cu130解释器、独立output/user/temp及实验装载目录，等待该进程完成初始化。只对8190做有界只读就绪检查；短暂502/连接拒绝先看本PID启动日志，不切换端点。进程退出或真实启动失败时保留日志停止，不反复重启。

读取该PID输出的Sol审计快照，确认CUDA build=13.0、CUDA registry已启用、扩展/架构门槛通过、Sol可用。启动其他扩展后的状态及实际必需节点导入均应核对；报告07旧快照不能代替本轮。旧导演trace/OP_PROFILE/backend verify开关保持关闭。

**上述新实例就绪后**，只校验当前B0：

```powershell
& $Python "$Lab/validate_workflows.py" --server 'http://127.0.0.1:8190' `
  --api "$Lab/local/workflows/Lab_B0_Dense_Clip1.api.json" `
  --ui "$Lab/local/workflows/Lab_B0_Dense_Clip1.json"
if ($LASTEXITCODE -ne 0) { throw 'Lab B0 validation failed; retain the real startup/validation evidence' }
```

通过后按原任务只向该8190提交一次B0。实际H3异常/OOM/输出失败仍按原停止规则，不调参重试。B0完整成功后正常停止**本轮拥有的实验PID**并保留产物；再用新的 `sol_cu130_b1_<时间标识>` 实例重复启动、PID/gate检查，以B1的上述API/UI路径运行同一校验命令，然后最多提交一次B1。不是在同一进程叠补丁，也不重启正式8188。

本轮上限仍是 **cu130 B0一次 + B1一次**，报告08提交数0不构成已消耗的生成预算；不得在B0失败时排B1。若本机已在报告08之后完成了未提交的同任务，先保留核对现有证据，不能重复排队。

## 4. 交付与结论边界

新增 `reports/09_SOL_CU130_INSTANCE_RETRY.md` 与 `evidence/sol_cu130_instance_retry.json`。记录两条实际实验PID/解释器、启动gate、校验端点、源文件哈希、提交次数/任务ID/history起止、阶段计时、Sol实际调用、输出规格/位置及质量未知项。报告08保持原文；无媒体应写“未生成/不适用”，不要表述为已有成片待验收。

沿用原实验计时helper，不增加同步/Profiler或改采样口径。同cu130的B0/B1才是主要对照；旧cu128 B0只能作跨环境历史参考。成功后保留完整AV checkpoint及四秒音画视频，画质/声音仍需单独确认，不自动植入导演。结束只停止实验实例，检查正式服务和生产冻结文件不变，不触碰cu128备份。

交付侧只执行了16项新标准库单测（HTTP/节点注册表为替身），并用读取到的旧验证器复现缺上游注册时的KeyError；新验证器返回错误列表。脚本语法检查通过。未运行完整实验测试集、真实Windows启动器、ComfyUI/GPU或视频生成；这次修的是实验启动/校验流程，不是Sol性能或环境的新修复。
