# SelfLift 二采实装 · 本地验收

> 目标：验证新拓扑与 selflift-Avatar 的真实采样链。  
> 不跑 50 秒长任务；先用短片段确认功能和质量。

## 节点拓扑

```text
TerryDirector 二采配置
        ↓ 二采配置
TerryDirector 配置
        ↓ 导演配置
TerryDirector / TerryDirector Advanced
```

不连接“二采配置”时，保持原生 TerryDirector 采样链不变。

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

1. Prompt 可以通过验证，不出现 SelfLift 输入名错误。
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

确认 selflift-Avatar 能显示实际 tiling plan 并完成一次短片段。

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
