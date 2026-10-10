# cu130 环境通过后：重新建立独立 B0，再测 Sol B1

> 分支：`feat/selflift-internal`；报告复核基线：`53c51e5b01059de3c2e8d30c2559756c638a7b41`。  
> 前置证据：`reports/06_SOL_RUNTIME_GATE_AUDIT.md`、`reports/07_CU130_ENV_HANDOVER.md` 及各自 evidence。  
> 本文件是下一轮待执行任务，不是新环境的生成或性能结果。继续用户已确认的独立实验链，不植入导演、不合并 main。

## 1. 当前结论和本轮范围

报告06已在本机同一子进程直接复现：cu128 下导入 `comfy.quant_ops` 后 Kitchen CUDA registry 从 enabled 变为 disabled，Sol available 从 true 变为 false；实际8190服务状态吻合。扩展/符号存在，SM86满足SM80门槛，不能把这次阻塞归为3090架构不支持。

报告07记录环境迁移 `PASS_WITH_NOTES`：原 Conda prefix 改名为 `.venv_cu128_backup_20261010_144207`，48个关键二进制哈希与迁移前匹配；新环境在原 `.venv`，torch/torchvision/torchaudio 为 `2.11.0+cu130 / 0.26.0+cu130 / 2.11.0+cu130`。Kitchen 0.2.37、Sage、Triton和Comfy/KJ源码未升级。完整8190启动后Sol检查正常，五条小张量路径成功，但视频生成数为0。

**这轮恢复有界生成：最多 B0 一次 + B1 一次。** 覆盖先前审计/迁移任务的“0次生成”和旧续测的“不重跑B0”，仅用于本轮独立实验。原因是环境已改变：必须在同一cu130环境内比较密集与稀疏，不能把环境变化全部算作Sol收益。B0失败则B1不排；不自动重试，不扩大到三段。

现有生产代码仍冻结在 `0c82cd7bfb2de963304479eda86e02513e106da0`。只允许在实验目录新增本轮报告、脱敏证据及必要的本地驱动；不改现有导演节点、根注册、运行数学核心、计时方式、正式工作流或第三方源码。不再次安装/升级包，不切回cu128、不改驱动，不触碰封存备份。INT8 VAE仍为ALREADY_ACTIVE，不排V0/V1；不安装Veda或叠加其他加速。

## 2. 两份现成请求，不重建故事

复用本机已有UI/API文件，先校验SHA-256，再复制到新的私有目录；不要覆盖旧工作流/失败证据。找不到同哈希来源就BLOCKED。

| 用途 | 已有文件（相对于实验目录） | API SHA-256 |
|---|---|---|
| B0：密集Kitchen | `local/workflows/Lab_B0_Dense_Clip1.api.json` | `d867be9289b4f91e4d61feb6b9ee4e3172a61370fcbad9a35dd7c5912083e864` |
| B1：Sol＋块接口桥接 | `local/workflows/sol_forward_bridge/Lab_B1_SolAttn_Clip1.api.json` | `b1cfd6576406102d31bc2868c605a24a9adf72edab213135398d5ac0daf911b5` |

B0来源为报告03已成功的独立链；B1来源为报告05越过绑定和块接口错误的桥接图。各自UI同名去掉`.api`，B1 UI哈希为 `df4e65a71d3a04781d436540bd4f500615c7ce06bbde696f90d3f6f88d68a0e1`。无需再次运行旧构建器从头搭图。

B0：原模型/LoRA → Kitchen → LowVRAM(4) → FFN(2/4096) → 实验Self-Lift。

B1：同链 → `TerryAccelLabSolLowVRAMBridge` → 原生 `BlockSparseAttention` → 实验Self-Lift。桥接是保持当前KJ版本的必要适配，属于候选组合；不能把B0/B1差值称为纯Sol kernel收益。

完整有效API保持上述版本原样，run_id仍为B0/B1，通过新进程、新RunName和新输出目录隔离缓存/文件；可更换提交外层client_id，但不改模型链、提示词或资产。每份图只有一个保存目标，不提交导演、配置、Advanced或输出节点。源请求/源码/资产前后哈希不变。

固定内容为报告46已认可的驾驶舱clip-1：七项原资产及编译顺序、最终提示词哈希 `353ee9913b2d40fc272e498e2f330d9bf689b59a371a1b6d71c15b0aaa57e1f7`；不替换成最初附件的另一故事。输出1920×1088、不做空间裁剪/缩放，24fps/96帧/4秒；内部H3对齐107帧，沿原时间裁切输出96帧。音频设置和裁切不变。

Self-Lift保留原主模型/LoRA/CLIP/两种VAE和放大权重，Seed1000、CFG1、Euler/simple、基础6步、transition_step5、lowres_scale0.5；Sigma精修开、extra1/start0.7/end0/cosine，rho/w_min/w_max=0/0.5/1；无独立高清模型，highres_tiling=false。不能把实际5+1硬改为5+2。

Sol预设不变：`selection="sol-attn"`、`selection.tau=1.0`、start_percent=.05/end_percent=1、dense_blocks=`0,1,48,49`、min_tokens12288、extra_tokens256、sink_conditioning=`exact_kv_and_rows`、verbose=true。不要用Python整理后的嵌套selection字典替代API扁平字段。

## 3. 排队前检查：使用实际cu130实验进程

使用报告07确认的新原路径解释器执行，不以另一shell的pip/torch输出代替服务进程身份。保留未提交改动，先运行实验测试和边界检查：

```powershell
& "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe" -m unittest discover `
  -s experiments/acceleration_lab/tests -p "test_*.py" -v
& "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\python.exe" `
  experiments/acceleration_lab/check_isolation.py --repo .
```

逐条检查退出码；不修改/跳过失败项放行。对B0/B1分别做既有API隔离、注册/schema/连线检查；B1继续运行 `preflight_sparse_binding.py`。版本/hash未变时，报告05已通过的CPU桥接分派和报告07微张量结果可引用，不为预检反复运行微基准。前端UI若未实际打开/导出，保留未验证，不冒称通过。

两条任务分别使用独立8190实验进程和新的RunName，例如 `sol_cu130_b0_<时间标识>` 与 `sol_cu130_b1_<时间标识>`。沿用 `start_lab.ps1` 的其他参数。每次启动以既有 `TERRY_ACCEL_LAB_SOL_AUDIT=1` 获取该PID已加载对象快照，确认解释器是新`.venv`、torch CUDA build=13.0、registry已注册且未disabled、扩展/符号/架构通过、Sol available=true。审计文件的`generation_allowed=false`描述审计工具本身不授权生成，不要改写该历史/工具字段；后续排队须另外满足本文条件。

审计快照只保证记录时点；本次采样仍依赖现有实际producer计数验证，不用启动快照替代运行证明。出现版本禁用警告、扩展缺失、关键节点导入失败或与报告07不一致，停止本轮，不调用registry.enable或改availability返回值。

旧 `TERRYDIRECTOR_TRACE`、`TERRYDIRECTOR_OP_PROFILE`、`TERRYDIRECTOR_BACKEND_VERIFY` 保持关闭。不启用重型Profiler，不修改既有阶段同步/峰值重置实现，不在每层加同步。保留正式8188服务、启动参数和备份不动；只在8188/8190队列均空闲、没有其他GPU任务时测试，不并发，不中断别人的任务。若正式服务持有大量模型显存导致对照环境不同，记录并暂停，不擅自清缓存/重启它。

报告07的三条既有pip冲突、Kornia可选节点错误和瞬时端口冲突保留为迁移注意项，不在本次为了清空日志升级NumPy/Kornia等。新出现的实验必需依赖错误须停止；不能把已有冲突记录当成任意新错误的豁免。

## 4. 顺序执行和停止条件

1. 新进程提交一次B0，保存真实payload/提交响应/history/stdout/stderr和stages。确认完成5个低清、1个高清回调、Sol chunked调用为0，产出完整B0_AV.pt和1920×1088/24fps/96帧/4秒音画视频。原生产画质认可不自动替B0验收；B0异常则保存失败，不启动B1。
2. B0成功后正常停止该实验PID，保留全部输出；新建另一个cu130实验进程，完成该PID检查后只提交一次B1。B1保留所有已有桥接/分块/保护设置。
3. B1首个Sigma=1按计划密集；记录第一个本应稀疏的前向之后实际 `ck.sol_attn_chunked` 调用。不能因密集首步计数为0就直接认定失败，也不能将dense_blocks保护、窗口外密集等预期行为当作异常回退。若应稀疏时仍无调用、再次出现kernel不可用或桥接异常，按现有检查停止；不改开关后重试。
4. 分别记录低清和高清实际producer调用数、完整CPU Sigma、回调数、现有verbose中的保护/密集原因和layout证据。未覆盖的按block/step细节记UNKNOWN，不套用旧密集Kitchen的1000/200计数作Sol判定，也不把Python入口次数冒称GPU kernel数或稀疏率。
5. 长序列CUDA错误/OOM、非有限结果或输出失败时保留完整traceback和阶段，不降分辨率、减资产、改tau/head/chunks/dtype，也不自动退回密集并计为Sol成功。每路最多一次，成功也不扩到三段或植入导演。

两路均使用新输出目录，checkpoint虽为固定文件名也不得覆盖旧记录。结束后只停止8190实验实例；记录8188状态及Git隔离检查，不回退或删除cu130/cu128环境。

## 5. 耗时必须拆成两个不同问题

**问题A：环境变化后的密集链结果。** 可将新cu130 B0与报告03的cu128 B0作历史参考：低清357.2919559秒、高清201.419842秒、合计558.7117979秒；Self-Lift561.8316424秒；整任务804.685秒。标记为跨环境、跨次对照，不把变化精确归因于某个未观测算子。

**问题B：当前环境中加Sol的结果。** 主要比较本轮cu130 B1与本轮cu130 B0：条件编码、低清、高清、Self-Lift整体、视频/音频解码、保存/编码、history总耗时分别列出。计算 `(B0-B1)/B0×100%`，负值如实写慢；无成功B1则无Sol速度结论。禁止用新B1直接除旧cu128 B0并称为Sol加速。

整任务以history的execution_start/成功事件原始毫秒相减，排队时间不混入。父子阶段不重复相加；latent放大没有独立记录时不能给精确秒数。保持原CUDA同步/峰值重置计时口径，记录首调用/编译、模型驻留和其他GPU活动限制；单次顺序对照没有重复误差区间，不外推三段时长。峰值allocated不是整卡占用，未测reserved/NVML则保留未知。

## 6. 交付与质量门槛

只新增：

```text
experiments/acceleration_lab/reports/08_SOL_CU130_COMPARISON.md
experiments/acceleration_lab/evidence/sol_cu130_comparison.json
```

记录实际提交/环境版本/hash、备份保留、B0/B1源API哈希、每条新PID及启动gate、提交次数/任务ID/原始起止/成功或失败、逐阶段计时、实际Sol调用与观测范围、输出规格/本机相对路径、失败栈及未知项。区分 `environment_ready`、`b0_success`、`b1_success`、`sol_observed`、速度结果和画质状态。完整私人请求/日志/视频/权重留本机，不提交环境备份或wheel。

对照本轮B0/B1的完整四秒成片，检查身份、脸手细节、动作/闪烁、曝光；声音与同步单列。仅自动解码或抽帧不能判完整质量；用户未确认前标待人工验收。此前认可的Kitchen片段可以作为视觉历史参考，但不能代替本轮B0/B1对照。旧01–07报告及证据保留，速度与质量分开判定。独立链技术、速度、用户画质都通过后才讨论导演集成，不能自动改默认后端。

本轮文档交付侧只审阅远端报告06/07、证据和改动范围，并新增本文；没有访问本机环境、运行测试、提交生成或获得新的加速数据。
