# 独立 Sol 实验续测：B0 成功，B1 入口失败后停止

## 结论

| 项目 | 本轮结果 |
|---|---|
| 技术 | B0 Kitchen 密集基线成功，输出完整 AV checkpoint 与 4 秒音画视频。B1 唯一一次提交在原生 `BlockSparseAttention` 参数绑定处失败，尚未执行 H3 前向；Sol-Attn 技术效果仍未验证。 |
| 速度 | B0 执行开始至成功为 **804.685 秒**。B1 没有采样时间，不能计算 Sol 提速。报告46只作历史参考。 |
| 画质 | B0 文件规格及音视频流已验证；**未连续实际看听，人物、动作、闪烁、声音与同步均待人工确认**。B1 无视频。 |

本轮严格提交 B0 **1** 次、B1 **1** 次；B1 失败后未修图重试。V0/V1、Veda 和其他组合均未排队。两个实验实例分别使用新的 `local/runs/sol_retry_b0` 与 `sol_retry_b1`，均已停止；8188 正式服务未重启，最终队列为空。没有改生产节点、根注册入口、正式工作流或模型参数，没有合并 main。旧报告和旧 `local/B0_*` 记录未覆盖。

## 源码及零生成预检

拉取 `feat/selflift-internal` 后的起始 HEAD 为 `88c168e6a732dd26a9ef028f27b33d3b8da6b82f`，包含指定提交。冻结生产基线 `0c82cd7bfb2de963304479eda86e02513e106da0`。实验目录 22/22 项测试通过；隔离检查在运行前后均通过，`forbidden_changed_paths=[]`。B0/B1 UI/API 与新实例 `/object_info` 的静态 schema/连线检查均为零错误。该检查后来证明**不能验证 DynamicCombo 在执行时的参数绑定**。

在干净、无生成的 ComfyUI `.venv` 子进程中，通过实际安装 junction 所指向的实验扩展调用 `TerryAccelLabSigmaRefine.execute`，没有 mock `_refine_sigmas`：

- 原 H3 同型日程 `[1,.983683884,.960057557,.923076928,.857509673,.706380010,0]`，`extra_steps=1/start=.7/end=0/cosine`，结果保持 7 个 float32 Sigma 且输入未变。
- 合成触发日程 `[1,.7,.4,0]`，`extra_steps=2`，实际扩为 `[1,.7,.597487330,.349999994,.102512598,0]`，dtype 和输入未变。
- `frozen.ROOT` 解析到本仓库根；`_refine_sigmas` 来源 `director_node.py`，SHA-256 `de0ea0c96e360560b07bdee15c71b41891924392885df718c94d6ea8d5a67ee9`；`sample_selflift` 来源 `director_selflift.py`，SHA-256 `8d45fdfb41db0fa3f72f1d02ee99c0c1209dd3f339286ab075ad74e88f76830f`。此子进程的 `sys.modules` 无 `TerryDirector` 根包。实验实例装载的 junction 均解析到本实验目录，节点实际注册；不依赖生产根入口导入成功。
- 原有合成测试覆盖 Self-Lift 包装的原对象/单次调用/异常恢复、七图条件入口和完整 AV 存取；真实 H3 下游只由本轮 B0 验证。前端手动打开 UI 工作流文件未验证。

原报告46请求 SHA-256 `fa15bd5cc127969374d565f2caad664dd9bdc0c41e800c5f59521544328e5a64`；最终编译提示词 SHA-256 `353ee9913b2d40fc272e498e2f330d9bf689b59a371a1b6d71c15b0aaa57e1f7`。私人 B0/B1 API 文件 SHA-256 分别为 `d867be9289b4f91e4d61feb6b9ee4e3172a61370fcbad9a35dd7c5912083e864` / `f1808f2a6b9d367930117468c7f99ebd43a8709153f9ca2a98ef6c2328edaa7a`，与上轮构建记录相同。七项资产逐一哈希及模型、LoRA、CLIP、VAE、Self-Lift 参数见原 `evidence/sol_attn.json`。两图保留 1920×1088、24fps/96 帧、H3 107 帧、Seed1000、全部原提示词和资产。视频 VAE 状态 **ALREADY_ACTIVE**，没有下载或改换权重。

## B0：实际密集基线

任务 `186cedb3-b4a1-41e2-8dc9-1c60f3182931`，history `execution_start=1791606293332`、`execution_success=1791607098017`（Unix 毫秒），差值 **804.685 秒 / 13:24.685**；不含排队和轮询。原始阶段记录在 `local/runs/sol_retry_b0/runtime/output/.acceleration_lab/stages.jsonl`。阶段计时使用 `perf_counter_ns`；采样和视频解码前后同步 CUDA、重置峰值，计时包含这些诊断动作，单独开销未知。

| 阶段 | 秒 | 证据 |
|---|---:|---|
| 七图条件/参考编码 | 112.070 | `conditioning` |
| 低清采样，5 次 callback | 357.292 | `low_sampling`；Sigma `[1,.983683884,.960057557,.923076928,.857509673,.706380010]` |
| 高清采样，1 次 callback | 201.420 | `high_sampling`；Sigma `[.706380010,0]` |
| Self-Lift 整体 | 561.832 | `selflift_total`，**包含**低清、放大、高清，不与上两行累加 |
| 完整 AV checkpoint | 0.068 | `checkpoint_av`，25,114,989 字节 |
| 音频 VAE 解码 | 0.480 | `audio_vae_decode` |
| 视频 VAE 解码 | 123.411 | `video_vae_decode` |
| 最终保存/编码 | 3.352 | `save_encode` |

低清与高清各阶段实际 `sol_chunked_calls=0`，符合 B0 密集链。latent 放大无独立边界，已包含在 Self-Lift 整体与两个采样阶段间，不能给精确秒数。其余模型装卸/调度时间不强行分摊。

实际视频：`local/runs/sol_retry_b0/runtime/output/video/Lab_B0_Clip1_00001_.mp4`，3,613,665 字节，SHA-256 `eb80b4c96febafe578b96d1168ce8252d08989e1ea154708879025e6ef3fc7e0`。history 与 ffprobe 均确认 1920×1088、H.264、24 fps、96 帧、4.000 秒，AAC 音频 32 kHz。完整 AV checkpoint：`local/runs/sol_retry_b0/runtime/output/.acceleration_lab/B0_AV.pt`。这些文件均为本机私有结果，未提交仓库。

## B1：唯一一次提交及停止证据

任务 `44f89a2a-1272-40a2-a23c-6cf900b5ef55`，history `execution_start=1791607132187`、`execution_error=1791607132545`，**0.358 秒到错误**；这是入口错误耗时，不是 Sol 采样速度。错误节点 `6 BlockSparseAttention`。本地 API 的节点 6 明确含 `selection={"selection":"sol-attn","tau":1.0}`，原生定义 `comfy_extras/nodes_sparse_attention.py:368-373` 要求 DynamicCombo，`414-416` 的 `execute` 要求位置参数 `selection`。然而 history `current_inputs` 只有 `model/start_percent/end_percent/dense_blocks/min_tokens/extra_tokens/sink_conditioning/verbose`，无 `selection`，随即抛 `TypeError`。确切丢失点尚未从现有证据定位，不能称为 Sol 内核失败。静态 `validate_workflows.py` 对 DynamicCombo 的检查放过了这个请求，预检覆盖不足；本轮未改请求或验证器后重试。

没有条件编码、H3 前向、AV checkpoint、视频、稀疏调用或 GPU kernel 观测，因此 Sol 的实际 layout、保护行范围、dense fallback、速度和画质均为 **UNKNOWN**。B1 原始 history、请求及 stderr 分别位于 `local/runs/sol_retry_b1/history.json`、`local/workflows/Lab_B1_SolAttn_Clip1.api.json` 和 `local/runs/sol_retry_b1/lab_stderr.log`。完整 traceback（history 原文）如下：

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
TypeError: BlockSparseAttention.execute() missing 1 required positional argument: 'selection'
```

本轮 `start_lab.ps1` 只新增命名运行目录参数，以隔离两次启动的 output/temp/user、stdout/stderr/history/checkpoint；原默认行为保留。小型脱敏汇总见 `evidence/sol_attn_retry.json`，其中含原始本地记录哈希。原报告 `01_SOL_ATTN.md`、`02_VAE_INT8.md` 及旧 evidence 均未改。
