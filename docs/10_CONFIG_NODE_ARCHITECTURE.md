# TerryDirector 配置节点架构

> 决策日期：2026-10-05  
> 本文覆盖旧的“主节点直接接入全部模型 / 采样输入”形态。 `docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md` 继续保留为历史演进记录；与本文冲突时以本文为准。

## 1. 两个可见节点

画布上使用两个 TerryDirector 节点：

1. **TerryDirector 配置**：集中接收模型、编码器、VAE、尺寸、采样器、SIGMAS 与生成参数，输出一个 `TERRYDIRECTOR_CONFIG`。
2. **TerryDirector**：只接收一个“导演配置”输入，保存创作编排并打开页内导演台，输出分段 LATENT 列表、合并 IMAGE 和合并 AUDIO。

```text
MODEL ─────┐
CLIP ──────┤
VAE ───────┤
Audio VAE ─┤
width ─────┤
height ────┤
sampler ───┤ → TerryDirector 配置 → 导演配置 → TerryDirector
sigmas ────┤                                      ├─ 分段潜变量
Seed ──────┤                                      ├─ 合并画面
参考图尺寸 ┤                                      └─ 合并音频
二采方案 ──┘
```

## 2. 配置节点职责

配置节点只打包运行时依赖，不采样、不解码、不复制模型，也不维护时间线或资产池。

输入呈现完全使用 **ComfyUI 原生 Widget + 原生 socket**。不为配置节点自绘一套输入组件；原生组件本身支持连接，连接后的禁用 / 收起、主题和工作流序列化均由 ComfyUI 管理。

MODEL / CLIP / 视频 VAE / 音频 VAE 使用纯原生接入点，不在配置节点重复加载器选项。分辨率使用 ComfyUI 原生 Resolution Selector 形态：宽高比、百万像素、实时“宽 × 高 / MP”预览，nearest multiple 放高级设置。SAMPLER / SIGMAS 保留原生可连接 Widget，以便简单工作流不必额外堆节点。

当前输入：

- `MODEL`
- `CLIP`
- 视频 `VAE`
- 音频 `VAE`
- 外接 `width / height`
- `SAMPLER`
- `SIGMAS`
- Seed
- 参考图尺寸
- 二采方案

二采方案默认“无”。当前可选 `SelfLift`；其放大模型和高清步数属于 SelfLift 专属配置。

音频连续不再是配置项：时间线上相邻片段有重叠时，执行层自动延续音频 latent；无重叠时音频独立；仅首尾贴合时只做视觉尾帧承接。

输出为内部连线类型 `TERRYDIRECTOR_CONFIG`。该类型只用于 TerryDirector 节点之间传递运行上下文，不是用户下游结果协议，也不取代标准 LATENT / IMAGE / AUDIO 输出。

## 3. 主节点职责

主 TerryDirector 节点左侧只保留一个可见输入：**导演配置**。

主节点内部只展示：

- 只读迷你时间线
- 总时长 / 片段排列摘要
- 编辑入口

提示词、资产池、片段时长与时间线几何保存在主节点自己的内部序列化状态；生成参数不再重复保存到主节点。

旧版主节点 `config_json` 中的 runtime 参数只作兼容读取，升级后会被丢弃；创作编排继续保留。旧工作流需要把原来的模型 / 采样连线改接到新的配置节点。

## 4. 页内导演台

导演台继续只负责创作编排：

- 时间线
- 提示词
- 资产池
- 片段时长和重叠
- 保存并退出

不出现模型、尺寸、Seed、采样器、SIGMAS、SelfLift 或预览设置。预览继续交给采样链上的独立预览节点。

## 5. 当前实现状态

已实现：

- 配置节点 schema 与 `TERRYDIRECTOR_CONFIG`
- 主节点单一可见输入
- 创作状态与 runtime 配置分离
- 主节点迷你时间线 / 页内编辑器
- 三个标准输出端口定义

尚未实现：

- MiniMax H3 实际分段采样
- 重叠连续性执行
- SelfLift 运行链路
- 最终音画合并执行
