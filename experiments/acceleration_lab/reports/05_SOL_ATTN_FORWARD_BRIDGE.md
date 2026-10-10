# Sol-Attn 实验桥接续测

## 判定

| 维度 | 结果 |
|---|---|
| 预检与桥接 | 通过。实验测试 52/52，前后隔离检查通过；本机块级分支预检、真实实验节点注册、MODEL clone 与补丁绑定检查通过。新图只有一个桥接节点及一条 model 连线变更。 |
| 本次 B1 | **停止，未完成。** 唯一任务完成七图条件编码和一个低清 callback 后，运行日志显示 GPU 没有已编译的 `sol_attn` kernel；实际 `ck.sol_attn_chunked` 调用为0。随后按停止条件中断，没有继续采样或重试。 |
| 速度 | **不可判定。** B1 没有实际稀疏调用或完整低清/高清阶段。报告03独立 B0 保留作参考，不把未完成的 B1 用时与 B0 相除。 |
| 输出与画质 | B1 没有视频或 AV checkpoint，规格和画质不适用。报告03的 B0 文件为 1920×1088、24fps、96帧、4秒；**仍待人工连续看听**，本轮没有替它判画质通过。 |

本轮 B1 只提交 **1** 次，不重跑 B0，不排 VAE/Veda。未升级 KJ/ComfyUI，未修改导演代码、正式服务或参数，没有合并 main。实验 8190 服务已停止，正式 8188 服务保持运行且队列为空。

## 版本和零生成预检

拉取 `feat/selflift-internal` 后确认包含提交 `0c3225a8992074f56303b6669fee91bd3c6c6b79`。生产冻结基线为 `0c82cd7bfb2de963304479eda86e02513e106da0`。ComfyUI `b26625f23a888367b92153b28d93e159e83e677b`、KJNodes `3f20054214fec9f9234fd3841ae6f1e4287948f6`，均与报告04一致。

- 实验测试 **52/52 通过**；`check_isolation.py` 在运行前后均通过，`forbidden_changed_paths=[]`。仓库边界检查确认生产文件未改。
- `preflight_sol_block_bridge.py` 使用本机 KJ、ComfyUI 和 sparse 源码，在无模型权重的 CPU 合成实例中覆盖密集首步、稀疏低清、保护密集块和稀疏高清四种分派。旧 `attention` 参数错误可复现；桥接路径的调用次数、tensor/list分支、MLP调用、结果与 RNG 检查通过。结果明确限制为合成 CPU 分派，不代表实际 H3 数值、稀疏内核或 GPU 验收。
- 本机 `.venv` 另用原生 `DiTBlock` 类型、实际 KJ 绑定函数与轻量 MODEL 替身，调用 `TerryAccelLabSolLowVRAMBridge.execute`。节点输出是与源对象不同的 clone；只替换 `diffusion_model.blocks.{i}.forward`。两块的源补丁映射未变，clone 的 attn/MLP 补丁、Kitchen attention override 和 `minimax_head_chunks=4` 均保留。测试输出记录 `Sol/KJ block bridge installed: 2 blocks on cloned MODEL`。这一步未加载权重或执行 block 前向。
- 新8190隔离实例从实验扩展真实注册 `TerryAccelLabSolLowVRAMBridge`。新 API/UI 从 `/object_info` 校验零错误，只有一个视频保存节点；DynamicCombo 绑定预检仍得到 `{"selection":"sol-attn","tau":1.0}`，旧格式反例被拒绝。前端实际打开/导出 UI 文件未验证。

## 新 B1 副本与输入保持

`build_sol_bridge_workflow.py` 从报告04的私人 B1 API/UI 在新目录 `local/workflows/sol_forward_bridge/` 生成副本，旧图保留。构建差异记录：新增节点30 `TerryAccelLabSolLowVRAMBridge`，节点6 `BlockSparseAttention` 的 model 输入从原节点5输出改接节点30输出。其他图节点、提示词和生成参数保留。

新 API SHA-256 `b1cfd6576406102d31bc2868c605a24a9adf72edab213135398d5ac0daf911b5`，新 UI SHA-256 `df4e65a71d3a04781d436540bd4f500615c7ce06bbde696f90d3f6f88d68a0e1`。桥接源码 SHA-256 `569bf5954619982559dddb92df696cdf8bf8e0765c0e4f170ba21309d9533657`。原报告46请求 SHA-256 `fa15bd5cc127969374d565f2caad664dd9bdc0c41e800c5f59521544328e5a64`，最终编译提示词 SHA-256 `353ee9913b2d40fc272e498e2f330d9bf689b59a371a1b6d71c15b0aaa57e1f7`；七项资产哈希和其余参数详见 `evidence/sol_attn.json`。

输入保持原主模型/LoRA/CLIP/视频与音频 VAE、七资产及顺序、1920×1088、24fps/96输出帧/H3对齐107帧、Seed1000、Kitchen、LowVRAM(4)、FFN(2/4096)、Self-Lift 参数，以及 Sol tau=1、percent=.05–1、保护块0/1/48/49、min_tokens=12288、extra_tokens=256、`exact_kv_and_rows`。当前 INT8 视频 VAE 仍为 **ALREADY_ACTIVE**。桥接构建器的输入 API SHA-256 与报告04记录相同：`64cfdf3584e74272d9efc504eb25995d230576a9d672186577c79b78f31eaccc`。

## 唯一 B1 运行

任务 `f52183a0-e800-4d80-9973-519dfee26ee9`。history 记录 `execution_start=1791612475420`、`execution_interrupted=1791612714617`（Unix毫秒），运行至中断 **239.197秒**；其中 ComfyUI 执行日志约239.20秒。桥接节点在克隆 MODEL 上报告安装 **50 blocks**。

| 阶段 | 本次 B1 | 报告03 B0参考 | 结论 |
|---|---:|---:|---|
| 七图条件编码 | 102.905秒 | 112.070秒 | 独立运行；模型加载/驻留差异，不用于宣称提速 |
| 低清采样 | 133.800秒至中断，1 callback | 357.292秒，5 callbacks | B1仅一个低清步，且稀疏 kernel 不可用，不可比 |
| 其中实际 `ck.sol_attn_chunked` | **0次** | 0次（密集 B0） | B1没有测到 Sol 稀疏调用 |
| 高清采样/解码/编码 | 未开始 | 201.420 / 123.411 / 3.352秒 | 无 B1 数据 |
| Self-Lift 至中断 | 133.820秒 | 561.832秒（含低清、放大、高清） | 父阶段不与低清子阶段重复累加 |
| 执行总时长 | 239.197秒后中断 | 804.685秒成功 | 无完整任务速度比较 |

B1 Sigma 为 `[1,.983683884,.960057557,.923076928,.857509673,.706380010]`，低清预期5 callbacks；稀疏窗口 start sigma `0.9956331877729258`，end `0`。日志观察到 Sigma=1 时密集（窗口外），block0/1 按保护配置密集。随后符合窗口的 eligible 路径打印 `no compiled sol_attn kernel for this GPU` 并走密集 fallback；之后另一形状也打印同一 kernel 不可用信息。没有 `sparse producer path` 记录，也没有 `ck.sol_attn_chunked` 调用。观测仅覆盖这个低清首步里的两条密集信息与 kernel 不可用回退；其余 block 的具体 layout、保护行范围、后续 Sigma 和高清阶段均未知。

首次低清 callback 后检查到该 fallback，立即发出 ComfyUI interrupt。history 最终为 `execution_interrupted`，没有输出、视频或 AV checkpoint。实际 history、stdout、stderr、stages 和两份预检 JSON 保留于本机 `local/runs/sol_forward_b1/`、`local/runs/sol_forward_preflight/` 与新工作流目录；各自哈希见 `evidence/sol_attn_forward_bridge.json`。完整原始 history 保留停止事件；stderr 留有 ComfyUI 模型日志及 fallback 行。本仓库只提交脱敏汇总，不提交私人工作流/模型/生成文件。

## 失败证据与结论边界

运行日志包含：

```text
[TerryAccelLab] Sol/KJ block bridge installed: 50 blocks on cloned MODEL
[INFO] BlockSparseAttention: dense (45804 tokens): sigma 1 outside the start/end window
[INFO] BlockSparseAttention: dense (45804 tokens): block 0 in dense_blocks
[INFO] BlockSparseAttention: dense (45804 tokens): block 1 in dense_blocks
[INFO] BlockSparseAttention: dense (45804 tokens): no compiled sol_attn kernel for this GPU
[INFO] BlockSparseAttention: dense (1, 45804, 14, 128): no compiled sol_attn kernel for this GPU
[INFO] Processing interrupted
```

所以桥接注册、克隆、补丁绑定和稀疏回调接口已运行到实际 H3；但本机当前没有可用的 Sol kernel，未产生任何 chunked producer 调用。报告04的 KJ `attention` 参数异常已被桥接跨过，但这次不能判定 Sol 加速、速度收益、完整音画规格或 B1 画质。报告03成功 B0仍是本轮速度参考，不重跑；其画质仍待人工完整看听。没有自动植入导演。
