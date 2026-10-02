# TerryDirector

> 当前浮窗 UI / 时间线恢复基线：`408395e7620fe368775515ca515d04fae7a8daed`（Demo 06.11）。

AI 视频镜头生成任务工作台。当前为 **HTML / CSS / JavaScript 静态交互 Demo**，不连接 ComfyUI，不做 React 拆分。

## 下一阶段架构 · 单节点与页内浮窗

2026-10-02 确认：画布上保留**一个采样器式 TerryDirector 主节点**，接入模型与采样参数、输出结果到下游解码。节点内是只读迷你时间轴，点击在当前 ComfyUI 页面打开大编辑浮窗；保存退出后隐藏，不再另开网页或独立端口。内部仍分开维护规划和执行，采用成熟实现但提供我们自己的节点，不要求安装或连接 Songssx 导演台节点。

详见 [单节点与页内浮窗架构](docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md)。当前静态 Demo 已更新到浮窗的创作编排形态；真实 ComfyUI 节点和采样仍未实现。

## Demo v0.6.14 · 创作编排浮窗

当前 Demo 只表现导演台**编辑浮窗**，不模拟生成节点参数。

| 行 | 内容 |
| --- | --- |
| 第一行 | 左侧提示词编辑，右侧共享资产池；中间分隔线可调整宽度 |
| 第二行 | 单行时间线，保留片段移动 / 裁剪、吸附、后续联动、重叠反馈与总编排时长 |

浮窗中**没有生成预览、分辨率、种子、采样器、SelfLift / 二采、生成按钮或其他运行参数**；这些全部属于未来的 ComfyUI 主节点。也不再存在“项目”层级、项目首页、项目标题或项目级配置入口。资产池直接属于当前 TerryDirector 节点保存的编排数据，所有片段共用。

提示词继续支持可视化 / 原文同源编辑、@ 资产引用、/ H3 语法、对白和运镜标签；资产池继续支持上传 Demo、ComfyUI input 示例选择、稳定编号、灯箱和引用清理。时间线交互与已确认的视觉层级不变。

节点本体的设计约定是：**保留 ComfyUI 原生节点容器、标题栏和端口，只在节点内容区嵌入与浮窗同源的 TerryDirector 控件与只读迷你时间线。** 这轮尚未实现节点 UI。

## 查看与发布

根目录 `index.html` 是静态入口，保留 `src/`、`assets/` 相对位置即可。无安装、编译或外部 CDN。下载包同时提供内联的 `打开Demo.html`。

GitHub Pages：Settings → Pages → Deploy from a branch → main → /(root)。`.nojekyll` 保留。预计地址：`https://terry-xu-2077.github.io/TerryDirector/`；提交代码不等于已完成 Pages 部署。

数据只在当前页面暂存，刷新还原；Demo 不执行生成，也不显示生成参数。

## UI IMPLEMENTATION BLUEPRINT

**当前编辑体验延续蓝图 1.0，但节点形态、参数归属和浮窗布局以 [单节点与页内浮窗架构](docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md) 为最高优先级。** Demo v0.6.14 已按该决策移除预览、生成参数和项目层级；旧版本用于追溯。

## 文档

- [单节点与页内浮窗架构（当前节点与编辑入口决策）](docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md)
- [UI 实现蓝图（实现 Source of Truth）](docs/06_UI_IMPLEMENTATION_BLUEPRINT.md)
- [成熟实现参考清单（新增需求先查这里）](docs/07_REFERENCE_IMPLEMENTATIONS.md)
- [QuantFunc 调研与暂缓接入决策（候选，等待用户明确指令）](docs/08_QUANTFUNC_RESEARCH.md)
- [本轮时间线起点与时长说明](docs/05_TIMELINE_READABILITY.md)
- [当前 UI 与时间线架构（设计演进记录）](docs/02_UI_AND_TIMELINE_ARCHITECTURE.md)
- [H3 编辑器来源与移植对应](docs/H3_EDITOR_PORT.md)
- [Demo 范围与检查记录](docs/DEMO.md)

完整产品和主题文档保留在仓库 `docs/01_PRODUCT_AND_TECH_DECISIONS.md`、`docs/03_VISUAL_THEME_CONTRACT.md`。当前节点形态以 09 为准，未涉及的 UI 范围以 06 实现蓝图及其已确认补充为准。

后续运行功能优先从用户指定的 **Songssx TimelineDirector、AIMixer Director、yolain Easy Media、nkxx188 H3 Easy** 中查找成熟实现。当前生成基础保持 Songssx 的有限分段链路，其余参考按需求补充；仓库入口、核对版本与具体查找位置集中在上述参考清单。

**QuantFunc 当前仅作调研归档，暂缓接入。** 不新增依赖、UI 控件或生成路径，等待用户明确要求后再复查版本、兼容性和本机收益。它不是当前开发前置条件，也不替代既定 Songssx / SelfLift 方向。

## 代码

`src/h3-syntax.js` 为 H3 语法与原文标签；`src/h3-editor.js` 为可编辑视图和菜单的静态适配；`src/h3-editor.css` 消费现有主题变量。现有 Canvas 时间线保持独立，不增加运行依赖。

共享 UI 库、Rulesmd Editor、TerryShotMill 和来源节点仓库均未修改。

可选开发检查：`node --test tests/*.test.cjs`。