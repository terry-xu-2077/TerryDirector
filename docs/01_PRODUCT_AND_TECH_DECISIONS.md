# TerryDirector 产品与技术决策

> 状态：产品基线  
> 目的：记录 TerryDirector 当前已经确定的产品定位、技术边界和开发原则。后续视觉设计、前端 Demo、ComfyUI 插件开发和功能实现都以本文为基线。

---

## 1. 产品定位

TerryDirector 不是一个独立桌面应用，也不是一个单纯的 ComfyUI 批量任务提交器。

它的定位是：

> **运行在 ComfyUI 环境中的 AI 视频导演工作台。**

它负责组织：

- 项目
- 素材
- 片段 / Segment
- Prompt
- Prompt 编辑（当前 UI 不做 AI 增强）
- 片段承接
- 时间线
- 参考素材
- Guide
- 音频
- 生成任务
- 生成结果（当前 UI 不做片段版本管理界面）
- 最终连续视频

ComfyUI 则负责：

- 模型环境
- 节点生态
- VAE / Sampler
- GPU Runtime
- Workflow
- Queue
- History
- Execution
- Progress

二者的关系应理解为：

```text
TerryDirector = 创作与导演系统
ComfyUI       = 生成 Runtime
```

而不是“一个外部应用去远程控制 ComfyUI”。

---

## 2. 部署形态

### 2.1 ComfyUI Custom Node 插件

TerryDirector 直接安装在：

```text
ComfyUI/custom_nodes/TerryDirector/
```

插件与 ComfyUI：

- 使用同一个 Python 环境
- 使用同一个模型环境
- 共享 input / output / temp
- 能直接访问 ComfyUI 节点和执行环境
- 不需要额外 Bridge

### 2.2 独立本地 Web 工作台

完整导演 UI 不塞进 ComfyUI 节点 DOM。

插件启动后额外提供一个本地 Web 入口，例如：

```text
ComfyUI        http://127.0.0.1:8188
TerryDirector  http://127.0.0.1:8189
```

端口号后续可配置。

Web 工作台由浏览器打开，但其后端仍然属于当前 ComfyUI 插件。

### 2.3 ComfyUI 节点只作为入口

ComfyUI 中只保留一个轻量入口节点，例如：

```text
┌ TerryDirector ─────────────────┐
│ Service      ● Running         │
│ Project      当前项目           │
│ Queue        3                 │
│                                │
│ [ 打开导演工作台 ]              │
└────────────────────────────────┘
```

节点不承担：

- 大型时间线
- 素材管理
- 项目管理
- 多版本结果浏览
- 大型 Prompt 编辑器

这些都属于独立 Web 工作台。

---

## 3. 明确不再采用的架构

TerryDirector 不继承 TerryShotMill 的以下结构：

```text
Tauri
  ↓
独立 React App
  ↓
独立 FastAPI
  ↓
Application / Domain / Repository / UoW
  ↓
Provider / Capability
  ↓
Bridge
  ↓
ComfyUI
```

当前阶段明确不做：

- Tauri 桌面壳
- Rust 桌面依赖
- 独立 FastAPI 服务
- ShotMill Bridge
- 为 Provider 泛化而设计的大量 Adapter
- 为未来多实例提前设计的隔离层
- 独立任务 Runtime 替代 ComfyUI Queue
- 为假设中的大规模部署提前增加 Redis / Celery / 微服务
- 没有实际需求时引入数据库迁移体系

### 原因

这些架构元素本身并非错误，但它们曾让大量开发成本集中在：

- 稳定性
- 启动顺序
- 端口
- 进程生命周期
- Bridge
- 路径转换
- Provider 抽象
- 状态同步
- 连接验证
- 系统级测试

而不是最核心的用户体验和生成功能。

TerryDirector 的原则是：

> **功能复杂，架构简单。**

---

## 4. TerryShotMill 的定位

TerryShotMill 暂时封存。

它以后只作为以下内容的参考：

- 项目首页视觉
- 项目文件夹卡片
- 任务卡片
- Prompt 标签
- 参数控件
- 一些已经打磨过的交互经验
- 项目配置与任务编辑器的 UX 经验

不再继续：

- 后端扩展
- Bridge 开发
- Tauri 打包
- Runtime 架构扩张
- 数据库治理
- 大规模测试体系维护

TerryShotMill 是 **Frozen Reference**，不是 TerryDirector 的代码基础。

---

## 5. UI 视觉基础

Terry React UI Library 已新增独立视觉类别：

> **Studio Dark**

TerryDirector 默认直接采用 Studio Dark。

当前保留并复用的视觉资产包括：

- ProjectFolderCard
- TaskCard
- PromptTag
- 参数行
- Segmented Control
- Sliding Tabs
- 紧凑 Select
- 数值输入
- Switch

### 规则

Studio Dark：

- 固定暗色
- 不做亮色模式
- 不参与 Base Style 的亮暗主题切换
- 使用独立 `tsd-` CSS 命名空间
- 不修改 RulesMD Editor 当前使用的 Base Style

未来 TerryDirector 的视觉参考或前端 Demo，可以继续修改 Studio Dark 或 TerryDirector 自身业务组件，但不能破坏 UI Library 已有使用者。

---

## 6. 核心数据观念：Segment 是一等公民

TerryDirector 不再把生成任务理解成一堆互相独立的 Prompt。

核心对象是：

```text
Project
  ├─ Assets
  └─ Segments
```

Segment 表示：

> 时间线上一个明确的视频生成片段。

它至少拥有：

```ts
Segment {
  id
  order

  startFrame
  endFrame

  userPrompt
  aiPrompt
  activePromptSource

  references[]

  continuity

  generation

  outputs[]
}
```

Segment 既可以：

- 独立生成
- 承接上一段
- 与上一段有重叠
- 引用自己的素材
- 使用自己的 Prompt
- 保存多个生成版本

---

## 7. 共享素材池

项目拥有统一的 Asset Pool。

```text
Project
  └─ Assets
      ├─ images
      ├─ videos
      └─ audios
```

Segment 不复制素材本体，只保存素材引用。

例如：

```ts
SegmentReference {
  assetId

  role:
    image_reference
    video_reference
    fixed_guide
    boundary_guide
    audio_reference
    locked_audio

  trimStart
  trimEnd
}
```

这使得：

- 素材一次导入，多处复用
- 项目管理简单
- 每段只向模型提交真正需要的参考
- 不把所有历史素材永久堆入每个生成任务

---

## 8. 参考素材编号动态编译

项目中的 Asset ID 与 H3 Prompt 中的：

```text
<Picture 1>
<Video 1>
<Audio 1>
```

不是同一个概念。

每个 Segment 在编译时，根据它实际使用的素材重新生成模型引用编号。

例如：

```text
项目素材：
角色A
角色B
基地
车辆

Segment 1：
<Picture 1> = 角色A
<Picture 2> = 基地

Segment 2：
<Picture 1> = 角色A
<Picture 2> = 角色B
<Picture 3> = 车辆
```

Prompt 编号必须由 Segment Compiler 统一生成，不能让 UI 自己猜。

---

## 9. 视频引用的角色

视频参考至少支持三种语义：

### Fixed Guide

固定 Guide：

- 锁定时间线上已有内容
- 用于连续镜头
- 用于长视频续写
- 用于稳定动作、站位和运镜

### Editable Reference

可编辑视频参考：

- 作为 Video Reference 提交
- 不硬锁原画面
- 适合人物替换
- 风格替换
- 动作迁移

### Boundary Guide

只固定边界：

- 取首帧和 / 或尾帧
- 中间内容允许模型重新生成

后续如有更多实际需求，再扩展角色，不提前增加抽象。

---

## 10. 长视频连续性的核心机制

TerryDirector 将参考 ComfyUI-MiniMaxH3-TimelineDirector 的核心工作原理，但重新实现 UI 和数据层。

长视频不只依赖“上一段尾帧”。

优先支持：

### 10.1 Latent Continuation

```text
Segment N sampled AV latent
             ↓
取尾部 overlap latent
             ↓
放入 Segment N+1 开头
```

避免：

```text
Latent → Decode RGB → Encode → Next Segment
```

带来的反复损失。

### 10.2 Drift-Control

对重叠视频区域进行采样噪声控制：

- 已确定区域受到保护
- 接缝附近逐渐释放
- 新区域正常生成

### 10.3 Soft AV

音频连续性跟随视频接缝一起处理。

重叠区：

- 前部保护
- 接近新内容处逐渐释放
- 最终合并时不重复保留 overlap

### 10.4 Locked Audio

区分：

```text
Audio Reference
Locked Original Audio
```

Locked Audio 用于：

- 对白
- 数字人
- 歌曲
- 已完成配音

原始 waveform 保留作为最终音轨，同时进入 AV 驱动路径。

---

## 11. 片段承接

TerryDirector 中“片段承接”是正式概念。

建议数据模型：

```ts
Continuity {
  mode:
    independent
    latent
    guide
    reference

  sourceSegmentId

  overlapFrames

  videoContinuity
  audioContinuity
  promptContinuity
}
```

用户界面不需要直接暴露内部所有机制。

默认 UI 可以先提供：

```text
片段承接
○ 独立生成
● 承接上一片段
```

高级项再展开：

- 重叠长度
- 视频承接
- 音频承接
- Prompt 上下文

---

### 11.1 首尾吸附：尾帧承接

当相邻片段满足：

```text
current.startFrame === previous.endFrame
```

即零空隙、零重叠地首尾吸附时，当前片段生成自动参考上一片段当前输出的最后一帧。由于时间范围使用半开区间 `[startFrame, endFrame)`，实际尾帧为：

```text
previous.endFrame - 1
```

该尾帧是时间线关系派生出的连续性输入，不加入项目资产池、不占用项目 Picture 编号、不自动写入 Prompt 标签。

状态切换规则：

```text
gap > 0      → 不使用自动尾帧承接
gap = 0      → 使用上一片段尾帧承接
overlap > 0  → 转入 overlap / latent continuity 机制
```

若上一片段尚未有可用输出，当前片段生成任务依赖上一片段先完成；不能用参考素材或占位图伪造尾帧。

---

## 12. 时间与分段

内部时间基准应以整数帧为主，不以浮点秒作为 Source of Truth。

例如 H3 当前使用：

```text
24 fps
```

Segment：

```text
startFrame
endFrame
overlapFrames
```

时间显示时再转换成：

```text
00:02.000
```

这样能避免：

- 拖拽误差
- 拼接误差
- 重叠帧误差
- 音画接缝漂移

模型特有的合法帧网格，由 Workflow Adapter / Segment Compiler 负责吸附，而不是散落在 UI 各处。

---

## 13. Prompt 模型

每个 Segment 保存：

```text
User Prompt
AI Prompt
Active Prompt Source
```

用户 / AI 标签决定：

> 真正用于生成的是哪一份 Prompt。

可视化 / 文本模式只决定：

> 同一份 Prompt 的编辑表现。

推荐：

```ts
Segment {
  userPrompt
  aiPrompt
  activePromptSource: "user" | "ai"
}
```

编译时：

```text
effectivePrompt
      ↓
Generation IR
```

不让 ComfyUI Workflow 再判断 Prompt 来源。

---

## 14. Global Prompt 与 Segment Prompt

如保留全局 Prompt，可参考 TimelineDirector 的安全逻辑：

- 所有 Segment Prompt 为空时，全局 Prompt 可以复用
- 一旦进入逐段 Prompt 模式，全局 Prompt 不再自动叠加

不建议：

```text
Global Prompt + Segment Prompt 自动拼接
```

因为容易造成隐藏 Prompt 污染。

---

## 15. Generation IR

UI 数据不直接等于 ComfyUI Workflow 参数。

中间增加一个非常薄的 Generation IR：

```ts
GenerationIR {
  segmentId

  width
  height
  frameCount
  seed

  prompt

  images[]
  videos[]
  audios[]

  guides[]

  lockedAudio

  continuationLatent

  overlapFrames

  samplerConfig
}
```

数据流：

```text
Project / Segment
       ↓
Segment Compiler
       ↓
Generation IR
       ↓
Workflow Adapter
       ↓
ComfyUI Workflow
```

这一层存在的理由不是“架构漂亮”，而是：

- UI 不被具体 Workflow 节点 ID 绑死
- 模型引用编号有统一出口
- 连续性规则有统一出口
- 未来换 Workflow 时不改项目数据

---

## 16. Workflow 策略

优先：

> **固定、经过验证的 workflow.json 模板 + 参数注入。**

而不是动态生成复杂 ComfyUI 图。

推荐做法：

```text
workflows/
  minimax_h3.json
```

运行时：

```text
Generation IR
      ↓
填充固定输入节点
      ↓
ComfyUI Queue
```

可以增加一个 TerryDirector 专用 Task Input Node：

```text
TerryDirector Task
      │
      ├─ prompt
      ├─ references
      ├─ duration
      ├─ guide
      ├─ locked audio
      └─ continuation
```

这样 Workflow 其它部分长期保持稳定。

---

## 17. Queue 策略

不重新造一整套任务执行系统。

优先复用 ComfyUI：

- Queue
- History
- Progress
- Execution
- WebSocket

TerryDirector 自己只保存必要映射：

```text
Segment
  ↓
prompt_id / execution id
  ↓
Result
```

只有 ComfyUI 原生能力明确无法满足某个实际需求时，才增加自己的调度逻辑。

---

## 18. Segment 依赖

承接关系天然形成依赖：

```text
Segment 01
   ↓
Segment 02
   ↓
Segment 03
```

独立 Segment 可以并行进入 ComfyUI Queue。

依赖逻辑应尽量简单：

```text
Segment B 需要 Segment A 的结果
→ A 完成后才编译 B 的 continuity input
```

不提前实现通用 DAG 调度平台。

---

## 19. 结果版本

生成结果不得覆盖。

推荐：

```text
Segment 03
  ├─ V1
  ├─ V2
  ├─ V3 ★
  └─ V4
```

Segment 保存：

```text
selectedOutputId
```

下一段承接默认读取：

```text
sourceSegment.selectedOutput
```

这样可以支持：

- 多次生成
- 挑选最佳版本
- 后续片段基于选定版本继续

---

## 20. Proxy 与媒体缓存

时间线和预览不直接长期使用原始大视频。

项目目录应包含：

```text
assets/
cache/
  proxies/
  thumbnails/
  waveforms/
results/
```

UI 使用：

- 低清视频 Proxy
- 缩略图
- Waveform Cache

生成仍读取原始媒体。

这样时间线才能保持流畅。

---

## 21. 项目存储

初期不强制数据库。

项目可以直接是：

```text
projects/
  <project-id>/
    project.json
    assets/
    cache/
      proxies/
      thumbnails/
      waveforms/
    results/
```

例如可映射到：

```text
ComfyUI/user/TerryDirector/projects/
ComfyUI/input/TerryDirector/
ComfyUI/temp/TerryDirector/
ComfyUI/output/TerryDirector/
```

具体最终目录在开发时根据 ComfyUI API 再确认。

只有当真实项目规模证明 JSON / 文件结构不够用时，再引入 SQLite。

---

## 22. Web Server 原则

TerryDirector Web 服务优先复用 ComfyUI 已存在的 Python Web / asyncio 技术栈。

目标：

- 不再增加独立运行环境
- 不再管理第二个 Python 进程
- 不再额外维护 Uvicorn 生命周期
- 不产生“外部应用是否连上 ComfyUI”的问题

浏览器只访问 TerryDirector 的本地 Web 工作台。

TerryDirector 插件内部再调用 ComfyUI Runtime。

---

## 23. 开发顺序

开发必须纵向打通，而不是先建设完整基础设施。

第一条闭环：

```text
新建项目
→ 新建 Segment
→ 写 Prompt
→ 点击生成
→ ComfyUI 执行
→ 视频回到 Segment
```

第二条：

```text
导入图片
→ Segment 引用
→ Prompt 编号正确
→ 生成视频
```

第三条：

```text
Segment A
→ Segment B 承接
→ overlap
→ 连续生成
```

再逐步增加：

- 音频
- Locked Audio
- 多版本
- AI Prompt
- Timeline 高级编辑
- Final Assembly

---

## 24. 开发红线

1. 产品闭环优先于架构完整性。
2. 优先复用 ComfyUI 能力，不重复造 Runtime。
3. 当前只解决真实存在的需求。
4. 不为假设中的未来 Provider 提前搭大框架。
5. 新增抽象必须能减少总体复杂度。
6. 用户体验问题优先于领域模型的理论纯洁性。
7. 能用少量可靠代码实现的功能，不设计成大型框架。
8. UI、数据、生成、结果应尽量一次纵向打通。
9. 时间线性能属于产品核心能力，不是开发后期再补的优化项。
10. TerryShotMill 只参考，不直接迁移其架构。

---

## 25. 参考项目

### ComfyUI MiniMax H3 Timeline Director

参考：

```text
https://github.com/Songssx/ComfyUI-MiniMaxH3-TimelineDirector
```

主要学习：

- 素材时间线
- GEN Segment Window
- Fixed Guide
- Editable Reference
- Boundary Guide
- Latent Continuation
- Drift-Control
- Soft AV
- Locked Audio
- Segment Plan
- 动态素材编号
- Proxy

不照搬：

- 大型 ComfyUI DOM Node UI
- 单文件巨大前端
- Node Resize Hack
- 把完整项目状态塞进 Workflow JSON

### TerryShotMill

参考：

```text
https://github.com/terry-xu-2077/TerryShotMill
```

仅作为冻结 UX / UI 参考。

### Terry React UI Library

```text
https://github.com/terry-xu-2077/Terry_React_UI_Library
```

TerryDirector 默认使用其中 Studio Dark 类别。

---

## 26. 当前阶段

当前 UI 与交互已经冻结为实现蓝图 1.0，详见 `docs/06_UI_IMPLEMENTATION_BLUEPRINT.md`。

下一阶段开始真实功能实现：项目、资产、ComfyUI input、Prompt 保存、时间线持久化、生成任务、真实进度和生成预览。原则仍然是功能复杂、架构简单，并保持已确认 UI 不被后端实现反向重构。

## 术语约定

用户可见文案、产品讨论和设计文档统一使用：

- **片段**：泛指一个可生成、可编辑、可承接的视频片段。
- **时间线片段**：特指位于时间线中的片段对象。

后续沟通中不再使用 “Segment” 作为用户可见术语。内部代码标识可在实现阶段另行确定，但不得影响 UI 与产品文案。