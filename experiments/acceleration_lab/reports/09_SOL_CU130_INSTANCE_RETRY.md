# Sol cu130 独立实例续测报告

## 判定

| 项目 | 结果 |
|---|---|
| 目标分支 / 提交 | `feat/selflift-internal`，确认包含 `5f29318`（本轮代码基线 `5f293183d387662e0316effe5670af6cfe540fb2`） |
| 环境 | `environment_ready=true`；B0、B1 各自的新 8190 进程都记录 cu130，CUDA registry enabled，Sol available |
| B0 | 成功，唯一提交，任务 `43643c68-c34e-40be-b780-6850df35ecd6` |
| B1 | 成功，B0 完整成功后在新的 8190 进程中唯一提交，任务 `763acc2b-e1e8-4e40-b78d-aea726d63f12` |
| Sol 实际调用 | B0 为 0；B1 低清 184、高清 46，合计 `ck.sol_attn_chunked=230` |
| cu130 B0→B1 总执行耗时 | 424.066→412.657 秒，B1 快 2.690%；单次顺序运行，不提供误差区间 |
| 输出规格 | 两条均为 1920×1088、24fps、96 帧、4秒，含音频；ffprobe 确认 |
| 画质 / 声音 | 两份完整成片均待人工连续观看和听音确认；本报告不判画质通过 |
| 生产服务 / 代码 | 8188 未重启、未装实验节点，队列保持空；未改生产代码或正式工作流，未合并 main |

本轮按 `RESUME_SOL_INSTANCE.md` 先通过离线预检，再用现有 `start_lab.ps1` 分别启动 B0 和 B1 独立实例。没有使用 8188 的节点表校验实验工作流；两份 API/UI 都由对应的 8190 注册表校验通过。没有安装或升级依赖，也没有触碰 `.venv_cu128_backup_20261010_144207`。

## 预检与源文件

- 目标分支快进到包含 `5f29318` 的提交。实验测试 **83/83 通过**；`check_isolation.py` 在单次 Git safe.directory 配置下通过，`production_files_unchanged=true`、`forbidden_changed_paths=[]`。B1 既有 DynamicCombo 绑定预检通过，归一结果为 `selection="sol-attn", tau=1.0`，旧格式反例被拒绝；预检生成提交数为 0。
- B0 API SHA-256：`d867be9289b4f91e4d61feb6b9ee4e3172a61370fcbad9a35dd7c5912083e864`；B0 UI SHA-256：`1faf4078625048a9cf52818fa46e27bfa734140452ccd37846ae3b4736a33d62`。
- B1 API SHA-256：`b1cfd6576406102d31bc2868c605a24a9adf72edab213135398d5ac0daf911b5`；B1 UI SHA-256：`df4e65a71d3a04781d436540bd4f500615c7ce06bbde696f90d3f6f88d68a0e1`。
- 两条图均来自本机已有固定请求；B1 仅为文档指定的原 Sol＋桥接链。提示词哈希仍为 `353ee9913b2d40fc272e498e2f330d9bf689b59a371a1b6d71c15b0aaa57e1f7`，七项资产及顺序、1920×1088、4秒/96帧/H3对齐107帧、Seed1000、Kitchen、LowVRAM(4)、FFN(2/4096) 与 Self-Lift 参数保持。B1 Sol 参数保持原 preset 和保护块配置。
- 正式 8188 队列在两次启动前与结束后均为 running=0、pending=0。两次实验结束后均只停止本轮启动的实验进程；8190 已关闭。

## 实验进程与 gate

| 路线 | PID / RunName | 实际解释器（同 PID 审计快照） | CUDA / Sol gate | 节点注册表校验 |
|---|---|---|---|---|
| B0 | 20452 / `sol_cu130_b0_20261010_153154` | `ComfyUI/.venv/python.exe` | torch `2.11.0+cu130`，CUDA build `13.0`；CUDA backend available 且未 disabled；扩展已加载并导出 `sol_attn`；SM86≥SM80；Sol available | `http://127.0.0.1:8190`，`SCHEMA_VALIDATED`，错误列表为空 |
| B1 | 36492 / `sol_cu130_b1_20261010_154137` | `ComfyUI/.venv/python.exe` | 同上；由 B1 自己的审计快照确认 | `http://127.0.0.1:8190`，`SCHEMA_VALIDATED`，错误列表为空 |

每份 gate 快照由对应新进程在实验扩展加载后生成，且记录自身 PID、解释器路径、torch/Kitchen 模块路径及源码哈希；审计器的 `generation_allowed=false` 仍表示审计自身不授权生成，不被改写。该快照不等同于长序列 kernel 成功；实际 B1 的 230 次 chunked 调用及无回退日志是独立运行证据。OS 进程信息接口在本地沙盒中拒绝查询，因此 PID/解释器依据启动器 PID 文件与同 PID 审计快照，8190 HTTP 就绪和独立输出目录相互核对。

## 执行时间和阶段

history 原始毫秒事件用于总耗时：

| 路线 | execution_start (Unix ms) | execution_success (Unix ms) | 时长 |
|---|---:|---:|---:|
| B0 | 1791617580821 | 1791618004887 | 424.066秒 |
| B1 | 1791618148398 | 1791618561055 | 412.657秒 |

阶段值来自各自 `stages.jsonl`，保持既有同步与峰值重置口径。阶段表把 Self-Lift 父计时单列；**不要把父阶段与低清/高清子阶段相加**。模型初始化时间包含在相应的采样阶段。latent 放大没有独立边界，故无精确单独耗时。

| 阶段 | cu130 B0 | cu130 B1 | B1 相对 B0 |
|---|---:|---:|---:|
| 条件/参考编码 | 101.703秒 | 102.157秒 | 慢0.45% |
| 低清采样 | 167.351秒（5 callbacks） | 165.179秒（5 callbacks） | 快1.30% |
| 低清 `ck.sol_attn_chunked` | 0 | 184 | B1观察到实际调用 |
| 高清采样 | 116.710秒（1 callback） | 92.136秒（1 callback） | 快21.06% |
| 高清 `ck.sol_attn_chunked` | 0 | 46 | B1观察到实际调用 |
| Self-Lift 总阶段（含低清/放大/高清） | 287.034秒 | 275.043秒 | 快4.18% |
| AV checkpoint 写入 | 0.062秒 | 0.058秒 | — |
| 音频 VAE 解码 | 0.453秒 | 0.451秒 | — |
| 视频 VAE 解码 | 28.579秒 | 28.543秒 | — |
| 视频保存/编码 | 3.383秒 | 3.434秒 | 慢1.52% |
| history execution_start→success | 424.066秒 | 412.657秒 | 快2.69% |

按原始毫秒相减的总任务时长不混入生成前排队或后续轮询时间。主要收益来自本轮高清采样观测；整任务速度提升较小，且仅为一次 B0→B1 顺序对照。报告03 cu128 B0 只作为跨环境历史材料，本轮主对照和上述百分比均不使用它。

## 稀疏调用及运行日志

B0 是 Kitchen 密集链，低清/高清 chunked 调用均为 0，阶段记录的 Sol 调用合计为 0。B1 日志先记录 Sigma=1 窗口外密集；保护块 0、1、48、49 按配置密集。随后低清出现 `sparse producer path: 45804 tokens, sinks (0, 461)/(455, 461)`，高清出现 `sparse producer path: 94764 tokens, sinks (0, 461)/(455, 461)`。阶段计数分别为 184 与 46，总计 230。没有 `no compiled sol_attn kernel`、OOM、异常回退或非有限错误；两路均完成低清5次与高清1次回调。

这些计数是现有 producer 计数，不外推其他层/布局的稀疏率，也不称为独立的 GPU kernel 次数。逐 block 的保护行和未打印布局细节仍未知。峰值 CUDA allocated 仅为阶段张量分配口径：B0 低清 2.526GB/高清 2.589GB，B1 低清 2.526GB/高清 2.665GB；没有 reserved/NVML 峰值数据，不能当作整卡占用。

## 输出与画质

- B0：`local/runs/sol_cu130_b0_20261010_153154/runtime/output/video/Lab_B0_Clip1_00001_.mp4`；history 和 ffprobe 均确认视频 1920×1088、24fps、96帧、4.000秒，并有音频流。私有 AV checkpoint：`runtime/output/.acceleration_lab/B0_AV.pt`。
- B1：`local/runs/sol_cu130_b1_20261010_154137/runtime/output/video/Lab_B1_Clip1_00001_.mp4`；history 和 ffprobe 确认同规格并有音频流。私有 AV checkpoint：`runtime/output/.acceleration_lab/B1_AV.pt`。
- 两条成片均未在本轮做完整连续观看/听音。身份一致性、脸手细节、动作/闪烁、曝光、音质及音画同步均标记为 **待人工确认**。不得仅凭自动探测或采样推断画质通过。
- 私人 request/history/stdout/stderr/stages、审计快照、checkpoint 和视频完整保留于本机 `experiments/acceleration_lab/local/runs/`；本仓库只提交脱敏汇总，不提交私人工作流、生成视频或 checkpoint。

## 结论边界

技术路径方面：B0 完整成功；B1 完整成功且有真实 chunked producer 计数。当前 cu130 同环境单次对照显示 B1 总执行快2.69%，Self-Lift 总阶段快4.18%，高清采样快21.06%，低清采样快1.30%。样本只有一对，不能据此外推多次运行、三段任务或导演集成。速度结果与画质结论分开：两条画质/声音仍待人工确认。报告08原文和 01–07 记录未覆盖或修改；本轮未植入导演、未合并 main。