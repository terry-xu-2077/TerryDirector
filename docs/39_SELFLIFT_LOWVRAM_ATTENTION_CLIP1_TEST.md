# Self-Lift 速度筛选 · 仅第一段 + 低显存注意力

> 分支：`feat/selflift-internal`；任务编写基线：`ff32515fbdfdc0547d1a03b5b4ae99f98a883d49`。  
> 状态：待本地 Codex 执行，尚无新性能结果。用户已同意继续验证这一候选。  
> 本轮仅改验收请求副本，最多提交 **1 次 / 1 段 / 4 秒**；不改产品运行代码、不合并 main，不自动扩展三段或参数矩阵。

## 1. 要回答的问题与历史对照

只验证：保留已成功的 MODEL 链、Self-Lift 参数和生成内容，在 FFN 前加入原始参考工作流的 `MiniMaxLowVRAMAttention(head_chunks=4)` 后，第一段低清/高清采样是否出现值得继续验证的速度改善，且画质是否可接受。

它是候选，不是已确认的瓶颈或提速修复。`head_chunks=4` 不表示四倍加速；本轮也不承诺与原画面逐像素一致。不能因节点名带 LowVRAM 就推定一定更快。

历史证据：[38 报告](38_SELFLIFT_STAGE_TRACE_RETRY_REPORT.md) 及 `docs/evidence/selflift_stage_trace_retry_summary.json`，Prompt `9855f66f-b997-4638-aacd-c5c499aee3e0`。**只取 clip-1 对照，不用三段总耗时 2529.511 秒作单段基线。**

| clip-1 阶段 | 历史 host-wall 秒 | 原 trace 行号 |
|---|---:|---|
| 条件/参考编码 | 84.239 | L134–197 |
| 低清采样（5 次回调） | 373.161 | L199–212 |
| 分辨率切换（含 latent 放大） | 2.998 | L213–229 |
| 高清采样（1 次回调） | 218.535 | L230–239 |
| Self-Lift 整体 | 594.737 | L198–240 |
| 解码/无损缓存 | 122.248 | L245–264 |

低清 + 高清的历史合计为 **591.696 秒**；切换/整体之间存在包含关系，不能再次叠加。

**比较限制：**38 的三个条件节点先按 clip-3、clip-2、clip-1 调度，再开始第一段采样；本轮只保留 clip-1，会改变前置工作、预热和模型驻留状态。因此这是“一个模型链变更的单段筛选 + 历史阶段对照”，不是同轮严格 A/B。即使明显变快，也只能写观察结果，不能把全部差额归因于注意力节点，或按比例宣称整条三段已提速。没有改善也不直接推广成所有片段无效。

## 2. 从真实成功请求建立副本

优先读取 38 已执行的本机文件：

```text
G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_stage_trace_retry_request.json
```

预期 SHA-256：`efed65e30406b7c612541fb68aceff411eaa0f8b7084b2bcfc9c3ce563e7b1cf`。它已包含 FFN，不使用首次 OOM 的 `selflift_minimal_request.json`。路径以 38 的证据为准；找不到或哈希不匹配，先定位正确原件，不能悄悄拿另一份工作流替代。

深拷贝请求；原 JSON、原 `Terry导演台.json`、旧视频与证据保持不变。沿实际 prompt 的 `class_type` 与输入链接找出 Advanced、导演配置、二采配置、FFN 和 Sage 节点，不凭画布位置或硬编码 ID 改链接。

副本只允许以下变更：

1. 在 Advanced 的 `config_json.document.clips` 中只保留原 **clip-1 [0,96)**；保留它的完整字段、提示词和原时长，不添加前一片段 Guide。其他片段从副本移除，不能只挂起。保留完整 `globalPrompt`、`useGlobalPrompt`、七项资产的稳定 ID/编号/`source.path`；不因本轮只生成一段而删改资产池。
2. 在原 Sage 输出到既有 FFN 输入之间插入 **一个** `MiniMaxLowVRAMAttention`，`head_chunks=4`。FFN 仍为 `chunks=2 / seq_threshold=4096`，位置不变。保留原 Sage 模式/后端、LoRA 强度、量化方式和其他 MODEL 补丁。
3. 使用新导演 ID/缓存标识、client ID 及唯一输出前缀，如 `video/TerryDirector_SelfLift_LowVRAM_Clip1`；同步修改真实链接与相关提交目标。只保留该输出的可达执行依赖，不提交其他导演分支。

模型链应为：

```text
原 UNET → 原 LoRA → 原 PathchSageAttentionKJ
    → MiniMaxLowVRAMAttention（head_chunks=4）
    → 原 MiniMaxChunkFeedForward（2 / 4096）
    → TerryDirector 配置.model

TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector Advanced
```

不要重复叠加已有 LowVRAM 节点。若基底已经含该节点或模型链与 38 不符，记为 BLOCKED 并保留差异，不重建原模型链。二采可选 `high_res_model` 保持未连接，低清与高清复用同一条 MODEL。

保存源文件前后哈希、提交副本哈希及精简 diff；验证除了上述片段数量、候选节点/连线和运行标识变化外，其余有效执行参数保持一致。上传到仓库的 diff 只需字段/哈希，不必公开完整提示词和本机绝对资产路径。

## 3. 固定参数与接入预检

继续使用当前分支和本机现有 ComfyUI/KJNodes，不升级插件、驱动或依赖，不换启动参数。记录实际代码提交、本机 KJNodes 版本或源文件哈希。

| 项目 | 本轮固定值 |
|---|---|
| 输出 | 1920×1088，24fps，96 帧 / 4 秒；不裁剪、不缩放、不补帧 |
| 分辨率配置 | 16:9、2.0 MP、multiple=32 |
| Seed / 预览 / 重跑 / 恢复 | 1000/fixed；preview=false；rerun_clip_id、recovery_mode 为空 |
| Self-Lift | CFG=1，transition_step=5，lowres_scale=0.5 |
| 日程 | Euler/simple，sampling_steps=6，Denoise=1 |
| 精修 | enabled=true，extra_steps=1，start=0.7，end=0，cosine |
| 修正与权重 | rho=0，w_min=0.5，w_max=1；原指定 `minimax_h3_latent_upscaler_3d_fp16.safetensors` |
| 高清模型 / 空间分块 | 不另接高清模型；highres_tiling=false，auto/2/auto 保持原值 |
| 模型、CLIP、视频/音频 VAE、参考图尺寸 | 保留真实成功请求值，不改成原示例的另一套权重或参考尺寸 |

预期仍是当前真实 Sigma 数组的低清 5 步 + 高清 1 步；保存本次实际数组，按参考精修条件判断，不通过改阈值凑 5+2。

零生成预检仍执行 37 的两组测试，失败即停止。通过 `/object_info` 或实际注册表核对 `MiniMaxLowVRAMAttention` 存在且接受 `model/head_chunks`；缺节点或当前 API 不兼容记 BLOCKED，不安装替代插件、不回退外部 SelfLift 采样器。

同时读取本机实际的 `MiniMaxLowVRAMAttention.execute` 与 `PathchSageAttentionKJ.patch`，核对模型补丁组合。参考源码通过 `transformer_options.minimax_head_chunks` 传参，并增加 block/attention forward 补丁；已有 attention forward 补丁可能被保留。必须区分“请求中连接了节点”“补丁成功挂载”“实际执行了头分组”三种证据，不能用前者冒充后者。

静态预检需要确认：原 Sage 的注意力 override 不被无意清除，FFN forward 补丁仍保留；已有 attention forward 会正确接收相应输入并处理头分组，或由本轮预期的 lowmem forward 接管。必要时使用本机实际节点函数与轻量模型替身检查 clone 后的补丁字典，不运行真实 H3 前向或额外预热生成。若组合明确冲突、头分组配置被忽略或补丁实际未挂载，保留文件/函数来源与差异后停止，不私改第三方节点使预检通过。

运行中的实际补丁/forward 证据能读到就写入报告，读不到标为未独立观测；本轮不再增加大型 profiler、全局 monkey patch 或以额外生成任务追捕钩子。

## 4. 只执行一次单段，沿用现有 trace

两组测试与模型链预检通过、队列空闲后，在实际 ComfyUI 进程环境设置 `TERRYDIRECTOR_TRACE=1`，按 35 的已验证方式重启，确认 `trace_ready` 与当前分支模块路径。保持日志模式、原启动参数一致，不强制 CUDA 同步、不改变显存装卸策略。

同时保存真正的 ComfyUI stdout/stderr；trace 路径使用后端打印的实际位置，不把 GPU 监控快照当作服务日志。

只提交本轮单段请求一次；`plan` 应仅有 clip-1，conditioning → low_sampling → resolution_transition/latent_upscale → high_sampling → checkpoint → decode_cache → final_output 必须完整。低清/高清应为 5/1 次回调。复用现有 trace 前置检查，不以关闭检查或复用旧缓存绕过。由于只有首段，没有 continuation Guide 事件是预期，也不能因此宣称多段衔接已验证。

如果预检/trace 检查失败、运行 OOM 或抛异常，保留实际原因与新 traceback 后停止；不改 head_chunks=2/8，不加空间分块，不降分辨率，不自动再提交。正常完成也只结束本次单段；是否继续三段由用户另行确认。

汇总时必须改为 **`--expected-segments 1`**，工具原默认是 3，不修改工具默认值：

```powershell
python tools/summarize_selflift_trace.py "本轮实际trace.jsonl" --prompt-id "本轮prompt_id" --expected-segments 1 --output "本轮单段summary.json"
```

使用 ComfyUI 自己的 Python；输出路径不得覆盖旧文件。退出码非零或 `integrity_ok=false` 时如实报告完整性问题，不冒充有效计时。

## 5. 判断和交付

报告同时给出功能、性能观察、画质三个独立状态，不用“任务成功”替代“提速成功”。

- 功能：新任务 success/completed，无异常，原始输出 1920×1088、24fps、96 帧、4 秒；音轨存在且可解码。报告单段实际 history 开始/成功时间与总耗时。
- 性能观察：按第 1 节逐行填新值、差值和 `(历史值-本次值)/历史值`；低清/高清分别比较，也列二者合计。首回调含准备时间，低清第 2–5 次回调可另列；高清只有一次，不能伪装成稳态纯 kernel 时间。保留父子包含关系，不重复累加。最终输出与单段总时长只记录绝对值，不与三段整体直接比较。
- 结论：注明历史与本次的前置调度/预热差异、实际 MODEL 补丁证据等级；没有重复测量就没有误差范围。小幅变化写“证据不足”，变慢或无明显改善如实记录；即使出现明显改善也仅作为下一轮同条件验证的候选，不写成永久提速结论。
- 画质：将新视频与此前用户已认可的报告 34 视频**前 4 秒**对照，保留首/中/末帧样例，检查身份、细节、运动、闪烁和声音。自动检查不能替代人工认可；未实际听看写“待人工确认”，此前画面通过不自动转移到新链路。

仅新增：

```text
docs/40_SELFLIFT_LOWVRAM_ATTENTION_CLIP1_REPORT.md
docs/evidence/selflift_lowvram_attention_clip1_summary.json
```

报告附代码提交、输入前后哈希/允许变更、原 MODEL 链与新链、预检结果及本机 KJ 源码版本、实际 prompt_id、Sigma、阶段表、视频本机路径及错误（如有）。小型汇总保留事件名/segment_id/父子关系、monotonic 起止、回调、实际尺寸、完整性和历史对照，不只交本机日志路径。去掉绝对 source/implementation 路径；权重、视频与大型日志留本机。

若未提交生成，汇总明确 `generation_submitted=false`，不要复制历史耗时作为本次值。旧 34/36/38 报告及证据全部保留。本轮不更新正式示例或产品默认配置。结束后移除 trace 环境变量并在队列空闲时重启，恢复原无计时服务，不改写用户原工作流。

## 参数与接口来源

- 用户最初附件 `Unsaved Workflow (2)(1).json`：节点 220 为启用的 `MiniMaxLowVRAMAttention(head_chunks=4)`，位于节点 219 的 FFN（2 / 4096）之前；本轮只提取这项候选，不替换附件里的其他模型、提示词或后处理。
- 历史实测：38 报告与 `selflift_stage_trace_retry_summary.json`（基线提交 `ff32515`）；计时边界继续以 [35 文档](35_SELFLIFT_STAGE_TRACE.md) 为准。
- 接口核对：`kijai/ComfyUI-KJNodes/nodes/minimax_nodes.py`，本轮读取 blob `6ffdb6af2cdf94f847f574051b1d1401374564b7`；`nodes/model_optimization_nodes.py`，固定提交 `d3cfe21625e5170126ce06fbfcfe1d88108688c3`、blob `90d8d41210825a6cc355f4467e4d247f13e55f94`。来源用于核对，不要求本机升级到该版本。
- `tools/summarize_selflift_trace.py` 已支持 `--expected-segments 1`。本轮仅新增任务文档，没有修改、运行测试或实测任何新的采样实现。
