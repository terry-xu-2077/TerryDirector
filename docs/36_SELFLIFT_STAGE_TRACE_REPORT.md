# Self-Lift 阶段计时采集报告（预检停止）

## 结果

本轮在零生成预检停止，**没有提交新的 ComfyUI 生成任务，也没有产生阶段 trace**。因此没有三段阶段耗时、模型装卸计时或新视频。不能把报告 34 的旧任务日志当作本轮计时结果。

分支 `feat/selflift-internal` 已快进至 `3873517397b043d4d31fc004e711c2e82462a56d`，确认包含 `3873517`；未合并 main。执行环境为 Windows PowerShell 7.4.17、`G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe`。预检前 `/queue` 返回 `queue_running=[]`、`queue_pending=[]`。

## 零生成预检

| 检查 | 结果 | 证据 |
|---|---|---|
| `python -m unittest discover -s tests -p "test*trace*.py" -v` | 18 项通过 | `Ran 18 tests in 0.061s`；`OK` |
| `python -m unittest discover -s tests -p "test_selflift_internal.py" -v` | 47 项中 1 项失败 | `Ran 47 tests in 0.933s`；`FAILED (failures=1)` |

失败测试为 `NativeBoundaryTests.test_model_folder_registered_without_reference_plugin`，位于 `tests/test_selflift_internal.py:420–429`。测试将 `folders.models_dir` 设为 `/comfy/models`，第 429 行断言注册路径必须为 `/comfy/models/latent_upscale_models`；本机 Windows 实际调用为 `/comfy/models\latent_upscale_models`。完整失败核心：

```text
AssertionError: expected call not found.
Expected: mock('latent_upscale_models', '/comfy/models/latent_upscale_models')
  Actual: mock('latent_upscale_models', '/comfy/models\\latent_upscale_models')
```

这是该测试的路径分隔符断言在 Windows 环境下未通过的证据；本轮没有修改测试、产品代码或工作流，也未以重跑生成来绕过预检。按 `docs/35_SELFLIFT_STAGE_TRACE.md` 的“任何检查失败，停止，不提交生成”要求，**未重启后端，未设置实际 ComfyUI 进程的 `TERRYDIRECTOR_TRACE=1`，未验证 `trace_ready` / 模块路径**。这些后续检查记为未执行，不能写成通过。

## 待采集请求核对

预定基底为报告 34 的成功请求副本 `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_mlp_retest_request.json`，SHA-256 为 `6bc7589f59b9660fd76321c56164e97fa1512c0566fb2bfa6c144853d51b14d7`。静态读取确认其中仅有 `clip-1 [0,96)`、`clip-2 [96,168)`、`clip-3 [168,288)`，24 fps、七项资产、seed 1000，MODEL 链包含 `MiniMaxChunkFeedForward(chunks=2, seq_threshold=4096)`；配置为 2.0 MP、`sampling_steps=6`、`rho=0`、`highres_tiling=false`、预览关闭。此请求仅被读取，没有创建新的采集副本或提交到 `/prompt`。

## 采集状态与证据范围

- 本轮新 prompt ID：无；history 起止与总耗时：无；三段阶段耗时：无；trace JSONL：无；视频：无；失败 traceback：无（失败发生在预检断言，而非生成）。
- 本地没有本轮可供 `tools/summarize_selflift_trace.py` 处理的 trace；未运行该汇总脚本。随报告提交的 `docs/evidence/selflift_stage_trace_summary.json` 是小型脱敏**停止状态汇总**，明确 `integrity_ok=false`、`generation_submitted=false`，不冒充完整阶段汇总。
- 报告 34 的成功任务 `65ca768f-651a-4959-a8bc-ee4a6af11f09` 与本轮预检独立；其 `2467.519` 秒总耗时不作为本轮测量值。

下一次采集须先解决这项 Windows 预检失败并重新通过文档要求的两组检查，再验证实际后端的 `trace_ready`。本轮不自动继续生成。
