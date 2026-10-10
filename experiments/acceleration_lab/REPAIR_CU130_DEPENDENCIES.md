# 固化 cu130 后，定向修复 NumPy / Pydantic / Kornia 冲突

> 用户于2026-10-10授权：“然后修复那个环境冲突问题，nmpy那些”。
> 交付分支 `feat/selflift-internal`，读取基线 `ac87ff994361ed8d5509d1dae2e43583de056360`。
> 本文授权本地Codex完成受控修复，不只是提交诊断。所有视频生成次数为0。

## 1. 不变范围与明确授权

`ENVIRONMENT_BASELINE.md` 和 `environment/cu130-core.constraints.txt` 固定核心环境。不得改变六项核心包、Python、驱动、ComfyUI/KJ或导演源码、模型、工作流、采样参数、注意力选择和Sol状态。

本任务覆盖旧实验规则的“禁止更改依赖/重启正式服务”限制，仅允许：在所有相关队列空闲时，备份当前cu130环境，修复下述周边依赖，完成原服务的停止与恢复。不能杀运行任务、清队列、关闭插件掩盖错误、改site-packages源码或全量升级。不得触碰原cu128封存备份。不合并main。

## 2. 先核对真实错误，不能把摘要当安装元数据

读取报告07对应的原始 `pip_check.txt` / stderr，再用实际 `.venv/python.exe` 重跑 `-m pip check`，保存stdout、stderr、退出码。通过 `importlib.metadata` 读取 **当前已装版本** 的 `Requires-Dist`、`Requires-Python`、METADATA路径/哈希及本地direct_url来源（脱敏后提交）。找出所有对numpy、pydantic/pydantic-core、kornia声明约束的已装消费者，包括pydantic-settings、SciPy、OpenCV、Numba/llvmlite和相关插件requirements。

报告07称三条冲突为 llama-cpp-python/NumPy、Numba/NumPy、Mixpanel/Pydantic，外加Kornia `pad` 导入错误。它只给摘要，**必须以这次原始证据校正具体归属**。2026-10-10查到的官方Mixpanel当前 `pyproject.toml` 没有Pydantic依赖；这不证明本机旧版本也没有，但不应只为迎合摘要而降级Pydantic。若实际不存在该冲突，记录摘要与实测差异，保持Pydantic和pydantic-core原样。旧报告不覆盖。

从完整traceback定位Kornia错误的实际调用插件。0.8.2源码仍在pyramid模块导入 `pad`；若本机同错误重现且所有消费者允许，优先只回到0.8.2，不升级/修改整个LTX或KJ仓库，也不添加全局monkey patch。

## 3. 候选和最小变更集

| 问题 | 首选候选 | 放行条件 |
|---|---|---|
| 已记录的NumPy 2.5.3上限冲突 | `numpy==2.3.2` | 满足所有实际反向依赖；不只检查Numba |
| Kornia pyramid.pad缺失 | `kornia==0.8.2` | 本机定位一致、所有已装消费者允许、实际导入通过 |
| 仅当真实Pydantic <2.12冲突成立 | `pydantic==2.11.10` + `pydantic-core==2.33.2` | 全环境约束允许；两项配套，不单改Pydantic |

NumPy有Python3.12 Windows x64 wheel；Pydantic2.11.10官方元数据明确要求core2.33.2。`environment/repair-candidates.requirements.txt` 默认只列NumPy/Kornia，Pydantic二项是注释，**候选未做本机验收**。

根据现场证据生成私人 `approved.requirements.txt`：移除不需要改变的候选，确有Pydantic问题才加入配套两项。只允许这四个直接目标；若其配套依赖 `pydantic-settings` 或 `kornia-rs` 的实际约束要求小范围调整，可依据真实元数据选择满足交集的最小变更并显式加入该文件/报告。不得改变Numba、llvmlite、llama-cpp-python、Mixpanel或其他无关包来碰碰运气。无满足交集的方案时记录具体约束，保持环境不动；不能用 `--no-deps` 强行安装。

## 4. 不停机先准备与检查安装计划

用实际目标解释器确认 `sys.prefix` 是已迁移的Conda prefix，核心版本匹配。导出修复前freeze/list、pip check、Conda explicit/env、启动命令、目标插件注册表和关键二进制哈希。保存到新的 `local/dependency_repair/<当地时间>/`。保存wheel和基础管理器位置，准备足够空间；不能依赖改名后的旧环境来运行Conda。

生成 `unchanged.constraints.txt`：以所有已装分发包的实际版本精确固定，排除此次approved中的包；不写入凭据URL。核心六项仍必须存在。duplicate metadata、editable/VCS/本地扩展来源需核对，不能用同版本号自动认定同二进制。检查插件requirements中的extras/非元数据约束。

以下是命令模板，路径变量必须由上述步骤解析，不使用裸pip：

```powershell
$Lab = 'experiments/acceleration_lab'
$Core = "$Lab/environment/cu130-core.constraints.txt"
# $Python = 实际ComfyUI .venv\python.exe；$Work = 新私有证据目录
$Approved = Join-Path $Work 'approved.requirements.txt'
$Unchanged = Join-Path $Work 'unchanged.constraints.txt'
$Plan = Join-Path $Work 'pip-plan.json'
& $Python -m pip install --dry-run --report $Plan --only-binary=:all: `
  -c $Core -c $Unchanged -r $Approved
if ($LASTEXITCODE -ne 0) { throw 'Resolve the reported dependency intersection before installing' }
& $Python "$Lab/check_dependency_plan.py" --report $Plan --approved $Approved `
  --output (Join-Path $Work 'plan-guard.json')
if ($LASTEXITCODE -ne 0) { throw 'Projected dependency state rejected; no install' }
```

新guard读取本机全部分发包元数据，检查方案只改approved目标、核心不变，并检查未参与pip请求的反向依赖，防止pip局部求解后留下全局冲突。它不安装、不导入GPU代码、不访问服务。其通过只代表基础元数据一致；extras/二进制/实际插件必须另验。若出现direct URL检查项，逐项核对来源和哈希，不能忽略。

根据通过的plan下载**准确wheel**到本地wheelhouse并记录SHA-256；使用官方来源，不使用未知重打包文件，不做源码编译。可做多次不安装的依赖求解来找到真正交集，但只应用一套最终计划，不反复安装不同组合试错。

## 5. 备份cu130，再应用一次经过验证的修复

先确认8188、8190及其他使用目标环境的本项目任务无运行/待处理；有任务则等用户空闲窗口，不能终止。关闭会自动重启的本项目启动器，正常停止相应已识别进程，确认DLL释放。不得“结束所有python.exe”。

同卷将现 `.venv` 原样改名为唯一 `.venv_cu130_before_dependency_fix_<时间>`；它是本次回退点，不是cu128备份。核对关键二进制哈希与快照一致，不修改备份内任何包。在原路径用外部Conda `--clone` 恢复一份cu130工作环境，核对Python路径布局和受保护核心二进制哈希。遵循 `CU130_ENV_HANDOVER.md` 的前缀/同路径恢复注意事项，不从改名备份启动服务。

在新工作前缀、同一组constraints/approved和本地wheelhouse上再做一次dry-run，guard通过且计划/文件哈希与已审批相符后，去掉 `--dry-run`，用 `--no-index --find-links <wheelhouse> --only-binary=:all:` 安装一次。保留安装日志和 `--report`；不加 `--no-deps`、`--upgrade`、`--force-reinstall` 或重新安装Torch。若安装计划试图改变核心，停止；不能放宽核心constraints。

安装失败或后续验收失败时，封存失败的新前缀，恢复本次cu130备份到原 `.venv`，用原命令恢复服务并报告。**绝不自动退回cu128**。未进行真实回退不能声称回退演练通过。

## 6. 验收：不能只看pip install成功

1. `pip check` 必须退出0。运行guard `--check-installed --approved <实际文件>` 检查整个基础依赖投影。对比freeze：除approved白名单外所有版本、六项核心版本/关键文件哈希保持；Python3.12.13、Torch2.11.0+cu130与CUDA build13.0不变。
2. 新进程导入NumPy、Numba、llama_cpp及实际涉错包。小型CPU测试验证torch/NumPy双向转换、Numba编译简单数组加法；不加载LLM/H3/TTS模型。若Pydantic确有改动，连同pydantic-core/settings测试简单模型验证和设置解析，避免NumPy问题换成服务schema问题。
3. Kornia验证 `from kornia.geometry.transform.pyramid import pad`，执行微小张量pad/pyramid；检查原traceback对应的LTX/其他插件实际导入及节点注册，不以“import kornia成功”替代。
4. 完整初始化临时8190进程后核对Kitchen CUDA registry不disabled、Sol可用及Sage/Kitchen关键扩展；允许复用报告07方式做少量有界算子smoke，禁止生成。检查Qwen-TTS原先Numba/NumPy错误消失。只加载实验扩展的精简8190不能替代正式插件集合的检查。
5. 以原命令恢复8188全部既有插件，核对唯一PID/监听端口、API与队列空、原有TerryDirector及之前报错插件注册/启动日志。不禁用插件或删日志伪造修复；其他错误如存在须逐项列出。正式注册集合前后对比不能只看总数。
6. 结束停止本轮临时8190，8188保持可用。视频任务、模型生成和 `/prompt` 提交都必须为0。不调用遥测上报、不下载模型。旧cu128及本次cu130备份均保留。

## 7. 提交结果与锁定修复后版本

只在实验目录提交：

```text
reports/13_CU130_DEPENDENCY_REPAIR.md
evidence/cu130_dependency_repair.json
environment/cu130-accepted.constraints.txt  # 仅全部检查通过才新增
```

报告包含：真实冲突原文/元数据归属（纠正摘要但不改旧报告）、实际approved版本与全部diff、核心哈希、plan guard和pip-check输出、目标插件与完整服务结果、备份映射/回退是否执行、生成数0。accepted约束用 `-c cu130-core.constraints.txt` 引用核心，再追加此次已验证的周边精确版本；不能在修复前先标为accepted。完整环境freeze/Conda清单/原始日志与私人路径留本机；公开JSON只保留必要脱敏字段和哈希。

不补写45%速度收益“修依赖后仍保证”或视频画质通过：本轮不生成。之后新的性能测试都记录修复后的环境指纹，不与旧指纹混写。

## 已核对来源和交付侧测试

- PyPI NumPy 2.3.2：https://pypi.org/project/numpy/2.3.2/
- Pydantic 2.11.10的requires_dist：https://pypi.org/pypi/pydantic/2.11.10/json （core==2.33.2）
- Kornia0.8.2源码：https://github.com/kornia/kornia/blob/v0.8.2/kornia/geometry/transform/pyramid.py
- Kornia0.8.2元数据：https://pypi.org/pypi/kornia/0.8.2/json
- Mixpanel官方当前声明：https://github.com/mixpanel/mixpanel-python/blob/master/pyproject.toml ，读取blob `16b5c3a6e1d9d78437fb2508ed88f32e88dc8c0d`；不用于冒认本机安装版本。

交付侧17项合成元数据单测通过，覆盖核心cu128误装、禁止核心重装、反向依赖冲突、core配套、平台marker、Python约束、可选extras边界及重复元数据。脚本语法检查通过。没有访问本机环境或运行真实Windows安装/ComfyUI/GPU；修复尚待本地执行，不是完成报告。
