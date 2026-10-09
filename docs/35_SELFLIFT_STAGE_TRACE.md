# Self-Lift 性能定位：有效计时后，只采集一次原三段

分支：`feat/selflift-internal`。基线：`060a0e4`。本轮只增加可关闭的诊断，不是提速修复；不合并 main。

## 已知事实与目标

用户回传的成功任务原始时间戳为本地 2026-10-10 02:46:38.192 至 03:27:45.711，任务持续 **2467.519 秒**。旧 history 只有整任务起止；旧 service.log 是 30 秒监控快照，不是阶段日志；旧临时插件没有捕获到采样钩子。不能恢复这一次的分阶段耗时，也不能据此归因于 FFN、显卡或 Self-Lift。

本次改为从实际执行对象记录事件。先验证计时入口，再用**已经画面验收通过的请求副本**采集一次，不运行参数矩阵、不先跑完整探测再跑验收。

## 代码与测量边界

`director_trace.py` 由本扩展 `get_node_list()` 使用实际包名和真实节点类列表接入。默认未设置 `TERRYDIRECTOR_TRACE=1` 时不安装运行包装、不创建日志。启用状态需要重启后端；不增加 UI、不修改节点输入/默认值、缓存签名或 Self-Lift 数学计算。

- 修饰本仓库实际 `sample_selflift`，同时替换内部节点已经 from-import 的函数别名；修饰实际 `ComfyBackend.sample`，不搜索/导入另一份自定义节点包。
- 导演编译时从正在运行的 `nodes.NODE_CLASS_MAPPINGS` 获取原生 ReferenceToVideo / AddGuide 类；保留 classmethod 与函数签名。
- 原生 `get_executing_context()` 提供 prompt_id、完整 node_id、list_index；编译计划映射到 director_id / segment_id。同一请求多个导演节点按根 ID 区分。
- 条件编码没有被成功观测时，Self-Lift **在采样前停止**并报告 `missing fresh conditioning event`。这是诊断模式对全新任务的保护，不支持拿缓存条件绕过检查。
- 计时包装只旁观调用，不改模型装卸策略，不改变输出参数；原生模型加载/卸载调用只在当前被测阶段内记录。`model_unload_call` 返回 false 不代表完整卸载。

| 事件名 | 口径 |
|---|---|
| conditioning / continuity_guide | 原生条件构造、参考编码 / 衔接 Guide 的完整调用 |
| selflift | 单片段两阶段采样总调用 |
| low_sampling / high_sampling | 原生 sampler 调用的主机侧墙钟时间，包含其内部准备和模型加载 |
| step_callback / sampler_return | 回调入口间隔和最后回调至 sampler 返回的尾部；首个间隔包含准备，不是纯去噪 kernel 时间 |
| resolution_transition | 低清调用返回到高清调用开始的完整切换；latent_upscale 是其子事件 |
| latent_upscale / upscaler_weights / upscaler_offload | 放大整体 / 读取或复用放大器权重 / 定向卸载调用 |
| vae_encode / vae_decode | 上述阶段中的 VAE 子调用；记录实际 VAE 模型类，区分音频/视频时核对该类 |
| latent_checkpoint / decode_cache | LATENT 缓存 / 分段解码和无损缓存整体 |
| tensor_save / tensor_load | 被观测阶段内的张量读写子调用 |
| final_output | Advanced 最终输出整体，含缓存读取、帧转换、音视频编码、封装关闭与状态/清理，不冒充纯 codec 时间 |
| model_load_request / model_load_call / model_unload_call | 父阶段内部的模型管理调用；含模型类、设备、调用前后 loaded_size |

日志逐行写入 `ComfyUI/output/.terrydirector_trace/trace-<PID>-<SESSION>.jsonl`，控制台同时输出少量阶段边界。每条包含 UTC（显式 +00:00）和同进程 `perf_counter_ns`。旧监控时钟未经核对不得和新事件直接混算。

**这是 host-wall 诊断，不是 GPU kernel profiler。** 不调用 `torch.cuda.synchronize()`，不设置 CUDA_LAUNCH_BLOCKING，以免主动串行化原链路；异步 GPU 工作可能跨主机调用边界，不能将回调间隔当作纯 GPU 步时。显存为阶段边界当前 CUDA 设备的快照，不是区间峰值，也不是所有设备或所有进程的分项占用。不会为计时而初始化 CUDA。

事件存在父子关系：放大整体已包含权重准备/装卸；sampler 已包含内部模型加载。**不能将所有 inclusive 时间相加。** 汇总脚本给出直接子区间并集之外的 `outside_children_s`，它仍包含未拆开的工作、异步等待和日志开销，不等于纯计算时间。根区间并集也不等于 history 的整任务时间：上游加载器、资产读入、节点调度等未包裹范围仍须列为未覆盖，而不是虚构为某阶段。

## 本地 Codex 执行

### 1. 零生成预检

保留本地改动，拉取本分支。使用 ComfyUI 自己的 Python，在 TerryDirector 仓库运行：

```bash
python -m unittest discover -s tests -p "test*trace*.py" -v
python -m unittest discover -s tests -p "test_selflift_internal.py" -v
```

第一条调用实际内部节点、实际 Self-Lift 编排及 ComfyBackend.sample，使用合成 CPU 降噪器和注册表替身；检查输出逐值一致、事件、函数别名、V3 风格锁定子类、错误传播及汇总完整性。它不是完整 ComfyUI/GPU 预检。任何检查失败，停止，不提交生成。

确认队列空闲后沿用原来的后端启动方式，只给**实际启动 ComfyUI 的同一进程环境**加开关。例如 PowerShell：

```powershell
$env:TERRYDIRECTOR_TRACE = "1"
# 在此 shell 中执行原来的 ComfyUI 启动命令，原有参数保持不变。
```

不要仅在另一个 Codex shell 中设置变量，却继续使用没重启的服务。后端启动应打印 `[TerryDirector Trace] enabled:` 和实际 JSONL 路径；文件应有 `trace_ready`，其中的模块路径必须指向当前分支这份 TerryDirector，不是旧副本。启动没有此事件则停止，不提交生成。

### 2. 一次原三段采集

基于报告 34 的成功 `selflift_mlp_retest_request.json` 做副本，**不是最早缺 FFN 的失败 payload**。保留：

- 原 3 段 96 / 72 / 120 帧、24fps、原提示词与七项资产、后两段 tail_continuation。
- 原模型/LoRA/Sage 链与 `MiniMaxChunkFeedForward(2, 4096)`；不同时补另一种 attention 优化。
- 1920×1088，不裁剪；Seed=1000/fixed；原 Self-Lift 参数全部不变，`highres_tiling=false`、preview=false、rho=0。
- 不接独立高清模型，不切回外部 SelfLiftAvatarH3Sampler，不减步数或资产。

使用新的测试导演 ID / 缓存标识和输出前缀，确保三个片段真正执行，不改写原工作流，不复用旧生成缓存。沿用已验证的 /prompt 提交，最多一次三段；启动时同时保存**真实 ComfyUI stdout/stderr**，不要再用 GPU 监控快照文件冒充服务日志。

本次任务应依次出现 native_trace_ready、plan、片段 1 conditioning begin/end、low_sampling。首个低清步骤完成时应出现真实回调事件；不要设置过短的固定耗时超时。若只有 trace_ready 没有后续事件，或前置检查失败，保留错误后停止；不以完整重复生成测试日志。正常执行则继续同一请求完成三段。

### 3. 汇总与报告

对本轮实际 JSONL 和 prompt_id 运行（替换实际路径，不与旧任务混用）：

```bash
python tools/summarize_selflift_trace.py "实际trace.jsonl" --prompt-id "本轮prompt_id" --expected-segments 3 --output "本轮summary.json"
```

输出文件已存在时脚本拒绝覆盖；退出码 2 / integrity_ok=false 表示缺事件、失败、不完整或非本轮三段，不代表性能结论。脚本会核对每段条件/两阶段/放大/缓存/最终输出及回调数量。

写入 `docs/36_SELFLIFT_STAGE_TRACE_REPORT.md`：代码提交、两条预检结果、真实请求 ID、history 起止与总耗时、每段阶段耗时表、模型装卸子项、测量覆盖与未覆盖范围、完整性错误（如有）、视频路径与失败 traceback。附每项原始 monotonic 起止或 JSONL 行号，不平均分摊。

将**小型汇总 JSON**脱敏后作为 `docs/evidence/selflift_stage_trace_summary.json` 随报告推送本分支（仅去掉本地绝对 source_file/implementation.file 路径，保留模型类、时间、事件和 ID）。不要只提交本机日志路径，否则远端仍无法分析证据。模型、视频和大型原始服务日志留本机。

如果某阶段占比明显最高，只给证据支持的结论和单变量候选；本轮不自动修改算法/采样参数，不再跑第二遍，不合并 main。完成后移除环境变量并重启后端，恢复默认无计时状态。

## 交付侧检查

Python 3.13.5 / PyTorch 2.10.0+cpu：18 项计时/汇总检查、47 项已有 Self-Lift CPU 检查通过。真实 ComfyUI/GPU、原权重和全仓库回归未执行；没有本轮三段的新性能数据。五个 Self-Lift 运行模块保持原 blob，不更改已认可的采样计算。

接口依据：ComfyUI v0.39.0 `comfy_execution/utils.py` 的执行上下文、当前仓库的实际 node/engine 入口；测量边界参考 PyTorch CUDA semantics 的 asynchronous execution 与 memory management 说明：
https://docs.pytorch.org/docs/stable/notes/cuda.html
