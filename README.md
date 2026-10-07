# TerryDirector

> 当前浮窗 UI / 时间线恢复基线：`408395e7620fe368775515ca515d04fae7a8daed`（Demo 06.11）。

AI 视频镜头生成任务工作台。仓库同时保留 **HTML / CSS / JavaScript 静态交互 Demo**，并已加入第一版 **ComfyUI TerryDirector 主节点**；前端仍不做 React 拆分。

## 下一阶段架构 · 单节点与页内浮窗

当前架构：画布上使用 **TerryDirector 配置 + TerryDirector 主节点**。配置节点集中接入模型、VAE、尺寸和采样参数，主节点只接收一个“导演配置”输入并输出结果。节点内是只读迷你时间轴，点击在当前 ComfyUI 页面打开大编辑浮窗；保存退出后隐藏，不再另开网页或独立端口。内部仍分开维护规划和执行，采用成熟实现但提供我们自己的节点，不要求安装或连接 Songssx 导演台节点。

当前架构详见 [配置节点架构](docs/10_CONFIG_NODE_ARCHITECTURE.md)；[单节点与页内浮窗架构](docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md) 保留为历史演进记录。当前已实现主节点外壳、节点内自定义控件、只读迷你时间线、页内导演台浮窗、工作流序列化以及 ComfyUI `input` 资产读取 / 上传；采样执行链路仍未接入。

## ComfyUI 节点测试版（当前）

把仓库放在 `ComfyUI/custom_nodes/TerryDirector`（或直接在已有目录 `git pull`）后重启 ComfyUI。在节点菜单中搜索 **TerryDirector**，分类为 `MiniMax H3/TerryDirector`。

本轮请优先验证：**TerryDirector 配置** 和 **TerryDirector** 是否都能正常注册；主节点左侧是否只剩一个“导演配置”输入；配置节点的 `width` / `height` 是否为外接输入；`config_json` 是否完全隐藏；Seed、参考图尺寸和“二采方案”是否正常；二采默认“无”，选择 `SelfLift` 后才展开模型和高清占比；只读迷你时间线与标题右侧编辑按钮是否正常；页内导演台的毛玻璃叠层、窗口尺寸和右上角关闭按钮是否符合预期；从 ComfyUI `input` 选择 / 上传资产后能否保存；保存工作流、重新载入以及复制节点后数据是否各自独立。

**当前测试版故意没有接入采样执行。** 如果直接 Queue，节点会抛出明确的“采样执行尚未接入”提示，而不是返回伪造结果。等这轮节点 UI / 序列化验收稳定后，再接 MiniMax H3 分段采样、重叠合成与 SelfLift 运行链路。

## Demo v0.6.14 · 创作编排浮窗

当前 Demo 只表现导演台**编辑浮窗**，不模拟生成节点参数。

| 行 | 内容 |
| --- | --- |
| 第一行 | 左侧提示词编辑，右侧共享资产池；中间分隔线可调整宽度 |
| 第二行 | 单行时间线，保留片段移动 / 裁剪、吸附、后续联动、重叠反馈与总编排时长 |

浮窗中**没有生成预览、分辨率、种子、采样器、SelfLift / 二采、生成按钮或其他运行参数**。其中预览不再属于 TerryDirector 职责；目标 `width` / `height` 由节点外部连入；二采方案留在主节点，默认“无”，选择 `SelfLift` 时才显示其专属参数。也不再存在“项目”层级、项目首页、项目标题或项目级配置入口。资产池直接属于当前 TerryDirector 节点保存的编排数据，所有片段共用。

提示词继续支持可视化 / 原文同源编辑、@ 资产引用、/ H3 语法、对白和运镜标签；资产池继续支持上传 Demo、ComfyUI input 示例选择、稳定编号、灯箱和引用清理。时间线交互与已确认的视觉层级不变。

节点本体遵守既定约定：**保留 ComfyUI 原生节点容器、标题栏和端口，只在节点内容区嵌入与浮窗同源的 TerryDirector 控件与只读迷你时间线。** 节点 UI 已进入本地验收阶段。

## 查看与发布

根目录 `index.html` 是静态入口，保留 `src/`、`assets/` 相对位置即可。无安装、编译或外部 CDN。下载包同时提供内联的 `打开Demo.html`。

GitHub Pages：Settings → Pages → Deploy from a branch → main → /(root)。`.nojekyll` 保留。预计地址：`https://terry-xu-2077.github.io/TerryDirector/`；提交代码不等于已完成 Pages 部署。

静态 Demo 数据仍只在当前页面暂存，刷新还原；ComfyUI 节点模式则把编排与节点参数写入工作流。静态 Demo 不执行生成，也不显示生成参数。

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

`director_node.py` / `director_core.py` 提供 V3 节点 schema 与序列化配置；`server_routes.py` 提供页内编辑器、ComfyUI `input` 资产和 SelfLift 模型列表接口；`web/terry_director.js` / `.css` 是节点内嵌 UI。`src/h3-syntax.js` 为 H3 语法与原文标签；`src/h3-editor.js` 为可编辑视图和菜单的静态适配。现有 Canvas 时间线保持独立。

共享 UI 库、Rulesmd Editor、TerryShotMill 和来源节点仓库均未修改。

可选开发检查：`node --test tests/*.test.cjs`；配置模型检查：`python -m unittest discover -s tests -p "test_*.py" -v`。