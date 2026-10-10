# Self-Lift Kitchen 注意力对照 · 第一段一次生成

> 分支：`feat/selflift-internal`；编写基线：`c04bf786f69b96c27b55fab50fb7b195cfd3496e`。  
> 用户已同意继续。交给本地 Codex：最多提交 **1 次 / clip-1 / 原 4 秒**。唯一生成配置变量是 MODEL 的注意力后端，从 KJ Sage auto 改为原生 Kitchen。  
> 本文是待执行任务，不是提速结果；轻量后端观测器仍须本地接入验证。不要复用报告 44 的重型算子 Profiler 来测速度，不合并 main。

## 1. 对照依据

[44 算子报告](44_SELFLIFT_OPERATOR_PROFILE_CLIP1_REPORT.md) 已实际观测 Sage CUDA 叶函数、四组 heads 与 FFN 两块执行；高清所选前向中 Sage 核心 kernel 累计 123.785 秒。这支持优先筛选注意力后端，但不能推导 Kitchen 必然更快。原附件 `Unsaved Workflow (2)(1).json` 的 node 148 保存 `comfy kitchen attention`；只参考这一选择，不换成附件里的另一套 fl2va 模型/LoRA。

**速度基线使用 [40 报告](40_SELFLIFT_LOWVRAM_ATTENTION_CLIP1_REPORT.md) 的同一个单段任务，不使用 44 的 Profiler 时间或三段总时长。** 基线 Prompt：`13cb6203-424c-43ec-bc39-bb3bfb50eb3b`；精确值见 `docs/evidence/selflift_lowvram_attention_clip1_summary.json`。

| 指标 | Sage 历史基线（秒） |
|---|---:|
| 低清采样 | 371.201 |
| 高清采样 | 217.581 |
| 低清 + 高清 | 588.783 |
| Self-Lift 整体 | 591.802 |
| 条件/参考编码 | 83.633 |
| 解码/无损缓存 | 121.763 |
| 整任务 history 持续时间 | 804.347 |

合计和百分比从原 JSON 未舍入值计算。记录本轮相同指标及 `(基线-本轮)/基线×100%`，负值就是变慢，不隐藏。单次历史对照仍受设备负载、热状态、依赖版本和轻量观测开销影响；不能把微小差额定性为提速，更不能外推三段或任意时长。

## 2. 只替换测试副本的 Sage 节点

读取报告 40 的真实请求，不用其他工作流重建：

```text
G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_lowvram_attention_clip1_request.json
SHA-256: 36edcdc2b61bfd6d96d0fe415ebd7630b663b7a017e82563a3b211e309691ebf
```

位置变化可找同哈希原件；找不到记 BLOCKED，不编造提示词或资产。深拷贝后，先确认节点 312 原为 `PathchSageAttentionKJ`，输入 model 为 `["332",0]`，下游 220 引用 `["312",0]`。将该节点的有效定义替换为：

```json
"312": {
  "class_type": "ModelAttentionBackend",
  "inputs": {
    "model": ["332", 0],
    "attention": "comfy kitchen attention"
  }
}
```

此为 prompt 字典中的节点片段，不是完整 API 请求。保留 220→219→304 的原连接；同步副本的 UI metadata，清除已失效的 `sage_attention` / `allow_compile` 输入，不保留另一个后置 Sage 节点。不要通过“disabled Sage”来假定清除了已有 override。

```text
原 UNET 333 → 原 LoRA 332 → ModelAttentionBackend 312（Kitchen）
    → MiniMaxLowVRAMAttention 220（4）
    → MiniMaxChunkFeedForward 219（2 / 4096）→ 导演配置 304.model

二采配置 → 导演配置 → TerryDirector Advanced
```

MODEL 后端覆盖机制及回退入口采用 [42 本机审计](42_SELFLIFT_ATTENTION_BACKEND_AUDIT_REPORT.md) 的来源导航，实际本机源码优先。**保留原服务的 `--use-sage-attention` 全局启动参数**，只改变上述 MODEL override；否则可能连条件编码、VAE 等默认路径一起改变。全局仍打印 Sage 不代表该 MODEL 没用 Kitchen。

原 ref2va INT8 主模型、ref2v LoRA 及强度、CLIP、两种 VAE、参考图尺寸保持不变。clip-1 全部字段、`[0,96)`、24fps、globalPrompt/片段 prompt/useGlobalPrompt、七项资产及稳定编号/路径保持原样；H3 对齐帧数记录实际值，历史为 107，最终输出为 96 帧。

保留 **1920×1088、不裁剪、不缩放**，2.0MP/16:9/multiple=32；Seed=1000/fixed；CFG=1、低清5步、比例0.5；Euler/simple/基础6步/Denoise=1；Sigma精修开、extra=1/start=0.7/end=0/cosine；rho/w_min/w_max=0/0.5/1；原 latent 放大权重、无独立高清模型、`highres_tiling=false`、preview=false。不要硬改阈值凑5+2。

使用新的导演 ID/缓存标识、client ID、输出前缀；同步所有相关引用。规范化差异白名单仅允许后端节点替换及上述隔离/输出元数据。原工作流不写回、不复用旧生成缓存、不覆盖报告40/44或它们的证据。

## 3. 预检与轻量实际调用证据

记录本机代码提交、未提交改动、ComfyUI/KJNodes及 torch、Sage、Kitchen 版本与关键源码哈希，和42/44核对；有版本变化就写明，不自动升级或降级。使用实际 ComfyUI `.venv`，在仓库根目录逐条运行并检查退出码：

```powershell
python -m unittest discover -s tests -p "test*trace*.py" -v
python -m unittest discover -s tests -p "test_selflift_internal.py" -v
```

检查 `/object_info/ModelAttentionBackend` 当前包含 Kitchen；在实际后端注册表中确认 `comfy_kitchen_int8` 对应函数，以及 clone 后的最终 MODEL override、LowVRAM/FFN补丁仍保留。只有菜单或源码推导不算运行通过。函数未注册、节点选到 PyTorch或存在后置 Sage override时停止，不提交生成。

允许本地 Codex 增加**独立、默认关闭的轻量观测器及合成测试**到 `tools/`、`tests/`；确需自动接入时仅在 `director_trace.py` 加最小安装/阶段入口。禁止修改五个 Self-Lift 运行模块、公开schema、H3执行图、模型算法、第三方源码或已认可的正式工作流。不要启用 `tools/selflift_operator_profile.py`，它针对 Sage 且会运行 Profiler。

观测器只在本次目标 prompt/director/clip 的 low_sampling / high_sampling 上下文内工作：

- 每个阶段进入时，记录最终 override 的真实来源、有效 heads 设置和阶段标识。对实际被调用的 Kitchen wrapper/API/扩展调用入口计数，例如 `comfy_kitchen.int8_attention` 与本机 `sage_attention.py` 引用的 `sage_sdpa`；核对 from-import/注册表/闭包中的实际引用，不只替换一个未被使用的模块同名属性。常规与预量化入口如有不同，按实际路径记录。
- 每阶段首次调用记录 q/k/v shape、dtype、stride、device、mask存在性及函数来源，之后仅内存计数，阶段末输出一份小型汇总。区分 Kitchen API 调用数、扩展边界调用数与真正 GPU kernel 数；**不运行 Profiler，因此不能宣称采到了内核耗时或内核名**。历史的 50 blocks×4 groups 仅作核对，实际次数照实记录。
- 记录采样上下文内已覆盖的 PyTorch/Sage回退入口调用与首次来源；条件编码/VAE可能仍使用全局Sage，不能误记为本次MODEL回退。给出哪些回退路径已覆盖、哪些无法覆盖；没有warning不能代替无回退证据。
- 不额外运行任何 attention/H3求值，不改输入/kwargs/返回值，不保留tensor副本，不读取数据计算checksum，不消耗RNG，不逐调用写盘、不安装全层模块计时、不调用cuda.synchronize或CUDA Events。这是后端身份与调用计数检查，不是下一轮算子性能采集。
- 合成测试验证真实函数恰好调用一次、参数和输出对象不变、阶段/任务隔离、别名覆盖、回退计数、异常/OOM不被清理错误遮盖、退出后恢复包装。默认关闭不安装hooks或写文件。测试通过后在实际服务输出 `backend_verify_ready` 和观测对象来源；这个标记需本轮实现，当前分支仅有旧trace/op readiness。

轻量包装影响仍须写入比较限制。遇到无法覆盖的关键分派入口，先停止并提交证据，不为取得计数降级成重型Profiler或新建第二条任务。

## 4. 一次实际执行

队列空闲时沿用原启动方式，只启用阶段trace和已验证的轻量观测器。**清除重型Profiler开关后重启实际后端**，不能只在另一个shell改环境而继续用旧进程：

```powershell
$env:TERRYDIRECTOR_TRACE = "1"
Remove-Item Env:TERRYDIRECTOR_OP_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:TERRYDIRECTOR_OP_PROFILE_MODE -ErrorAction SilentlyContinue
# 启用本轮已实现并测试的轻量观测器，再执行原ComfyUI启动命令。
```

启动必须有当前分支的 `trace_ready`、`backend_verify_ready`，不能有 `op_profile_ready` 或新增算子窗口文件。先核对队列、实际PID/环境和模块路径，然后仅提交一次上述单段副本；保存真实stdout/stderr、request/响应、history和trace，不用GPU监控快照冒充服务日志。

首个低清采样回调到达时检查 Kitchen API/扩展边界已实际调用，未观测到目标MODEL的回退；未调用、出现回退或观测器失效则停止本任务，保留证据，不继续整个低清/高清才检查。不设新的短固定超时，不中断其他任务。该检查通过则继续同一请求的剩余步骤，并在高清阶段执行同样检查。

完整Sigma数组在本次现成CPU调度输入处记录一次，各阶段回调数照实记录；不用历史数组冒充本次观测，不增加采样求值。已观测的0.7阈值未触发额外步骤时，5+1符合参考逻辑，不算失败。

OOM、Kitchen输入不支持、显式/实际回退或诊断异常时停止；不降分辨率、改分组数、减资产、换dtype/权重、切回Sage或自动重试。成功也不自动扩展三段。结束后在队列空闲时关闭本轮trace/轻量观测并按原参数恢复服务。

## 5. 判定与交付

阶段汇总继续使用 `tools/summarize_selflift_trace.py --expected-segments 1`，提供本轮trace和prompt-id；原始工具的阶段完整性不代替后端观测检查。

分别报告：`generation_success`、`stage_integrity_ok`、`backend_verification_ok`、`backend_observation_scope`、`fallback_observed`、速度变化和画质状态。只有候选后端实际调用且没有已观测回退，才可把时间列为有效Kitchen候选结果；关键覆盖不足标INCONCLUSIVE，不把成功出片当作后端验证通过。

速度按第1节逐阶段给出本轮秒数、基线、差值、比例与原始trace行号；整任务以history原始start/success相减。不累加父子事件，不拿44的835.275秒或kernel累计时间作生产速度基线。不预设必需达到某个加速倍数，不为改善数字改变配置。

输出须为1920×1088/24fps/96帧/4秒并可解码，音轨可解码。以报告40原四秒视频作为对应对照，检查脸、手、细节、曝光、运动与闪烁，声音和同步单列；只抽帧不能判完整运动，未实际听看标待人工确认。后端替换不承诺逐像素一致，速度与画质分别判定。

提交到本分支：

- `docs/46_SELFLIFT_KITCHEN_ATTENTION_CLIP1_REPORT.md`。
- `docs/evidence/selflift_kitchen_attention_clip1_summary.json`：保留代码/依赖哈希、源请求哈希、白名单diff、prompt/phase标识、history起止、阶段数据与基线、Kitchen与回退观测范围/调用计数/首次输入元数据、完整性和限制；去掉绝对路径和提示词/资产内容。
- 本轮实际使用的轻量诊断源码与合成测试（如新增），默认关闭；原报告40/42/44及原证据不覆盖。大型日志、视频和模型留本机，不提交仓库。

本轮只回答“相同单段请求改用Kitchen是否值得继续”，不自动固化为默认后端，不合并main。本文交付侧只完成任务设计与仓库文档提交，没有本轮本机预检、Kitchen运行或速度结果。
