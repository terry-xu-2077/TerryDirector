# 内置 Self-Lift 主分支发布与已验收默认值

日期：2026-10-10。用户明确授权将最新 Self-Lift 合并到主分支，并采用最近成功运行的默认参数。
合并准备读取的主分支为 `b7b72de811677438fc28a9983a59e068fb12aeec`，功能分支为 `7033fb03d0be32fd5d1c945562c1c449c7b33ba2`；后者领先45个提交，无分叉。最终合并提交及状态以 Git / PR 记录为准。

## 1. 合并范围

内置采样器、数学核心、潜空间放大器、可选高清分块、二采配置接线及已有测试/验收历史随 `feat/selflift-internal` 合入 `main`。不再依赖外部 `SelfLiftAvatarH3Sampler`，不重新引入提示词增强、DLSSNR 或补帧节点。

```text
TerryDirector 二采配置
        ↓
TerryDirector 配置
        ↓
TerryDirector / TerryDirector Advanced
```

保持原生节点容器、当前时间线 UI、Guide、Base/Advanced 输出与无损缓存架构。不接二采配置时仍走原普通采样，不自动启用 Self-Lift。

Sol、桥接节点及实验工具的源码/报告随分支历史保留在实验目录，但正式根 `__init__.py` 不导入该实验扩展。合并不是植入 Sol，不修改既有 MODEL 后端选择，不将实验节点注册进日常导演链。原诊断保持 opt-in，默认关闭；不因合并启动实验服务、执行安装或排队生成。

## 2. 默认参数：采用成功的 Self-Lift 预设，不采用普通四步任务参数

本次核对了 `director_node.py:TerryDirectorSecondPassConfig.define_schema`、`_prepare_second_pass_runtime` 与 `director_core.py` 的二采配置归一化。原代码默认值已经与下表一致，保留原实现，不为了发布重新改采样数学或覆盖已有工作流值。

| 字段 / 行为 | 发布默认值 |
|---|---|
| cfg | 1.0 |
| sampling_steps | 6 |
| transition_step | 5 |
| lowres_scale | 0.5（宽高比例） |
| sampling_denoise | 1.0 |
| sampler / scheduler | euler / simple，由二采运行配置准备 |
| upscaler_model | 节点优先选择已安装的 `minimax_h3_latent_upscaler_3d_fp16.safetensors` |
| rho | 0.0 |
| w_min / w_max | 0.5 / 1.0 |
| sigma_refine_enabled | true |
| sigma_refine_extra_steps | 1 |
| sigma_refine_start / end | 0.7 / 0.0 |
| sigma_refine_spacing | cosine |
| highres_tiling | false |
| tiling_mode / tiling_tiles / tiling_axis | auto / 2 / auto（分块关闭时不启用） |
| high_res_model | 可选，不接时复用导演配置的主模型 |

上表与最初参考附件的 Self-Lift 参数一致，并继续用于后来已经成功的导演及 cu130 独立测试；不能把最新九段普通任务的 res_multistep / 4步 / Seed9误设为Self-Lift默认值。

在已测试H3模型的实际日程中，基础6步产生7个Sigma；精修起始0.7未命中可插步的非终点位置，因此仍是**低清5步＋高清1步**。保持精修预设，不人为改成5+2；实际求值次数按生成的Sigma日程与回调验证，不对其他模型的日程作无条件保证。

目标尺寸仍属于导演配置。成功的高清验收尺寸为1920×1088，不裁上下像素；不把该尺寸写成所有普通生成的强制默认。Seed仍属于时间线；成功单段测试的Seed1000不是全局默认值修改。主模型、LoRA、CLIP和两种VAE仍由上游加载器提供，不写死本机资产路径或替换用户权重。

## 3. 成功的 MODEL 接线与环境

针对已验证的 RTX3090 Self-Lift 请求，保留可复用接法：

```text
原 Ref2VA INT8 模型 → 原 LoRA → ModelAttentionBackend（comfy kitchen attention）
→ MiniMaxLowVRAMAttention（head_chunks=4）
→ MiniMaxChunkFeedForward（chunks=2，seq_threshold=4096）
→ TerryDirector 配置.model
```

这是成功测试的上游配置，不是二采节点自动安装/注入的算法。普通工作流可以继续保留原 Sage；不能把固化cu130理解为自动切换全局注意力。前馈分块来自已成功规避OOM的请求；此接法也不保证任意片长和资产数都不OOM。

已验收环境依据 [环境基线](../experiments/acceleration_lab/ENVIRONMENT_BASELINE.md) 与 [周边依赖验收13](../experiments/acceleration_lab/reports/13_CU130_DEPENDENCY_REPAIR.md)：Windows / Python3.12.13，Torch2.11.0+cu130、torchvision0.26.0+cu130、torchaudio2.11.0+cu130；Kitchen0.2.37，Sage和Triton保持已有核心约束。NumPy2.3.2、Pydantic2.11.10、pydantic-core2.33.2为本机已修复周边版本。约束入口为 `experiments/acceleration_lab/environment/cu130-accepted.constraints.txt`。

本次Git合并不安装或重建本机环境，不删除cu128或修复前cu130备份。LTX/Kornia排除项及pyproject解析警告仍以报告13为准，不宣称整个插件环境零问题。

## 4. 验收依据与本次复核

- [报告34](34_SELFLIFT_MLP_OOM_RETEST_REPORT.md)：三段Self-Lift完整生成并获用户画面认可；该运行位于旧环境，不拿其时间作为cu130固定性能承诺。
- [报告46](46_SELFLIFT_KITCHEN_ATTENTION_CLIP1_REPORT.md)：导演节点Kitchen单段成功及用户画面确认，作为正式接线参考。
- [实验报告09](../experiments/acceleration_lab/reports/09_SOL_CU130_INSTANCE_RETRY.md) 与 [验收10](../experiments/acceleration_lab/reports/10_SOL_CU130_VISUAL_ACCEPTANCE.md)：cu130密集Self-Lift及Sol实验候选均跑通，B0/B1画面均获用户确认。使用的是同一Self-Lift数学核心；实验Sol不因通过而自动成为正式默认。
- [报告11](../experiments/acceleration_lab/reports/11_CU130_9CLIP_50S_NO_UPSCALE.md) / [验收12](../experiments/acceleration_lab/reports/12_CU130_9CLIP_VISUAL_ACCEPTANCE.md)：九段50秒普通生成及画质确认。这不是九段Self-Lift验收，也不改变二采步数。

本次合并准备重新运行47项 `test_selflift_internal.py` CPU检查，全部通过。用于复测的5个运行模块和测试文件均逐个核对Git blob SHA，与功能分支一致：

```text
director_selflift.py           3a4cd32087d505b366a7efca4370d0c2ecad8767
director_selflift_math.py      96d6042807ceca4608fe01428ccde566f303a960
director_selflift_node.py      e4633db7744dcfccbb84d0a18a6a9a77ed685660
director_selflift_tiling.py    663c955528abba1e19541a1ae1324495ae74a76c
director_selflift_upscaler.py  a2a146347ec3d39bd97d7019d98267ce639bd3dd
tests/test_selflift_internal.py 6031b050da59631191554b2b8458e100dec8fc5b
```

当前复测环境是Linux/CPU、合成Comfy/denoiser/VAE接口；不是Windows完整ComfyUI，也不是新增GPU生成。未重新运行完整仓库测试集。正式默认值及根注册入口另作源码复核；UI/工作流既有显式值没有改写。本次准备提交只更新README和本发布说明，生产运行源码与已测分支完全相同。

既有声音/同步未单独人工确认的部分保留其原状态；单段与三段结果不泛化为任意时长或全部高级参数的保证。默认高清分块关闭，不能把未测试的可选分块组合称为全面验收。

## 5. 更新使用

在已有仓库先保留未提交修改，然后 `git fetch origin`、`git switch main`、`git pull --ff-only origin main`，重启ComfyUI并刷新前端。新增二采节点使用上述默认值；已有节点保存的参数保持用户原值。无需重新执行补丁脚本，也无需让本地Codex再次合并。功能分支与原始验收记录保留，不做强制覆盖、清理历史或自动生成。
