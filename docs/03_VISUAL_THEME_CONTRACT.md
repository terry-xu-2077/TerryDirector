# TerryDirector Visual Theme Contract

> 状态：视觉 / 主题架构基线  
> 当前产品：仅使用一个固定暗色预设，不提供主题设置 UI。  
> 设计目标：完整保留 TerryDirector 当前确定的综合色彩关系，同时为未来主题自定义保留低成本扩展能力。

---

## 1. 当前视觉基线

TerryDirector 当前默认暗色配色来自 2026-09-28 确认的音乐插件视觉参考。

参考图的核心不是纯黑，而是：

- 偏蓝紫的深灰背景
- 多级灰蓝 Surface
- 紫蓝主强调
- 粉紫高光
- 珊瑚 / 粉 / 暖棕作为少量对比
- 银灰用于弱文字、刻度和金属边界

当前目标视觉：

> **专业、安静、略带未来感，但不使用死黑和满屏霓虹。**

---

# 2. Source Palette：直接来自参考图

TerryDirector 不采用“只允许 5 个源颜色”的限制。

当前 Theme Palette 直接保存完整的综合色板。组件仍然不能自己拥有独立色板，但 Theme Contract 本身可以拥有足够丰富的源色。

## 2.1 Neutral / Surface

~~~text
Deep Base           #1D1F29
Panel Dark          #343747
Panel Mid           #3E4152
Panel Raised        #44485B
Neutral Silver      #8F939F
~~~

用途：

- 应用背景
- 主工作区
- Inspector
- Timeline
- 卡片
- Hover / Raised Surface
- 弱文字
- 刻度
- 分隔线

---

## 2.2 Violet / Cool Accent

~~~text
Accent Primary      #6655DF
Accent Deep         #4738AA
Accent Mid          #5756A7
Accent Highlight    #BA87F8
Accent Pink         #E48BEA
~~~

用途：

- 主选中态
- Playhead
- Timeline Segment
- Overlap
- Primary Action
- Focus
- 激活控件
- 高亮标签

这组颜色构成 TerryDirector 最核心的识别色。

---

## 2.3 Warm Accent

~~~text
Warm Coral          #E3786B
Warm Pink           #EC82A2
Warm Amber          #9D5E21
Warm Brown          #6C472D
~~~

用途：

- Warning
- 特殊状态
- 次级强调
- 局部发光
- 少量图表或状态对比

暖色不作为大面积主色使用。

---

# 3. Theme Palette 数据结构

当前建议直接以完整 Palette Object 表达：

~~~ts
type TerryDirectorThemePalette = {
  neutral: {
    base: string
    panel: string
    surface: string
    elevated: string
    silver: string
  }

  violet: {
    primary: string
    deep: string
    mid: string
    highlight: string
    pink: string
  }

  warm: {
    coral: string
    pink: string
    amber: string
    brown: string
  }

  text: {
    primary: string
    bright: string
    secondary: string
    muted: string
  }
}
~~~

默认主题：

~~~ts
const DEFAULT_THEME = {
  neutral: {
    base: "#1D1F29",
    panel: "#343747",
    surface: "#3E4152",
    elevated: "#44485B",
    silver: "#8F939F",
  },

  violet: {
    primary: "#6655DF",
    deep: "#4738AA",
    mid: "#5756A7",
    highlight: "#BA87F8",
    pink: "#E48BEA",
  },

  warm: {
    coral: "#E3786B",
    pink: "#EC82A2",
    amber: "#9D5E21",
    brown: "#6C472D",
  },

  text: {
    primary: "#F2F4F8",
    bright: "#F7FAFC",
    secondary: "#8F939F",
    muted: "#6F7483",
  },
}
~~~

这比只保存 5 个 seed 更符合当前视觉。

---

# 4. CSS Source Tokens

Theme Contract 应先将 Palette 暴露成稳定的 Source Token：

~~~text
--td-neutral-base
--td-neutral-panel
--td-neutral-surface
--td-neutral-elevated
--td-neutral-silver

--td-violet-primary
--td-violet-deep
--td-violet-mid
--td-violet-highlight
--td-violet-pink

--td-warm-coral
--td-warm-pink
--td-warm-amber
--td-warm-brown

--td-text-primary
--td-text-bright
--td-text-secondary
--td-text-muted
~~~

Source Token 是主题输入。

组件不直接消费这些变量，组件主要消费下一层的 Semantic Token。

---

# 5. Semantic Token 层

业务组件只使用语义 Token。

## Background

~~~text
--td-bg-app
--td-bg-workspace
--td-bg-panel
--td-bg-surface
--td-bg-elevated
--td-bg-hover
--td-bg-selected
~~~

建议初始映射：

~~~css
--td-bg-app: var(--td-neutral-base);
--td-bg-workspace: var(--td-neutral-base);
--td-bg-panel: var(--td-neutral-panel);
--td-bg-surface: var(--td-neutral-surface);
--td-bg-elevated: var(--td-neutral-elevated);
~~~

Hover / Selected 再由 Source Palette 做混色。

---

## Border

~~~text
--td-border-soft
--td-border
--td-border-focus
~~~

---

## Text

~~~text
--td-text-main
--td-text-secondary-ui
--td-text-muted-ui
--td-text-accent
~~~

---

## Accent

~~~text
--td-accent-primary
--td-accent-deep
--td-accent-mid
--td-accent-highlight
--td-accent-pink
--td-accent-soft
--td-effect
--td-glow
~~~

---

## Status

~~~text
--td-status-success
--td-status-warning
--td-status-danger
--td-status-info
~~~

状态色可从 Warm / Violet / Neutral 组合派生，但必须保持可辨识性。

---

# 6. Timeline 专用语义 Token

Timeline Renderer 必须从 Theme Contract 获取颜色，不得自己维护 Canvas 色板。

~~~text
--td-timeline-bg
--td-timeline-grid
--td-timeline-ruler
--td-timeline-playhead
--td-timeline-selection
--td-timeline-snap
--td-timeline-overlap
--td-timeline-lane-a
--td-timeline-lane-b
--td-timeline-waveform
--td-timeline-muted
~~~

建议默认：

### Timeline Background

以：

~~~text
#1D1F29
#343747
~~~

为主。

### Lane A

从：

~~~text
#4738AA
#5756A7
~~~

之间取得较稳重的紫蓝。

### Lane B

从：

~~~text
#6655DF
#BA87F8
~~~

之间取得稍亮版本。

### Selected

使用：

~~~text
#6655DF
~~~

配合边缘 / Glow。

### Overlap

建议：

~~~text
#6655DF → #E48BEA
~~~

形成很弱的综合色或透明渐变。

### Playhead

优先：

~~~text
#E48BEA
~~~

或：

~~~text
#BA87F8
~~~

因为它比普通 Segment Accent 更容易保持最高视觉优先级。

最终在 Demo 阶段根据实际画面决定。

---

# 7. Prompt Tag 色彩

Prompt Tag 可以使用多种颜色，但全部来源于 Source Palette。

例如：

~~~text
Shot       Violet Highlight
Camera     Violet Primary / Mid
Time       Neutral Silver + Violet
Dialogue   Accent Pink
Audio      Warm Coral / Warm Pink
Reference  Violet Deep
Warning    Warm Amber
~~~

允许做轻微 hue / alpha / luminance 派生。

禁止业务 CSS直接写另一组无关蓝、绿、紫固定色。

---

# 8. 不要求所有颜色都数学派生

Rulesmd Editor 适合“少量源色 → 大量派生色”。

TerryDirector 当前参考图本身已经提供一组完整且协调的主色板，因此这里不强求：

~~~text
所有颜色都必须从 1～5 个颜色数学计算出来
~~~

正确原则是：

> **Theme Contract 集中拥有颜色；组件不拥有颜色。**

Theme Contract 可以直接拥有 10～20 个经过设计确认的 Source Swatch。

这是视觉系统，不是颜色算法比赛。

---

# 9. Studio Dark 与 TerryDirector Theme Contract

Terry React UI Library 的 Studio Dark 负责：

- 控件结构
- 默认几何
- 通用交互
- 通用视觉基线

TerryDirector Theme Contract 是产品层配色。

关系：

~~~text
TerryDirector Source Palette
        ↓
TerryDirector Semantic Tokens
        ↓
映射 Studio Dark Public Tokens
        ↓
Studio Components
~~~

未来如果 Studio Dark 暴露：

~~~text
--tsd-bg
--tsd-panel
--tsd-surface
--tsd-accent
--tsd-effect
--tsd-text
--tsd-text-muted
~~~

TerryDirector 直接映射。

禁止通过：

~~~text
.tsd-segmented-item
.tsd-switch-knob
...
~~~

等内部 selector 强行改色。

---

# 10. 当前版本不做 Theme UI

当前明确：

- 不显示主题选择器
- 不显示颜色 Picker
- 不显示预设切换
- 不显示 Dark / Light
- 不保存用户自定义主题

产品当前只有：

> **TerryDirector Default Dark**

但是完整 Palette API 从第一版保留。

---

# 11. 未来主题自定义不限制为 5 色

未来如果增加自定义主题，UI 可以按需求分层。

## Level 1：Accent Preset

最简单：

~~~text
Violet
Blue
Teal
Amber
Custom
~~~

只改变 Accent Group，Neutral Group 不变。

---

## Level 2：Palette Group

用户可以分别调：

~~~text
Neutral
Violet / Accent
Warm Accent
Text
~~~

每组内部可以自动生成深浅关系。

---

## Level 3：Advanced Palette

如果真的有高级需求，可以直接允许编辑完整 Source Palette。

例如：

~~~text
Base
Panel
Surface
Elevated
Primary
Deep
Mid
Highlight
Pink
Coral
Amber
...
~~~

因为 Theme Contract 本来就是完整 Palette，所以不需要重构。

---

# 12. Theme Profile 不进入 Project 数据

Theme 属于：

> 用户 / 应用工作区偏好

不属于项目内容。

原因：

- 打开别人项目不应强制改变自己的 UI 配色
- Project 文件不应携带作者个人主题
- Timeline 内容与 Theme 独立

未来可存储：

~~~text
user/TerryDirector/settings.json
~~~

或浏览器本地偏好。

---

# 13. Canvas / WebGL Theme Snapshot

Timeline 最终可能使用：

- Canvas 2D
- OffscreenCanvas
- WebGL

因此需要一个统一的 Theme Snapshot：

~~~ts
type TimelineThemeSnapshot = {
  background: string
  grid: string
  ruler: string
  playhead: string
  selection: string
  snap: string
  overlap: string
  laneA: string
  laneB: string
  waveform: string
  muted: string
}
~~~

Theme 变化时：

~~~text
Theme Contract
      ↓
createTimelineThemeSnapshot()
      ↓
Timeline Renderer
      ↓
invalidate()
~~~

不让 Canvas Renderer 自己读取散落 CSS / Hex。

---

# 14. 实现红线

1. 组件不得拥有自己的独立主题色板。
2. Timeline Canvas 不得写死主题 RGB / Hex。
3. SVG Icon 状态色优先使用 currentColor 或公开 Theme Token。
4. Hover / Focus / Selected 必须来自 Theme Contract。
5. Studio Dark 通过公开变量映射配色。
6. 当前不因为未来主题功能增加设置 UI 或额外产品复杂度。
7. Theme Profile 不进入 Project 数据。
8. 默认主题永远优先保证 TerryDirector 当前设计品质。
9. 不要求所有 Source 色都从少数 seed 数学派生。
10. 当前参考图提取的综合色板是默认主题的正式视觉基础。

---

# 15. 当前结论

当前阶段：

~~~text
视觉：
完整采用当前提取的灰蓝 / 紫蓝 / 粉紫 / 暖色综合色板

架构：
完整 Palette → Semantic Token → Component / Timeline

UI：
暂不开放主题设置

未来：
可低成本增加 Accent Preset、Palette Group 或完整 Advanced Palette
~~~

核心原则：

> **不是限制颜色数量，而是限制颜色所有权。**

颜色可以丰富，但只能由 Theme Contract 统一管理。
