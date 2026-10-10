# Self-Lift 单段算子采集报告（44）

## 结论与运行状态

**单次生成成功，阶段完整性与两个指定前向的算子采集均通过。** 新任务 `638ff359-0782-4ae1-b1aa-acb0452e860b`，生成提交次数 **1**。原始 `execution_start=1791597118739`、`execution_success=1791597954014`，差值 **835.275 秒（13:55.275）**，不含提交前准备或结束后检查。阶段汇总 `--expected-segments 1` 返回 `integrity_ok=true`；两个 `operator_window.capture_ok=true`。

主要可直接观测的 GPU 计算是 Sage attention 核心和 INT8 GEMM。高清所选前向的 Sage 核心 kernel 200 次、累计 **123.785 秒**；低清为 200 次、**28.397 秒**。外层 attention 的 GPU annotation 区间分别为 **127.922 / 30.376 秒**（高清/低清），MLP 分别 **32.336 / 15.531 秒**。这些区间含父子重叠、可能跨流或含等待，不能互相相加，也不能外推成全片或与报告40做速度倍数比较。

另有 `Command Buffer Full` CPU self time：低清 **59.674 秒/957 次**、高清 **149.758 秒/1204 次**。这是当前 profiler 的主机侧事件，不足以归因于 GPU 忙、CPU offload、分块或 Self-Lift 算法。GPU memcpy 的直接时间远小于 attention 核心累计时间，但 `aten::copy_` 与多流等待仍无法全部归属。画面与声音**未实际观看/听取，待人工确认**。

## 基线、固定请求和预检

- 分支 `feat/selflift-internal`，拉取后 HEAD `07d37c81e29b4364f4aeeade5698606c5eadd02e`，包含指定 `07d37c8`；没有合并 main。
- 原报告40请求 SHA-256 `36edcdc2b61bfd6d96d0fe415ebd7630b663b7a017e82563a3b211e309691ebf`；本次副本 SHA-256 `9d4630ae5269f99475ee16c7adfbf8412c8065bb1021492192c13496e01f5e86`。规范化比较仅变更 Advanced 节点 ID `9600328→9700431`、`save_subfolder`、`filename_prefix`、client ID 与对应 workflow metadata；其他有效输入完全相同。原 `Terry导演台.json` 未写回。
- 原 clip-1 `[0,96)`、24 fps，7 项资产和全部提示词保留；编译计划 trace 第5行给出 H3 对齐 107 帧、输出96帧。原模型链仍是 UNET → ref2v LoRA → KJ Sage auto → LowVRAMAttention(4) → FFN(2/4096)；没有 Kitchen attention 后端切换，也没有独立高清模型、高清空间分块、采样参数或分辨率变化。
- 两组原预检：trace 类 **24/24**、Self-Lift internal **47/47**；包含新增的单次调用/输入输出/RNG/异常传播/真实 CPU hooks 清理/安装卸载测试。微张量能力冒烟在实际 `.venv`：Python 3.12.13、torch 2.11.0+cu128、RTX 3090 sm86、张量上界 786,432 bytes；CUDA Event 31.862 ms、profiler 表格 device 71.680 µs、Chrome trace 1 条真实 GPU kernel，选择 `cpu_cuda`。冒烟没有加载模型或调用 Sage/Kitchen。
- 实际后端 PID 28744 在提交前的 trace 第1–2行发出 `op_profile_ready` 与 `trace_ready`，H3 路径指向 `comfy/ldm/minimax/model.py`、适配器指向本仓库 `tools/selflift_operator_profile.py`，窗口为低清第2、高清第1个实际 H3 forward。初次零生成启动预检发现 readiness 字段 `version` 冲突导致扩展导入失败；修正为 `adapter_version` 后重新启动并确认两事件，再提交唯一一次生成。

## 指定前向的实际覆盖

| 窗口 | trace 行 / UTC | 回调已完成数 | H3 timestep | latent（视频；音频） | block / attn / MLP / Sage叶 | GPU kernels |
|---|---|---:|---:|---|---|---:|
| low_sampling forward 2 | L80 / 2026-10-10T01:56:12.901+00:00 | 1 | 983.683899 | `[1, 24, 32, 34, 60]`；`[1, 32, 2, 178]` | 50 / 50 / 50 / 200 | 38,565 |
| high_sampling forward 1 | L111 / 2026-10-10T02:03:51.408+00:00 | 0 | 706.380005 | `[1, 24, 32, 68, 120]`；`[1, 32, 2, 178]` | 50 / 50 / 50 / 200 | 51,219 |

两窗口的 attention 输入均为嵌套列表，当前适配器的外层 CUDA Event 未取得输入设备，故 `attention.cuda_event_interval_sum_ms=null`；profiler 独立给出了 `td_op.attention` 的 GPU annotation 区间。低清与高清各实际观测 50 次 qkv、50 次 output 投影、100 次 fc1；`fc2` 模块 hook 为0，因为 KJ `minimax_mlp_chunked_forward` 在 `nodes/minimax_nodes.py:21–30` 经 `comfy.ops.linear_input_act(self.fc2,...)` 直接调用，不代表 fc2 计算缺失。fc1 两次半段输入分别为 `[22902,5376]` 与 `[47382,5376]`，直接支持 2 分块实际生效。

Sage override 是 KJ `PathchSageAttentionKJ.patch.<locals>.attention_override_sage`；实际叶函数两窗均为 `sageattention.core.sageattn_qk_int8_pv_fp16_cuda`，各200次（50 block × 4 heads group）。两窗 q/k/v 均 BF16、`cuda:0`、HND、stride `[7168,128,21504,1]`，shape 分别 `[1,14,45804,128]`、`[1,14,94764,128]`，`is_causal=false`、无 mask、`pv_accum_dtype=fp32`。这是实际调用记录，不是从 auto 标签推测。`comfy_kitchen::int8_linear` 是量化 Linear 算子名，本次没有切换为 Kitchen **attention**。

trace L72/L104 的两阶段 sigma_count 分别为 6/2；实际回调为 5/1（L79–85、L111–113）。被采到的两个 timestep 如上。**完整 Sigma 数组未写入本轮原始 trace/history，无法作为已观测数值给出**；仅有数量、选中前向的 timestep 与原请求中的生成参数。低清第2个 forward 不直接称为第2个 Euler step。

## 模块区间（毫秒）

以下 host-wall、CUDA Event 与 GPU annotation 均是对应类别**多次区间累计**，不是同一时间轴的可加分项。CUDA Event 测量所在流的区间，可能含等待；GPU annotation 与子算子重叠。

| 窗口 | 模块 | 次数 | host-wall 累计 ms | CUDA Event 累计 ms | GPU annotation 累计 ms |
|---|---|---:|---:|---:|---:|
| low_sampling | attention | 50 | 10,764.554 | UNKNOWN | 30,375.730 |
| low_sampling | qkv_proj | 50 | 288.242 | 11,205.200 | 11,204.887 |
| low_sampling | sage_leaf | 200 | 5,220.634 | 28,758.561 | 28,757.886 |
| low_sampling | out_proj | 50 | 3,120.070 | 3,967.601 | 3,967.330 |
| low_sampling | mlp | 50 | 11,363.303 | 22,605.689 | 15,530.716 |
| low_sampling | fc1 | 100 | 5,253.159 | 14,180.713 | 14,180.327 |
| low_sampling | fc2 | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| high_sampling | attention | 50 | 17,981.249 | UNKNOWN | 127,921.992 |
| high_sampling | qkv_proj | 50 | 1,988.183 | 23,296.682 | 23,295.949 |
| high_sampling | sage_leaf | 200 | 7,544.082 | 124,558.200 | 124,557.423 |
| high_sampling | out_proj | 50 | 2,306.910 | 8,142.051 | 8,141.872 |
| high_sampling | mlp | 50 | 19,456.605 | 47,795.493 | 32,336.470 |
| high_sampling | fc1 | 100 | 12,252.724 | 30,962.193 | 30,961.770 |
| high_sampling | fc2 | 0 | UNKNOWN | UNKNOWN | UNKNOWN |

低清/高清 `td_op.sage_leaf` 的 GPU annotation 累计 **28,757.886 / 124,557.423 ms**；对应核心 `qk_int_sv_f16_attn_kernel` 本身累计 **28,396.679 / 123,785.385 ms**。MLP GPU annotation 累计 **15,530.716 / 32,336.470 ms**。本次窗口更支持 attention 核心占较大 GPU 计算区间；未观测的多流重叠、offload 归属和 profiler 开销使全任务瓶颈比例仍为 UNKNOWN。

## 拷贝、等待与诊断开销

| 证据 | 低清 | 高清 | 解释 |
|---|---:|---:|---|
| GPU `Memcpy HtoD (Pinned -> Device)` | 393次 / 481.655ms | 596次 / 820.098ms | profiler 直接 memcpy 事件；累计时长非墙钟占用 |
| GPU `Memcpy HtoD (Pageable -> Device)` | 11次 / 0.259ms | 12次 / 0.293ms | profiler 直接 memcpy 事件；累计时长非墙钟占用 |
| GPU `Memcpy DtoD (Device -> Device)` | 167次 / 63.863ms | 169次 / 132.197ms | profiler 直接 memcpy 事件；累计时长非墙钟占用 |
| GPU `Memcpy DtoH (Device -> Pinned)` | 4次 / 0.005ms | 4次 / 0.005ms | profiler 直接 memcpy 事件；累计时长非墙钟占用 |
| `aten::copy_` | 15206次 / self CPU 176.610ms / device 4,673.260ms | 20427次 / self CPU 234.026ms / device 8,967.794ms | 算子自身时间；`aten::copy_` 不等同 PCIe |
| `cudaStreamWaitEvent` | 161次 / self CPU 0.497ms / device 1.036ms | 160次 / self CPU 0.412ms / device 0.000ms | 算子自身时间；`aten::copy_` 不等同 PCIe |
| `cudaStreamSynchronize` | 15次 / self CPU 4.702ms / device 0.000ms | 15次 / self CPU 9.520ms / device 0.000ms | 算子自身时间；`aten::copy_` 不等同 PCIe |
| `cudaDeviceSynchronize` | 1次 / self CPU 5,597.498ms / device 0.000ms | 1次 / self CPU 12,716.810ms / device 0.000ms | 算子自身时间；`aten::copy_` 不等同 PCIe |
| `Command Buffer Full` | 957次 / self CPU 59,673.807ms | 1204次 / self CPU 149,757.684ms | profiler 主机开销/等待证据；根因未知 |
| profiler 收尾 / 解析导出 | 6,868.319 / 24,718.286ms | 14,396.611 / 33,396.979ms | 收尾和事件解析另列，不能算进模型算子 |

`cudaDeviceSynchronize` 的 5.597 / 12.717 秒位于诊断窗口，主要与 profiler 收尾同量级；不作为采样算法自身的同步耗时。每层没有主动 synchronize；适配器在窗口结束后统一解析 CUDA Events。`aten::_to_copy`、`aten::copy_`、HtoD 与 DtoD 有直接事件，但缺完整张量来源链；不能把全部 `aten::to` 解释为 CPU offload。

## low_sampling 算子 Top 20（按 self CPU）

父模块列仅当记录本身是 `td_op.*` 时标出对应区间；其余事件的精确父模块未在小型汇总中关联，标 `UNKNOWN`。self device 为 profiler 累计设备时间，零值只表示该条记录无计入的设备时间。单位 ms。GPU kernel 另见下表与脱敏 JSON。

| # | 算子 | 次数 | self CPU ms | self device ms | 父模块/区间 |
|---:|---|---:|---:|---:|---|
| 1 | `Command Buffer Full` | 957 | 59,673.807 | 2,557.760 | UNKNOWN |
| 2 | `cudaDeviceSynchronize` | 1 | 5,597.498 | 0.000 | UNKNOWN |
| 3 | `cudaLaunchKernel` | 37969 | 464.956 | 0.000 | UNKNOWN |
| 4 | `comfy_kitchen::int8_linear` | 200 | 233.062 | 0.000 | UNKNOWN |
| 5 | `aten::copy_` | 15206 | 176.610 | 4,673.260 | UNKNOWN |
| 6 | `td_op.mlp` | 50 | 164.579 | 0.000 | td_op.mlp |
| 7 | `aten::empty_strided` | 14250 | 125.293 | 0.000 | UNKNOWN |
| 8 | `td_op.sage_leaf` | 200 | 92.955 | 0.000 | td_op.sage_leaf |
| 9 | `aten::_to_copy` | 13706 | 91.561 | 0.000 | UNKNOWN |
| 10 | `cudaHostRegister` | 55 | 77.863 | 0.419 | UNKNOWN |
| 11 | `td_op.attention` | 50 | 74.689 | 0.000 | td_op.attention |
| 12 | `aten::mul` | 4813 | 71.493 | 3,146.792 | UNKNOWN |
| 13 | `aten::addcmul_` | 2600 | 65.463 | 476.048 | UNKNOWN |
| 14 | `aten::slice` | 15799 | 50.991 | 0.000 | UNKNOWN |
| 15 | `aten::mm` | 876 | 49.065 | 1,069.639 | UNKNOWN |
| 16 | `cudaMallocAsync` | 30362 | 44.184 | 0.000 | UNKNOWN |
| 17 | `aten::add` | 2418 | 42.771 | 4.250 | UNKNOWN |
| 18 | `td_op.out_proj` | 50 | 39.862 | 0.000 | td_op.out_proj |
| 19 | `aten::to` | 19565 | 37.063 | 0.000 | UNKNOWN |
| 20 | `aten::empty` | 4105 | 35.188 | 0.000 | UNKNOWN |

对应 GPU kernel 按事件累计耗时前5（各 kernel 时长可重叠，不可等同墙钟）：

| kernel 名（保留可读前缀；完整名在 JSON） | 次数 | 事件累计 ms |
|---|---:|---:|
| `_Z25qk_int_sv_f16_attn_kernelILj128ELj64ELj32ELj64ELj128EL8DataTy` | 200 | 28,396.679 |
| `ampere_igemm_int8_128x128_ldg4_nn` | 300 | 26,378.591 |
| `_ZN2at6native29vectorized_elementwise_kernelILi4ENS0_13BinaryFunc` | 2150 | 2,058.276 |
| `_ZN2at6native27unrolled_elementwise_kernelIZZZNS0_23direct_copy_k` | 2946 | 1,511.936 |
| `_ZN2at6native29vectorized_elementwise_kernelILi4EZNS0_25bfloat16_` | 10045 | 1,158.608 |

## high_sampling 算子 Top 20（按 self CPU）

父模块列仅当记录本身是 `td_op.*` 时标出对应区间；其余事件的精确父模块未在小型汇总中关联，标 `UNKNOWN`。self device 为 profiler 累计设备时间，零值只表示该条记录无计入的设备时间。单位 ms。GPU kernel 另见下表与脱敏 JSON。

| # | 算子 | 次数 | self CPU ms | self device ms | 父模块/区间 |
|---:|---|---:|---:|---:|---|
| 1 | `Command Buffer Full` | 1204 | 149,757.684 | 8,699.073 | UNKNOWN |
| 2 | `cudaDeviceSynchronize` | 1 | 12,716.810 | 0.000 | UNKNOWN |
| 3 | `cudaLaunchKernel` | 50525 | 920.398 | 0.000 | UNKNOWN |
| 4 | `cudaMallocAsync` | 42024 | 495.476 | 0.000 | UNKNOWN |
| 5 | `comfy_kitchen::int8_linear` | 200 | 367.669 | 0.000 | UNKNOWN |
| 6 | `aten::copy_` | 20427 | 234.026 | 8,967.794 | UNKNOWN |
| 7 | `td_op.mlp` | 50 | 192.399 | 0.000 | td_op.mlp |
| 8 | `cudaHostRegister` | 246 | 178.691 | 0.000 | UNKNOWN |
| 9 | `td_op.sage_leaf` | 200 | 173.047 | 0.000 | td_op.sage_leaf |
| 10 | `aten::empty_strided` | 19438 | 167.270 | 0.000 | UNKNOWN |
| 11 | `aten::mul` | 9609 | 146.248 | 6,519.865 | UNKNOWN |
| 12 | `aten::_to_copy` | 18796 | 119.529 | 0.000 | UNKNOWN |
| 13 | `td_op.attention` | 50 | 91.496 | 0.000 | td_op.attention |
| 14 | `td_op.fc1` | 100 | 81.976 | 0.000 | td_op.fc1 |
| 15 | `aten::mm` | 1170 | 69.438 | 2,126.477 | UNKNOWN |
| 16 | `aten::slice` | 22187 | 68.180 | 0.000 | UNKNOWN |
| 17 | `comfy_kitchen::dequantize_int8_convrot_weight_dtype` | 290 | 58.322 | 0.000 | UNKNOWN |
| 18 | `aten::addcmul_` | 2600 | 53.418 | 994.085 | UNKNOWN |
| 19 | `aten::to` | 27747 | 51.243 | 0.000 | UNKNOWN |
| 20 | `td_op.out_proj` | 50 | 47.036 | 0.000 | td_op.out_proj |

对应 GPU kernel 按事件累计耗时前5（各 kernel 时长可重叠，不可等同墙钟）：

| kernel 名（保留可读前缀；完整名在 JSON） | 次数 | 事件累计 ms |
|---|---:|---:|
| `_Z25qk_int_sv_f16_attn_kernelILj128ELj64ELj32ELj64ELj128EL8DataTy` | 200 | 123,785.385 |
| `ampere_igemm_int8_128x128_ldg4_nn` | 300 | 55,830.850 |
| `_ZN2at6native29vectorized_elementwise_kernelILi4ENS0_13BinaryFunc` | 4450 | 4,288.515 |
| `_ZN2at6native27unrolled_elementwise_kernelIZZZNS0_23direct_copy_k` | 5442 | 3,119.627 |
| `_ZN2at6native29vectorized_elementwise_kernelILi4EZNS0_25bfloat16_` | 12541 | 2,386.517 |

## 阶段与输出、未知项

| 阶段 | trace host inclusive s | 备注 |
|---|---:|---|
| conditioning | 79.132 | 已含内部装卸/子阶段，禁止相加 |
| low_sampling | 382.164 | 已含内部装卸/子阶段，禁止相加 |
| latent_upscale | 2.825 | 已含内部装卸/子阶段，禁止相加 |
| high_sampling | 246.361 | 已含内部装卸/子阶段，禁止相加 |
| decode_cache | 116.297 | 已含内部装卸/子阶段，禁止相加 |
| final_output | 5.264 | 已含内部装卸/子阶段，禁止相加 |

原始视频：`G:\AIGC\ComfyUI_Codex\output\video\TerryDirector_SelfLift_OpProfile_Clip1_00001_.mp4`。history 与 ffprobe 均确认 H.264 1920×1088、24fps、96帧、4.000秒，AAC 音轨；文件大小 3,748,239 bytes。画面、音频内容与同步：**待人工确认**，本轮未实际看听。

未知项：完整 Sigma 数组；每个 GPU kernel 对应的精确 CPU 父 scope；嵌套 attention 外层 CUDA Event；全窗口未标记算子、CUDA Graph/多流空档的时间归属；HtoD 的具体权重或激活来源；`Command Buffer Full` 的根因。没有据此下 GPU、分块或 Self-Lift 算法因果结论。

## 原始证据、源码与收尾

- 实际请求：`G:\AIGC\ComfyUI_Codex\output\.terrydirector_diag\selflift_operator_profile_clip1_request.json`；白名单比较：同目录 `selflift_operator_profile_clip1_request_diff.json`；提交响应：`selflift_operator_profile_clip1_submit_response.json`；history：`selflift_operator_profile_clip1_history.json`。
- 阶段 trace：`G:\AIGC\ComfyUI_Codex\output\.terrydirector_trace\trace-28744-ccce76c6c4d04885bc9491acb86c7ff9.jsonl`；阶段汇总：`G:\AIGC\ComfyUI_Codex\output\.terrydirector_diag\selflift_operator_profile_clip1_stage_summary.json`。关键证据行 L1–2 readiness、L5计划、L72–85低清、L104–114高清。
- 算子窗口原始 JSONL：`G:\AIGC\ComfyUI_Codex\output\.terrydirector_op_profile\op-28744.jsonl`；Chrome traces 同目录 `op-28744-low_sampling-2.chrome.json`、`op-28744-high_sampling-1.chrome.json`。大型 profiler trace 留本机；脱敏小型汇总为 `docs/evidence/selflift_operator_profile_clip1_summary.json`，附源码哈希、完整 Top20 与 GPU memcpy 分类。
- 后端 stdout/stderr：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_operator_profile_clip1_comfy_stdout.log` / `selflift_operator_profile_clip1_comfy_stderr.log`。生成无异常 traceback；stderr 中另有不相关自定义节点导入报错及 profiler `External init callback must run in same thread` 提示，但两个窗口文件与 history 均成功，按原文保留以供排查。
- 临时接入：`director_trace.py` 的 `install()` 与 `wrap_sampler()`；算子适配器 `tools/selflift_operator_profile.py` 的 `install()`、`wrap_forward()`、`Window._install_hooks()`、`_install_leaf()`。设置 `TERRYDIRECTOR_TRACE=1` 和 `TERRYDIRECTOR_OP_PROFILE=1` 才生效。已按原命令重启为 PID 3532，两个开关关闭；`/queue` 为空，TerryDirector 导入正常。代码保留为默认关闭的诊断能力，临时运行时 hooks 随窗口结束清除。
