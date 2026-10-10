# Self-Lift 三段阶段计时复采报告

## 结论与口径

- 分支实测提交：`fbdf0ae5b9f1de981771c51d2524535ac82e223a`（含 `fbdf0ae`）；本轮仅运行一次生成任务，没有修改生成参数或采样算法，没有合并 main。
- 新任务 ID：`9855f66f-b997-4638-aacd-c5c499aee3e0`；history `execution_start` = `1791582842146`（2026-10-09T21:54:02.146+00:00），`execution_success` = `1791585371657`（2026-10-09T22:36:11.657+00:00），**总耗时 2529.511 秒（00:42:09.511）**。这是执行持续时间，不含排队/轮询结束。状态 `success`、`completed=true`，无生成 traceback。
- 汇总脚本：`integrity_ok=true`、`integrity_errors=[]`；`measured_root_union_s=2524.666`。与 history 总时长差 4.845 秒，属于根计时覆盖之外的时间差，不能按阶段分配。
- 已生成视频：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\video\TerryDirector_SelfLift_StageTrace_Retry_00001_.mp4`，13413437 bytes；1920×1088、24.0 fps、288 帧、12.0 秒。画面与声音尚未实际听看，待人工确认。

## 零生成预检与 trace 启动

- Windows PowerShell 7.4.17，使用 ComfyUI 的 `.venv\python.exe`：`test*trace*.py` **18/18 通过**（0.056 秒）；`test_selflift_internal.py` **47/47 通过**（0.429 秒）。检查后队列为空。
- 实际后端 PID 31896 以原参数 `main.py --listen 0.0.0.0 --port 8188 --enable-manager --use-sage-attention` 重启，进程环境设 `TERRYDIRECTOR_TRACE=1`；真实 stdout/stderr 分别见 `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_comfy_stdout.log` 和 `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_comfy_stderr.log`。
- `trace_ready` 原始 JSONL L1：`2026-10-09T21:53:19.021+00:00`；模块路径均指向 `G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\TerryDirector`。`native_trace_ready` L2：`2026-10-09T21:54:03.560+00:00`；`plan` L4：`2026-10-09T21:54:03.563+00:00`，列出 clip-1/2/3。
- 实际 trace：`G:\AIGC\ComfyUI_Codex\output\.terrydirector_trace\trace-31896-0e7cae740333481a8139734fd9d98dbf.jsonl`（SHA-256 `4a73f23e34e34ebb49dec598391655f236a3d6b7d68f058ec35516731275403a`）；原始成功请求 SHA-256 `6bc7589f59b9660fd76321c56164e97fa1512c0566fb2bfa6c144853d51b14d7`，新请求 SHA-256 `efed65e30406b7c612541fb68aceff411eaa0f8b7084b2bcfc9c3ce563e7b1cf`。新副本只变更导演 ID、client ID 和输出前缀；前三段提示词/资产、FFN `(2,4096)`、2.0 MP 配置（输出 1920×1088）、seed 1000、采样参数、`rho=0`、`highres_tiling=false` 均保留。

## 分段耗时

下表单位为秒；括号为原始 trace JSONL 行号。`Self-Lift 整体`包含低清、切换和高清；`latent 放大`包含于切换，不能再次累加。条件构造的实际调度顺序为 clip-3、clip-2、clip-1，按片段 ID 归属。

| 阶段 | clip-1 | clip-2 | clip-3 |
|---|---:|---:|---:|
| 条件/参考编码 | 84.239 (L134–197) | 83.390 (L70–133) | 83.234 (L6–69) |
| 衔接参考 Guide | — | 1.281 (L265–274) | 1.043 (L342–351) |
| 低清采样 | 373.161 (L199–212) | 316.451 (L276–289) | 401.209 (L353–366) |
| 分辨率切换 | 2.998 (L213–229) | 1.758 (L290–306) | 4.863 (L367–383) |
| latent 放大 | 2.918 (L214–228) | 1.702 (L291–305) | 4.778 (L368–382) |
| 高清采样 | 218.535 (L230–239) | 144.838 (L307–316) | 416.055 (L384–393) |
| Self-Lift 整体 | 594.737 (L198–240) | 473.271 (L275–317) | 839.895 (L352–394) |
| latent checkpoint | 0.056 (L241–244) | 0.014 (L318–321) | 0.026 (L395–398) |
| 解码/无损缓存 | 122.248 (L245–264) | 81.381 (L322–341) | 143.926 (L399–418) |

- 全片最终输出（含缓存读取、编码、封装与清理）：**15.920 秒**（L419–L426）。这是 `final_output` 整体时间，不能冒充纯 codec 时间。

### 原始阶段边界（UTC +00:00）

| 片段 | 事件 | 起点行 / UTC | 终点行 / UTC | host-wall 秒 |
|---|---|---|---|---:|
| clip-1 | 条件/参考编码 | L134 `2026-10-09T21:56:51.334+00:00` | L197 `2026-10-09T21:58:15.579+00:00` | 84.239 |
| clip-1 | 低清采样 | L199 `2026-10-09T21:58:15.734+00:00` | L212 `2026-10-09T22:04:28.918+00:00` | 373.161 |
| clip-1 | 分辨率切换 | L213 `2026-10-09T22:04:28.919+00:00` | L229 `2026-10-09T22:04:31.918+00:00` | 2.998 |
| clip-1 | latent 放大 | L214 `2026-10-09T22:04:28.922+00:00` | L228 `2026-10-09T22:04:31.840+00:00` | 2.918 |
| clip-1 | 高清采样 | L230 `2026-10-09T22:04:31.919+00:00` | L239 `2026-10-09T22:08:10.467+00:00` | 218.535 |
| clip-1 | Self-Lift 整体 | L198 `2026-10-09T21:58:15.708+00:00` | L240 `2026-10-09T22:08:10.480+00:00` | 594.737 |
| clip-1 | latent checkpoint | L241 `2026-10-09T22:08:11.110+00:00` | L244 `2026-10-09T22:08:11.167+00:00` | 0.056 |
| clip-1 | 解码/无损缓存 | L245 `2026-10-09T22:08:11.178+00:00` | L264 `2026-10-09T22:10:13.433+00:00` | 122.248 |
| clip-2 | 条件/参考编码 | L70 `2026-10-09T21:55:27.796+00:00` | L133 `2026-10-09T21:56:51.192+00:00` | 83.390 |
| clip-2 | 衔接参考 Guide | L265 `2026-10-09T22:10:13.460+00:00` | L274 `2026-10-09T22:10:14.742+00:00` | 1.281 |
| clip-2 | 低清采样 | L276 `2026-10-09T22:10:14.804+00:00` | L289 `2026-10-09T22:15:31.270+00:00` | 316.451 |
| clip-2 | 分辨率切换 | L290 `2026-10-09T22:15:31.271+00:00` | L306 `2026-10-09T22:15:33.029+00:00` | 1.758 |
| clip-2 | latent 放大 | L291 `2026-10-09T22:15:31.273+00:00` | L305 `2026-10-09T22:15:32.976+00:00` | 1.702 |
| clip-2 | 高清采样 | L307 `2026-10-09T22:15:33.030+00:00` | L316 `2026-10-09T22:17:57.876+00:00` | 144.838 |
| clip-2 | Self-Lift 整体 | L275 `2026-10-09T22:10:14.790+00:00` | L317 `2026-10-09T22:18:08.083+00:00` | 473.271 |
| clip-2 | latent checkpoint | L318 `2026-10-09T22:18:08.558+00:00` | L321 `2026-10-09T22:18:08.572+00:00` | 0.014 |
| clip-2 | 解码/无损缓存 | L322 `2026-10-09T22:18:08.583+00:00` | L341 `2026-10-09T22:19:29.968+00:00` | 81.381 |
| clip-3 | 条件/参考编码 | L6 `2026-10-09T21:54:04.404+00:00` | L69 `2026-10-09T21:55:27.644+00:00` | 83.234 |
| clip-3 | 衔接参考 Guide | L342 `2026-10-09T22:19:29.999+00:00` | L351 `2026-10-09T22:19:31.043+00:00` | 1.043 |
| clip-3 | 低清采样 | L353 `2026-10-09T22:19:31.112+00:00` | L366 `2026-10-09T22:26:12.340+00:00` | 401.209 |
| clip-3 | 分辨率切换 | L367 `2026-10-09T22:26:12.340+00:00` | L383 `2026-10-09T22:26:17.204+00:00` | 4.863 |
| clip-3 | latent 放大 | L368 `2026-10-09T22:26:12.345+00:00` | L382 `2026-10-09T22:26:17.125+00:00` | 4.778 |
| clip-3 | 高清采样 | L384 `2026-10-09T22:26:17.205+00:00` | L393 `2026-10-09T22:33:13.276+00:00` | 416.055 |
| clip-3 | Self-Lift 整体 | L352 `2026-10-09T22:19:31.091+00:00` | L394 `2026-10-09T22:33:31.019+00:00` | 839.895 |
| clip-3 | latent checkpoint | L395 `2026-10-09T22:33:31.699+00:00` | L398 `2026-10-09T22:33:31.725+00:00` | 0.026 |
| clip-3 | 解码/无损缓存 | L399 `2026-10-09T22:33:31.737+00:00` | L418 `2026-10-09T22:35:55.669+00:00` | 143.926 |
| 全片 | 最终输出 | L419 `2026-10-09T22:35:55.695+00:00` | L426 `2026-10-09T22:36:11.617+00:00` | 15.920 |

## 主要耗时与子事件

- 三段 Self-Lift 整体合计 **1907.903 秒**（占 history 总时长 75.4%）；其中低清 sampler 合计 **1090.821 秒**，高清 sampler 合计 **779.429 秒**。这两个子项已包含在 Self-Lift 整体内。三段条件构造合计 **250.863 秒**，解码/缓存合计 **347.554 秒**。
- 高频/长间隔证据：clip-3 高清采样 L384–L393 为 416.055 秒，其唯一 `step_callback` 为约 416.046 秒；clip-1 高清 218.535 秒，clip-2 高清 144.838 秒。高清各为 1 次回调，其首个回调间隔包含初始化与准备，不能视作纯去噪 step 或 GPU kernel 耗时。
- clip-2 与 clip-3 的高清 sampler 返回至 Self-Lift 返回间分别约 10.207 秒（L316→L317）与 17.743 秒（L393→L394）；已计入相应 Self-Lift 整体的 `outside_children_s`（10.224 / 17.768 秒），尚无更细事件证明具体操作或根因。
- 三段 `decode_cache` 中视频 VAE decode 子调用分别为 118.719、78.935、139.728 秒；同段还包含音频 VAE decode、tensor 保存等子调用，均已包含于 `decode_cache`，不另加到整任务。

### 模型管理事件（均为父阶段内部子项）

| 片段 | model_load_request | 内层 model_load_call | model_unload_call | 放大器 offload |
|---|---:|---:|---:|---:|
| clip-1 | 13 次 / 1.628 秒 | 13 次 / 1.517 秒 | 1 次 / 0.004 秒 | 0.006 秒 (L223–L227) |
| clip-2 | 14 次 / 0.912 秒 | 14 次 / 0.823 秒 | 1 次 / 0.003 秒 | 0.004 秒 (L300–L304) |
| clip-3 | 14 次 / 1.022 秒 | 14 次 / 0.896 秒 | 1 次 / 0.003 秒 | 0.004 秒 (L377–L381) |

- `model_load_call` 嵌在 `model_load_request` 内，二者又嵌在条件编码、采样、放大或解码阶段内；上述耗时不重复相加。按调用记录，涉及 `MiniMaxH3VideoVAE`、`MiniMaxH3TEModel_`、`MiniMaxH3`、`H3LatentUpscaler`、`MiniMaxH3AudioVAE`。三次 `H3LatentUpscaler` 定向卸载调用的返回记录为 `complete_unload=true`；仅说明这些调用返回值，不泛化为整个进程的完整模型卸载。逐调用模型类、ID、原始行号与时间见脱敏 JSON。

## 测量范围与证据文件

- 本次 trace 为主机侧墙钟时间，使用同进程 `perf_counter_ns`；没有强制 CUDA 同步。异步 GPU 工作可能跨主机调用边界，回调间隔不是 GPU kernel profiler 数据。阶段边界显存值不是区间峰值。
- `outside_children_s` 表示某父区间未被直接子计时覆盖的部分，仍可包含未拆开的工作、异步等待和记录开销。完整性通过不代表所有任务时间都有细分标签。没有证据将慢阶段归因于显卡、FFN 分块或 Self-Lift 数学算法。
- 采集完成后已关闭实际后端的 `TERRYDIRECTOR_TRACE` 并以原参数重启为 PID 18696；节点服务可用、队列为空，新启动 stdout/stderr 未出现 trace enabled 信息。
- 本机原始资料：请求 `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_request.json`；history `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_history.json`；stdout `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_comfy_stdout.log`；stderr `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_comfy_stderr.log`；原始 JSONL `G:\AIGC\ComfyUI_Codex\output\.terrydirector_trace\trace-31896-0e7cae740333481a8139734fd9d98dbf.jsonl`；完整本机汇总 `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_summary_raw.json`。
- 随本报告提交的脱敏小型汇总：`docs/evidence/selflift_stage_trace_retry_summary.json`，保留 prompt/segment ID、事件行号、原始 UTC 和 monotonic 时间、模型类及回调；不含本机绝对路径。报告 36 与旧停止状态汇总未覆盖。
