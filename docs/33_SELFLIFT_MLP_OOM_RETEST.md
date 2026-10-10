# Self-Lift 高清 MLP OOM · 定向检查与一次三段复测

> 分支：`feat/selflift-internal`。首次失败报告：[`32_SELFLIFT_1080P_MINIMAL_REPORT.md`](32_SELFLIFT_1080P_MINIMAL_REPORT.md)，报告提交 `193f703`，实际运行代码 `eace12b`。  
> 状态：待本地 Codex 执行。本文只授权本机读取证据、修改验收副本中的一处 MODEL 链路，以及预检通过后最多一次三段生成；不是已修复或已通过报告。

## 已定位与尚未确认

首次任务低清采样、latent lift 已完成，失败在第 1 段高清去噪：

```text
sample_selflift → backend.sample(high_model, ...)
→ comfy/ldm/minimax/model.py: DiTBlock.forward → self.mlp(h)
→ MLP.forward → self.fc1(x)
→ comfy_kitchen/backends/eager/quantization.py
→ fast_int8_mm → torch._int_mm(lhs, rhs)
```

报错申请 10.12 GiB，CUDA 可用为 0 bytes；这不是 VAE 解码、最终编码或多片段合并位置。报错时这一调用走原生整批 MLP forward，没有出现前馈分块调用；但仅凭栈不能区分“工作流没接分块”与“上游补丁在模型切换/装卸后未生效”，也不能排除其他显存占用的贡献。不要把尚未验证的原因写成已证实根因。

用户最初的 Self-Lift 示例除了采样器设置，还在 MODEL 链上启用：

- `219 / MiniMaxChunkFeedForward`：`chunks=2`、`seq_threshold=4096`。
- `220 / MiniMaxLowVRAMAttention`：`head_chunks=4`。

它们不是提示词增强、DLSSNR 或后处理，也不等于 `highres_tiling`。最初附件 SHA-256 为 `709a0c227765999bbe38a29fc1df21f01dca0c5accd6777a17266fefc190f842`。前一版验收只明确复制 Self-Lift 参数、保留导演原 MODEL 链，没有要求比对这两项，不能称为参考工作流全链等价。

本轮只针对栈已定位的 **FFN/MLP 分块**做单变量复测。低显存注意力先记录原状态，不同时添加或改动它；不以增加多个优化开关来掩盖具体差异。

## 1. 先预检，不重复生成取日志

读取首次失败留下的 `selflift_minimal_request.json`、`selflift_minimal_history.json`、stderr 日志；路径见 32 报告。保存原证据不覆盖，先记录本地 git HEAD / 未提交改动。

沿真实提交副本追踪 `TerryDirectorConfig.model` 的全部上游 MODEL 链，并核对二采 `high_res_model` 是否未连接。检查节点是否 bypass / mute、连线是否落到正确输入、后置节点是否重新换回未打补丁的 MODEL。不要只凭画布上存在节点判定已启用。

对照本机已安装 KJNodes 的 `MiniMaxChunkFeedForward` 实现与当前 ComfyUI API；通过 `/object_info` 或本地注册表确认可用。核对传入低清和高清 native sampler 的 ModelPatcher 及其 `object_patches` 中 `diffusion_model.blocks.*.mlp.forward`，特别是经过 latent upscaler 装卸后是否仍保留；必要时用临时验收日志记录方法来源、补丁键与第一块 MLP 输入形状，不永久修改生产代码。

判定分支：

- **确认为未接 FFN 分块**：仅在验收副本的原完整 MODEL 链末端添加 `MiniMaxChunkFeedForward(chunks=2, seq_threshold=4096)`，其输出接导演配置 `model`。不重建/替换原主模型、LoRA、CLIP、VAE 或已有 MODEL patch。高清模型保持未连接，因此低清、高清使用同一条已打补丁的 MODEL。
- **已经接了分块，但高清阶段没生效**：不要重复叠加节点；记录补丁在哪一阶段丢失、模型对象/方法来源差异，停止生成并交回证据。本轮不擅自修第三方插件或改变模型生命周期。
- **节点不存在、当前 API 不兼容，或输入链无法确定**：记录 BLOCKED 后停止，不升级环境、不下载替代插件、不退回外部 `SelfLiftAvatarH3Sampler`。
- **原生分块已实际生效且证据不同于首次失败栈**：先报告差异，不把同样参数重复提交当作修复。

缺失情况下唯一新增的接线是：

```text
原主模型 + 原 LoRA / 既有 MODEL 补丁
    → MiniMaxChunkFeedForward（2 / 4096）
    → TerryDirector 配置.model

TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector Advanced
```

参考实现：`kijai/ComfyUI-KJNodes/nodes/minimax_nodes.py` 的 `MiniMaxChunkFeedForward` / `minimax_mlp_chunked_forward`。本次读取源码 blob 为 `6ffdb6af2cdf94f847f574051b1d1401374564b7`，仅作为核对来源，不要求升级到该版本。实现沿 packed token 维分片，每片仍完整执行 fc1 → SwiGLU → fc2；不是裁剪视频或空间分块。2 块会减小每次处理的行数，但不保证整体峰值减半，也不保证本机一定不再 OOM。

## 2. 修正 Sigma 验收口径，不改参数凑步数

首次实际日程：

```text
[1.0000, 0.9837, 0.9601, 0.9231, 0.8575, 0.7064, 0.0000]
```

最初附件对应 `H3SigmaRefiner` 源码（`yichengup/ComfyUI-YCNodes-MiniMax-H3`，commit `146207295c1d2bd6b64a6552484cb6ed8be1c9ef`，`py/h3_sigma_refiner.py`）与本仓库 `_refine_sigmas()` 都是：找到首个 `sigma <= 0.7`，若已是末尾的 0，则原样返回。

本次 `0.7064 > 0.7`，所以 `extra_steps=1` 没有实际插入；6 个区间、低清 5 步 + 高清 1 步是符合该日程与参考算法的结果。旧文档把“开启精修”直接等同于 5+2，是验收预期错误，不是已证实的采样实现错误。

保留精修开、阈值 0.7、加步 1、cosine，以及其余用户指定默认值。不要把阈值改成 0.71、基础步数改成 7 或硬插一个 Sigma。预检记录精修前后完整数组、是否触发，以及 `len(sigmas)-1` 推导的实际低清/高清步数；符合参考算法即通过，不再写死 5+2。

32 首次失败报告原文保持不变，复测报告注明上述口径更正；CUDA OOM 的 FAIL 结论仍然成立。

## 3. 预检通过后最多一次三段复测

只有第 1 节确认缺失并补齐 FFN 分块后，才按 31 文档原副本重跑三段：`96 / 72 / 120` 帧、24fps、Seed=1000/fixed、原提示词与 7 项资产、第二/三段 tail_continuation、仅 Advanced 分支。

1920×1088 原尺寸不裁剪、不缩放；Self-Lift 仍为 CFG=1、低清5步、比例0.5、Euler/simple/6步/Denoise=1、rho=0、w_min=0.5、w_max=1；指定 latent upscaler 不变，高清模型复用主模型。**`highres_tiling=false`、preview=false**；不要打开空间分块、改 attention backend、改权重量化/参考尺寸、减少资产或缩短片段。

使用新的验收副本/缓存标识及证据文件前缀，保留首轮失败文件和原 `Terry导演台.json`；不覆盖其他任务缓存、不清空别人的队列。临时诊断应与本轮生成共用一次任务，不先跑一轮探测再跑一轮验收。

在这一轮临时记录低清结束、upscaler 完成并卸载、高清采样入口处的 `torch.cuda.memory_allocated()`、`memory_reserved()`、`mem_get_info()`，以及当前加载模型名称/loaded_size；高清第一块 MLP 记录整段 token 行数、分块后最大行数、dtype 和实际 forward 来源。PyTorch allocated=4.86 GiB 不是全卡总占用，不能用 24−4.86 推算实际剩余显存，更不能仅凭该数字断言显存泄漏或外部进程占用。

预期先确认 FFN 已真正分片，再检查三段输出、音频、接缝和 Advanced 收尾。若仍 OOM，保留新 traceback、失败片段/阶段及上述数据后停止；不再尝试 4/8 块、不做空间分块矩阵、不重复重跑。没有真实输出时不得宣称修复成功。

## 4. 交付

仅写 `docs/34_SELFLIFT_MLP_OOM_RETEST_REPORT.md`：代码 commit、预检结论、修改前后 MODEL 链与补丁证据、单变量变更、精修是否触发/真实步数、prompt_id、结果与日志/视频路径、失败 traceback。原报告 32 不覆盖，原工作流前后哈希不变；视频/权重/大型日志留在本机。

本轮不修改产品采样代码、不合并 main。待本机证据确认瓶颈后再决定是否需要 TerryDirector 内部实现层的修复。

## 参考

- 首次失败现场：仓库 `docs/32_SELFLIFT_1080P_MINIMAL_REPORT.md`。
- 原始参考：用户提供的 `Unsaved Workflow (2)(1).json`，节点 219、220、244、147。
- KJNodes 分块实现：https://github.com/kijai/ComfyUI-KJNodes/blob/main/nodes/minimax_nodes.py
- 固定 Sigma Refiner 源码：https://github.com/yichengup/ComfyUI-YCNodes-MiniMax-H3/blob/146207295c1d2bd6b64a6552484cb6ed8be1c9ef/py/h3_sigma_refiner.py
- PyTorch 显存指标口径：https://docs.pytorch.org/docs/stable/notes/cuda.html#memory-management
