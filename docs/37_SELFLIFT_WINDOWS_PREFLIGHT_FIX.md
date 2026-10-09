# Windows 路径预检修复 · 继续原阶段计时任务

> 分支：`feat/selflift-internal`。停止报告提交：`fe91fc4`；测试修复后提交：`24a197a`。  
> 本轮仅修改一项测试的路径断言并补充跨平台子案例，没有修改运行代码、计时模块、模型链、采样参数或工作流；不是提速修复。

## 已读取的本机结果

[36 报告](36_SELFLIFT_STAGE_TRACE_REPORT.md) 和 `docs/evidence/selflift_stage_trace_summary.json` 均明确：18 项 trace 检查通过，47 项 Self-Lift 检查中 1 项路径断言失败，因此未提交生成、未设置实际后端 trace 开关、未验证 trace_ready，没有本轮阶段耗时。Codex 按预检失败即停止的要求执行正确；不要把这次停止算成再次 OOM 或又跑了一次 41 分钟。

失败发生在 `NativeBoundaryTests.test_model_folder_registered_without_reference_plugin`。生产代码使用 `os.path.join(models_dir, "latent_upscale_models")`，旧测试却硬编码 `/comfy/models/latent_upscale_models`。Windows 对旧测试输入 `/comfy/models` 拼接得到 `/comfy/models\\latent_upscale_models`，因此该字符串断言跨平台不成立。没有证据表明用户的真实模型路径或权重出错。

## 修复与已运行检查

修复保留“无需参考插件即可注册模型目录、列表排序去重、只注册一次”的断言，没有 skip、捕获后忽略或放宽目录名检查。

同一测试包含 6 个子案例：当前宿主路径、POSIX、报告中的 Windows 混合分隔符、Windows 盘符、中文/空格路径、UNC 网络路径。Windows 案例使用标准库 `ntpath`，只替换被测模块的 `os` 引用，不修改进程全局 `os.path` 或 `os.name`，不访问真实磁盘。

交付侧在 Linux / Python 3.13.5 / PyTorch 2.10.0+cpu 执行：

- 修复前用 `ntpath.join` 复现了报告相同的断言失败。
- 修复后 `test_selflift_internal.py` **47 项通过**，包含上述 6 个路径子案例；这不是 53 项独立测试。
- 核对远端更新后的测试 blob 为 `6031b050da59631191554b2b8458e100dec8fc5b`，与交付侧运行过的文件一致。五个 Self-Lift 运行模块与分支基线字节相同。

这不等于在 Windows 主机上执行过整套预检，也没有完成真实 ComfyUI/GPU 采集。本轮交付侧没有重新执行 trace 的 18 项检查；本机上一轮 18 项通过的结论来自 36 报告。下一步在本机同时复跑两组，不因测试修复跳过它们。

## 本地 Codex：从预检继续，不扩大任务

拉取本分支，保留本地未提交改动。在 TerryDirector 根目录使用 ComfyUI 自己的 Python 执行：

```powershell
& "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe" -m unittest discover -s tests -p "test*trace*.py" -v
if ($LASTEXITCODE -ne 0) { throw "trace preflight failed; do not submit generation" }
& "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe" -m unittest discover -s tests -p "test_selflift_internal.py" -v
if ($LASTEXITCODE -ne 0) { throw "SelfLift preflight failed; do not submit generation" }
```

两组均通过后，继续 [35 阶段计时任务](35_SELFLIFT_STAGE_TRACE.md)：队列空闲时沿用原启动方式，在实际后端进程环境启用 `TERRYDIRECTOR_TRACE=1` 并重启；先确认 trace_ready 及当前分支模块路径，再提交**最多一次**已成功的原三段请求副本。保留 FFN 2/4096、1920×1088、不裁剪、原资产/提示词、Seed 1000、全部 Self-Lift 参数与关闭高清空间分块的设置。仍不运行参数矩阵、不修改采样算法、不合并 main。检查或事件完整性失败就停止，不能反复提交。

为保留本次零生成停止记录，**仅覆盖 35 文档中的交付文件名**，其余采集和测量口径不变：

- 新报告：`docs/38_SELFLIFT_STAGE_TRACE_RETRY_REPORT.md`。
- 新的脱敏小型汇总：`docs/evidence/selflift_stage_trace_retry_summary.json`。
- 36 报告及原 `selflift_stage_trace_summary.json` 的停止记录保持不变。

报告必须区分新任务与旧任务；没有新 trace 时不得复制旧任务 2467.519 秒作为本次数据。成功采集后按 35 文档核对事件完整性、父子时间避免重复累计，并一并提交小型汇总；不要只给本机绝对日志路径。完成后按 35 文档关闭 trace，恢复正常后端。
