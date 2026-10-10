# Self-Lift Kitchen 注意力单段对照报告（46）

## 判定

**Kitchen 为有效候选，单次原四秒 clip-1 成功。** `generation_success=true`、`stage_integrity_ok=true`、`backend_verification_ok=true`；目标 MODEL 路径的已覆盖回退入口计数为0。提交次数 **1**，Prompt ID `287705bf-9d2d-400b-874e-84e21de4b1d7`。本轮没有重试、三段扩展、Kitchen 默认值变更或 main 合并。

相对报告40的同一单段 Sage 基线，低清与高清采样合计从 **588.783** 降至 **497.337 秒**，减少 **91.445 秒（15.53%）**；整任务 history 从 **804.347** 降至 **704.077 秒**，减少 **100.270 秒（12.47%）**。这是一次历史对照，轻量 Python 包装、设备负载与热状态仍可能影响结果；不宣布普遍加速。报告44的重型 Profiler 时间未用于速度基线。

四个对应时间点的抽帧里，脸、手和车舱细节均可辨认，未见明显结构破坏或曝光崩溃；两版本有正常画面差异。**完整运动、闪烁、声音内容及声画同步待人工确认**。音轨已通过解码检查，但没有实际听看。

## 输入与零生成预检

- 已拉取 `feat/selflift-internal` 至 `fa2a7409eb73c14dea7a72b36cb8ee4c615bcf85`，确认包含用户指定提交。开始时工作树无未提交改动。保留报告40/42/44及其证据。
- 报告40真实请求 SHA-256 `36edcdc2b61bfd6d96d0fe415ebd7630b663b7a017e82563a3b211e309691ebf`，本轮副本 SHA-256 `fa15bd5cc127969374d565f2caad664dd9bdc0c41e800c5f59521544328e5a64`。规范化 diff 仅替换节点312：`PathchSageAttentionKJ(auto,false)` → `ModelAttentionBackend(model=[332,0], attention="comfy kitchen attention")`，并隔离 Advanced ID `9600328→9700451`、client ID、输出前缀及对应 UI metadata。节点220→219→304连接、模型/LoRA、CLIP/VAE、7项资产、提示词、全部采样设置保持原值；原正式工作流未写回。
- 仍按 `main.py --listen 0.0.0.0 --port 8188 --enable-manager --use-sage-attention` 启动。ModelAttentionBackend 菜单确有 `comfy kitchen attention`。本轮预检 `test*trace*.py` **29/29**、`test_selflift_internal.py` **47/47**；新增合成测试覆盖默认关闭、单次原函数调用、参数/输出/RNG、任务隔离、别名恢复、回退和原始 OOM 异常传播。
- 实际诊断进程 PID 28780 在阶段 trace L1–2 发出 `backend_verify_ready` 与 `trace_ready`，注册函数是 `comfy.ldm.modules.attention.attention_comfy_kitchen_int8`，扩展路径为当前 Kitchen CUDA 模块；无 `op_profile_ready` 或该 PID 的算子窗口文件。没有启用重型 `OP_PROFILE`。
- 本机版本：ComfyUI 提交 `b26625f23a888367b92153b28d93e159e83e677b`、KJNodes 提交 `3f20054214fec9f9234fd3841ae6f1e4287948f6`、torch `2.11.0+cu128`、SageAttention `2.2.0+cu130torch2.10.0andhigher.post5`、Kitchen `0.2.37`。ComfyUI/KJ/Sage/Kitchen 关键文件 SHA-256 与报告42所记一致；完整哈希见脱敏 JSON。无依赖升级。

## 实际后端调用验证

`ModelAttentionBackend.execute` 在 `comfy_extras/nodes_model_advanced.py:402–413` 将 Kitchen 注册函数写入 MODEL override；`model_patcher.py:689–695` 的闭包捕获该函数。观测器在采样入口读取最终 MODEL：两阶段闭包内函数均为 `attention_comfy_kitchen_int8`，`minimax_head_chunks=4`，LowVRAM attention patch 和 FFN patch 各50个。KJ `minimax_attn_lowmem_forward` 在 `nodes/minimax_nodes.py:89–134` 使用真实导入别名；该别名源函数名为 `attention_sage`（保留的全局启动选项），但 Comfy `attention.py:206–244` 先命中 MODEL override，随后**实际**进入 Kitchen API 和 `sage_sdpa` 扩展。不能用别名或启动日志单独判定最终后端。

| 阶段 | 首回调 trace 行 | 回调 | KJ别名调用 | Kitchen常规API | CUDA扩展 `sage_sdpa` | 已覆盖回退 |
|---|---:|---:|---:|---:|---:|---:|
| low_sampling | L80 | 5 | 1000 | 1000 | 1000 | 0 |
| high_sampling | L113 | 1 | 200 | 200 | 200 | 0 |

低清首回调 L80 与高清首回调 L113 均在第一实际前向后确认 API 200、扩展边界200、回退0；阶段末 L85/L114 记录完整计数。两阶段均走常规 API；预量化 API/扩展入口本轮调用0，不能据此推断其它请求。源码 `comfy_kitchen/sage_attention.py:597–635` 从常规 API 到自定义 op，`:208–317` 最终调用 `_C.sage_sdpa`；本轮仅计数，没有 profiler，**GPU kernel 数、内核名和核耗时均未知**。

| 首次 Kitchen API 输入 | 低清 | 高清 |
|---|---|---|
| q/k/v shape（均相同） | `[1,14,45804,128]` | `[1,14,94764,128]` |
| dtype / device / stride | BF16 / cuda:0 / `[7168,128,21504,1]` | BF16 / cuda:0 / `[7168,128,21504,1]` |
| mask | 无 | 无 |

完整实际 CPU Sigma 输入：低清 `[1.0, 0.9836838841438293, 0.9600575566291809, 0.9230769276618958, 0.8575096726417542, 0.7063800096511841]`；高清 `[0.7063800096511841, 0.0]`。5+1 个回调与计划的基础6步、`transition_step=5`和本次精修阈值结果一致；未人为补出第2个高清步。

**观测范围与限制：**计数只在 prompt `287705bf-…`、导演 `9700451`、clip-1 的采样上下文、真实 KJ 导入别名下生效。覆盖 Kitchen 常规/预量化 API、CUDA 扩展 `sage_sdpa` 等入口，以及 Comfy PyTorch/Sage 与 torch SDPA 回退入口；不覆盖扩展内部未暴露分支或所有可能的新回退函数。`fallback_observed=false` 仅适用于上述范围。条件编码/VAE可能仍用全局 Sage，不属于目标 MODEL 回退。没有逐调用写盘、tensor拷贝、额外H3求值、CUDA Event或同步。

## 速度：仅与报告40无重型 Profiler 基线比较

以下阶段是原 trace 的 host inclusive 时间；模型装卸已包含在其父阶段内，不重复累加。正百分比表示本轮耗时减少。低清+高清只加两个兄弟阶段，Self-Lift 和子阶段不相加。

| 指标 | 报告40 Sage s | 本轮 Kitchen s | 减少 s | 减少 % | 本轮 trace 行 |
|---|---:|---:|---:|---:|---|
| 条件/参考编码 | 83.633 | 79.102 | 4.531 | 5.42% | L7–70 |
| 低清采样 | 371.201 | 319.881 | 51.320 | 13.83% | L72–87 |
| 高清采样 | 217.581 | 177.456 | 40.125 | 18.44% | L105–116 |
| 低清+高清 | 588.783 | 497.337 | 91.445 | 15.53% | 两阶段合计 |
| Self-Lift整体 | 591.802 | 500.268 | 91.534 | 15.47% | L71–117 |
| latent放大 | 2.904 | 2.813 | 0.091 | 3.12% | L89–103 |
| 解码/无损缓存 | 121.763 | 117.552 | 4.211 | 3.46% | L122–141 |
| 最终输出 | 4.113 | 3.983 | 0.130 | 3.15% | L142–145 |
| 整任务history | 804.347 | 704.077 | 100.270 | 12.47% | history原始时间 |

本轮 history 原始 `execution_start=1791599662595`、`execution_success=1791600366672`，相减 **704.077 秒**；没有混入排队或轮询结束时间。单次历史对照还受到轻量 Python wrapper、显卡负载、内存状态、温度及依赖环境影响，不能据此承诺三段或其它素材同等收益。

## 输出与画质检查

- 实际原始视频：`G:\AIGC\ComfyUI_Codex\output\video\TerryDirector_SelfLift_Kitchen_Clip1_00001_.mp4`，3,752,760 bytes。trace L5 记录 H3 107 对齐帧的计划，ffprobe 验证输出 H.264 1920×1088、24fps、96帧、4.000秒及 AAC 音轨。FFmpeg 视频抽帧和音轨完整解码无错误。
- 取基线与本轮约0、1、2、3秒四个对应帧观察：近景人物的眼、皮肤污痕、手部与方向盘仍可辨；色调和曝光相近，未见黑屏、白屏或明显结构断裂。静态帧不足以判断完整运动、连续闪烁、音频内容或声画同步，这些项目均**待人工确认**。不要求逐像素一致，也未把静帧结论写成完整画质通过。
- 本机对照图：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_kitchen_clip1_baseline_contact.png` 与 `selflift_kitchen_clip1_candidate_contact.png`；仅用于静态视觉核查，不提交仓库。

## 原始证据与收尾

- 请求/白名单差异/提交响应/history/阶段汇总：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_kitchen_attention_clip1_{request,request_diff,submit_response,history,stage_summary}.json`（实际五个文件名分别见脱敏 JSON）。
- 真实阶段 trace：`G:\AIGC\ComfyUI_Codex\output\.terrydirector_trace\trace-28780-c37e269ecd37419bb24c4c53db96ce1d.jsonl`。轻量观测原始数据：`G:\AIGC\ComfyUI_Codex\output\.terrydirector_backend_verify\kitchen-28780.jsonl`。实际服务 stdout/stderr：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_kitchen_clip1_comfy_stdout.log`、`selflift_kitchen_clip1_comfy_stderr.log`。stderr L254/L270显示 H3 的208个补丁，L282显示任务完成；启动时其它自定义节点的 traceback 与本任务成功状态分开保留。
- 轻量源码 `tools/selflift_kitchen_backend_verify.py` 由 `director_trace.py` 默认关闭的入口安装；`TERRYDIRECTOR_TRACE=1` 且 `TERRYDIRECTOR_BACKEND_VERIFY=1` 才启用。窗口结束即撤销真实别名包装，异常时保留原异常。结束后队列空闲，已用原参数恢复服务 PID 37276，诊断与阶段 trace 开关均关闭；`/queue` 为空，TerryDirector 正常导入。
