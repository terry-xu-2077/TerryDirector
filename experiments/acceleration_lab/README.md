# 独立加速实验台

本目录不会被 TerryDirector 根扩展自动导入。`start_lab.ps1` 只在 `local/runtime/custom_nodes/` 建立指向冻结生产源码、KJNodes 和本实验扩展的目录联接；启动独立 8190 端口，使用独立的 output/temp/user，模型和 input 仅作为原路径读取。`local/` 被 Git 忽略，不包含在提交内。

PowerShell 7：

```powershell
$Lab = 'G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\TerryDirector\experiments\acceleration_lab'
& "$Lab\start_lab.ps1" -Port 8190
```

构建器从报告46的私有成功请求生成四份 UI/API 配对文件到 `local/workflows/`，并验证源请求哈希、冻结编译结果、七项资产路径与文件哈希。使用 ComfyUI `.venv\python.exe` 运行 `build_workflows.py --request <原请求> --input-dir <原input> --vae-dir <模型VAE目录>`。运行 `validate_workflows.py --directory <local/workflows>` 向实验实例校验实际注册 schema 与连线。正式 Git 边界用 `check_isolation.py` 逐图检查。

本轮唯一 B0 提交已在 Sigma 节点处失败；修正只读导入后没有再提交任务。`reports/` 与 `evidence/` 记录此停止状态。要继续 GPU 实验须先安排新一轮授权及次数预算。

停止实验实例时，先确认 8190 `/queue` 的运行和等待队列均为空，读取 `local/lab_pid.txt`，核对进程路径是此 ComfyUI `.venv\python.exe`，然后只停止该 PID。移除安装时，核对 `local/runtime/custom_nodes/` 下三个目录联接的目标分别是本仓库、KJNodes 和本实验目录，再用 PowerShell `Remove-Item -LiteralPath` 逐个移除联接；不得对生产 custom_nodes 或模型目录递归删除。保留 `local/` 中的私有工作流与原始日志可供复核。
