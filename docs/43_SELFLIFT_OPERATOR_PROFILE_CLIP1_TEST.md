# Self-Lift 采样内部定位 · 单段、两个前向采集窗口

> 分支：`feat/selflift-internal`；编写基线：`7d89de8cba6138c73471244bd4a2100f9a02ccdd`。  
> 用户已同意再测一次。交给本地 Codex：先接入并验证诊断，再最多提交 **1 次 / clip-1 / 原 4 秒**；不是 Kitchen 后端对照，不是提速验收，不扩展三段或参数矩阵。  
> 本文是执行任务，尚未实装或实测本轮算子采集器；不能把旧阶段 trace 当作已有 GPU 算子数据。

## 1. 要得到的证据

报告 40 的低清/高清分别为 371.201 / 217.581 秒，报告 42 只完成了源码与请求核对。下一次不再只重复阶段总数，而是回答：

- 实际调用的注意力包装/分派/叶函数是什么？输入 q/k/v 的 shape、dtype、stride、设备、head 分组如何？是否真正进入了回退函数？
- 在采到的低清、高清前向中，注意力模块、FFN/MLP、其他计算分别耗时多少？尤其把注意力模块内 QKV/output 投影与 attention 核心区分开，不把所有 Linear 都算作 FFN。
- 有哪些能直接观测的数据拷贝、转换、同步与等待？无法归属的部分留下 unknown，不能用主机时间减 GPU 时间推断 CPU offload。

采集只用于定位，不承诺提速。Profiler/诊断会产生开销，本次总时长不能用于宣布比报告 40 快或慢了多少。

## 2. 固定输入，不换后端

读取报告 40 的真实单段请求副本：

```text
G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_lowvram_attention_clip1_request.json
SHA-256: 36edcdc2b61bfd6d96d0fe415ebd7630b663b7a017e82563a3b211e309691ebf
```

文件位置变化可定位同哈希原件，不能拿其他模板重建。保留 clip-1 全部字段、[0,96)、24fps、原 globalPrompt/片段 prompt/useGlobalPrompt、7 项资产及稳定编号/路径；H3 对齐帧数按当前编译结果记录，报告 40 为 107，最终输出仍为 96 帧。原 `Terry导演台.json` 不写回。

```text
原 UNET → 原 LoRA → PathchSageAttentionKJ(auto, allow_compile=false)
    → MiniMaxLowVRAMAttention(head_chunks=4)
    → MiniMaxChunkFeedForward(chunks=2, seq_threshold=4096)
    → TerryDirector 配置.model

TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector Advanced
```

原 ref2va INT8 主模型、ref2v LoRA 及其强度、CLIP、两种 VAE、参考图尺寸均不变。不换成附件的 fl2va 模型，不设置 Kitchen，不改变全局 attention 启动参数。

保留 2.0MP / 16:9 / multiple=32，原始 **1920×1088、不裁剪**；Seed=1000/fixed；CFG=1、低清步数=5、比例=0.5、Euler/simple/6步/Denoise=1；精修开、extra=1/start=0.7/end=0/cosine；rho/w_min/w_max=0/0.5/1；原 latent upscaler；无独立高清模型；highres_tiling=false、preview=false。本次输出完整 Sigma 数组、真实回调和前向计数，不能只复述历史 5+1。

副本只允许变更导演/缓存标识、client ID、输出前缀和相应 metadata，防止复用旧缓存。提交前保存规范化输入差异，确认没有其他有效输入变化。

## 3. 先完成采集能力与适配器预检，不用真实生成探测工具

允许本地 Codex 编写独立、默认关闭的诊断适配器及小型测试，放在 `tools/` 与 `tests/`；确需自动接入时，只在现有 `director_trace.py` 增加默认关闭的安装入口。建议使用 `TERRYDIRECTOR_OP_PROFILE=1`，并要求同时启用 `TERRYDIRECTOR_TRACE=1`。这个新开关必须先实现、测试并出现 readiness 事件；当前版本本身不认识它。不要仅设置变量后直接长跑。

禁止修改 Self-Lift 数学计算、五个 `director_selflift*.py` 运行模块、H3 执行图、公开 schema、默认值、正式工作流和第三方源码。不装/升级 profiler、CUDA、Sage、Kitchen 或其他依赖，不合并 main。

使用 ComfyUI 本机虚拟环境，先复跑：

```powershell
python -m unittest discover -s tests -p "test*trace*.py" -v
python -m unittest discover -s tests -p "test_selflift_internal.py" -v
```

逐条检查退出码。再对新增适配器进行合成模块测试，验证：原函数只调用一次、输入与输出不被修改、随机数状态不被诊断消耗、调用计数正确、异常/OOM/中断不会被导出错误遮盖、移除诊断后函数与 hooks 恢复。不要删除或 skip 失败测试来放行。

**本轮额外允许一次微张量 GPU 能力冒烟，不属于视频生成，也不是后端速度微基准。** 在相同虚拟环境、队列空闲时用少量确定性张量和矩阵乘法/拷贝验证 profiler 与 CUDA Events，显存限制在小规模（例如总张量不超过 16 MiB），不加载 H3/CLIP/VAE，不跑 Sage/Kitchen attention，不下载权重。记录解释器、包版本/源码哈希、设备及测试结果，与实际后端环境核对。

PyTorch 2.11 文档明确：CUDA 可用但 CUPTI 不可用时，profiler 可能只在表格中给 CUDA 时间，而 JSON 没有 CUDA kernel 事件。因此不能只看 `torch.cuda.is_available()` 或 `supported_activities()` 就宣布 GPU 采集可用。按真实冒烟结果选择一次采集方式：

| 能力 | 本轮可用测量 | 必须保留的限制 |
|---|---|---|
| Chrome trace 有非零真实 GPU kernel 事件及关联 | CPU+CUDA profiler、record_function 模块区间与算子/内核归属 | 区分 CPU launch、GPU kernel、memcpy 和同步，不混算父子时间 |
| 表格有有效 device 时间，但没有 GPU kernel 时间线 | profiler 表格 + 已验证的模块 CUDA Events | 标明 legacy/无 kernel trace，不能报告未观测到的内核名或 GPU 空闲比例 |
| profiler 只有 CPU 数据，但 CUDA Events 可用 | CPU profiler + 模块 CUDA Events，记录有限的模块归属 | event elapsed 是被观测流上的区间时间，含等待，不是纯 kernel 时间；精确搬运/多流归属可为 UNKNOWN |
| 均无有效 GPU 计时，或适配器预检失败 | BLOCKED，提交停止证据 | 不提交视频，不自动升级工具或反复尝试生成 |

CPU-only 不能冒充 GPU 成功；但不因缺少 CUPTI 就丢弃已验证的 CUDA Events 模块计时方案。测量降级只影响证据类型，不改变采样后端。

## 4. 两个采集窗口与实际执行入口

复用已经验证的 `director_trace` 任务/导演/片段标识以及 `ComfyBackend.sample` 两阶段入口。适配器必须引用当前扩展实际加载的对象，不能另外导入一份 TerryDirector；安装在实际进程中并写出 `op_profile_ready`（版本、模式、真实模块路径、窗口配置）。默认关闭时不装 hooks、不做 GPU 操作、不创建文件。

只选取同一次任务中的两个真实 H3 diffusion model 前向：**低清阶段第 2 个实际 forward、高清阶段第 1 个实际 forward**。窗口只包所选前向，不覆盖条件编码、整个五步低清、VAE 解码或全片任务。不增加/重放任何模型求值，不截断原 sigma 日程，窗口结束后继续原生成。

记录 phase、forward_index、最近的 sampler callback_index、真实 sigma/timestep、batch、视频/音频 latent shape。计数按实际 forward，不把 CFG、条件分批或额外 wrapper 引起的多次前向误算成多步；低清第 2 个 forward也不在无证据时称为第 2 个 Euler step。没有对应前向则采集不完整，不临时重放一次补齐。

推荐 `torch.profiler.profile(activities=[CPU, CUDA], record_shapes=False, profile_memory=False, with_stack=False, with_flops=False)`，具体 activities 按第 3 节实测选择。不要全程 stack tracing 或记录全部张量 shapes；在实际模块入口只提取 shape/dtype/stride 等标量元数据，不保留张量或输入/输出副本。两个 profiler 窗口不能嵌套，统计导出/停止 profiler 的开销要单独列出。

在所选 forward 中，用实际执行对象的模块 hooks/最薄包装与 `record_function` 标记全体 transformer blocks 的 `.attn`、`.mlp`。保留 forward 的现有 KJ patch，不用原生未 patch 方法替换它。记录实际 block 数/观测次数，不能只测一个 block 后乘以总层数。已有直接函数调用绕过模块 hooks 时须找到真实调用点；缺失范围标 unknown，不补造记录。

注意力进一步标记实际 backend dispatch / leaf 调用；MLP 记录真实 fc1/fc2 调用与分片行数。检查当前有效 `optimized_attention_override` 及其闭包/被引用函数，而不是只替换模块同名属性后假定所有 from-import 别名都被覆盖。实际调用时记录叶函数来源、q/k/v 元数据、heads/mask/有效选项和调用次数；不为了取得名称而额外调用该函数，不更改 mask、kwargs、dtype、contiguous 或返回值。未知名称直接写 NOT_OBSERVED。

支持 CUDA Events 时，在真实 attention/MLP 调用前后于输入所在 CUDA 设备的当前流记录事件，只在整个窗口结束后统一解析。不要在每层/每算子后 synchronize，不设置 CUDA_LAUNCH_BLOCKING，不关闭 async offload/CUDA graphs 或改变模型管理策略。记录为解析事件或 profiler 收尾所做的同步及耗时；CUDA Graph/跨流导致 hooks 或事件语义不可靠时标受限，不能暗中关闭它们来取得数据。

窗口上下文退出、正常完成、OOM 或中断后均须清理 handles/临时包装，避免污染本次未采样部分或下一条任务。日志/统计只保存标量元数据，不复制生成 tensor、完整提示词或资产内容。

## 5. 一次真实任务与尽早检查

队列空闲时沿用原启动命令，仅启用本轮诊断。确认真实后端的 `trace_ready`、`op_profile_ready`、包路径与能力预检一致后，提交一次第 2 节的请求。保留真实 stdout/stderr、history、阶段 JSONL 和两个算子窗口文件，使用新前缀，不覆盖旧证据或清空其他任务队列。

第一个低清采集窗口结束即输出小型完整性结果：实际进入过 H3、attention、MLP，GPU 计时模式有效，并保存该窗口。如果模块事件或 GPU 数据缺失，记录 `diagnostic_incomplete` 后停止本任务，不继续耗到高清结束才检查，也不新建第二个任务。Profiler/CUDA Events 的测量限制须如实写入；有效的降级模式不因没有 kernel 时间线被误判失败。

低清窗口有效就继续同一任务，采集高清窗口并完成原 96 帧视频。发生 OOM 或采集器异常保留 traceback 后停止；本轮没有自动重试、Kitchen 切换、参数扫描或三段扩展。

原阶段完整性工具继续用 `--expected-segments 1`。它只验证阶段 trace，**不能替代算子采集完整性**。分别报告 generation_success、stage_integrity_ok、operator_capture_ok、measurement_mode 与 capture_limitations。

## 6. 只提交能决定下一步的结果

新报告：`docs/44_SELFLIFT_OPERATOR_PROFILE_CLIP1_REPORT.md`。  
小型脱敏数据：`docs/evidence/selflift_operator_profile_clip1_summary.json`。

报告首先给出低清窗口/高清窗口各自的下表，而不是先列十几行重复的阶段总耗时：

| 项目 | 必填内容 |
|---|---|
| 实际覆盖 | phase/forward/callback、sigma、block/attention/MLP/leaf 调用数、模式、原 trace 行号或 profiler event ID |
| Attention 模块 | host-wall、可用的 GPU 时间及口径；投影/核心注意力能分则分，不能分则标明 |
| FFN/MLP | host-wall、可用的 GPU 时间及口径；fc1/fc2、量化/反量化、分片证据 |
| 拷贝与等待 | 真实算子/kernel/事件名、次数、时间；有直接依据才写 H2D/D2H/设备内搬运，不把 aten::to 全算作 PCIe |
| 其他/未知 | 未归属的算子与时间、异步/多流/采集限制，不能靠差值制造因果归属 |
| 算子 Top 20 | 名称、调用次数、self CPU/device 时间、父模块或区间、单位；无设备时间时为 null，不写0伪装测到了 |
| 运行状态 | 新 prompt_id、输入哈希/白名单差异、history 总时长、输出规格、异常、诊断清理结果 |

不要把模块 inclusive CUDA 时间、其子算子时间和对应 kernel 时间重复相加；单独呈现模块归属表与算子表。重叠 GPU kernel 的累计执行时间不等于墙钟占用，CUDA event 区间也可能含等待。不得将采样窗口比例直接外推为全部 5 步/三段，或将本次 profiler 总时间与历史无 profiler 时间作加速倍数。

诊断源码和测试随同提交到本分支，注明临时接入位置与关闭方式。数据保留函数来源/哈希、shape/dtype、阶段与事件标识，去除本机绝对路径和提示词；大型 Chrome traces、视频、权重留本机。报告至少给出“主要开销更支持注意力/MLP/搬运/仍不能判断”的证据；缺 kernel 级数据可以给受限模块结论，不要无限追加生成才能写报告。

结束后关闭新增开关和阶段 trace，撤除临时诊断接入、恢复原启动状态，确认队列及服务正常。保留全部历史报告，不自动改采样代码、不合并 main。

## 参考与测量依据

- [40：当前单段成功请求与历史阶段对照](40_SELFLIFT_LOWVRAM_ATTENTION_CLIP1_REPORT.md)。
- [42：本机注意力分派审计与未知项](42_SELFLIFT_ATTENTION_BACKEND_AUDIT_REPORT.md)。
- `director_trace.py`：实际包对象、ComfyBackend.sample、阶段/回调入口；原模块未提供算子分析能力。
- PyTorch 2.11 profiler：CUPTI 缺失时 CUDA 表格与 JSON trace 的区别、record_shapes/with_stack 的开销和张量引用风险。https://docs.pytorch.org/docs/2.11/profiler.html
- PyTorch 2.11 CUDA Event：事件记录的设备/流、elapsed_time 及同步语义。https://docs.pytorch.org/docs/2.11/generated/torch.cuda.Event.html

本次仓库提交仅新增任务说明，没有执行本轮预检、GPU 能力冒烟、采集器测试或视频生成；本机 Codex 执行结果另见 44 报告。
