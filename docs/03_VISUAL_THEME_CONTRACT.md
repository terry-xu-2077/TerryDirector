# TerryDirector Visual Theme Contract

> 状态：视觉 / 主题架构基线  
> 当前产品：仅使用一个固定暗色预设，不提供主题设置 UI。  
> 设计目标：现在保持视觉一致性，同时为未来“自定义主题色”保留低成本扩展能力。

---

## 1. 当前视觉基线

TerryDirector 当前默认暗色配色来自 2026-09-28 确认的音乐插件视觉参考。

参考图的核心不是纯黑，而是：

- 偏蓝紫的深灰背景
- 多级灰蓝 Surface
- 紫蓝为主 Accent
- 粉紫作为高亮 Effect
- 少量珊瑚暖色作为提示和对比

当前目标视觉：

> **专业、安静、略带未来感，但不使用死黑和满屏霓虹。**

---

## 2. 当前默认目标色板

以下颜色作为视觉校准目标，不代表所有组件可以直接硬编码使用。

### Neutral / Surface

~~~text
App Background      #1D1F29
Panel               #343747
Surface             #3E4152
Elevated Surface    #44485B
Secondary Text      #8F939F
~~~

### Accent

~~~text
Primary Accent      #6655DF
Secondary Accent    #BA87F8
Pink Highlight      #E48BEA
Warm Highlight      #E3786B
~~~

### Text

~~~text
Primary Text        #F2F4F8
Bright Text         #F7FAFC
Secondary Text      #8F939F
Muted Text          ~#6F7483
~~~

这套配色是当前 TerryDirector Studio Dark 的默认视觉目标。

---

## 3. 不允许组件拥有自己的主题色板

借鉴 Rulesmd Editor 的主题颜色契约：

> **业务组件、Timeline、卡片、弹窗、Inspector、Prompt、Toolbar 都不能自己保存一套独立配色。**

例如禁止：

~~~css
.timeline-clip {
  background: #6655DF;
}

.inspector {
  background: #343747;
}
~~~

应改为：

~~~css
.timeline-clip {
  background: var(--td-accent);
}

.inspector {
  background: var(--td-surface-1);
}
~~~

颜色所有权必须集中在 Theme Contract。

---

# 4. Theme Seed

TerryDirector 从第一版开始保留以下五个主题源颜色：

~~~text
--td-theme-base
--td-theme-accent
--td-theme-effect
--td-theme-text
--td-theme-text-bright
~~~

这与 Rulesmd Editor 的思路保持一致，但 TerryDirector 当前只实现暗色模式。

默认建议：

~~~css
--td-theme-base: #1D1F29;
--td-theme-accent: #6655DF;
--td-theme-effect: #BA87F8;
--td-theme-text: #F2F4F8;
--td-theme-text-bright: #F7FAFC;
~~~

当前 UI 不提供修改入口。

这些变量存在的意义是：

> 未来开放主题色时，不需要修改各业务组件。

---

# 5. 派生颜色层

所有产品实际使用的颜色从 Theme Seed 派生。

示意：

~~~css
--td-surface-0: var(--td-theme-base);

--td-surface-1:
  color-mix(
    in oklab,
    var(--td-theme-base) 90%,
    var(--td-theme-text) 10%
  );

--td-surface-2:
  color-mix(
    in oklab,
    var(--td-theme-base) 84%,
    var(--td-theme-text) 16%
  );

--td-surface-elevated:
  color-mix(
    in oklab,
    var(--td-theme-base) 78%,
    var(--td-theme-text) 22%
  );

--td-border:
  color-mix(
    in oklab,
    var(--td-theme-base) 76%,
    var(--td-theme-text) 24%
  );

--td-accent-soft:
  color-mix(
    in srgb,
    var(--td-theme-accent) 16%,
    transparent
  );

--td-effect-soft:
  color-mix(
    in srgb,
    var(--td-theme-effect) 14%,
    transparent
  );
~~~

具体混色比例在 Demo 阶段根据视觉参考继续微调。

要求：

> 默认派生结果应尽可能接近当前目标色板，而不是为了数学统一牺牲视觉效果。

---

# 6. 语义 Token

业务组件只使用语义 Token。

推荐至少包含：

### Background

~~~text
--td-bg-app
--td-bg-workspace
--td-bg-panel
--td-bg-surface
--td-bg-elevated
--td-bg-hover
--td-bg-selected
~~~

### Border

~~~text
--td-border-soft
--td-border
--td-border-focus
~~~

### Text

~~~text
--td-text-primary
--td-text-secondary
--td-text-muted
--td-text-accent
~~~

### Accent

~~~text
--td-accent
--td-accent-hover
--td-accent-selected
--td-effect
--td-glow
~~~

### Timeline

~~~text
--td-timeline-bg
--td-timeline-grid
--td-timeline-ruler
--td-timeline-playhead
--td-timeline-selection
--td-timeline-snap
--td-timeline-overlap
--td-timeline-clip-a
--td-timeline-clip-b
~~~

Timeline Renderer 无论最终使用 Canvas 2D 还是 WebGL，都必须从同一 Theme Snapshot 读取颜色，不能另建 Canvas 专用色板。

---

# 7. 状态色与主题色分离

以下颜色具有固定语义：

~~~text
Success
Warning
Danger / Error
~~~

它们不应该完全随用户 Accent 改变，否则可能丢失状态辨识度。

建议 Theme Contract 保留：

~~~text
--td-success
--td-warning
--td-danger
~~~

默认可基于当前参考图的暖色体系调整。

主题色可以轻微影响它们的明度、Surface 和 Glow，但不能让：

~~~text
失败 = 与普通 Accent 几乎相同
~~~

---

# 8. Timeline 的主题规则

Timeline 是 Theme Contract 的重点消费者。

### Playhead

永远使用最强视觉锚点色：

~~~text
--td-timeline-playhead
~~~

默认来自 Primary Accent 或 Effect。

### Selected Segment

使用 Accent：

~~~text
border / edge / small glow
~~~

不要整个 Clip 大面积高饱和填充。

### Overlap

Overlap 必须与 Selected 状态区分。

推荐：

~~~text
Primary Accent + Effect
~~~

派生出一个稍偏紫粉的 Overlap 色。

### Lane A / Lane B

两条 Lane 不使用两个互不相关的固定颜色。

应从 Accent 派生：

~~~text
Lane A = Accent 的较冷 / 深版本
Lane B = Accent 向 Effect 轻微偏移
~~~

这样未来更换主题 Accent 时，两条 Lane 自动保持协调。

---

# 9. Prompt Tag 的主题规则

Prompt Tag 可以拥有不同语义，例如：

- Shot
- Camera
- Time
- Dialogue
- Audio
- Reference

但这些颜色不直接硬编码。

应基于：

~~~text
Accent
Effect
Warm Semantic
Neutral
~~~

做色相偏移和透明度派生。

目标：

> 用户换主题色后，Prompt Tag 仍然是一组协调色，而不是残留旧紫色。

---

# 10. Studio Dark 与 TerryDirector Theme Contract 的关系

Terry React UI Library 的 Studio Dark 负责：

- 控件结构
- 默认视觉
- 通用组件

TerryDirector Theme Contract 是产品层。

关系：

~~~text
TerryDirector Theme Seed
        ↓
TerryDirector Semantic Tokens
        ↓
映射 Studio Dark public tokens
        ↓
Studio Components
~~~

例如未来实现时可以：

~~~css
.terry-director-theme {
  --tsd-accent: var(--td-accent);
  --tsd-effect: var(--td-effect);
  --tsd-text: var(--td-text-primary);
  --tsd-text-muted: var(--td-text-secondary);
}
~~~

具体映射以 Studio Dark 当时公开的 token API 为准。

禁止 TerryDirector 通过内部选择器去覆盖：

~~~text
.tsd-segmented-item
.tsd-switch-knob
...
~~~

主题变化必须经过公开变量。

---

# 11. 当前版本不做 Theme UI

当前产品明确：

- 不显示主题选择器
- 不显示颜色 Picker
- 不显示预设切换
- 不显示 Dark / Light
- 不保存用户自定义主题

产品只有：

> **TerryDirector Default Dark**

但 Theme Contract 和数据结构从第一版就保留。

---

# 12. 未来扩展方式

未来如果确实有需求，可以按层级逐步开放。

### Level 1：只开放主题色

用户只选：

~~~text
Accent Color
~~~

系统自动计算：

- Effect
- Selected
- Hover
- Timeline Lane
- Prompt Tag

这是最推荐的未来 UI。

### Level 2：预设

例如：

~~~text
Default Violet
Cold Blue
Teal
Amber
Custom
~~~

仍然只是修改 Theme Seed。

### Level 3：高级自定义

如果以后真的需要 Rulesmd Editor 那种完整能力，可以开放：

~~~text
Base
Accent
Effect
Text
Text Bright
~~~

因为底层已经保留五个 Seed，所以不需要重构。

---

# 13. Theme Profile 数据接口

虽然当前不持久化自定义主题，但代码层建议预留类型：

~~~ts
type ThemeProfile = {
  base: string
  accent: string
  effect: string
  text: string
  textBright: string
}
~~~

当前使用：

~~~ts
const DEFAULT_THEME: ThemeProfile = {
  base: "#1D1F29",
  accent: "#6655DF",
  effect: "#BA87F8",
  text: "#F2F4F8",
  textBright: "#F7FAFC",
}
~~~

当前应用启动直接使用 DEFAULT_THEME。

未来增加：

~~~text
loadThemeProfile()
saveThemeProfile()
~~~

即可。

---

# 14. 实现红线

1. 组件不得拥有独立固定主题色板。
2. Timeline Canvas 不得写死 RGB / Hex。
3. SVG Icon 的状态色必须使用 currentColor 或主题 Token。
4. Hover / Focus / Selected 从 Theme Seed 派生。
5. Studio Dark 只能通过公开 Token 被 TerryDirector 调色。
6. 当前不因未来主题功能增加设置 UI 或额外业务复杂度。
7. Theme Profile 不进入 Project 数据；它属于应用 / 用户偏好。
8. 项目文件打开后不应因为作者主题配置而改变用户自己的工作区主题。
9. 自定义主题未来必须可以恢复默认。
10. 默认主题永远优先保证 TerryDirector 当前设计质量，不为了“万能换色”降低默认视觉品质。

---

# 15. 当前结论

当前阶段：

~~~text
视觉：
固定 TerryDirector Default Dark

架构：
完整 Theme Contract

UI：
不开放主题设置

未来：
可以低成本加入 Accent Picker / Theme Preset / Advanced Palette
~~~

也就是：

> **现在不做主题功能，但绝不把颜色写死到未来无法改。**
