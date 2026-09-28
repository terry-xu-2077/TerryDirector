# TerryDirector

当前是视觉 / 交互 Demo 阶段。先读 README、docs/02_UI_AND_TIMELINE_ARCHITECTURE.md、docs/03_VISUAL_THEME_CONTRACT.md 与 docs/DEMO.md。

- 面向用户只说“片段”或“时间线片段”。
- 时间线只有两行；重叠由片段起止位置派生，不能单独选中、拖动或调长度。
- 区间用整数帧 `[start,end)`。一整次拖动只记一步撤销。
- 颜色数量不受五色限制，但颜色必须集中由主题变量管理，Canvas 与页面同源。
- 保留根目录 index.html 和相对资源路径；当前 Demo 不引入运行依赖、后端或模型调用。
- 模拟进度、示例增强、演示版本、静帧预演必须明确标记，不显示虚假连接或持久化状态。
- 不修改 Rulesmd Editor 或共享 UI 库的 Base 样式；TerryShotMill 只作冻结参考。
- 当前静态视图适配不是新的 UI 框架。正式 React 接入时复用公共组件和独立时间线模块。
- 优先完成可见交互，不因假设中的未来要求扩张架构。验证范围与真实完成情况必须一致。
