# TerryDirector 配置节点架构

> 决策日期：2026-10-05  
> 本文覆盖旧的“主节点直接接入全部模型 / 采样输入”形态。 `docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md` 继续保留为历史演进记录；与本文冲突时以本文为准。

## 1. 三个可见节点

画布上使用三个 TerryDirector 节点：

1. **TerryDirector 配置**：集中接收模型、编码器、VAE、尺寸、采样器、SIGMAS 与生成参数，输出一个 `TERRYDIRECTOR_CONFIG`。
2. **TerryDirector**：接收“导演配置”以及主节点自己的原生 Seed 控件，保存创作编排并打开页内导演台；右侧只输出一个 `TERRYDIRECTOR_OUTPUT`，用户可见名称为“导演输出”。
3. **导演输出**：接收“导演输出”，解包并输出标准 `VIDEO / LATENT / IMAGE / AUDIO`。其中 VIDEO 直接由最终合并画面、合并音频和 24fps 通过 ComfyUI 原生 `VideoFromComponents` 构造，不额外写文件、不预编码。

```text
MODEL ─────┐
CLIP ──────┤
VAE ───────┤
Audio VAE ─┤
width ─────┤
height ────┤
sampler ───┤ → TerryDirector 配置 → 导演配置 → TerryDirector → 导演输出
sigmas ────┤                                                   ├─ 视频
参考图尺寸 ┤                                                   ├─ 分段潜变量
二采方案 ──┘                                                   ├─ 合并画面
                                                              └─ 合并音频
```

## 2. 配置节点职责

配置节点只打包运行时依赖，不采样、不解码、不复制模型，也不维护时间线或资产池。

输入呈现完全使用 **ComfyUI 原生 Widget + 原生 socket**。不为配置节点自绘一套输入组件；原生组件本身支持连接，连接后的禁用 / 收起、主题和工作流序列化均由 ComfyUI 管理。

MODEL / CLIP / 视频 VAE / 音频 VAE 使用纯原生接入点，不在配置节点重复加载器选项。分辨率使用 ComfyUI 原生 Resolution Selector 形态：宽高比、百万像素、实时“宽 × 高 / MP”预览，nearest multiple 放高级设置。SAMPLER / SIGMAS 保留原生可连接 Widget，以便简单工作流不必额外堆节点。

ResolutionPreview 使用 ComfyUI 原生默认的可选、socketless 预览输入；它只负责显示计算结果，不参与 Queue 的必需输入校验。

当前输入：

- `MODEL`
- `CLIP`
- 视频 `VAE`
- 音频 `VAE`
- 外接 `width / height`
- `SAMPLER`
- `SIGMAS`
- 参考图尺寸
- 二采方案

二采方案默认“无”。当前可选 `SelfLift`；其放大模型和高清占比属于 SelfLift 专属配置。

“总步数”表示完整采样过程的总步数；SelfLift 使用 `0.0–1.0` 的高清占比滑块，默认 `0.25`。执行层再由 `总步数 × 高清占比` 计算实际高清阶段步数。

音频连续不再是配置项：时间线上相邻片段有重叠时，执行层自动延续音频 latent；无重叠时音频独立；仅首尾贴合时只做视觉尾帧承接。

配置节点输出为内部连线类型 `TERRYDIRECTOR_CONFIG`。该类型只用于配置节点向 TerryDirector 主节点传递运行上下文。主节点另输出 `TERRYDIRECTOR_OUTPUT`，只用于连接配套“导演输出”节点；标准 VIDEO / LATENT / IMAGE / AUDIO 由配套节点向用户暴露。

## 3. 主节点职责

主 TerryDirector 节点左侧只保留一个可见输入：**导演配置**；右侧只保留一个可见输出：**导演输出**。

主节点运行输入为“导演配置 + Seed”；其中 Seed 使用 ComfyUI 原生可连接控件。主节点内部创作 UI 只展示：

- 只读迷你时间线
- 总时长 / 片段排列摘要
- 编辑入口

提示词、资产池、片段时长与时间线几何保存在主节点自己的内部序列化状态；生成参数不再重复保存到主节点。

只支持当前配置 schema。旧版 `config_json`、旧运行参数和旧工作流不做自动兼容或迁移；如未来需要迁移，必须作为单独明确需求实现。

## 4. 页内导演台

导演台继续只负责创作编排：

- 时间线
- 提示词
- 资产池
- 片段时长和重叠
- 保存并退出

导演台浮窗不出现模型、尺寸、Seed、采样器、SIGMAS、SelfLift 或预览设置。Seed 只出现在 TerryDirector 主节点本体；预览继续交给工作流下游独立节点。

## 5. 当前实现状态

已实现：

- 配置节点 schema 与 `TERRYDIRECTOR_CONFIG`
- 主节点可见运行输入为“导演配置 + Seed”
- 创作状态与 runtime 配置分离
- 主节点迷你时间线 / 页内编辑器
- Timeline Compiler：H3 帧对齐、素材局部编号、overlap / tail-frame / gap
- GraphBuilder 原生 H3 分段采样展开
- 图片 / 视频 / 音频参考素材加载；视频参考自动转换为 24fps 帧序列
- 重叠 AddGuide、首尾贴合尾帧 Guide、空隙独立生成
- 合并 IMAGE / AUDIO：H3 尾部裁切、重叠去重、黑帧 / 静音 gap
- 主节点单一 `TERRYDIRECTOR_OUTPUT` 输出
- 配套“导演输出”节点：VIDEO / 分段 LATENT / 合并 IMAGE / 合并 AUDIO
- 标准 VIDEO 由合并音画直接构造，无需额外“创建视频”节点

尚未实现：

- SelfLift 运行链路
- 缓存 / 低显存分块等性能层
