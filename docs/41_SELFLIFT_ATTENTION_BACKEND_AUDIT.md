# Self-Lift 注意力后端核对 · 零生成

> 分支：`feat/selflift-internal`；编写基线：`100ccc6d405fd1226c7f52121e60af2b271b36d0`。  
> 状态：待本地 Codex 执行。仅读取现有请求、日志、安装元数据与源码，**本轮新增生成次数必须为 0**。不修改运行代码、工作流或环境，不合并 main。

## 1. 目标与已知结果

[40 报告](40_SELFLIFT_LOWVRAM_ATTENTION_CLIP1_REPORT.md) 已确认：加入 `MiniMaxLowVRAMAttention(head_chunks=4)` 后，第一段低清/高清合计 588.783 秒，对照 591.697 秒，仅差约 0.49%，不足以确认提速。不要再扫描 head_chunks 或追加三段。

这次要回答：**报告 40 的 Sage `auto` 经哪些覆盖/分派层到达哪个候选实现？与原附件的 Kitchen 选择有何实际差异？现有日志能否证明历史任务真正调用了该实现？** 区分“请求设置”“本机源码推导”“历史运行直接观测”，不能混写。

## 2. 已核对的参考事实（不是本机实测结论）

### 原始附件

用户最初提供的 `Unsaved Workflow (2)(1).json`，SHA-256：
`709a0c227765999bbe38a29fc1df21f01dca0c5accd6777a17266fefc190f842`。

- `148 / ModelAttentionBackend` 保存值是 `comfy kitchen attention`，mode=0；模型链为 `127 UNET → 148 Backend → 145 LoRA → 220 LowVRAMAttention(4) → 219 FFN(2/4096) → 153 Preview → 244 SelfLift`。这是保存的连线，不是逐次 kernel 执行证据。
- 报告 40 的实际请求则保留 `PathchSageAttentionKJ(auto, allow_compile=false)`，再接 LowVRAM 与 FFN。不能把这两份配置说成完整后端等价。
- 附件 UNET 的**实际保存字段** `widgets_values_named.unet_name` 为 `minimax_h3_fl2va_bf16.safetensors`，但 `properties.models` 中还有 ref2va INT8 下载元数据；实际 LoRA 保存字段也为 fl2v 版本。不能拿下载元数据当作实际选中的权重，更不能因此自动替换当前导演工作流已认可的模型/LoRA。
- 本轮不需要运行或安装外部 SelfLift 插件，也不引入附件中的预览、清理、提示词增强、DLSSNR 或补帧。

### 固定源码核对结果

以下只提供核对入口；本机文件内容及哈希优先，不要求升级到这些版本。

| 来源 | 源码支持的事实 |
|---|---|
| KJNodes `3f20054214fec9f9234fd3841ae6f1e4287948f6`，`nodes/model_optimization_nodes.py`，blob `90d8d41210825a6cc355f4467e4d247f13e55f94` | `get_sage_func("auto")` 调用 `sageattention.sageattn`；`PathchSageAttentionKJ.patch` 写入 `transformer_options.optimized_attention_override`；`allow_compile=false` 包装为禁用编译，并非关闭 Sage。 |
| ComfyUI `v0.39.0`，`comfy/ldm/modules/attention.py`，blob `c54415368e33561987180c1c53afefa585b954e3` | `wrap_attn` 在正常外层调用中优先处理 `optimized_attention_override`，之后才检查 `preferred_attention` 或调用包装的函数；启动日志的全局后端名称不能单独证明 MODEL 的最终后端。 |
| ComfyUI `v0.39.0`，`comfy_extras/nodes_model_advanced.py`，blob `c1917d3d960267bc516b18ff0fc5b18f1b468463` | Kitchen 标签映射到注册名 `comfy_kitchen_int8`；找不到函数时记录 warning 并选 PyTorch，再通过 `set_model_optimized_attention` 设置模型。选择标签不等于保证 Kitchen 实际可用。 |
| SageAttention `d1a57a546c3d395b1ffcbeecc66d81db76f3b4b5`，`sageattention/core.py`，blob `96da4c02a3c40ba3802191de51f3e45638d64646` | 这个版本的 `sageattn` 在 `arch == "sm86"` 分支选择 `sageattn_qk_int8_pv_fp16_triton`；这不是对本机 Windows wheel 的认定，必须读取实际安装源码和设备信息。 |

ComfyUI 的原生 `attention_sage` 与 KJ 包装不是同一个函数。例如上述原生版本存在异常退回 PyTorch 的逻辑，并传入 `smooth_k=False`；KJ 的 auto 包装传参不同。**还要继续检查本机 Sage dispatcher 是否将 kwargs 传到叶函数，不能假定上层参数一定生效。**

另外，首次 OOM 栈的 `comfy_kitchen...int8_linear → torch._int_mm` 属于 MLP 线性计算，不能拿它证明用了 Kitchen **attention**，也不能仅凭路径出现 `eager` 认定注意力退回了 CPU。

## 3. 本地执行范围

保留未提交改动，只快进拉取本分支。沿用现有后端，**不重启、不设置 trace、不调用 /prompt、/free、interrupt 或队列写操作**。不启动 H3、不加载权重、不创建 CUDA 张量、不运行 attention/MLP forward 或微基准；不为本次文档核对再执行 GPU 预检。只允许读取源码、文件、安装元数据以及现有服务的只读信息。

### A. 固定证据来源与环境

读取报告 40 的真实文件，而不是画布截图或原示例代替：

```text
G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_lowvram_attention_clip1_request.json
G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_lowvram_attention_clip1_history.json
G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_lowvram_clip1_comfy_stderr.log
G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_lowvram_clip1_comfy_stdout.log
```

任务 ID `13cb6203-424c-43ec-bc39-bb3bfb50eb3b`；request SHA-256 `36edcdc2b61bfd6d96d0fe415ebd7630b663b7a017e82563a3b211e309691ebf`。先核对哈希与 history 内任务 ID，再引用日志行号；文件缺失记 MISSING，不改用不相关任务。

用原 ComfyUI `.venv\python.exe` 的 `importlib.metadata` 读取 Python / torch / sageattention / comfy-kitchen / Triton 的安装版本和文件位置；读 ComfyUI、KJNodes git HEAD 与相关文件 SHA-256。不要为了 inspect 而导入整个 ComfyUI、Sage 或 Kitchen 包。可通过现有 `/system_stats` 或只读 `nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader` 核对设备；查询不支持就标 UNKNOWN，不安装工具或分配 GPU 张量。

源码必须来自该虚拟环境实际包路径，先读 `sageattention/__init__.py` 追踪 `sageattn` 的真实导出，不默认它一定来自 core.py。检查当前版本/哈希是否与历史任务一致；无历史版本证据时明确“当前安装源码推导”，不得冒称对旧进程的直接观测。

### B. 沿实际模型链追踪分派

1. 从真实请求的 `TerryDirectorAdvanced → director_config → model` 反查上游。记录实际 UNET、LoRA、Sage、LowVRAM、FFN 的输入和顺序、二采独立高清模型是否连接；不能只凭存在节点判断生效。不导出提示词或资产绝对路径。
2. 读取本机 `PathchSageAttentionKJ.patch/get_sage_func`、`MiniMaxLowVRAMAttention.execute/minimax_attn_lowmem_forward` 和 FFN 实现。列出各节点写哪些 `model_options/object_patches`，有没有覆盖此前选项；不要通过加载真模型来核对。
3. 读取本机 `comfy/model_patcher.py:set_model_optimized_attention`、`attention.py:wrap_attn` 和 H3 实际 forward 路径，确认全局默认、MODEL override、checkpoint preferred attention 的优先级。若本机与上方固定源码不同，以本机为准。多个节点写同一键时必须按真实链路顺序判断，不能笼统认为 Sage 永远压过 Kitchen。
4. 从本机 Sage 导出一路追到 auto selector 和叶函数。写出设备条件、函数名、量化/累加默认值与关键输入条件；核对 `attn_mask`、`low_precision_attention`、dtype、head_dim、布局及 `smooth_k` 的传递/丢弃。缺少历史张量/参数证据的条件标 UNKNOWN，不补成自己期望的值。
5. 读取本机 `ModelAttentionBackend` 和 Kitchen 包中的 `int8_attention` 注册、可用性判断、设备分派/回退。可 GET 现有 `/object_info/ModelAttentionBackend` 看菜单，但“菜单有 Kitchen”最多证明当前节点提供该选项，不能当成该任务的 kernel 调用或所有 dtype/shape 均支持的证据。
6. 核对 TerryDirector 自有 `ComfyBackend.sample` 及两阶段调用是否原样传递模型选项，记录源码依据；不因缺运行钩子自动改生命周期或装卸策略。

最终给出两条链：**当前请求可由本机源码推导的路径**与**原附件选择在本机环境下的候选路径**。均须列出前提、条件分支和仍未知的输入；后者不写成原作者实际执行结果。

### C. 只在既有日志中查运行证据

检索并保留带行号的短片段：全局 `Using ... attention`、KJ `Using sage attention mode: auto`、模块/版本、缺内核/回退 warning、异常，以及已有 profiler/调用记录。不存在就记 NOT_OBSERVED；**没有回退 warning 不等于证明全程无回退，没有 kernel 名日志不等于未启用加速。**

将三种证据分别标记：`request`（配置）、`source_inference`（分派推导）、`runtime_observed`（实际调用证据）。日志只打印 auto 而未给具体叶函数时，后者仍为 NOT_OBSERVED。208 patches 也不等于四组 head 或某个后端的调用计数。

## 4. 交付与停止条件

只提交：

```text
docs/42_SELFLIFT_ATTENTION_BACKEND_AUDIT_REPORT.md
docs/evidence/selflift_attention_backend_audit.json
```

报告开头直接回答：

- 本轮新增生成次数（必须 0）。
- 当前请求选什么；本机源码在已知设备条件下会选什么；历史 runtime 是否直接观测到。
- 原 Kitchen 选择在本机有无可用性证据，哪些回退条件尚不能排除。
- 两条路径是否有已证实差异；是否值得安排下一次**单变量**验证，还是应先定位采样内部算子。最多提出一个下一步，不自动执行。

证据 JSON 至少含 `generation_submitted=false`、`submission_count=0`、`source_prompt_id`、request 哈希、环境/源码版本及文件哈希、MODEL 链、每条结论的证据等级/相对文件路径/行号、候选分派与未知项。不得仅提交本机绝对路径，也不要提交整份第三方源码、完整提示词或权重；保留短源码/日志摘录以供远端核验，并脱敏本地路径。

**无法确定某层时仍交付已查到的证据和缺口，不为填满报告额外生成。** 找到后端差异也不是已证明瓶颈或提速：不把 Sage 改成 Kitchen、不改启动参数/量化/模型/LoRA、不升级依赖、不进行性能承诺。原 34/38/40 报告及证据保持不变，生成质量与声音结论不扩写。

## 参考定位

- 原附件：上述 SHA-256 的用户工作流；节点 148、127、145、220、219、244。
- KJNodes 固定代码：`kijai/ComfyUI-KJNodes@3f20054214fec9f9234fd3841ae6f1e4287948f6`。
- ComfyUI 固定代码：`Comfy-Org/ComfyUI@v0.39.0`，文件和 blob 见第 2 节。
- SageAttention 对照：`thu-ml/SageAttention@d1a57a546c3d395b1ffcbeecc66d81db76f3b4b5/sageattention/core.py`。不是本机安装版本的替代。

本次远端交付只新增本任务文档；未在用户 Windows 主机执行审计，没有新的生成、kernel 观测或性能结果。
