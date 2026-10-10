# TerryDirector 内置 SelfLift

日期：2026-10-10。目标基础提交：`b7b72de811677438fc28a9983a59e068fb12aeec`。
交付分支：`feat/selflift-internal`。源码直接纳入仓库，无需应用补丁脚本；`main` 保持不变。
本文覆盖旧文档中 SelfLift 尚未接入、依赖外部采样节点及旧二采参数归属的说明。

## 用户确认的边界

```text
TerryDirector 二采配置
          ↓ 二采配置
TerryDirector 配置
          ↓ 导演配置
TerryDirector / TerryDirector Advanced
```

学习参考仓库的采样原理，由 TerryDirector 自己实现；不是调用外部节点的包装。
不要求安装 selflift-Avatar，不读取它的 `NODE_CLASS_MAPPINGS`，不动态加载其目录，
不保留外部节点作为 fallback，不注册同名节点覆盖其他插件。

二采节点继续负责 SelfLift 专属参数，导演配置继续负责主模型、CLIP、VAE、
目标分辨率，时间线继续负责 Seed 和创作编排。浮窗 UI 不变。

## 实现文件

| 文件 | 责任 |
|---|---|
| `director_selflift_math.py` | Sigma 校验、仅空间缩放、Guide 适配、Euler 边界、风险修正、静态 AV mask |
| `director_selflift.py` | 本仓库的两阶段采样与 ComfyUI 原生接口适配 |
| `director_selflift_upscaler.py` | H3 3D checkpoint 格式推理、权重加载、时间窗口、专属放大器卸载 |
| `director_selflift_tiling.py` | 可选高清空间分块、位置编码、完整音频上下文、内存估算 |
| `director_selflift_node.py` | 自有内部执行节点 `TerryDirectorSelfLiftSampler`，`is_dev_only=True` |

内部节点由 GraphBuilder 展开使用，不要求用户再摆放一个采样器。公开接线仍只有上方三级。

`director_node.py` 删除外部节点存在性检查、current/legacy API 检测与对应字段；
放大模型列表由自己的代码注册和读取。`director_h3.py` 改为展开自有内部节点。
`__init__.py` 注册该内部节点。普通 `SamplerCustomAdvanced` 分支不变。

SelfLift 签名加入 `engine=terrydirector-selflift-v1`，避免把外部方案留下的缓存
视为相同实现。没有改写 Advanced 的缓存或时间线编译架构。

## 采样原理

一个 Sigma 日程包含 N 个 Euler 步骤。前 k 步在低分辨率视频 latent 上进行，
剩余 N-k 步在目标分辨率上继续。这里按采样回调计数，不是测量 CFG 下底层前向
调用次数。不会先完整采样，再额外完整跑一次。

低清最后一次回调保存 **更新前的状态 x 与干净预测 x0**。切换时：

1. 把视频 x0 从模型空间转回 VAE latent 空间。
2. 默认使用学习式 H3 latent upscaler 把它提升到目标空间尺寸；时间维、batch 和通道数不变。
3. rho>0 且 w_max>0 时，额外执行低清 VAE 解码 → 像素放大 → VAE 编码，
   建立像素锚点。以通道平均绝对差作为风险，按每个 batch 的分位数选取位置并插值修正。
4. 在切换区间的起始 Sigma 对高清干净预测重新加噪，复用这一预测完成当前 Euler 区间；
   不增加一次额外的模型求值。
5. 音频继续完成相同 Euler 区间，不做空间放大、不重新初始化、不注入新的独立音频噪声。
6. 撤销采样入口将再次施加的信号缩放，以零新增噪声恢复到下一个 Sigma，继续高清采样。

Guide 在低清阶段按帧做空间缩放并匹配均值；原始目标分辨率 Guide 留给高清阶段。
参考图的独立 latent 网格不随着生成网格缩放。没有改写 H3 内部音频/视频 Sigma 映射。

默认 rho=0，跳过像素/VAE 往返。rho=1、w_min=1 的纯像素锚点路线跳过直接 latent lift。
有静态 mask 时使用干净内容作为 inpaint anchor，结束时只还原精确的 mask=0 区域，
避免对软 mask 再混合一次。

## 保留的工作流预设

| 参数 | 值 |
|---|---|
| CFG | 1 |
| 低清阶段步数 | 5 |
| 低清比例 | 0.5 |
| 基础采样步数 | 6 |
| 采样器 / 调度器 | Euler / simple |
| H3 Sigma 精修 | 开，加 1 步，起始 0.7、结束 0、cosine |
| rho / w_min / w_max | 0 / 0.5 / 1 |
| 高清分块 | 关 |
| 分块模式 / 手动块数 / 方向 | auto / 2 / auto |

目标放大权重：`minimax_h3_latent_upscaler_3d_fp16.safetensors`，放在
`ComfyUI/models/latent_upscale_models/`。权重不是节点插件，仍由用户提供。
本实现不下载权重，不复制示例的主模型/LoRA 配置，不加入提示词增强、DLSSNR、
DLSS 放大或补帧。

## 分块与显存边界

高清分块只切空间方向；每块都得到完整音频和音频条件，使用原全图的位置坐标。
视频预测羽化拼接；无 mask 的生成音频采用第一块的预测，因此它是近似方案，
不是与全图前向逐值等价的方案。默认关闭。

带 mask 的分块只支持全视频生成、全音频保留；不支持局部视频保留、部分音频保留
或 ControlNet 的分块组合，会明确报错，不静默丢条件。

auto 依据当前模型管理器和原生内存估算选择 1–8 块；manual 不自动改用户块数。
小尺寸可能只能形成更少的实际块数，实际值写入控制台。估算不保证不 OOM，
不进行隐式 OOM 重试。累加画面放在 CPU；未改变完整音画 latent 的尺寸。

H3 upscaler 使用一个 CPU 可复用权重缓存；推理结束或异常后，沿 ComfyUI 0.39
`LoadedModel.model_unload()` 生命周期只卸载本次放大器，不卸载用户全部模型。
权重格式、空间上采样和时间窗口由本仓库实现。超过 32 个 latent 时间位置时使用
带上下文的时间窗口与羽化；不宣称它等于不分窗口的计算结果。

## 原理与接口参考

下列是学习和接口核对来源，不是运行依赖，也不是把整包参考源码改名内嵌：

- `slmonker/selflift-Avatar`，固定提交
  `dc8e545601e3460bde6260c806c6893ce04597c5`。
  https://github.com/slmonker/selflift-Avatar/tree/dc8e545601e3460bde6260c806c6893ce04597c5
- `nodes.py`：两阶段 Euler 状态、最后一次预测复用、音频承接、零新增噪声恢复。
- `selflift.py`：paired lifts、像素/VAE anchor、通道差异风险和分位数修正。
- `h3_upscaler.py`：H3 checkpoint 层命名/架构、VAE mean/std、时间窗口约定。
  其说明指向 `LBH-123-AI/Minimax_h3_latent_Upscaler`。
- `h3_tiling.py`：H3 PackedLayout 的全图位置保留、全音频上下文和空间分块约束。
- `avatar_sampling.py`：ComfyUI 原生 inpaint anchor 与恢复状态需要分开。
- ComfyUI `v0.39.0`：核对 `comfy/model_management.py` 的模型生命周期，
  `comfy/ldm/minimax/model.py` 的 H3 音画布局。依然使用宿主 ComfyUI 的采样、VAE、
  NestedTensor、模型管理和 GraphBuilder，而非自己替换 ComfyUI。

不宣称 SelfLift 算法、H3 模型或 checkpoint 架构由 TerryDirector 首创。

## 本轮验证

PyTorch `2.10.0+cpu`。本次分支交付前复跑 47 项内部 CPU 检查和 9 项原补丁/接线检查，均通过。
上传后核对 Git blob SHA，五个新增运行模块与已测试包的源码字节一致。
主要覆盖：两阶段实际求值次数、音频连续 Euler 轨迹、信号不重复缩放、Guide
不原地修改、默认不走像素 VAE、纯锚点/混合路线、可选高清模型、Seed 溢出回绕、
中断与错误传播、静态 mask、空间分块覆盖、时间窗口覆盖、目录注册、定向卸载、
内部节点 schema、自有执行节点接线与普通采样分支。

检查使用真实 PyTorch 张量、合成降噪器、合成 VAE、小型随机 checkpoint，以及
ComfyUI 接口替身。原补丁/接线检查使用已读取代码的结构片段和临时目录，
不将补丁安装脚本或其安装测试纳入运行仓库。
**没有运行完整 ComfyUI、真实 H3 权重、真实 latent upscaler 权重、GPU 生成或前端。**
没有完成全仓库回归，也不把这些检查当成画质、口型、性能或显存的实机验收。

拉取分支后在仓库复跑：

```bash
python -m unittest discover -s tests -p "test_selflift_internal.py" -v
python -m unittest discover -s tests -p "test_selflift_runtime.py" -v
```

第二条是此前仓库的隔离检查，已更新其节点名/模型输入断言；本次交付未在完整
仓库重新执行这条旧测试。实机流程见 `28_SELFLIFT_SECOND_PASS_TEST.md`。
