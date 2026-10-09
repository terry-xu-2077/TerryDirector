# 内置 SelfLift · 本地验收

2026-10-10。此版覆盖此前要求安装 selflift-Avatar 的验收说明。
实现与来源见 `30_SELFLIFT_INTERNAL.md`。不安装外部采样插件，不引入提示词增强或 DLSSNR。

## 结构与准备

```text
TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector / TerryDirector Advanced
```

切换到 `feat/selflift-internal` 分支后重启 ComfyUI 后端并刷新页面，无需运行补丁安装脚本。
二采节点仍使用原有参数布局。
确认 `models/latent_upscale_models/` 中有自己的 H3 latent 放大权重并已在新节点中选中。
普通模型、CLIP、音画 VAE 和分辨率仍在导演配置；Seed 仍在导演时间线。

## A · 不依赖外部插件

在没有启用 selflift-Avatar 的测试实例中启动，不需要卸载它在其他工作流里的使用。
确认能够创建二采配置、连接三级节点、看到放大模型列表、通过任务验证。
展开图应出现 `TerryDirectorSelfLiftSampler`，不出现外部同名采样器。
控制台应出现 `[TerryDirector SelfLift] engine=terrydirector-selflift-v1`。

## B · 普通采样回归

不接二采配置，单段 4 秒、0.2MP，确认仍走 `SamplerCustomAdvanced` 并正常输出音画。

## C · SelfLift 单片段

连接二采配置。保持默认参数、高清分块关闭，先用 4 秒 / 0.2MP。
确认控制台的低清/高清步数及分辨率，最终分辨率等于导演配置目标值。
确认输出包含完整 H3 AV latent，音频不丢失、时长不改变，画面无异常。
此步通过后再用自己的常用目标分辨率检查效果。

## D · 多段衔接

测试三个短片段，分别覆盖尾帧参考、尾帧续接及重叠 Guide。
确认连续性输入仍连接、没有 Guide 空间尺寸报错、最终音画裁切/合并和总时长正常。

## E · Advanced

检查短片段的无损缓存、最终输出、选中片段局部重跑、中断后恢复。
新引擎签名与旧外部方案不同；不要期望直接恢复旧方案的中断缓存。

## F · 可选高级路径

基础路径通过后，再分别测试高清分块、兼容的第二个高清模型、rho>0 的像素锚点。
不要一次打开所有选项。auto 分块实际块数以控制台为准；内存估算不保证不 OOM。
带 mask 的分块仅支持全视频生成、全音频保留，暂不支持 ControlNet 分块。

## 报告

在 `29_SELFLIFT_SECOND_PASS_REPORT.md` 记录实际测试结果，不预先填“通过”：
实际代码版本、A–F 状态、模型和放大器名称、参数、分辨率、时长、完整报错、
音画结果及观察到的显存/耗时。不必先跑长任务或大规模性能比较。
