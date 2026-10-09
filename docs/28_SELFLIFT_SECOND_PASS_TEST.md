# SelfLift 二采实装 · 本地验收

> 目标：验证新拓扑与 selflift-Avatar 的真实采样链。  
> 不跑 50 秒长任务；先用短片段确认功能和质量。

## 2026-10-10 接入检查

本轮检查发现主分支已经有 SelfLift 接入，因此保留现有实现，不重复重写采样器。

- `eaa2479`：修复 `director_node.py` 缺少模块级 `import torch`。原先默认开启 Sigma 精修时，`_refine_sigmas()` 会触发 `NameError`；其他函数内部的局部导入不能解决这个问题。
- `fc52938`：新增 `tests/test_selflift_runtime.py`，共 16 项 CPU 隔离检查。覆盖默认日程、三种精修分布、精修关闭、参数校验、切换边界、部分配置的缓存签名变化、新版 SelfLift 输入传递及关闭二采时的原生采样路径。
- 本轮使用从仓库读取的对应 helper 源码执行隔离检查，PyTorch `2.10.0+cpu`，16 项通过；移除模块级 torch 导入后能复现原错误，再恢复修复后通过。
- 调度器和 GraphBuilder 使用测试替身。测试不启动完整 ComfyUI，不运行真实 H3 模型，不代表完整仓库测试、GPU 生成、前端、连续性画质或显存验收已经通过。下面 Case A–F 仍需本机验证。

在完整仓库中复跑这组检查：

```bash
python -m unittest discover -s tests -p "test_selflift_runtime.py" -v
```

测试脚本读取仓库实际函数 AST 与生产文件自身的 torch 导入，不向被测函数注入 torch，以免掩盖缺失导入。

## 节点拓扑

```text
TerryDirector 二采配置
        ↓ 二采配置
TerryDirector 配置
        ↓ 导演配置
TerryDirector / TerryDirector Advanced
```

二采配置只接导演配置，不直接接导演时间线。时间线仍只接收一个导演配置包。
不连接“二采配置”时，保持原生 TerryDirector 采样链不变。

## 环境准备与参数归属

确认已安装并启用 `slmonker/selflift-Avatar`，建议更新其 main 分支后重启 ComfyUI 后端并刷新前端。
Latent 放大模型放在 `ComfyUI/models/latent_upscale_models/`，在二采配置中确认选中：

```text
minimax_h3_latent_upscaler_3d_fp16.safetensors
```

如果菜单只有 `none`，先检查模型目录与文件；默认 `rho=0` 时本项目会拦截未选择放大模型的配置。

分辨率、主模型、CLIP 与两种 VAE 仍归导演配置；Seed 仍归导演时间线。二采配置可额外接高清模型，不连接时复用导演配置的主模型。

接入二采配置后，本轮 SelfLift 使用二采节点的基础步数与精修设置，以及固定 Euler / simple 日程；导演配置中的普通采样器、总步数与调度器不控制该 SelfLift 日程。不接二采时它们继续控制普通采样。

SelfLift 是整段的“低清采样 → 潜空间提升 → 高清继续采样”路径，不是普通完整采样结束后再额外跑一遍采样。不会引入示例中的提示词增强、DLSSNR、DLSS 放大或补帧。

## 默认参数

新节点默认按用户提供的成熟 SelfLift 工作流：

- CFG = 1
- 低清阶段步数 = 5
- 低清比例 = 0.5
- Latent 放大模型优先选择 `minimax_h3_latent_upscaler_3d_fp16.safetensors`
- rho = 0
- w_min = 0.5
- w_max = 1
- SelfLift 基础步数 = 6
- Euler 固定
- simple Sigma
- H3 Sigma 精修 = 开
- 精修加步 = 1
- 起始 Sigma = 0.7
- 结束 Sigma = 0
- spacing = cosine
- 高清分块 = 关
- tiling = auto / 2 / auto

SelfLift 采样直接调用已安装的 `SelfLiftAvatarH3Sampler`，不复制 selflift-Avatar 源码。

## Case A：启动与节点结构

重启 ComfyUI，确认：

1. TerryDirector 无 import / registration 错误。
2. 可以新建 `TerryDirector 二采配置`。
3. `TerryDirector 配置` 中原来的“二采方案 / SelfLift 放大模型 / 高清占比”三个控件已经消失。
4. `TerryDirector 配置` 出现“二采配置”输入。
5. 新拓扑可以正常连接。

如果本机 selflift-Avatar 使用新版接口，应识别 `low_res_model/high_res_model`；旧版 `model/model_hires` 也做了兼容。

## Case B：不接二采配置的基线回归

0.2MP、单片段 4 秒或现成短工作流。

确认：

- 原生 TerryDirector 正常完成；
- expanded graph 仍走 `SamplerCustomAdvanced`；
- 输出画面/音频正常。

只需要跑一次，确认新节点没有影响旧链。

## Case C：SelfLift 单片段

连接：

```text
TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector
```

先保持新节点默认参数、高清分块关闭。

确认：

1. Prompt 可以通过验证，不出现 SelfLift 输入名错误或 `torch` 未定义错误。
2. expanded graph 采样节点为 `SelfLiftAvatarH3Sampler`，不是原来的 `SamplerCustomAdvanced`。
3. 控制台能看到 selflift-Avatar 的 low/high resolution 计划日志。
4. 最终 IMAGE / AUDIO 正常。
5. 画面分辨率是导演配置目标分辨率，不是低清阶段分辨率。
6. 音频正常，不丢失、不截断。

如果失败，保留完整 traceback，不改参数，直接修集成。

## Case D：3 段连续性

0.2MP，3 个短片段，使用当前已有 tail_reference / tail_continuation 测试时间线。

确认：

- 三段都走 SelfLift；
- 上一段尾帧/重叠上下文仍能正常进入下一段；
- 最终 Base 合并 IMAGE/AUDIO 正常；
- 没有因为 SelfLift 改坏 suspended / gap / overlap 现有语义。

## Case E：Advanced

同样 0.2MP / 3 段 / preview off。

确认：

- SelfLift + Advanced 无损 segment cache 可以同时工作；
- 最终仍只做一次视频/音频编码；
- LATENT checkpoint 保留；
- lossless pixel cache 完成后删除；
- 局部重跑至少选 1 段执行一次，确认 SelfLift 设置已进入缓存签名，不误复用旧采样结果。

## Case F：高清分块（最后再测）

只有 A–E 全部通过后：

- 开启“高清分块”
- 先用 `auto`
- 不改其他参数

检查控制台中的实际 tiling plan 并确认能完成一次短片段。内部展开节点的原插件状态面板不作为本轮 UI 验收前提。

不需要为了本轮测试手动尝试 2/4/6/8 全部组合。

## 报告

结果写入：

```text
docs/29_SELFLIFT_SECOND_PASS_REPORT.md
```

只记录：

- Case A–F 通过/失败；
- 实际识别到的 SelfLift API（current / legacy）；
- 单片段与 3 段 Prompt total；
- 是否成功使用目标 latent upscaler；
- 画面/音频是否正常；
- traceback（如有）；
- 最终 commit hash。

不要跑 50 秒任务，不做性能 A/B。
