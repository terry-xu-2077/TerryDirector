# SelfLift 内部实现（2026-10-10）

## 当前决定

用户明确要求学习 selflift-Avatar 的机制，自己实现，不依赖其节点。本文件覆盖旧文档中 SelfLift 外部节点调用、安装前提、旧接口兼容和待接入描述；普通 H3 路径及其他功能边界不变。

用户可见连接保持：

```text
TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector / TerryDirector Advanced
```

二采配置不直接接时间线。未连接二采时仍走原生 `SamplerCustomAdvanced`。

SelfLift 分支由本仓库内部的 `TerryDirectorSelfLiftSampler` 执行。它是 `is_dev_only` 的内部展开节点，不要求用户添加或重新接线。运行时不检查、不导入、不调用 `SelfLiftAvatarH3Sampler`，没有旧接口适配或回退到外部节点的路径。

## 模块归属

| 模块 | 职责 |
|---|---|
| `director_selflift.py` | 低清/高清采样协调、边界 Euler 步复用、视频 Lift 与纠偏、音频状态延续、静态遮罩 |
| `director_lift_model.py` | H3 3D 放大权重的本地函数式推理、时间窗口、模型目录注册与 ComfyUI 模型管理 |
| `director_selflift_tiling.py` | 高清空间分块、完整音频与全局位置编码、分块显存预算估计 |
| `director_selflift_node.py` | 本项目内部 V3 节点，调用本项目采样函数 |
| `director_h3.py` | 将时间线片段展开到内部节点，不改变编译器或段间关系 |

底层 H3 去噪器、Euler 采样执行、VAE 和模型装卸继续使用 ComfyUI 核心；本项目负责 SelfLift 的渐进分辨率机制，不重写 H3 主模型。

## 参考依据与差异

参考仓库：`https://github.com/slmonker/selflift-Avatar`。
固定阅读版本：`dc8e545601e3460bde6260c806c6893ce04597c5`。

重点阅读：`nodes.py::progressive_sample`、`selflift.py::artifact_aware_consistency_lift`、`h3_upscaler.py`、`h3_tiling.py`、`avatar_masks.py`、`avatar_sampling.py`。这些是算法和模型格式参考，不是运行依赖。

实现是在阅读上述机制后重写的本地代码，不是重命名原节点，也没有把原插件作为 vendor 包打入项目。不声称未经阅读原实现的 clean-room 开发，不声称 GPU 结果与原插件逐位一致。参考仓库该版本未提供顶层 LICENSE；本次没有将其整个源码或插件分发进仓库，也不为它声明不存在的许可。

主要实现差异：放大模型通过 checkpoint 键描述驱动函数式计算，不复制参考插件的模型类；静态遮罩与动态遮罩冲突时明确报错；音频专用 Guide 可缺少 video latent；像素锚点采用 CPU fp32、8 帧一批的 bicubic 放大，而非参考实现的 GPU 工作类型/32 帧分块。默认 `rho=0` 不运行这条像素锚点路径。

## 采样状态交接

令 `k=transition_step`。总日程为 `sigmas`，总 NFE 为 `len(sigmas)-1`。

低清阶段执行前 k 次模型求值。捕获第 k 次求值的输入状态和 clean prediction，并复制到本项目持有的缓冲，避免采样器随后原地修改回调 Tensor。

视频的 clean prediction 先从模型 latent 格式转到 VAE latent 格式，再通过所选 H3 learned upscaler 提升到目标 H/W；时间长度保持不变。需要像素纠偏时，另外执行低清解码、像素放大、VAE 重编码形成锚点。

直接 Lift 与像素锚点的通道平均绝对残差作为风险分数，在每个 batch 样本的可生成区域中选取最高 rho 比例的位置，按 w_min/w_max 进行局部纠偏。rho=0 跳过像素锚点；rho=1 且 w_min=w_max=1 跳过直接 Lift。

复用的 Euler 更新为：

```text
x_next = x + ((sigma_next - sigma) / sigma) * (x - x0)
```

视频在提升后的 clean endpoint 上使用 `(seed+1) mod 2^64` 的噪声重建边界状态，再完成上述 Euler 区间。音频则直接对原边界音频状态完成相同区间，不做空间放大、不重新抽取音频噪声。

高清阶段恢复前，去掉原生采样入口会重新施加的 noise scaling，并提供全零新增噪声，避免双重加噪。其后从 `sigmas[k:]` 继续，低清 k 次加高清 N-k 次，不额外多跑一次完整采样。

低清阶段只缩放目标网格的 keyframe latent，并保留每帧每通道均值；高清阶段重新使用原始目标分辨率 conditioning。参考图、参考音频和时间线 continuity 编译不改动。

## 参数、模型与缓存

默认仍取用户工作流：CFG=1、低清5步、低清比例0.5、rho=0、w_min=0.5、w_max=1；Euler/simple、基础6步、Sigma 精修增加1步、起始0.7/结束0/cosine；高清分块关闭。实际精修是否增加步数取决于日程中是否存在对应精修区间，最终 Sigma 会校验。

模型仍由用户提供：

```text
ComfyUI/models/latent_upscale_models/minimax_h3_latent_upscaler_3d_fp16.safetensors
```

不需要安装 `selflift-Avatar`。本项目自行注册目录并保留已配置的额外模型路径。模型文件不是插件依赖；它仍是 learned Lift 的必要权重。权重的授权和获取不因本次代码改写而改变。

分辨率、主 MODEL、CLIP、两种 VAE 继续由导演配置提供，Seed 继续由时间线提供。可选高清 MODEL 留在二采节点；两阶段模型必须匹配 H3 架构、latent 格式与 conditioning。SelfLift 日程由二采节点控制，普通采样器设置不控制 SelfLift。

模型加载使用 ComfyUI 核心模型管理，放大权重缓存最多保留一个键。正常任务不强制清空所有模型；由原生内存预算决定装卸，不另起后台服务。

内部引擎版本 `terry-selflift-v1` 进入 SelfLift 缓存签名；不能将旧外部后端的中断缓存当作当前结果继续恢复。切换后请先做一次新完整短任务。MODEL 在内部图里保留顶层输入，避免 Advanced 预览补丁的图连接被藏进字典而无法解析。

## 高清分块边界

支持 auto 和 manual 2/4/6/8，沿宽/高或较长侧切条；小目标可能减少实际块数，auto 也可能选择不拆分。保持原始全局 token 位置，空间裁切 Guide，每块收到完整音频，只保留首块音频预测。

分块仅接受无遮罩，或视频全生成/音频全保留。局部视频、软遮罩、部分音频遮罩须关闭分块。实际拆分时不支持 ControlNet，明确报错，不静默改变条件。自动显存预算只是估计，不保证不会 OOM，不自动重试或改参数。

## 已验证与未验证

执行了 `tests/test_selflift_runtime.py` 的 51 项 CPU 检查，全部通过；本轮环境 PyTorch 2.10.0+cpu。生产 Python 文件及测试文件通过语法编译。

覆盖真实张量数学、AV 边界状态交接、种子溢出、回调缓冲所有权、遮罩、keyframe 缩放、分块覆盖/全局位置、模型目录独立注册、内部图路由，以及使用小型合成 checkpoint 与独立 nn.Module 方程对照的本地放大推理。

ComfyUI 原生采样、模型管理、PackedLayout 和 VAE 在测试中使用替身。没有加载真实 H3 或真实放大模型权重，没有启动完整 ComfyUI，没有 GPU/显存、实际视频画质/音频、前端和完整仓库回归结果。因此这些测试不构成用户机器上的采样验收。

本机验收步骤见 `docs/28_SELFLIFT_SECOND_PASS_TEST.md`。不引入提示词增强、DLSSNR、DLSS、补帧、独立预览界面或新的时间线交互。
