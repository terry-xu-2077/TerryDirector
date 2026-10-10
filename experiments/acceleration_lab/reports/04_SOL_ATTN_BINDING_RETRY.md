# Sol-Attn B1 绑定修正续测

## 判定

| 维度 | 结果 |
|---|---|
| 绑定与隔离 | **通过。** 本机真实 ComfyUI V3 将新 B1 API 整理为 `selection={"selection":"sol-attn","tau":1.0}`，旧嵌套格式反例被拒绝。34/34 实验测试、运行前隔离检查、新实例 schema/连线校验通过。 |
| 本次运行 | **失败并停止。** 唯一一次 B1 在首个低清前向中遇到 `minimax_block_lowmem_forward() got an unexpected keyword argument 'attention'`；低清 callback 0，`ck.sol_attn_chunked` 0，未进入高清、解码或保存。未重试。 |
| 速度 | **不可比较。** 失败前的 2.084 秒是前向异常耗时，不是完成的低清采样；不能与报告03 B0 的 357.292 秒作 Sol 提速对照。 |
| 输出与画质 | B1 无 AV checkpoint、无视频，音画规格及画质无法验收。报告03 B0 的 1920×1088 / 24fps / 96帧 / 4秒视频仍在本机，尚未连续实际看听，待人工确认。 |

只补交 B1 **1** 次；本轮 B0 **0**、VAE/Veda **0**。没有修改现有导演节点、生产根注册、冻结 Self-Lift 源码、生成参数或正式工作流；没有升级依赖、重启8188或合并 main。原报告和旧失败图/日志保留。

## 起点与零生成检查

拉取 `feat/selflift-internal` 后确认包含 `39e64abc0038c8a1856df88b2953a744d0df16ed`。生产冻结基线仍为 `0c82cd7bfb2de963304479eda86e02513e106da0`。ComfyUI 为 `b26625f23a888367b92153b28d93e159e83e677b`；KJNodes 为 `3f20054214fec9f9234fd3841ae6f1e4287948f6`，与报告03一致。实验计时 helper `lab_nodes.py` SHA-256 `80741db4a0609faf19d6ac0eeba85781d19aeac45048344cff550dc87df337da` 未变。实验测试 34/34 通过；运行前隔离检查 `forbidden_changed_paths=[]`。

修正版构建器从报告46真实请求（SHA-256 `fa15bd5cc127969374d565f2caad664dd9bdc0c41e800c5f59521544328e5a64`）在新目录 `local/workflows/sol_binding_fix/` 构建，未覆盖 `local/workflows/` 的旧图。新 B0 API SHA-256 `d867be9289b4f91e4d61feb6b9ee4e3172a61370fcbad9a35dd7c5912083e864`，与报告03成功 B0 **完全一致**。新 B1 API SHA-256 `64cfdf3584e74272d9efc504eb25995d230576a9d672186577c79b78f31eaccc`，UI SHA-256 `243cbdf85289a7e1dfbf87be3ac460bc9c6842f85420d9c5ec50ec36850bde8b`。与旧 B1 API 比较，只有节点6不同：旧 `selection={"selection":"sol-attn","tau":1.0}` 改为 `selection="sol-attn"` 和 `selection.tau=1.0`；其他节点及参数未变。最终编译提示词哈希 `353ee9913b2d40fc272e498e2f330d9bf689b59a371a1b6d71c15b0aaa57e1f7`，七项资产哈希及所有原参数见 `evidence/sol_attn.json`。当前 INT8 视频 VAE 仍为 **ALREADY_ACTIVE**。

在原 `.venv` 中运行 `preflight_sparse_binding.py`，直接使用本机 `create_input_dict_v1 / get_finalized_class_inputs / build_nested_inputs` 和节点 `execute` 签名绑定；得到 `normalized_selection={"selection":"sol-attn","tau":1.0}`，动态路径为 `selection -> selection.selection`、`selection.tau -> selection.tau`。同一路径上的旧嵌套格式反例得到 `missing a required argument: 'selection'`。该检查没有调用节点、解析 MODEL 或加载权重，生成提交数为0。原始结果在 `local/workflows/sol_binding_fix/B1_binding_preflight.json`，SHA-256 `b457e3f60192ef77883efb03ad7ba23fcee795f0c4c2fd0df0a55c8bf04cf608`；实际解析器 `_io.py` SHA-256 `a16cea6dd228468b5fbe3fa2acb5dd86bf9445babcd9d8bfe697b84c449bf5fb`。

新8190实验实例的 B1 `/object_info` 注册、API/UI schema 和连线检查零错误；同一验证器对旧 B1 图返回退出码2，并明确指出嵌套 DynamicCombo 错误。正式8188队列运行/待处理均为0。未在前端实际打开/另存 UI 工作流，UI 运行状态保留未验证。旧导演诊断开关保持关闭。实验实例使用新的 `local/runs/sol_binding_b1/` 输出、日志和 user/temp 目录，现已停止。

## 唯一 B1 任务与阶段证据

Prompt ID `0e5ff5fa-275d-4dd7-8a38-494a418ce2b3`。原始 history：`execution_start=1791611104415`、`execution_error=1791611217041`（Unix 毫秒），差值 **112.626 秒**，不含排队/轮询。history 错误节点22 `TerryAccelLabSelfLift`；节点6 `BlockSparseAttention` 已执行，说明报告03的 `selection` 绑定失败点已越过。运行输入仍为原 4 秒、1920×1088、24fps/96输出帧/H3 107帧、原提示词和七项资产、Seed1000、Kitchen 密集后端、LowVRAM(4)、FFN(2/4096)、Sol tau1.0/percent .05–1/dense_blocks 0,1,48,49/min_tokens12288/extra_tokens256/exact_kv_and_rows，以及原 Self-Lift 参数。

| 阶段/计数 | B1 本次 | 报告03 B0 | 可比性 |
|---|---:|---:|---|
| 条件/参考编码 | 108.026 秒 | 112.070 秒 | 同任务参数的独立运行；含加载/环境差异 |
| 低清阶段 | 2.084 秒至异常；**0 callback** | 357.292 秒；5 callback | **不可比** |
| 高清阶段 | 未进入 | 201.420 秒；1 callback | **不可比** |
| Self-Lift 整体 | 2.118 秒至异常 | 561.832 秒，含两阶段和放大 | **不可比，不与子阶段相加** |
| 视频解码/编码 | 未进入 | 123.411 / 3.352 秒 | **不可比** |
| 执行总时长 | 112.626 秒至异常 | 804.685 秒至成功 | **不可比** |
| 实际 `ck.sol_attn_chunked` | **0 次** | 0 次（密集基线） | B1 没有运行到稀疏 producer |

本次低清 Sigma `[1,.983683884,.960057557,.923076928,.857509673,.706380010]`，完整日程尾为0；B1 稀疏窗口阈值记录为 `sigma_sparse_start=.9956331877729258`、end=0。按计划首步 `sigma=1` 本应密集，后续才应稀疏；本次在首步完成前报错，无法观测预期稀疏分支、保护 layout 或有意密集回退。阶段 helper 的 CUDA 同步/峰值重置与报告03相同；诊断开销未单独量化。低清 `peak_cuda_allocated_bytes=2526192704` 是异常前阶段记录，不代表完整采样峰值。

## 停止原因与证据边界

history 的完整 traceback 保留在 `local/runs/sol_binding_b1/history.json`，SHA-256 `282c90227915787a0c72435e0344fe4bcc310d3c49205ce48674c2d7c2bead9c`；stderr 在同目录 `lab_stderr.log`，SHA-256 `2b8e5ba9506d524bed389513177786e5ca96bb6189559b0282fe8a055040f0b1`；阶段原文在 `runtime/output/.acceleration_lab/stages.jsonl`，SHA-256 `b3b57b7f40c24d6398927cab016f99ef9d63f4ab9c9b2e85afd49c2ac977cb39`。新 B1 请求在 `local/workflows/sol_binding_fix/Lab_B1_SolAttn_Clip1.api.json`。这些完整私人记录均留本机，仓库只提交脱敏汇总。

报错栈从实验 `lab_nodes.py:159` 进入冻结 `director_selflift.py:216`，再进入 ComfyUI `model.py:765` 的 block patch，经过 `nodes_sparse_attention.py:318` 调原 block，最终在 `torch.nn.Module` 调用时报：

```text
TypeError: minimax_block_lowmem_forward() got an unexpected keyword argument 'attention'
```

只读源码核对：原生 `nodes_sparse_attention.py:315-318` 在 eligible block 的参数中加入 `attention`，并调用 `original_block`；ComfyUI `comfy/ldm/minimax/model.py:761-764` 将该值作为 `attention=` 传给 block。现有 KJNodes `nodes/minimax_nodes.py:141` 的 `minimax_block_lowmem_forward(self, x, t_emb, mod_segments, rope_freqs, transformer_options={})` 没有接收 `attention`。这与堆栈及错误文本吻合，说明当前 **Sol block patch 与 LowVRAM block forward 的接口组合不兼容**；尚无证据评价 Sol kernel 自身、GPU性能或出片质量。没有改补丁、降分辨率、调参数或重提交。

本轮无 B1 音视频文件、无 AV checkpoint；B0 原视频路径和规格见报告03。B0 的人物、动作、闪烁、曝光、声音和同步仍**待人工连续看听确认**，不能因文件存在判画质通过。新增小型汇总见 `evidence/sol_attn_binding_retry.json`；旧报告01/02/03及原 evidence 均未覆盖。
