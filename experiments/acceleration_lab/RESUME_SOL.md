# 继续独立 Sol 实验：先验证修正版入口，停止重复 VAE 对照

> 复核基线：`afedae677b95e30130e0b2bc76327448832af1e2`。  
> 继续执行 `docs/47_ACCELERATION_LAB_TEST.md` 已确定的 B0/B1 独立链，不扩大技术范围。  
> 本文件只补充续测门槛和交付文件名；既有报告、失败请求和证据保留不动。生产代码冻结基线仍为 `0c82cd7bfb2de963304479eda86e02513e106da0`。

## 1. 已确认的停止原因与收窄范围

来源：`reports/01_SOL_ATTN.md`、`reports/02_VAE_INT8.md`、`evidence/sol_attn.json`。

- 上轮 B0 提交一次，在 `TerryAccelLabSigmaRefine` 导入阶段报 `No module named 'TerryDirector'`；从 execution_start 到 execution_error 为 0.364 秒。实际 H3 前向为 0，B1 未提交。这个错误不是 Sol 内核运行失败、不是 OOM，也不是速度结果。
- Codex 已在实验目录提交 `frozen.py` 及调用点修正，通过私有包名只读加载冻结源码。报告中的修正后 22 项检查通过，不等于修正版已在真实生成中通过。本轮不得再套用上轮失败前的辅助节点副本。
- 当前视频 VAE 与拟测 INT8 候选是同一路径、同一 SHA-256：`52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e`，文件名 `minimax_h3_video_vae_int8_convrot.safetensors`。VAE 候选记为 **ALREADY_ACTIVE**，不排 V0/V1、不再次下载、不改用 FP16 制造对照、不计额外提速。
- 本次续测仅 B0 密集 Kitchen 与 B1 Sol-Attn。两次均为原 clip-1 / 4 秒；不测 Veda，不修改正式导演节点，不合并 main。

## 2. 先补足无生成入口验证

在实验目录允许新增或完善辅助器测试，不修改根 tests 或冻结源码。保留本机未提交修改，拉取本分支后先执行：

```powershell
python -m unittest discover -s experiments/acceleration_lab/tests -p "test_*.py" -v
python experiments/acceleration_lab/check_isolation.py --repo .
```

使用原 ComfyUI `.venv`，逐条检查退出码。不是只确认函数名或 `/object_info` 菜单存在：

1. 在一个干净的无生成子进程中，按实验扩展的真实加载路径调用 **实际 `TerryAccelLabSigmaRefine.execute`**。使用小型 CPU Sigma 张量与原参数，不替换 `_refine_sigmas` 为 mock；确认输出形状、dtype、值及输入未被修改。至少覆盖本次阈值不触发的日程，并检查一个确实触发精修的合成日程。不加载模型、不调用 `/prompt`。
2. 不依赖 `import TerryDirector` 成功。记录 `frozen.ROOT`、`_refine_sigmas` 与 `sample_selflift` 的真实来源路径及 SHA-256，确认指向冻结版仓库；私有加载不执行生产根 `__init__.py`。检查实际安装目录/Windows junction 解析后的路径，而不只在另一目录直接 import 测试。
3. 只读加载 Self-Lift 核心；用已有合成接口测试确认实验包装和冻结核心的调用约定一致，不新增真实 H3 前向。其它尚未实际经过的条件、AV checkpoint、解码、保存入口也做合成参数绑定/调用检查，不能把 schema 注册成功等同于执行成功。
4. 首次真实运行前，确认新实验进程已装载修正后的辅助节点，而不是上轮旧进程或旧复制件。现有 8188 正式服务不重启；8190 实验实例按既有隔离方式启动，旧导演 trace/OP_PROFILE/backend verify 开关仍关闭。前端能打开 UI 文件的检查尚未做过，有可用浏览器则零生成打开验证；做不到就明确保留未验证状态。

任一预检失败先提交停止证据，不消耗完整生成去定位导入或参数绑定问题；不通过跳过断言或修改冻结基线放行。原生 Sol 的小张量 GPU 冒烟已完成；环境和关键源码未变时不必重复跑微基准。

## 3. 有界执行，只比较新 B0 与新 B1

所有输入沿用已生成的本机私人工作流与原请求映射，不重新编造内容。保留原模型/LoRA、CLIP、当前 INT8 视频 VAE、音频 VAE、七项资产及顺序、最终编译提示词、1920×1088、不裁剪、24fps/96输出帧/H3对齐107帧、Seed1000和全部 Self-Lift 参数。

B1 参数仍为原计划：`sol-attn`、tau=1.0、percent=0.05–1、dense_blocks=0/1/48/49、min_tokens=12288、extra_tokens=256、`sink_conditioning=exact_kv_and_rows`。不调整这些数值追求更好的结果，也不同时改 FFN、LowVRAM 或 VAE。

- 本次续测上限 **B0 一次 + B1 一次**；不得自动重试。上轮失败的 B0 单独保留，不混入本次提交次数或耗时。
- B0 成功并产出完整 AV checkpoint 和合规视频，才开始 B1。B0 失败则 B1 不提交。
- 每条使用独立新实验进程和隔离输出目录；同一 GPU 不并发运行，不能覆盖上次的 stdout/stderr、history、stages.jsonl 或 checkpoint。当前 checkpoint 固定文件名可以保留，通过新的 output 目录隔离，避免为本轮额外改公共 schema。
- B0/B1 使用完全相同的实验计时方法和启动参数，记录阶段边界同步等诊断开销及口径。主要对照为本轮 B0；历史报告46只作合理性参考，不能把绕开导演链的变化算到 Sol 身上。
- 保存完整实际 Sigma；保留每阶段回调和稀疏调用证据。根据当前设置推导的低清首步密集、其余低清和高清稀疏只是预期，不替代实际观测。密集保护块的有意回退不能报作失效。
- 首次本应启用稀疏的前向返回后，核对真实 `ck.sol_attn_chunked` 调用。记录实际 layout/保护行范围及计数证据；无法观测的细项写 UNKNOWN，不将 API 入口计数冒充 GPU kernel 数量或质量保证。计时和轻量观测改进只能放实验目录，不使用重型 profiler或逐层同步。
- 出现 OOM、参数不支持或稀疏未生效则保留原 traceback 并停止该路；不降分辨率、不减资产、不换后端、不补交第二次请求。

## 4. 新文件交付，不覆盖上轮

```text
experiments/acceleration_lab/reports/03_SOL_ATTN_RETRY.md
experiments/acceleration_lab/evidence/sol_attn_retry.json
```

提交本轮确实使用过的实验辅助源码/测试修改（如有）及上述报告。报告至少包含：代码与装载路径核对、预检结果、新任务ID和次数、B0/B1实际阶段耗时、输入哈希/差异、稀疏观测范围、Sigma、AV规格、诊断开销、失败记录及人工质量状态。未连续看听不能把出片或少量静帧当作完整质量通过。

`reports/01_SOL_ATTN.md`、`reports/02_VAE_INT8.md` 和原 evidence 保持不变；VAE 的 ALREADY_ACTIVE 已是有效核对结论，不需要再跑同权重解码。私人工作流、模型和视频仍留本机。实验结束只停实验服务，确认生产文件和原工作流未改。

独立链技术成功、出现可解释的速度改善、用户认可画面后，再提出植入导演的方案。本文是复核后的续测任务，不是新的运行结果；交付侧未在本轮执行 ComfyUI/GPU或复跑本机22项测试。
