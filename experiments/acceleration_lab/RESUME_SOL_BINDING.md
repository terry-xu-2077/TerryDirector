# B1 DynamicCombo 修正：保留成功 B0，只补测 Sol

> 分支：`feat/selflift-internal`；复核报告提交：`925a2f0d507fb8d0380289aedd1dbb002130bfb6`。
> 覆盖 `RESUME_SOL.md` 的本轮生成次数：**不再生成 B0，最多补交一次 B1**。
> 生产冻结基线仍是 `0c82cd7bfb2de963304479eda86e02513e106da0`；所有修改仅在实验目录，不植入导演、不合并 main。

## 已读结果与定位

保留 `reports/03_SOL_ATTN_RETRY.md` 与 `evidence/sol_attn_retry.json` 原文。B0 已生成完整 AV checkpoint 和 1920×1088 / 24fps / 96帧 / 4秒视频；历史起止差为804.685秒。B1 在0.358秒时因 `selection` 缺失报错，H3前向为0；这不是Sol内核失败或速度结果。

源码核对发现构建器混用了两层格式。API线上的正确字段为：

```json
"selection": "sol-attn",
"selection.tau": 1.0
```

整理后的 Python `execute` 入参才是 `selection={"selection":"sol-attn","tau":1.0}`。不能直接把这个嵌套dict提交到API。

依据固定ComfyUI提交 `b26625f23a888367b92153b28d93e159e83e677b` 的 `comfy_api/latest/_io.py`（Git blob `42d2d1f374f74bcf2c82c9b5fad94ad72752448b`）：`DynamicCombo._expand_schema_for_dynamic` 将 `live_inputs["selection"]` 与每个option的字符串key比较。嵌套dict匹配不到option，最终schema不加入selection；输入过滤后就重现报告的缺参。正确字符串会展开 `selection.tau`，并建立 `selection -> selection.selection` 的动态路径，`build_nested_inputs` 才将两项组装成dict。这是本轮源码定位，不把旧报告的未知点改写成当时已观测结论。

## 本次修正及交付侧检查

- `build_workflows.py` 仅改变B1的上述API序列化；tau、Sigma区间、保护层及全部生成参数不变。UI的named widgets和内嵌API从同一修正后图生成。
- `validate_workflows.py` 按当前DynamicCombo选择展开带前缀的必填子参数；拒绝旧dict、缺少/不带前缀的tau、未选分支字段，以及UI/API动态字段或内嵌图不一致。
- 更新实验内的错误旧格式断言，新增12项DynamicCombo回归；新增 `preflight_sparse_binding.py`，使用本机真实V3整理函数和节点签名，不执行模型。
- 交付侧Linux/Python 3.13.5：**12项新静态回归 + 5项原构建/AV CPU检查，共17项通过**；三个修改/新增脚本语法检查通过。另用修正前后构建器确认合成B0 API/UI完全相同，合成B1只有两个序列化字段变化；旧验证器放过的dict现在被拒绝。
- 对已读取的固定上游整理函数做了摘取逻辑的CPU复现：旧形式在过滤后缺selection，正确形式得到预期dict。此复现的schema构造与节点为替身，**不是完整ComfyUI，也不是本机真实绑定预检**。交付侧没有ComfyUI/GPU环境，没有运行完整实验测试集或任何生成。

## 本地 Codex：先零生成绑定，再一次 B1

1. 拉取本分支、保留未提交改动。用原ComfyUI `.venv` 运行实验全部测试和 `check_isolation.py --repo .`，检查退出码。不要修改生产代码、旧报告、旧history或成功B0的文件。
2. 用修正版构建器从同哈希报告46请求生成到**新目录**，例如 `local/workflows/sol_binding_fix/`。不覆盖 `local/workflows/` 原失败图。B0、V0、V1可以随构建器生成供文件校对，**不能排队**。新B0 API须与报告03的成功B0完全一致；新B1与旧B1仅允许selection序列化差异，私人提示词、七项资产、模型、参数均保持相同。
3. 对新B1运行真实无生成绑定预检（路径替换为实际路径）：

```powershell
python experiments/acceleration_lab/preflight_sparse_binding.py `
  --comfy-root "G:\AIGC\ComfyUI_Codex\ComfyUI" `
  --api "新目录\Lab_B1_SolAttn_Clip1.api.json" `
  --output "新目录\B1_binding_preflight.json"
if ($LASTEXITCODE -ne 0) { throw "B1 binding preflight failed; do not queue" }
```

此脚本直接使用本机 `create_input_dict_v1 / get_finalized_class_inputs / build_nested_inputs`，再用 `inspect.signature(...execute).bind` 检查；必须得到 `normalized_selection={"selection":"sol-attn","tau":1.0}`，旧dict负例必须重现缺selection。记录脚本输出的源码与API哈希。它不导入execution/server、不调用节点execute、不解析MODEL连接、不加载权重；绑定通过仍不等于GPU兼容通过。

4. 在新8190实验进程按原方式执行API隔离、实际schema/连线校验；验证器只读访问 `/object_info`，不提交生成。旧导演诊断开关保持关闭，不重启8188正式服务。条件允许时，在实验前端打开/另存新B1并对照实际导出的API字段；做不到明确记录UI运行未验证，不冒充已打开通过。
5. 本机节点/包/实验运行helper与B0保持相同版本，记录差异。只补交**一次原4秒B1**，新run/output目录保留旧日志。保持tau=1、percent=.05–1、dense_blocks=0/1/48/49、min_tokens=12288、extra_tokens=256、exact_kv_and_rows；1920×1088不裁剪、原INT8模型/VAE、Kitchen密集后端、LowVRAM4、FFN2/4096、Seed1000和全部Self-Lift参数不变。
6. 沿用原实际Sol producer计数与阶段计时，分别报告实际稀疏调用、预期/有意密集路径及保护layout的观测范围。预检或执行失败保留证据后停止，不升级依赖、不调参重试，不自动转Veda/VAE或重跑B0。当前VAE仍为ALREADY_ACTIVE。

## 对照与新交付

复用报告03这次独立实验B0，而不是导演报告46或重型Profiler结果：低清357.2919559秒、高清201.419842秒，二者合计558.7117979秒；Self-Lift整体561.8316424秒，history总804.685秒。B0带阶段CUDA同步/峰值重置，B1必须保持同一计时方法；这是跨次单次对照，没有重复测量误差区间。前置工作、温度或驻留变化不能全部算作Sol收益。不要累加父子阶段、推断未测的精确放大耗时或将未触发的稀疏路径算作Sol。

成功后检查96帧/4秒音视频规格、保留成片与AV checkpoint；画面和声音未实际完整看听时标待人工确认。旧B0本身也尚未人工验收。只展示少数截图不能替代运动/闪烁检查。不要据一次成功自动植入导演。

新增并提交（都在实验目录）：

```text
reports/04_SOL_ATTN_BINDING_RETRY.md
evidence/sol_attn_binding_retry.json
```

附零生成绑定预检的精简结果、B1请求hash/白名单diff、新任务ID/原始起止/实际计数/阶段耗时及B0对照、输出位置、质量状态和限制。旧01/02/03报告及证据保留，失败不覆盖。结束后停止实验实例，保持正式服务与冻结文件不变。
