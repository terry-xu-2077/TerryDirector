# Self-Lift 单段 LowVRAMAttention 速度筛选报告

## 结果

- 分支实测提交：`756c2d9a164f99b788ec1033dbacb15bc06485d7`（包含 `756c2d9`），未合并 main；只提交 **1 次 clip-1 / 4 秒**生成，无追加三段或参数矩阵。Prompt：`13cb6203-424c-43ec-bc39-bb3bfb50eb3b`。
- **运行结果：成功。** History `success`、`completed=true`、无本次生成异常。原始 `execution_start=1791592213681`（`2026-10-10T00:30:13.681+00:00`），`execution_success=1791593018028`（`2026-10-10T00:43:38.028+00:00`），相减 **804.347 秒（00:13:24.347）**，不含提交排队或轮询结束。trace `integrity_ok=true`、`integrity_errors=[]`，根事件并集 801.371 秒；history 与其差 2.976 秒，不能强行分配给某阶段。
- **阶段速度：无可确认的改善。** clip-1 低清 371.201 秒（历史 373.161），高清 217.581 秒（历史 218.535），两者合计 588.783 秒（历史 591.697），仅快 2.914 秒 / 0.493%。单次历史对照的前置调度、预热和模型驻留不同，不能将这点差额归因于注意力节点，也不能推论三段总时长。
- **画质检查：部分完成。** 原始视频可解码，首/中/末三帧与报告 34 视频前四秒的同时间抽帧相比，人物身份、脸部细节、手和黄色胶带及驾驶舱一致，三帧未见明显形变或破损。完整运动、闪烁与声音未实际连续观看/听取，**待人工确认**；音轨存在且自动解码成功不能替代听看。

原始视频：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\video\TerryDirector_SelfLift_LowVRAM_Clip1_00001_.mp4`（3,748,235 bytes；SHA-256 `d9357647078e5a0830ee117e2f88bf998187c81f16111f1c6024c3a831d5935e`）。`ffprobe`：H.264、1920×1088、24 fps、96 帧、4.000 秒，AAC 音轨；`ffmpeg` 音轨解码退出码 0。对照视频：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\video\TerryDirector_SelfLift_MLP_Retest_00001_.mp4` 的前 4 秒。

## 输入与零生成预检

- 基底为报告 38 **真实成功请求** `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_request.json`，源 SHA-256 `efed65e30406b7c612541fb68aceff411eaa0f8b7084b2bcfc9c3ce563e7b1cf`；本次提交副本 `...\selflift_lowvram_attention_clip1_request.json`，SHA-256 `36edcdc2b61bfd6d96d0fe415ebd7630b663b7a017e82563a3b211e309691ebf`。原 `G:\AIGC\ComfyUI_Codex\user\default\workflows\Terry导演台.json` 当前 SHA-256 `cb8c153cec3141f839e365edc49bc223779df46a0ef055e5629668b14ff87fd7`；未编辑该文件。
- 精简有效请求差异：`document.clips` 从原 clip-1 `[0,96)`、clip-2 `[96,168)`、clip-3 `[168,288)` 减为**只保留原 clip-1 `[0,96)`**；其全部字段、原提示词、`globalPrompt`、`useGlobalPrompt` 与七项资产稳定 ID/编号/`source.path` 未变。新增节点 `220`：`MiniMaxLowVRAMAttention(model=[312,0], head_chunks=4)`；原 FFN 节点 `219` 的 `model` 由 `[312,0]` 接到 `[220,0]`，`chunks=2 / seq_threshold=4096` 未变。Advanced 执行 ID 更新为 `9600328`，另更新 client ID、保存目录/视频前缀与画布副本元数据。其余原有效节点逐项相等。
- 原 MODEL 链 `UNET 333 → LoRA 332 → Sage 312 (auto, allow_compile=false) → FFN 219 (2/4096) → Config 304`；本次仅在 Sage 与 FFN 间插入上述 LowVRAM 节点。二采 `930010`、模型、CLIP、视频/音频 VAE、LoRA、参考图尺寸和资产未变；`high_res_model` 仍未另接。
- 固定参数保持：1920×1088 输出、24 fps、96 帧，16:9 / 2.0 MP / multiple 32；seed 1000/fixed；Self-Lift CFG 1、transition_step 5、lowres_scale 0.5；Euler/simple、sampling_steps 6、denoise 1；精修 enabled、extra_steps 1、start 0.7、end 0、cosine；rho 0、w_min 0.5、w_max 1，原 latent upscaler、`highres_tiling=false`，预览关闭。报告 34 对同一日程的原始 Sigma 为 `[1.0000, 0.9837, 0.9601, 0.9231, 0.8575, 0.7064, 0.0000]`；本次配置未变，日志 L251/L279 与 trace 回调证实实际 **5+1**，但本次 trace 未逐值独立打印 Sigma，故不把历史数组冒称本次日志直接观测值。
- ComfyUI `.venv\python.exe` 零生成预检：`test*trace*.py` **18/18 通过**，`test_selflift_internal.py` **47/47 通过**。`/object_info/MiniMaxLowVRAMAttention` 已注册 `model` / `head_chunks`（默认 4，范围 1–56）；提交前队列为空。KJNodes HEAD `3f20054214fec9f9234fd3841ae6f1e4287948f6`；`nodes/minimax_nodes.py` SHA-256 `c371576b1bb31a2f518bdb4ceda43cb10b20338f0c9d68f99ed1be76ce06478f`，`nodes/model_optimization_nodes.py` SHA-256 `5317c12100a1701425a07b00bd9af6277d45101a37d82d0a3a9d75945011e51e`。
- 接入核对分层：①请求链接确有 Sage→LowVRAM→FFN；②本机实际节点函数配合轻量模型替身克隆后，Sage 的 `optimized_attention_override` 保留，`minimax_head_chunks=4`、`sol_take_forward`、每个 block/attention forward 和 FFN MLP forward 均存在，未执行 H3 前向；③实际服务日志显示 MiniMaxH3 `208 patches attached`（stderr L253、L272），生成完成。日志没有逐次 attention/head-group 调用计数，因此**实际执行四组 head 的行为未被独立观测**。源码路径为 LowVRAM `execute` 设置 `transformer_options.minimax_head_chunks` 并挂载 lowmem forward，后者按组调用 `optimized_attention`；Comfy 的 `wrap_attn` 将此调用交给保留的 Sage override。208 仅是总补丁数，不等于四组调用证据。

## trace 与阶段耗时

实际服务 PID 32720 以 `main.py --listen 0.0.0.0 --port 8188 --enable-manager --use-sage-attention` 启动，进程环境 `TERRYDIRECTOR_TRACE=1`。trace L1 `trace_ready` 为 `2026-10-10T00:29:46.116+00:00`，模块文件均指向当前 TerryDirector；L2 `native_trace_ready` 为 `00:30:15.086+00:00`，L4 `plan` 为 `00:30:15.090+00:00` 且仅有 clip-1、96 输出帧。汇总命令显式使用 `--expected-segments 1`，退出码 0；未改变工具默认值。

| clip-1 阶段 | 本次秒（trace 行） | 原始 UTC 起止 | 报告 38 clip-1 秒 | 历史−本次秒 / 比例 |
|---|---:|---|---:|---:|
| 条件/参考编码 | 83.633 (L6–69) | 00:30:15.823–00:31:39.458 | 84.239 | +0.606 / 0.720% |
| 低清采样（5 回调） | 371.201 (L71–84) | 00:31:39.594–00:37:50.801 | 373.161 | +1.960 / 0.525% |
| 分辨率切换 | 2.985 (L85–101) | 00:37:50.801–00:37:53.787 | 2.998 | +0.013 / 0.419% |
| 其中 latent 放大 | 2.904 (L86–100) | 00:37:50.804–00:37:53.709 | 2.918 | +0.014 / 0.484% |
| 高清采样（1 回调） | 217.581 (L102–111) | 00:37:53.787–00:41:31.372 | 218.535 | +0.954 / 0.437% |
| Self-Lift 整体 | 591.802 (L70–112) | 00:31:39.574–00:41:31.382 | 594.737 | +2.935 / 0.494% |
| latent checkpoint | 0.057 (L113–116) | 00:41:32.012–00:41:32.070 | 0.056 | −0.001 / −1.236% |
| 解码/无损缓存 | 121.763 (L117–136) | 00:41:32.080–00:43:33.845 | 122.248 | +0.485 / 0.397% |
| 单段最终输出 | 4.113 (L137–140) | 00:43:33.870–00:43:37.984 | 不作三段总量对照 | — |

UTC 日期均为 `2026-10-10`。低清+高清为本次 **588.783 秒**，历史 **591.697 秒**；低清第 2–5 回调累计本次 **284.620 秒**，历史 **285.970 秒**。首回调含准备；高清仅一次回调（217.576 秒），不能称为稳态 kernel 时间。`Self-Lift 整体`包含低清、切换、高清；`latent 放大`包含于切换；模型加载/卸载也嵌入其父阶段，以上不重复累加。最终输出是缓存读取/编码/封装等整体，不冒称纯 codec 时间。计时为未强制 CUDA 同步的主机墙钟，且无重复测量误差范围。与报告 38 相比，本轮只排一个条件节点，历史先处理 clip-3、clip-2、clip-1；前置调度和热状态不同。

## 本机证据与画质边界

- 真正提交的请求、响应、history、原始汇总分别在 `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_lowvram_attention_clip1_{request,submission,history,summary_raw}.json`；实际 trace 为 `G:\AIGC\ComfyUI_Codex\output\.terrydirector_trace\trace-32720-321acf815ae84866ac15f6f7b3e5f33e.jsonl`（SHA-256 `79af51f6f3ce5a97e36f38e246e0551b46250e5c0d6e292b8c3826568050872b`）。真实 ComfyUI stdout/stderr 为 `...\.terrydirector_diag\selflift_lowvram_clip1_comfy_stdout.log` / `selflift_lowvram_clip1_comfy_stderr.log`；后者 L251、L268、L279 记录低/高清尺寸 `(34,60) → (68,120)`、放大器和完成 5+1。启动时其他插件有导入警告/traceback（stderr L70–145），但本次生成 history 无异常、节点加载成功；这些警告不是本次任务失败 traceback。
- 首/中/末抽帧：本次 `...\.terrydirector_diag\new_0000.jpg`、`new_2000.jpg`、`new_3958.jpg`；报告 34 对照为同目录 `old_0000.jpg`、`old_2000.jpg`、`old_3958.jpg`。静帧能检查身份、局部细节和对应时刻的构图，不能判定全片闪烁、运动稳定性或声画同步；这些及主观画质、声音均**待人工确认**。
- 采集后队列空闲时关闭 trace，并以原参数启动无计时 ComfyUI（恢复 PID 19016）。旧 34/36/38 报告、旧证据、原请求和原工作流均保留；没有改模型、采样算法、产品代码或正式示例。脱敏小型汇总见 `docs/evidence/selflift_lowvram_attention_clip1_summary.json`，含事件、segment/父子关系、monotonic 边界、回调、尺寸、完整性及历史对照，不含本机绝对 source 路径或提示词。
