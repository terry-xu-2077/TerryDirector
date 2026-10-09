# Self-Lift MLP OOM 复测报告

## 结果

- 结果：**成功**。首次 OOM 后，本次单次三段验收任务完成。
- 分支实测 HEAD：`944f06f38c0313796b186e461577f79d14879f1c`（`docs: correct conditional sigma refinement expectation after real OOM report`）。相对此前运行基线的最新分支提交只改验收文档；产品运行代码未变。
- Prompt ID：`65ca768f-651a-4959-a8bc-ee4a6af11f09`。ComfyUI history：`success`, `completed=true`；服务日志记载 00:41:07 左右完成（由 execution_start/success 时间戳计算）。
- 视频：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\video\TerryDirector_SelfLift_MLP_Retest_00001_.mp4`，13413321 bytes。输出 metadata：`1920×1088`, `24.0 fps`, `288` 帧，时长 `12.0 s`。**画面与声音未实际听看，待人工确认。**

## 首次失败请求与节点核对

- 首次失败真实 payload：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_minimal_request.json`（SHA-256 `747e8cc98da80e824609dcdf1d5b6ba199f02ca6319eaf878450b02cd9b292de`）；对应 history 中 Prompt ID `586cc7d4-d68f-4a83-9e38-63991c07fb63`，错误为 `torch.OutOfMemoryError`，发生于首次高清采样。首次 payload 的实际模型链是 `333 UNET → 332 LoRA → 312 PathchSageAttentionKJ → 304 TerryDirectorConfig.model`，不存在 `MiniMaxChunkFeedForward`，也没有单独 `high_res_model` 输入。因此确认缺失后，只在临时验收请求副本中添加一个 FFN 节点。
- 复测请求使用 `333 UNET → 332 LoRA → 312 PathchSageAttentionKJ → 219 MiniMaxChunkFeedForward(chunks=2, seq_threshold=4096) → 304 TerryDirectorConfig.model`。`TerryDirectorSecondPassConfig` 不提供独立高清 MODEL 输入；`director_selflift.py` 在其缺省时从同一个 `model` 取高清 MODEL，因此请求图显示低清与高清共用 FFN patched MODEL。ComfyUI 当时 `/object_info/MiniMaxChunkFeedForward` 已注册且参数 schema 与所需值匹配。
- 本次运行时 JSONL 只记录临时诊断插件加载（并确认其引用实际 KJ 与 TerryDirector 模块），未捕获到 low/high sampler 和 MLP forward 的钩子事件。因此 **无法提供真实 MLP forward 的分块触发计数或 patcher 对象的高清阶段快照**。可确认的接入证据是已执行请求的序列化 prompt 中 FFN 节点被实际引用、Advanced 输出节点成功完成；这证明该请求图接入后完整流程成功，但不等同于独立观测每次底层 MLP forward。临时诊断插件已移除。

## 验收参数与保留情况

- 只运行原连续三段：`clip-1` [0, 96), `clip-2` [96, 168), `clip-3` [168, 288)；帧率 24 fps。提示词、全局提示词及七项输入资产与首次真实请求相同；三段提示词/资产 SHA-256 对照一致。
- 分辨率仍为 2.0 MP，16:9、multiple 32；未降低分辨率。`highres_tiling=false`，未启用高清空间分块；未修改 Self-Lift 默认参数。输出视频实测为 `1920×1088`。
- Self-Lift 参数保持：6 sampling steps，sigma refine enabled，extra steps 1、start 0.7、end 0.0、cosine；transition step 5，seed 1000。按照 `docs/33_SELFLIFT_MLP_OOM_RETEST.md` 的修订说明，实际 sigmas `1.0000, 0.9837, 0.9601, 0.9231, 0.8575, 0.7064, 0.0000` 对应 5 个常规区间 + 最终清零区间；`0.7064 > 0.7`，此配置下 extra step 条件不触发属于预期，不是额外故障。
- 原工作流文件未修改；运行前后 SHA-256 均为 `cb8c153cec3141f839e365edc49bc223779df46a0ef055e5629668b14ff87fd7`。只有临时 payload 副本包含验收 FFN 和唯一输出前缀。

## 提交与输出

- 原始视频路径：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\video\TerryDirector_SelfLift_MLP_Retest_00001_.mp4`。
- 复测 API payload：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_mlp_retest_request.json`（SHA-256 `6bc7589f59b9660fd76321c56164e97fa1512c0566fb2bfa6c144853d51b14d7`）。
- 完整 ComfyUI history（包含本次执行输入图及成功状态）：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_mlp_retest_history.json`。
- 执行状态轮询日志：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_mlp_retest_execution.log`。
- ComfyUI 服务/显存阶段采样日志：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_mlp_retest_service.log`。
- 临时运行时诊断日志：`G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_mlp_retest_runtime.jsonl`。
- 最终状态：`success`, `completed=true`; `execution_error` 条目数为 0。

## Traceback

无。本次 history 的 status 为 success，未产生 execution_error。
