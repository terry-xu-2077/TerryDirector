# SelfLift 内部实现 · 本地验收

> 2026-10-10：本文件取代先前要求安装 selflift-Avatar 的验收说明。当前 SelfLift 已由 TerryDirector 自己实现。

## 接线与准备

```text
TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector / TerryDirector Advanced
```

二采配置不直接接时间线。不接二采仍走普通原生采样。更新后重启 ComfyUI 后端并刷新前端。

本轮需要验证“不安装外部 SelfLift 插件也能运行”。可以在测试环境禁用 `selflift-Avatar` 后重启；无需删除其他工作流还在使用的插件。无论外部插件是否存在，本项目都不再调用它。

保留模型文件，并在二采配置中选中：

```text
ComfyUI/models/latent_upscale_models/minimax_h3_latent_upscaler_3d_fp16.safetensors
```

目录由 TerryDirector 自己注册。如果只看到 none，请检查该文件；默认 rho=0 时必须选择放大模型。

目标分辨率、主模型、CLIP、视频/音频 VAE 仍归导演配置，Seed 仍在时间线。高清模型不连接时使用主模型。SelfLift 采用二采节点自己的步数/精修和固定 Euler/simple，不使用导演配置中普通采样的步数或采样器。

## 默认参数

保持 CFG=1、低清阶段5步、低清比例0.5、rho=0、w_min=0.5、w_max=1、基础步数6、Sigma 精修开启且加1步（0.7→0，cosine）、高清分块关闭。

不要同时调整多个参数。代码原理与已知边界见 `docs/30_SELFLIFT_INTERNAL.md`。

## A：启动与独立性

确认 TerryDirector 无导入/注册错误，三级接线可用，放大模型菜单正常。内部图应出现 `TerryDirectorSelfLiftSampler`，不再出现外部 `SelfLiftAvatarH3Sampler`。内部节点无需手工添加。

## B：普通路径回归

不连接二采配置，0.2MP、单片段4秒、固定 Seed。确认仍由 `SamplerCustomAdvanced` 完成，画面、音频和输出端口正常。

## C：内部 SelfLift 单片段

连接二采配置，仍用0.2MP/4秒和默认参数，高清分块关闭。应看到：

```text
[TerryDirector SelfLift] backend=terry-selflift-v1 ...
[TerryDirector SelfLift] latent upscaler=...
[TerryDirector SelfLift] complete: low=... high=...
```

确认低清→Lift→高清能走完，最终尺寸为导演配置的目标尺寸，音频和实际输出时长正常。若失败保留完整 traceback 和上述日志，先不要改参数规避错误。

## D：连续片段

使用3个短片段，分别覆盖尾帧参考、尾帧续接或已验证过的重叠结构。确认各段走内部 SelfLift，上一段 Guide 能进入下一段，Base 合并音画正常，没有改变 gap/挂起片段语义。

## E：Advanced

先 preview off，以3个短片段做新的完整任务，再测试一次局部重跑。确认 LATENT 缓存、无损片段缓存和最终编码正常。然后再单独打开原有预览检查；本次没有新增预览插件依赖。

更换内部引擎后不要直接恢复旧外部后端的中断缓存；引擎版本已进入签名，旧缓存被拒绝是预期行为。新任务完成后才测试当前引擎的中断恢复。

## F：高清分块（最后）

A–E 通过后才开启，先 auto。不改其他参数，查看日志中的实际块数、方向和显存估计。auto 可能选择1块；需要明确验证拆分时再单独试 manual 2。

有局部视频/软遮罩/部分音频遮罩时关闭分块；实际拆分不支持 ControlNet。自动规划不能保证不发生 OOM。

## CPU 检查范围

```bash
python -m unittest discover -s tests -p "test_selflift_runtime.py" -v
```

本轮51项通过，使用 PyTorch 2.10.0+cpu，测试真实张量数学和小型合成权重；原生采样、VAE、模型管理等用替身。不是完整 ComfyUI、真实 H3/放大权重、GPU 或画质测试。A–F 的实机结果尚未取得。

## 结果记录

本地报告写到 `docs/29_SELFLIFT_SECOND_PASS_REPORT.md`。记录节点提交、ComfyUI 版本、外部插件是否禁用、权重文件、A–F结果、实际低清/高清步数、耗时、画面/音频情况及 traceback。先短任务，不跑50秒任务，不宣称与参考插件画质或速度一致。
