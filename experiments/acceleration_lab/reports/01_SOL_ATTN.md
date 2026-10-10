# 独立加速实验台：B0 密集 / B1 Sol-Attn

## 判定

| 维度 | 本轮结论 |
|---|---|
| 技术 | **未通过生成验收。** B0 唯一一次提交在实验 Sigma 辅助节点失败，尚未进入条件编码或采样；按文档47停止，B1 未提交。修正后的只读加载方式只通过无生成测试，本轮没有重新提交。 |
| 速度 | **无法比较。** B0/B1 都没有完成可比的采样；报告46的 704.077 秒只是历史导演链，不能代替独立实验台 B0。 |
| 画质 | **无片段可评。** 人物身份、脸手、运动、闪烁、曝光、声音和同步均待后续实际生成与人工听看。 |

本轮生成提交次数：B0 **1**，B1 **0**；实际 H3 前向次数 **0**。无自动重试、参数扫描、候选叠加或三段扩展，也未修改导演节点、`director_trace`、根注册、UI、默认参数或正式工作流。

## 来源、隔离及构建

- 拉取 `feat/selflift-internal`，确认包含 `af0a9887d7076d3b33daf557c60b134014fd3c01`。冻结生产基线是 `0c82cd7bfb2de963304479eda86e02513e106da0`；Git 边界工具在构建前与构建后均报告无生产文件改动。ComfyUI `b26625f23a888367b92153b28d93e159e83e677b`；KJNodes `3f20054214fec9f9234fd3841ae6f1e4287948f6`。实验 GPU RTX 3090 / SM 8.6，torch `2.11.0+cu128`，Comfy Kitchen `0.2.37`。
- 原请求 SHA-256 `fa15bd5cc127969374d565f2caad664dd9bdc0c41e800c5f59521544328e5a64`。构建器只读调用冻结版 `compile_timeline`，确认 clip-1 独立、96 输出帧、H3 107 对齐帧。最终编译提示词 SHA-256 `353ee9913b2d40fc272e498e2f330d9bf689b59a371a1b6d71c15b0aaa57e1f7`；global/clip 原文哈希及七项资产逐个哈希见 `evidence/sol_attn.json`，私人原文与路径留在本机 `local/workflows/input_mapping.private.json`。
- B0 保留原 ref2va INT8 主模型、Turbo LoRA 强度1、CLIP、视频/音频 VAE、Kitchen 密集后端、LowVRAM(4)、FFN(2/4096)，Seed1000/fixed、CFG1、Euler/simple/6步、低清5步、比例0.5、rho/w_min/w_max=0/0.5/1、原 upscaler、无高清空间分块。B1 仅在其 MODEL 链末端加原生 `BlockSparseAttention`，`selection={"selection":"sol-attn","tau":1.0}`、percent=0.05–1、密集块0/1/48/49、min_tokens=12288、extra_tokens=256、`exact_kv_and_rows`、verbose=true。两图均有各自单一保存目标，无导演编排节点；实验采样节点只读调用冻结版 `sample_selflift`。
- 四份私人 UI/API 配对文件均已生成在 `local/workflows/`；B0/B1 文件分别为 `Lab_B0_Dense_Clip1.{json,api.json}`、`Lab_B1_SolAttn_Clip1.{json,api.json}`。API/UI SHA-256 见 `evidence/sol_attn.json`。结构与后端 schema/连线已校验；**前端实际打开 UI 文件未实测**。仓库中的 `templates/` 是明确不可排队的脱敏示意，完整提示词与资产路径未提交。
- 实验 ComfyUI 用独立 8190 端口、output/temp/user 目录与显式加载目录，模型和输入路径只读共用；正式 8188 服务未重启，两边队列在提交前均为空。旧导演 trace / OP_PROFILE / backend observer 均未启用。实验结束已停止独立服务，正式队列仍为空。

## 零生成与运行预检

| 核查 | 结果与范围 |
|---|---|
| 实验目录测试 | 新旧合计 **22/22**；包含隔离、图差异、单次原函数调用与对象/RNG不变、异常传播、包装恢复、真实 NestedTensor 音画/mask/元数据往返。 |
| API/UI 与注册 | 独立实例中八个 `TerryAccelLab*` 节点、KJ LowVRAM/FFN、原生 H3 和 BlockSparseAttention 均注册；四图必需输入、输出类型、连线及单一输出目标检查均为0错误。四图 Git/API 隔离检查均通过。这些预检不等于生成通过。 |
| Sol 内核 | `ck.sol_attn_is_available(cuda:0)=true`；一次小张量常规入口与实际 B1 所需 chunked 入口 GPU 冒烟输出有限值，后者输出形状 `[1,128,2,128]`。未做注意力速度基准或加载 H3。 |
| 块数与Sigma | 冻结 H3 源码/报告46运行证据为50块，预设明确保护0、1、48、49。按 H3 shift=12 的 `percent_to_sigma(0.05)` 得 `0.9956331877729258`，end=0；实际同型基础日程 `[1,.983683884,.960057557,.923076928,.857509673,.706380010,0]`。冻结精修函数因阈值0.7低于倒数第二项0.70638，本次不加步；预计低清5次依次为密集、稀疏×4，高清1次预计稀疏。**这只是条件推导；B1 无运行观测。** |

原生稀疏 `make_h3_block_patch` 在 eligible 时改写每块 attention producer，遇密集块、窗口外或短序列走原链；其 `ck.sol_attn_chunked` 是实际候选入口。因 B1 未运行，producer/kernel 调用数、保护行的实际 layout、密集 fallback 次数均未知，不能把菜单可用或微张量成功当成 B1 长序列证明。

## 唯一 B0 任务与停止依据

Prompt ID `ce97d812-9e38-4a1c-907f-28fc2a7259be`，服务返回 `node_errors={}`，随后 history `status_str=error`。原始 `execution_start=1791605074942`（2026-10-10 12:04:34.942 +08:00），`execution_error=1791605075306`（12:04:35.306），**0.364秒是从执行开始到报错，不是生成速度**。报错节点19 `TerryAccelLabSigmaRefine`，`ModuleNotFoundError: No module named 'TerryDirector'`。history 只列出已执行的模型链/视频 VAE/基础 Sigma 节点；未执行条件构造、Self-Lift、AV checkpoint、解码或编码；`local/runtime/output/` 未产生 B0 视频或完整 AV latent。

原因是首次实验实例的 Sigma helper 按 `TerryDirector` 包名导入冻结函数，而独立 custom_nodes 装载器没有暴露该包名。修正仅位于实验目录：`frozen.py` 以私有包名、只读源码路径加载冻结函数，不触发生产根注册；`lab_nodes.py` 改用此入口。修正后实验目录 22 项测试通过，其中显式检验根包不可导入时仍能找到 `_refine_sigmas` 与 `sample_selflift`。**修正后的节点没有在 GPU 任务中验证，本轮没有第二次 B0 提交。**

本轮未得到条件编码、低清、latent 放大、高清、视频/音频解码、保存/编码的阶段时间；峰值显存没有有效测量。报告46整任务时间不能填入这些空项。原始记录：`local/B0_submit_response.json`、`local/B0_history.json`、`local/lab_stderr.log`、`local/lab_stdout.log`，均留本机。history 中的完整 traceback 附后。

## 完整 traceback（history 原始异常栈）

```text
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\execution.py", line 548, in execute
    output_data, output_ui, has_subgraph, has_pending_tasks = await get_output_data(prompt_id, unique_id, obj, input_data_all, execution_block_cb=execution_block_cb, pre_execute_cb=pre_execute_cb, v3_data=v3_data)
                                                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\execution.py", line 353, in get_output_data
    return_values = await _async_map_node_over_list(prompt_id, unique_id, obj, input_data_all, obj.FUNCTION, allow_interrupt=True, execution_block_cb=execution_block_cb, pre_execute_cb=pre_execute_cb, v3_data=v3_data)
                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\execution.py", line 327, in _async_map_node_over_list
    await process_inputs(input_dict, i)
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\execution.py", line 315, in process_inputs
    result = f(**inputs)
             ^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy_api\internal\__init__.py", line 149, in wrapped_func
    return method(locked_class, **inputs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy_api\latest\_io.py", line 2219, in EXECUTE_NORMALIZED
    to_return = cls.execute(*args, **kwargs)
                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\TerryDirector\experiments\acceleration_lab\local\runtime\custom_nodes\terry-acceleration-lab\lab_nodes.py", line 74, in execute
    from TerryDirector.director_node import _refine_sigmas
ModuleNotFoundError: No module named 'TerryDirector'
```

当前实验源码哈希：`director_compile.py=0d1eb2f16a1234d6804032892eb962f2f527838522f3415466e30c343f59d21b`、`director_selflift.py=8d45fdfb41db0fa3f72f1d02ee99c0c1209dd3f339286ab075ad74e88f76830f`、原生 sparse 文件 SHA-256 `de202f2b5eb753a5748e1c6452cdc10cdf28834ffd8f8bb6acfaf6f643de9692`。失败时运行的是修正前辅助节点；从当前文件和唯一导入改动反向重建的当时 `lab_nodes.py` SHA-256 为 `a15a85a45109478979112103e83fb45c3e3fd418bc8d5dbf49b272a1953d9191`，改动差量在 `evidence/B0_submitted_helper_delta.json`。当前修正版 SHA-256 为 `80741db4a0609faf19d6ac0eeba85781d19aeac45048344cff550dc87df337da`，未在 B0 任务中执行。
