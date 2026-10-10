# Self-Lift 注意力后端零生成审计报告

## 直接结论

- **本轮新增生成次数：0。** 只读核对报告 40 的真实 request、history、stdout/stderr、本机虚拟环境源码/安装元数据和当前只读节点菜单；未调用 `/prompt`、未运行 H3 或注意力前向/微基准、未重启后端、未修改工作流或依赖。审计分支提交 `60c483a3e9a665eb35d174e9676fe5509f50906e`，包含 `60c483a`；不合并 main。
- **请求证据：** 报告 40 实际 MODEL 链是 `UNET 333 → LoRA 332 → PathchSageAttentionKJ 312 (auto, allow_compile=false) → MiniMaxLowVRAMAttention 220 (head_chunks=4) → MiniMaxChunkFeedForward 219 (2/4096) → Config 304 → Advanced 9600328`。二采 `930010` 未另接 `high_res_model`。这与原附件保存的 Kitchen 选择是**不同的后端配置**，原附件也使用另一套保存的 UNET/LoRA 值，不可当作同权重 A/B。
- **本机源码推导：** KJ `auto` 导入 `sageattention.sageattn`；本机 `sageattention/__init__.py` 将它从 `core.py` 导出。本机 RTX 3090 / sm86 对应的 auto **候选叶函数**为 `sageattn_qk_int8_pv_fp16_cuda`、`pv_accum_dtype="fp32"`，而文档 41 所列固定参考源码的 sm86 分支为 Triton 叶函数。这是本机**当前安装源码**与固定参考源码的差异，不是历史任务的内核调用证明。该 CUDA attention 叶函数在默认 `qk_quant_gran="per_thread"` 时仍调用 `per_thread_int8_triton` 做量化；不能把函数名理解为每一步都不用 Triton。
- **历史运行直接观测：** stderr L240 仅记录 `Using sage attention mode: auto`，L253/L272 记录 `208 patches attached`，L279 记录 5+1 完成，history 记录成功。现有日志**没有** Sage 叶函数、Kitchen attention 内核、四组 head 调用或逐次回退的直接记录，均为 `NOT_OBSERVED`。208 是总补丁数，不是调用次数。报告 40 的约 0.49% 采样差异不能据此归因于后端。
- **原附件 Kitchen 候选：** `docs/41` 所记原附件 node 148 保存 `comfy kitchen attention`、mode=0；当前只读 `/object_info/ModelAttentionBackend` 菜单包含该选项，说明**当前服务**已提供这个注册选择。实际若执行，节点源码会查找 `comfy_kitchen_int8`，找到则通过 `set_model_optimized_attention` 写模型 override，找不到则发 warning 并设 PyTorch。当前菜单不证明原附件曾提交、历史任务曾使用 Kitchen，或所有输入形状均可运行。原附件文件本轮未在工作区找到，保存字段采用文档 41 的记录（其给出的 SHA-256 为 `709a0c227765999bbe38a29fc1df21f01dca0c5accd6777a17266fefc190f842`），没有重新校验该原件。
- **建议的唯一后续步骤：** 若仍需定位速度瓶颈，先另行设计一次固定请求的采样内部算子归属采集；在此审计证据下不切换后端，也不承诺 Kitchen 会提速。本轮不执行后续步骤。

## 固定文件与环境

真实文件均位于 `G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag`。`selflift_lowvram_attention_clip1_request.json` SHA-256 为 `36edcdc2b61bfd6d96d0fe415ebd7630b663b7a017e82563a3b211e309691ebf`，与文档 41 预期一致；`selflift_lowvram_attention_clip1_history.json` 唯一任务 ID 为 `13cb6203-424c-43ec-bc39-bb3bfb50eb3b`，状态 `success/completed`，原始 `execution_start=1791592213681`、`execution_success=1791593018028`。本轮读取的 stdout/stderr 分别为 `selflift_lowvram_clip1_comfy_stdout.log` 与 `selflift_lowvram_clip1_comfy_stderr.log`；由于后台输出缓冲在报告 40 编写后仍有写入，本轮文件哈希分别记录于脱敏 JSON，行号以本轮实际文件为准。没有读取其他任务替代。

当前 ComfyUI `.venv\python.exe` 的 `importlib.metadata`（未导入 Sage/Kitchen/ComfyUI 包）给出 Python 3.12.13、PyTorch `2.11.0+cu128`、SageAttention `2.2.0+cu130torch2.10.0andhigher.post5`、Comfy Kitchen `0.2.37`、`triton-windows 3.7.1.post27`。ComfyUI Git HEAD `b26625f23a888367b92153b28d93e159e83e677b`，KJNodes HEAD `3f20054214fec9f9234fd3841ae6f1e4287948f6`；历史 stderr L39/L50–53 直接记录 PyTorch 2.11、Python 3.12、ComfyUI 0.39.0、Kitchen 0.2.37，L41 记录 RTX 3090。当前只读 `nvidia-smi` 为 RTX 3090、计算能力 8.6。**历史日志未记录 SageAttention 的 wheel 版本或源码哈希**，因此本机安装源码推导须附“历史进程安装内容相同”这一前提。

主要本机文件 SHA-256：KJ `nodes/model_optimization_nodes.py` `5317c12100a1701425a07b00bd9af6277d45101a37d82d0a3a9d75945011e51e`，`nodes/minimax_nodes.py` `c371576b1bb31a2f518bdb4ceda43cb10b20338f0c9d68f99ed1be76ce06478f`；Comfy `comfy/ldm/modules/attention.py` `0daaf02f21578bbb4d913002a4a2c1a7610c3a585d7ebfe8d2a9025822c054f0`、`comfy_extras/nodes_model_advanced.py` `8308f07f95938c2156136553ffd1e81b13e71aa6955c71f48c64404bdf91fe1c`；已安装 Sage `sageattention/__init__.py` `9b178247cd22cc2c00114f445ee711c229745193ecda98d397a051e6f889326a`、`core.py` `630ff7f7566ccc8da2c765f5276f6ac1c82534a7bb204d3c0d8f9652af6de598`；Kitchen `comfy_kitchen/sage_attention.py` `565bab9b3ab7ce81a06f761812f7a775a465cebf20fecf15c9fd39590b6338b8`。全部文件的相对路径与哈希见随附 JSON。

## 当前请求的分派链：请求设置与源码推导

| 层 | 本机函数/条件与证据行 | 证据等级 |
|---|---|---|
| 模型输入 | request 的节点链接如上；333 实际选中 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`、332 为 `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`；不含独立高清模型。仅记录文件名，不附提示词/资产路径。 | `request` |
| Sage 设置 | KJ `get_sage_func` L28–33：`auto` 导入 `sageattention.sageattn`；L57–60 的 `torch.compiler.disable()` 由 `allow_compile=false` 触发，**不等于关闭 Sage**；`PathchSageAttentionKJ.patch` L123–135 克隆并写 `transformer_options.optimized_attention_override`。 | `source_inference`；历史 stderr L240 仅直接观测 auto 字样 |
| LowVRAM / FFN | KJ `MiniMaxLowVRAMAttention.execute` L173–203 克隆、设置 `minimax_head_chunks=4` 与 `sol_take_forward`，并挂 block/attention forward；已有 attention forward 会被保留。`minimax_attn_lowmem_forward` L89–138 按 `min(self.heads, head_chunks)` 分组调用 Comfy `optimized_attention`，`mask=None`、`skip_reshape=True`。FFN L69–85 独立挂 `blocks.*.mlp.forward`；没有写掉 Sage override。 | `source_inference`；208 补丁总数是有限的 `runtime_observed` |
| 模型选项传递 | TerryDirector `ComfyBackend.sample` `director_selflift.py` L73–78 将 `model.model_options` 原样交给 `samplers.sample`；L174 在缺独立高清模型时复用 model，L216–217/L275–277 两阶段使用该链。`mask_model` L83–107 在需遮罩时克隆并添采样 wrapper；Comfy `ModelPatcher.clone` L431–455 复制 object patches、深拷 model options。H3 `model.py` L755–770 把 transformer options 传入每个 block。 | `source_inference` |
| 优先级 | Comfy `attention.py:wrap_attn` L206–244：正常外层调用先看 `transformer_options.optimized_attention_override`，然后 `preferred_attention`，最后原函数。H3 原 `Attention.forward` L174–200 将 checkpoint 的 `self.comfy_attention` 作为 preferred 传入；本次 LowVRAM forward 改为直接调用 `optimized_attention`，未传 preferred。启动日志 L44 `Using sage attention` 只表示全局默认，不能盖过本请求 MODEL override。 | `source_inference`；全局日志为 `runtime_observed`，不代表叶函数 |
| Sage auto 设备分派 | 已安装 `sageattention/__init__.py` L1 导出 `core.sageattn`；`core.py` L62–71 通过设备能力建 `_cuda_archs`，L157–161 对 `sm80/sm86/sm87` 调 `sageattn_qk_int8_pv_fp16_cuda(..., pv_accum_dtype="fp32")`。本机设备是 sm86。 | 当前源码 `source_inference`；设备型号/能力为 `runtime_observed`；历史 Sage 安装哈希未知 |
| 叶函数输入与数值默认 | KJ L61–90：若 `low_precision_attention` 明确为 false 则走 PyTorch；否则 FP32 q/k/v 转 FP16；`skip_reshape=True` 用 HND，`is_causal=False`。本次 LowVRAM 调用传 `mask=None`。Sage `core.py` L436–448 默认 `qk_quant_gran="per_thread"`、`smooth_k=true`、`smooth_v=false`、FP32 PV 累加；L527–545 要求 CUDA 且 q/k/v 同为 FP16/BF16、末维连续并按 head_dim 补齐，L577–590 默认 per-thread Triton 量化后调用 `_qattn_sm80` CUDA attention。 | `source_inference`；历史实际 q/k/v dtype、head_dim、stride **UNKNOWN** |
| `kwargs` 丢失 | KJ L89 把 `attn_mask=mask` 传给 `sageattn`；本机 `core.sageattn` L93–101 接收 `**kwargs`，但 L157–178 所有设备分派调用均未传 `**kwargs`，sm86 叶函数亦无 `attn_mask` 显式参数。故本机 auto 路径不能凭上层调用宣称 mask 或外加 `smooth_k` 已生效；本次 LowVRAM 的 mask 本身为 `None`。Comfy 原生 `attention_sage` L707–746 是**另一函数**，有 PyTorch 异常回退且发送 `smooth_k=false`，不能把它的行为套到 KJ 包装；该参数在此安装版 auto dispatcher 也不会被转交。 | `source_inference`；历史张量/逐次回退 **NOT_OBSERVED** |

## 原附件 Kitchen 候选路径与边界

原附件保存链据 `docs/41` L16–21 为 `127 UNET → 148 ModelAttentionBackend (comfy kitchen attention) → 145 LoRA → 220 LowVRAMAttention(4) → 219 FFN(2/4096) → 153 Preview → 244 SelfLift`。其 UNET 实际保存字段是 `minimax_h3_fl2va_bf16.safetensors`，不是 `properties.models` 中的下载元数据；LoRA 也为 fl2v 版本。本轮未对该附件运行，也未更换当前已认可的 ref2va 模型与 LoRA。

在**本机当前源码**且附件按保存链实际执行的前提下：

1. `ModelAttentionBackend.define_schema` `nodes_model_advanced.py` L374–395 仅在 `COMFY_KITCHEN_INT8_ATTENTION_IS_AVAILABLE` 时列 Kitchen；当前 `/object_info` 确有该项。`execute` L402–413 将标签映射为 `comfy_kitchen_int8`，查不到函数则 warning + PyTorch，查到则克隆并调用 `set_model_optimized_attention`。`model_patcher.py` L689–695 写同一个 `optimized_attention_override` 键。附件该节点在 LoRA/LowVRAM **之前**；后续克隆会保留它。当前请求中 Sage 节点在 LoRA 后写入这个键，因此两份配置的 MODEL override 候选不同；若未来串接多个写该键的节点，按实际链序由后写者决定。
2. `attention.py` L55/L944–949 在可用时注册 `attention_comfy_kitchen_int8`；L645–660 常规路径传入 `comfy_kitchen.int8_attention`，L663–686 容器路径走 `prequantize_int8_attention → int8_attention_from_prequantized`。`comfy_kitchen/__init__.py` L27–31 导出这套 API；已安装 `sage_attention.py` L135–148 要求 CUDA、能力至少 7.5 且 CUDA 扩展 `_EXT_AVAILABLE`。当前 sm86 满足能力门槛，当前菜单证明服务注册了这个选项。历史 stderr L33 的通用 Kitchen cuda 后端 `available=True, disabled=True` 与当前注意力菜单并列存在；不能单凭通用后端的 disabled 标志判定该独立 attention 函数历史不可用，也不能把 L36 的 `eager` 字样解释成注意力在 CPU 上运行。
3. Kitchen 包 `sage_attention.py` L151–205 还要求同设备、合法 dtype、4D 形状、head_dim 1–256、末维连续、head 数可整除及 mask 可广播；L208–317 的 CUDA 路径按 head_dim 选 64/128/256 宽度，经 `sage_sdpa` 执行。Comfy wrapper L645–650 仅在 `low_precision_attention=false` 且 q 为 FP32 时明确退回 PyTorch；节点选择时函数未注册也会退回。其他不支持的形状/环境可抛错，**不能假设静默回退**。历史逐次 dtype、head_dim、mask、扩展可用状态和 Kitchen 调用均无证据。首次 OOM 中 Kitchen 的 `int8_linear → torch._int_mm` 是 MLP 线性路径，不能作为 Kitchen attention 使用证据。

## 历史日志的可观测范围与缺口

- `stderr` L39–44 给出环境与全局 `Using sage attention`；L235–240 给出模型类型及 `Using sage attention mode: auto`；L251–253、L268–279 给出 Self-Lift 尺寸、模型装载、208 补丁与 5+1 成功。`stdout` L53 某插件自身的“SageAttention ✅ / Triton ✅”只是其启动能力检查，不是本任务 kernel 调用。stdout L24–25、stderr L70–145 的异常属于其他插件导入；history 对应任务无生成异常。
- 检索这两份原日志未发现 Sage 叶函数名、`comfy_kitchen.int8_attention` 的调用证据或注意力回退记录。**没有回退 warning 不等于没有回退**；没有 kernel 日志也不等于未使用加速。
- 最大缺口是历史 PID 32720 所加载的 Sage wheel 版本/哈希、逐次 q/k/v dtype/head_dim/stride、effective transformer options、head 分组和实际内核名。此报告只确认“本机当前源码在已知设备条件下的候选分派”，不能将它改写成历史逐次执行轨迹。未做画质或声音的新增判断。

脱敏机器可核验汇总：`docs/evidence/selflift_attention_backend_audit.json`，按 `request`、`source_inference`、`runtime_observed` 等等级给出相对文件路径、行号、短摘录、源码哈希与未知项；不含完整提示词、资产绝对路径或第三方源码。
