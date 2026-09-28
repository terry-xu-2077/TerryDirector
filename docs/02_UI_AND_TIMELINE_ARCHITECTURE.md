# TerryDirector UI 与时间线架构

> 状态：UI / UX 基线  
> 目的：根据 TerryDirector 已确定的功能，定义界面信息架构、工作区关系和时间线交互技术原则。  
> 本文先固定“功能结构与体验原则”，不把当前布局当成最终视觉稿。后续可以根据视觉参考、前端 Demo 或其他 AI 生成的模板调整外观与面板比例，但不能牺牲时间线体验和核心工作流。

---

## 1. UI 核心目标

TerryDirector 的 UI 需要同时满足两件事：

1. 比传统 ComfyUI 节点工作流更适合项目化、素材化和连续视频创作。
2. 时间线交互必须接近专业 NLE，尤其 Adobe Premiere Pro 的直接、稳定和丝滑感。

TerryDirector 不是 Premiere 的复制品。它借鉴 Premiere 的时间线手感、面板式工作区、拖拽与裁剪、缩放、播放头、吸附、多轨视觉组织和高密度专业工具布局，但产品目标仍然是：

> **AI 视频生成导演工作台，而不是完整非线性剪辑软件。**

---

## 2. 视觉基础

TerryDirector 默认使用 **Terry React UI Library / Studio Dark**。

规则：

- 仅暗色，不提供亮色 / 暗色切换。
- 项目首页使用 ProjectFolderCard 视觉语言。
- Segment / 任务浏览使用 TaskCard 视觉语言。
- Prompt 标签使用 PromptTag。
- 参数区优先使用 Studio Dark 的 Segmented Control、Sliding Tabs、Select、Number Field、Switch。
- Studio Dark 负责颜色、控件几何、卡片质感和参数控件；TerryDirector 自身负责导演工作区、时间线、素材浏览器、Monitor、Prompt、Inspector 和结果版本等业务 UI。

---

## 3. 一级界面

初期只需要两个一级界面：

~~~text
项目首页
   ↓
导演工作区
~~~

避免重新制造大量一级页面和导航。

### 项目首页

只负责：

- 创建项目
- 打开项目
- 最近项目
- 基础项目管理

项目卡显示：

- 项目名称
- 封面
- 简介
- 最近修改日期
- Segment 数量
- 素材数量
- 已生成数量
- 少量状态提示

不要在首页加入生成参数、Queue 工程字段或大量 Badge。

---

## 4. 导演工作区

建议功能布局：

~~~text
┌───────────────────────────────────────────────────────────┐
│ Project / Toolbar / 当前项目 / 运行状态                    │
├─────────────────┬──────────────────────────┬──────────────┤
│                 │                          │              │
│ Project / Asset │        Monitor           │  Inspector   │
│ Segment Browser │                          │  Prompt      │
│                 │                          │  Parameters  │
│                 │                          │              │
├─────────────────┴──────────────────────────┴──────────────┤
│                                                           │
│                         Timeline                          │
│                                                           │
└───────────────────────────────────────────────────────────┘
~~~

这只是功能布局基线，不是最终视觉稿。

后续可根据视觉参考调整：

- 面板比例
- 面板位置
- 顶部工具栏结构
- Monitor 尺寸
- Inspector 宽度
- Timeline 默认高度
- 素材 / Segment 浏览方式

但 **Timeline 必须始终属于主工作区，而不是藏在二级弹窗中。**

---

## 5. 面板原则

主面板应支持：

- 拖动分隔线调整尺寸
- 双击或快捷动作恢复默认尺寸
- 必要时最大化当前面板
- 内部随尺寸自适应
- 不通过整个页面滚动掩盖布局问题

初期不急于实现 Premiere 那样自由 Dock / Undock 任意面板。

先做好：

> **稳定固定区域 + 可拖动 Split Pane。**

等真实使用证明需要自由 Dock，再扩展。

---

## 6. Project / Asset Panel

左侧 Project Panel 负责两类内容。

### Assets

- 图片
- 视频
- 音频
- 搜索
- 类型筛选
- 外部拖入
- 缩略图 / 列表切换
- 素材元数据
- 删除
- 重命名

### Segments

同一面板可以切换：

~~~text
素材 | 片段
~~~

Segment 支持：

- 卡片模式
- 紧凑列表模式
- TaskCard 视觉
- 顺序编号
- 生成状态
- Prompt 来源
- 结果版本数
- 承接状态
- 当前 selected output 缩略图

Segment Card 与 Timeline 中的 Segment 是同一个数据对象。

---

## 7. Monitor

Monitor 是当前视觉焦点，至少支持三种上下文。

### Asset Preview

选择素材时：

~~~text
Monitor = 素材预览
~~~

### Segment Result

选择生成完成的 Segment 时：

~~~text
Monitor = selectedOutput
~~~

### Timeline Playback

时间线播放时：

~~~text
Monitor = 当前 Timeline / Master 预览
~~~

基础能力：

- 播放 / 暂停
- Timecode
- 音量
- 最大化
- 帧级步进
- 快速 Scrub
- 结果版本切换入口
- 原始比例查看

---

## 8. Inspector

右侧 Inspector 根据当前对象变化。

### 选择 Segment

显示：

- Segment 名称
- 生成时长
- 起止时间
- Prompt 来源
- 片段承接
- 参考素材
- 视频用途
- 音频模式
- 分辨率
- 质量
- Workflow / Profile
- Seed
- 高级生成参数

### 选择 Asset

显示：

- 名称
- 类型
- 分辨率
- 时长
- FPS
- 音频信息
- 项目引用位置

### 选择 Timeline Clip

显示：

- Timeline 位置
- 源素材裁剪范围
- Reference Role
- Audio Role
- 与当前 Segment 的关系

Inspector 使用 Studio Dark 的 ParameterRow、SlidingTabs、SegmentedControl、Select、Number Field、Switch。

默认显示最常用参数，高级项折叠，避免参数墙。

---

## 9. Prompt Panel

Prompt 继续沿用已经确定的逻辑：

~~~text
用户提示词 | AI 增强提示词
~~~

当前标签决定真正用于生成哪一份 Prompt。

每份 Prompt 又有：

~~~text
可视化 | 文本
~~~

可视化模式继续参考 H3 Prompt Editor：

- Section
- Shot
- 时间
- 运镜
- 对白
- Picture / Video / Audio 引用
- PromptTag

文本模式显示完整真实 Prompt 字符串。

底部明确显示当前生成实际使用：

~~~text
当前生成使用：用户提示词
~~~

或：

~~~text
当前生成使用：AI 增强提示词
~~~

---

# 10. Timeline 的产品地位

Timeline 不是附属功能，而是 TerryDirector 的核心编辑面之一。

它统一呈现：

- Segment 时间关系
- 参考视频
- 参考音频
- 已生成视频
- Segment overlap
- Guide
- 承接关系
- Timeline Playback
- 最终成片结构

Storyboard / Segment Card 是 Timeline 的另一种观察方式，不是另一套数据。

---

## 11. Timeline 数据源

Timeline 不保存独立业务数据。

核心仍然来自：

~~~text
Project
  ├─ Assets
  └─ Segments
~~~

Timeline 只是对 Project / Segment 数据的时间空间化编辑。

例如：

- Segment.startFrame
- Segment.endFrame
- Continuity.overlapFrames
- Reference.trimStart
- Reference.trimEnd

都来自同一份数据。

不能出现 Storyboard 一套顺序、Timeline 一套顺序、Task 再一套顺序，然后互相同步。

---

## 12. Timeline 基础结构

推荐从上到下：

~~~text
Time Ruler
Segment / GEN Lane
Video / Reference Tracks
Audio Tracks
~~~

例如：

~~~text
00:00        00:05        00:10        00:15

GEN    [ Segment 01      ]
                 [ Segment 02      ]
                           [ Segment 03        ]

V1     [ reference.mov ]
V2                    [ generated-v2.mp4    ]

A1     [ source audio ----------------------- ]
~~~

### Segment / GEN Lane

Segment Window 单独拥有一条视觉层，表达：

- 起点
- 终点
- 编号
- 当前选中状态
- overlap
- 生成状态
- 承接来源

例如：

~~~text
Segment 01
0 ───────────── 239

Segment 02
             201 ───────────── 440
             └── 39 frames overlap
~~~

Overlap 必须在视觉上明确，而不是只藏在参数栏。

---

## 13. Timeline Clip 类型

### Reference Video Clip

用于：

- Fixed Guide
- Editable Reference
- Boundary Guide

不同 Role 应有轻量视觉标识，但避免高饱和大色块造成噪音。

### Generated Result Clip

表示 Segment.selectedOutput，可切换其他版本。

### Audio Clip

包括：

- Reference Audio
- Locked Audio
- Video Source Audio

Locked Audio 应有明确但克制的锁定标识。

---

## 14. Timeline 第一阶段必须支持的编辑能力

基础能力：

- 拖动播放头
- 点击定位播放头
- 水平滚动
- 鼠标滚轮 / 触控板缩放
- 以播放头或鼠标位置为锚点缩放
- 拖动 Clip
- Clip 左右裁剪
- 拖动 Segment Window
- Segment Window 左右裁剪
- Split
- Delete
- 多选
- 框选
- Snap
- 精确数值定位
- Timecode
- Undo / Redo

第二阶段再考虑：

- Slip
- Ripple
- Roll
- Track targeting
- 更复杂的剪辑工具模式

不要为了“像 Premiere”一次实现全部 Premiere 工具。

---

## 15. Snap / 吸附

吸附是手感核心之一。

吸附目标：

- 播放头
- Segment 起点 / 终点
- Clip 起点 / 终点
- overlap 边界
- 相邻素材边界
- Marker（未来）

吸附原则：

- 使用屏幕像素阈值，而不是固定时间阈值
- 缩放后手感保持一致
- 显示 Snap Guide
- 拖动时实时反馈
- 支持临时关闭 Snap

建议阈值以 6–10 screen pixels 为起点调试，而不是固定 0.2 秒之类的时间值。

---

## 16. Timeline Zoom

缩放必须像专业剪辑软件一样自然：

- 鼠标指针或播放头位置保持视觉锚点
- 缩放后内容不能突然跳走
- 最小尺度可查看长项目
- 最大尺度可逐帧编辑
- Zoom 不修改业务数据
- 只修改 pixelsPerFrame

核心坐标统一：

~~~text
frame ↔ x
~~~

所有时间到屏幕坐标的换算必须由同一个 TimeScale / Coordinate System 负责，不能散落在各组件中。

---

# 17. Timeline 性能架构

这是 TerryDirector 的重要红线。

> **不能把 Timeline 做成一大堆 React DOM 节点，然后等卡顿出现再优化。**

时间线从第一天就按高频交互组件设计。

---

## 17.1 React 负责什么

React 负责：

- 页面 Shell
- 面板
- Inspector
- Prompt Editor
- Asset Browser
- Dialog
- Context Menu
- Toolbar
- Timeline 外部布局

React 不负责每一个 pointermove 都重新渲染整条 Timeline。

---

## 17.2 Timeline Engine

Timeline 拥有独立的高频状态，例如：

~~~ts
TimelineViewState {
  scrollX
  scrollY
  pixelsPerFrame
  viewportWidth
  viewportHeight
}

TimelineInteractionState {
  pointer
  dragMode
  dragTarget
  dragOrigin
  snapTarget
  marquee
}

TimelinePlaybackState {
  currentFrame
  playing
}
~~~

这些高频状态不直接进入 Project Store。

---

## 17.3 分层渲染

首选架构：

> **React DOM + Layered Canvas**

建议：

~~~text
Canvas 1  静态层
          背景 / Grid / Track / Time Ruler

Canvas 2  内容层
          Clip / Segment / Waveform / Thumbnail

Canvas 3  Interaction Overlay
          Playhead / Snap Guide / Selection / Marquee / Drag Preview

DOM       Tooltip / Context Menu / Inline Input / Accessibility
~~~

第一版不强制 WebGL。

Canvas 2D 配合缓存、虚拟化、局部重绘、OffscreenCanvas、Proxy、预计算 Waveform，应先足够支撑典型 TerryDirector 项目。

如果真实项目证明 Canvas 2D 是瓶颈，再替换 Content Renderer 为 WebGL，而不重写 Timeline 数据和交互层。

---

## 18. 高频交互原则

Timeline 拖拽流程：

~~~text
pointerdown
  ↓
capturePointer
  ↓
TimelineInteractionState
  ↓
requestAnimationFrame
  ↓
直接更新 Timeline Render
  ↓
pointerup
  ↓
Commit Project Change
~~~

也就是说：

> 拖动过程中不持续写 project.json，不持续触发全局 React 更新。

只在 pointerup / drag commit 时提交正式业务状态。

---

## 19. requestAnimationFrame

拖拽、Zoom、Playhead 等视觉更新统一进入 requestAnimationFrame。

原则：

- 每帧最多一次 Render
- Pointer Event 可以高频到达，但不重复 Paint
- 当前帧只使用最新输入状态
- 不用固定 60fps timer

目标是在 60Hz 显示器上稳定接近 60fps，在高刷新率显示器上自然跟随更高刷新率。

---

## 20. 局部重绘

Timeline Engine 应知道哪些 Layer 变脏。

例如：

### 只移动播放头

只重绘 Interaction Overlay。

### 拖 Clip

只重绘 Content Layer + Interaction Layer。

### 修改 Track 高度或全局缩放

才重新计算更大区域。

---

## 21. 可视区域虚拟化

Timeline 只绘制当前 viewport 中可见的内容和少量安全边界。

需要维护：

~~~text
visibleFrameStart
visibleFrameEnd
visibleTrackStart
visibleTrackEnd
~~~

项目规模大以后可增加 interval index / spatial index，但不提前引入复杂架构。

---

## 22. Thumbnail Cache

视频 Timeline 不实时从原视频抽帧。

导入视频后生成 thumbnail cache。

Timeline 根据 Zoom：

- 粗尺度显示较少缩略图
- 细尺度显示更多缩略图

缩放过程中：

- 先复用已有缓存
- 不同步阻塞抽帧
- 缺图时异步补充

---

## 23. Waveform Cache

音频导入后预计算 waveform peaks。

建议支持多级采样数据，根据 Zoom 选择对应级别。

Render Loop 中禁止：

- 解码完整音频
- 扫描完整 waveform
- 实时重新计算 peaks

---

## 24. Proxy Playback

Monitor 和 Timeline Scrub 优先使用 Proxy。

~~~text
Original
  ↓
Proxy
  ↓
UI Playback
~~~

正式生成仍读取 Original。

快速拖动播放头：

1. Timeline 立即更新 Playhead。
2. Monitor 使用 Proxy Seek。
3. 极高速 Scrub 时可以临时显示最近 Thumbnail。
4. 停止拖动后再做精确 Seek。

鼠标不能等视频解码完成才移动。

---

## 25. Playback Sync

播放时应由真实媒体帧驱动 Timeline，而不是简单使用 setInterval。

浏览器支持时优先使用 requestVideoFrameCallback，同步：

- Monitor
- Playhead
- Timecode

---

## 26. Undo / Redo

Undo / Redo 从 Timeline 第一阶段就设计。

建议 Command Stack：

~~~text
MoveClipCommand
TrimClipCommand
MoveSegmentCommand
ResizeSegmentCommand
DeleteClipCommand
SplitClipCommand
AssignReferenceCommand
~~~

一次完整 drag = 一个 Undo Step。

不能拖 120 帧就产生 120 个 Undo。

---

## 27. Selection 模型

Director Workspace 维护一个明确的主选择上下文，例如：

~~~ts
Selection {
  type:
    "asset"
    "segment"
    "timelineClip"
    "result"

  id
}
~~~

Timeline、Segment Card、Inspector、Prompt、Monitor 都围绕它联动。

点击 Timeline 中的 Segment 03：

~~~text
Timeline Select Segment 03
          ↓
Segment Browser 高亮
          ↓
Inspector 显示 Segment 03
          ↓
Prompt 显示 Segment 03
          ↓
Monitor 显示 selectedOutput
~~~

不要让每个面板自己维护一份“当前任务”。

---

## 28. Segment Card 与 Timeline 的关系

TaskCard 在 TerryDirector 里承担 Segment Card 视觉，但 UI Library 组件名暂时保持通用。

Segment Card 适合：

- 快速浏览
- 比较缩略图
- 查看状态
- 批量选择
- 查看版本
- 进入 Prompt

Timeline 适合：

- 时间关系
- 承接
- overlap
- 参考素材位置
- 音频
- 精确时间

两者互补。

---

## 29. Segment 创建入口

自然入口包括：

### Timeline 空白处

右键或双击创建 Segment。

### Segment Browser

“+ 新建片段”。

### 当前 Segment 后

“Add Next Segment”。

若选择“承接上一片段”，自动建立 continuity source。

---

## 30. 参考素材拖拽

素材浏览器中的素材支持直接拖到：

### Segment

表示为当前 Segment 添加 Reference。

### Timeline Track

表示在指定时间位置放置参考素材。

Drop 后在 Inspector 中选择 Role：

- 固定 Guide
- 可编辑参考
- 仅固定边界

尽量减少“打开对话框 → 找任务 → 再添加”的流程。

---

## 31. Overlap 编辑体验

Overlap 不应主要靠数字输入。

最自然方式是 Timeline 直接编辑：

~~~text
Segment 01  [──────────────]
Segment 02           [──────────────]
                     ↑ overlap
~~~

拖 Segment 02 起点即可修改 overlap。

Inspector 同步显示：

~~~text
Overlap
39 frames
1.625s
~~~

数字输入用于精确调整。

---

## 32. 连续性视觉反馈

Segment 承接上一段时，Timeline 应有轻量关系提示，例如 overlap 区的 Continuity 标识或非常克制的方向提示。

不建议引入复杂 Node Graph 连线。

Timeline 本身已经表达顺序和重叠，关系 UI 只负责辅助理解。

---

## 33. 结果版本体验

Segment 多版本：

~~~text
V1
V2
V3 ★
V4
~~~

至少支持：

- 当前主版本
- 版本缩略图
- 切换
- 设为 Selected Output
- 删除无用版本
- 后续对比入口

切换 Selected Output 后：

- Monitor 更新
- Timeline Generated Clip 更新
- 后续承接链标记可能需要重新生成

---

## 34. Queue / 运行状态

运行状态要可见，但不能侵占导演工作区。

全局轻量显示：

~~~text
ComfyUI ●
Queue 3
Running 1
~~~

点击展开 Runtime Panel，显示：

- 正在生成
- 排队
- 失败
- Progress
- Cancel
- Retry

默认不显示 Prompt ID、Workflow Node ID、内部 Snapshot 等工程字段。

---

## 35. Project Config

集中管理：

- 项目名称
- 简介
- 封面
- 默认分辨率
- 默认 Workflow
- 项目素材
- AI Prompt 是否使用项目背景
- 默认 FPS
- 默认 Segment 时长

不要重复塞进每个 Segment。

---

## 36. 快捷键基线

第一阶段：

~~~text
Space         播放 / 暂停
Left / Right  前后 1 帧
Shift + ←/→   较大步进
Delete        删除选中
Ctrl/Cmd + Z  Undo
Ctrl/Cmd + Shift + Z / Ctrl+Y  Redo
+ / -         Timeline Zoom
S             Split（无文本输入焦点时）
Home          Timeline 起点
End           Timeline 末尾
~~~

J / K / L 后续加入。

快捷键必须尊重文本输入 Focus Context。

---

## 37. UI 状态与持久化

### Project State

保存：

- Assets
- Segments
- References
- Prompt
- Results
- Timeline 编辑结果

### Workspace State

可保存：

- 面板尺寸
- Timeline Zoom
- Track 高度
- 上次工作区布局

### Ephemeral Interaction State

不保存：

- 当前鼠标位置
- Drag Preview
- Snap Candidate
- Marquee Rect
- Hover Clip

Project JSON 不应被高频 UI 状态污染。

---

## 38. Autosave

采用 Commit 后 Autosave。

~~~text
Move Segment
pointerup
  ↓
Project Store Commit
  ↓
debounced autosave
~~~

禁止 pointermove 每次写磁盘。

Prompt 文本可以单独 debounce 保存。

UI 只需轻量显示：

~~~text
已保存
保存中
~~~

---

## 39. 时间线性能验收基线

正式开发时必须建立独立 Timeline 性能场景。

初期目标：

- 常见项目拖动 / 裁剪无肉眼可见掉帧
- 60Hz 下 Zoom / Pan 稳定接近 60fps
- Pointer Move 不经过全局 React Render
- 播放头移动无明显滞后
- 100+ Segment / Clip 项目仍能自然缩放和滚动
- Waveform / Thumbnail 加载不阻塞主线程交互
- Project 保存不阻塞 Drag
- Proxy 生成不阻塞 UI

实际性能记录决定是否需要 Web Worker、OffscreenCanvas、WebGL 或更复杂的 Spatial Index，而不是预先全部加入。

---

## 40. 前端 Demo 的使用方式

后续可以使用：

- 用户提供的视觉参考
- 其他 AI 制作的前端 Demo
- 外部模板

这些可以直接提供：

- 视觉层级
- 面板比例
- Typography
- 图标
- 卡片排布
- Toolbar
- Inspector 结构

但以下内容必须单独验证甚至重做：

- Timeline
- Drag
- Zoom
- Snap
- Playback
- Selection
- Undo / Redo
- Virtualization

> **不能因为一个 Demo 看起来像 Premiere，就默认它的 Timeline 技术实现足够用于 TerryDirector。**

Timeline Engine 是独立核心模块。

---

## 41. 建议开发阶段

### Phase UI-0：视觉方向

只做：

- 收集参考
- Studio Dark 调整
- 工作区布局 Demo
- Project / Segment / Monitor / Inspector / Timeline 视觉关系

不接真实生成。

### Phase UI-1：Timeline Interaction Prototype

单独做 Timeline 原型：

- 100+ Fake Clips
- Zoom
- Pan
- Playhead
- Drag
- Trim
- Snap
- Segment overlap
- Undo / Redo

这一阶段首先验证 **手感**，不是业务 API。

### Phase UI-2：Project State

Timeline 接真实 Project / Asset / Segment JSON。

### Phase UI-3：Media

接：

- Proxy
- Thumbnail
- Waveform
- Monitor Playback

### Phase UI-4：Generation

最后接：

~~~text
Segment → Generation IR → ComfyUI
~~~

这样避免再次出现“后端和架构很完整，但核心操作体验还没验证”的情况。

---

## 42. 最重要的 UI 原则

1. Timeline 是核心，不是补充。
2. Timeline 手感优先于“React 架构是否优雅”。
3. 高密度，但不能靠缩小字体硬塞。
4. 常用操作尽量直接拖拽完成。
5. 参数输入是精确补充，不是主要交互。
6. 不把 ComfyUI 工程概念暴露给普通导演流程。
7. 同一 Segment 在卡片、Timeline、Prompt、Inspector 中只有一份数据。
8. 高频交互状态与持久化业务状态分离。
9. 视觉可以持续迭代，Timeline Engine 不跟随视觉 Demo 反复重写。
10. 目标是打开项目后自然进入“导演状态”，而不是进入“配置软件状态”。

---

## 43. 当前未定事项

以下内容保留给后续视觉参考和 Demo 决定：

- 最终 Toolbar 视觉
- Monitor 是否采用双监视器布局
- Asset Panel 最终尺寸
- Segment Browser 卡片密度
- Inspector / Prompt 是否拆成两个 Panel

---

# 44. 当前视觉参考方向（2026-09-28）

当前新增两类视觉参考。

## 44.1 TerryComfyLauncher 的参考价值

参考仓库：

~~~text
https://github.com/terry-xu-2077/TerryComfyLauncher
~~~

TerryComfyLauncher 的价值不在于复用它的亮色、圆角或具体组件，而在于它已经证明一种设计方法：

> **先理解视觉参考的设计语言，再根据真实产品功能重新落地，而不是逐像素模仿参考图。**

从 TerryComfyLauncher 中值得继承的方法包括：

- 主次层级非常明确
- 一个页面只突出一个主要任务
- 背景、卡片、控件之间靠层次差而不是大量描边区分
- Accent 使用克制
- Secondary 信息保持低对比
- Hover / Active 有明显但不过度的反馈
- 信息密度偏紧凑，但不会显得工程化
- 视觉元素有轻微“材质感”，但不牺牲可读性
- 复杂功能被包装成直观的操作，不让用户感知底层复杂度

TerryDirector 不直接采用 TerryComfyLauncher 的亮色或大圆角风格。

TerryDirector 应将这套方法转译为：

> **Studio Dark 下更专业、更稳重、更偏影视制作工具的版本。**

建议视觉倾向：

- 深灰黑背景，不使用纯黑
- 面板层级靠 1～2 级明度差区分
- 圆角明显减少，主要集中在卡片、弹层、小型控制组
- Timeline / Monitor / Inspector 等核心工作区尽量保持更硬朗的矩形结构
- Accent 只用于 Selected、Playhead、Primary Action、重要生成状态
- 阴影比 TerryComfyLauncher 更弱，更多使用边界明度和 Surface 层级
- 避免“手机 App 放大到桌面”的感觉

---

## 44.2 时间线视觉参考

当前提供的移动端时间线参考图可作为 **交互层级和视觉组织** 的参考，而不是直接复制移动端布局。

值得借鉴：

- 播放头始终是最强视觉锚点
- Time Ruler 简洁
- Clip 本身就是主要交互对象
- Selected Clip 的边界非常明确
- 当前操作只突出一个目标
- Timeline 背景保持安静
- 不使用大量传统 NLE 工程按钮占满界面
- 颜色集中在当前选择和主要状态上

桌面版 TerryDirector 应保留这种“少轨道、强焦点”的方向。

---

# 45. TerryDirector 时间线改为两条 Segment Lane

当前产品不需要 Premiere 那样大量 Video / Audio Track。

TerryDirector 的核心任务是：

> **处理两个相邻生成片段的重叠与承接。**

因此第一版 Timeline 明确收敛为 **两条 Segment Lane**：

~~~text
                 Playhead
                    │
                    ▼
Time  ──────── 00:05 ───────── 00:10 ───────── 00:15

Lane A   [ Segment 01 ──────────────── ]
Lane B                 [ Segment 02 ──────────────── ]
                        <── overlap ──>
~~~

两条 Lane 的意义不是传统 NLE 的 V1 / V2。

它们表示：

~~~text
Lane A = 当前片段 / 前一个片段
Lane B = 下一片段 / 与当前片段发生承接的片段
~~~

### 这样设计的优势

1. 用户一眼就能看懂两个片段如何重叠。
2. overlap 成为视觉中心，而不是隐藏在参数里。
3. 拖动第二个片段起点就是调整承接长度。
4. 不需要 Track Targeting、轨道锁、轨道同步等传统 NLE 复杂度。
5. Timeline 高度可以非常克制，把更多空间留给 Monitor、Prompt 和素材。
6. 两条 Lane 非常适合做高性能 Canvas 渲染。

---

## 45.1 Lane 内部不再拆独立音视频轨

一个 Segment Clip 可以在内部表达：

- 视频
- 绑定音频
- Guide
- Reference
- Generated Output

也就是说不为了“音频存在”再增加 A1 / A2 轨道。

例如：

~~~text
┌ Segment 02 ─────────────────────┐
│ thumbnail strip                 │
│ ▁▂▃▅▆▃▂ waveform (optional)     │
└─────────────────────────────────┘
~~~

Audio 可以作为 Clip 内部第二层信息显示。

只有未来真实需求证明需要独立音轨编辑时，再增加专门的 Audio Lane。

---

## 45.2 参考素材不必都进入 Timeline

以下素材优先挂在 Segment 上：

- Picture Reference
- Audio Reference
- Character Reference
- Style Reference

这些在：

- Segment Inspector
- Reference Strip
- Prompt 引用标签

中显示即可。

只有具有明确时间区间意义的素材才进入 Timeline，例如：

- Reference Video
- Fixed Guide
- Generated Segment
- Locked Audio 区间（如确实需要时间可视化）

这样 Timeline 不会演变成素材仓库。

---

## 45.3 两条 Lane 的自动轮换

当用户向后工作时：

~~~text
Segment 01 + Segment 02
        ↓
确认 Segment 02
        ↓
Segment 02 成为 Lane A
Segment 03 进入 Lane B
~~~

也就是说 Timeline 可以像一个“连续镜头工作台”：

~~~text
A = 已确认 / 当前来源
B = 正在制作的下一段
~~~

但在缩放到全片视图时，仍然可以显示完整项目中的所有 Segment；两条 Lane 只是交替排布：

~~~text
Lane A: S01 ─────────      S03 ─────────      S05 ─────
Lane B:       S02 ─────────      S04 ─────────
~~~

这样所有连续 Segment 都能在 **两条 Lane 内表达任意长度的项目**。

---

## 45.4 Overlap 是核心交互区

Overlap 应拥有独立视觉语义。

例如：

~~~text
Lane A  [───────────────]
Lane B           [───────────────]
                 █████
                 OVERLAP
~~~

选中 overlap 时 Inspector 显示：

- overlap frames
- overlap seconds
- continuity mode
- video continuation
- audio continuation
- Guide / Drift 状态

直接拖动 Lane B 左边缘：

~~~text
← 增大 overlap
→ 减小 overlap
~~~

吸附到 H3 合法帧网格时，画面实时显示实际帧数。

---

# 46. 第一版前端 Demo 的目标

第一版 Demo 不接 ComfyUI，也不做真实项目后端。

目标只验证：

> **TerryDirector 的视觉语言 + 导演工作区布局 + 两条 Lane Timeline 的手感。**

Demo 需要包含：

- Studio Dark 工作区
- Project / Segment Browser
- Monitor
- Inspector
- Prompt 区
- 两条 Lane Timeline
- Time Ruler
- Playhead
- 两个或多个交替排列的 Segment
- overlap
- Clip 选中
- Drag
- Trim
- Zoom
- Pan
- Snap
- Segment Card 与 Timeline 联动
- 假生成状态
- 假版本切换

可以使用 Fake Data。

Demo 阶段不实现：

- ComfyUI
- Workflow
- 模型
- 真实 Proxy
- 后端
- 项目持久化
- AI Prompt

这样 UI 和 Timeline 手感可以独立快速迭代。

