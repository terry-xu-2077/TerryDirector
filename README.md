# TerryDirector

## 内置 Self-Lift · 主分支发布（2026-10-10）

TerryDirector 自有 Self-Lift 从 `feat/selflift-internal` 纳入 `main`，不再依赖
`SelfLiftAvatarH3Sampler` 或 selflift-Avatar 插件，不需要运行补丁安装脚本。
用户可见接线保持：**TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector / TerryDirector Advanced**。
不接二采配置时仍走原生普通采样。模型、CLIP、VAE 和目标尺寸留在导演配置，Seed 留在时间线。
H3 模型、VAE 与 latent upscaler 权重仍由用户提供。

### 已验收的 Self-Lift 默认参数

| 参数 | 默认值 |
| --- | --- |
| CFG / Denoise | 1.0 / 1.0 |
| Self-Lift 基础步数 / 低清阶段步数 | 6 / 5 |
| 低清尺寸比例 | 0.5 |
| Self-Lift 采样器 / 调度器 | Euler / simple |
| Latent 放大模型 | 优先选择 `minimax_h3_latent_upscaler_3d_fp16.safetensors` |
| rho / w_min / w_max | 0 / 0.5 / 1 |
| H3 Sigma 精修 | 开；加步1、起始0.7、结束0、cosine |
| 高清空间分块 | 关；备用设置 auto / 2 / auto |
| 独立高清模型 | 不接，沿用导演配置的主模型 |

现有节点 schema、配置归一化与 Self-Lift 运行路径已符合上述成功预设；本次发布不改采样算法。
在已验证 H3 日程上实际是**低清5步＋高清1步**，精修开关不表示强行多采一步。
已保存工作流的显式值不会被覆盖；普通生成的采样器、步数、Seed 和分辨率不改成实验值。

Self-Lift 的 RTX 3090 验证 MODEL 接线为：模型/LoRA → Kitchen 密集注意力 →
LowVRAM(head_chunks=4) → FFN(chunks=2, seq_threshold=4096) → 导演配置。
这些是上游 MODEL 配置，不是二采节点内自动注入的补丁；原有 Sage 普通工作流不会被自动改成 Kitchen。
Sol 与其桥接仍只在 `experiments/acceleration_lab/` 中独立装载，不注册到正式导演入口，
本次合并不启用 Sol，也不引入提示词增强、DLSSNR 或补帧链。

使用已验收的 cu130 核心及修复后的周边依赖，见
[环境基线](experiments/acceleration_lab/ENVIRONMENT_BASELINE.md) 和
[已验收版本约束](experiments/acceleration_lab/environment/cu130-accepted.constraints.txt)。
约束文件不自动安装依赖，也不拦截未使用它的 pip/Manager 操作。

发布范围、默认值来源和验证边界见 [Self-Lift 主分支发布说明](docs/48_SELFLIFT_MAIN_RELEASE.md)。
本节及 [内置 Self-Lift 实现说明](docs/30_SELFLIFT_INTERNAL.md) 覆盖下方历史段落中
“SelfLift 尚未接入”、旧二采控件和外部采样器依赖的描述；不改变时间线 UI、Guide、音画输出与缓存架构。

在已有仓库目录更新主分支（先保留本地未提交修改）：

```bash
git fetch origin
git switch main
git pull --ff-only origin main
```

随后重启 ComfyUI 后端并刷新页面。无需再让本地 Codex 重做本次合并。

## 原生 H3 时间线循环器（整合候选，待实机验收）

在保留上方**内置 Self-Lift** 和旧 Base / Advanced 的前提下，新增独立的循环器：
**TerryDirector 循环开始 → 循环媒体 → 普通官方 H3 生成节点组（可自由替换采样方案）→ 循环缓存 → 循环结束 → 可选循环合并**。
使用 ComfyUI 0.39.0 原生循环机制与现有 Base 无损分段缓存；**不自动沿用 Self-Lift 二采配置**，要在循环体内改用 Self-Lift 时必须自行连接相应采样节点及参数。
现有时间线编辑器 / 资产池完全复用。当前媒体适配限图片引用，视频/音频素材需后续完善。
本候选仅有代码检查和隔离测试，未完成循环器在 RTX 3090 上的 H3 实机生成，**暂不视为稳定版**。
详细接线与验收见 [循环器第一版](docs/29_NATIVE_H3_TIMELINE_LOOP.md) 与 [整合验收](docs/49_NATIVE_LOOP_MAIN_INTEGRATION.md)。

> 当前浮窗 UI / 时间线恢复基线：`408395e7620fe368775515ca515d04fae7a8daed`（Demo 06.11）。
> 下方保留历史设计与 Demo 说明；当前 Self-Lift 状态、接线和默认值以上方发布说明为准。

AI 视频镜头生成任务工作台。仓库同时保留 **HTML / CSS / JavaScript 静态交互 Demo**，并已加入第一版 **ComfyUI TerryDirector 主节点**；前端仍不做 React 拆分。

## 下一阶段架构 · 单节点与页内浮窗

当前架构：画布上使用 **TerryDirector 配置 + TerryDirector 主节点 + 导演输出节点**。配置节点集中接入模型、VAE、尺寸和共享采样参数；主节点接收“导演配置”并持有自己的原生可连接 Seed 控件。节点内是只读迷你时间轴，点击在当前 ComfyUI 页面打开大编辑浮窗；保存退出后隐藏，不再另开网页或独立端口。内部仍分开维护规划和执行，采用成熟实现但提供我们自己的节点，不要求安装或连接 Songssx 导演台节点。

当前架构详见 [配置节点架构](docs/10_CONFIG_NODE_ARCHITECTURE.md)；[单节点与页内浮窗架构](docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md) 保留为历史演进记录。当前已实现主节点外壳、节点内自定义控件、只读迷你时间线、页内导演台浮窗、工作流序列化以及 ComfyUI `input` 资产读取 / 上传；普通 H3 与内置 Self-Lift 执行链路已接入。

## ComfyUI 节点（当前）

把仓库放在 `ComfyUI/custom_nodes/TerryDirector`（或直接在已有目录更新 main）后重启 ComfyUI。在节点菜单中搜索 **TerryDirector**，分类为 `MiniMax H3/TerryDirector`。

公开节点包括 **TerryDirector 配置**、**TerryDirector 二采配置**、**TerryDirector**、**TerryDirector Advanced** 和 **TerryDirector 输出**。配置节点负责模型、CLIP、两种 VAE、分辨率及普通采样参数；主节点负责时间线和 Seed。二采参数独立成节点，经导演配置接入时间线；不接入时保持普通生成。创作浮窗、只读迷你时间线、工作流序列化及资产管理保持现有行为。

**普通 MiniMax H3 真实执行链已经接入。** TerryDirector 会把时间线编译成原生 ComfyUI H3 执行图，支持参考图片 / 视频 / 音频、尾帧参考 / 尾帧续接 / 独立三种首尾贴合关系、重叠 Guide 与空隙补黑。Base 主节点输出“导演输出”，配套 **TerryDirector 输出** 节点解包为分段 LATENT / 合并 IMAGE / 合并 AUDIO；视频创建、编码、预览与保存交给下游视频节点。Advanced 延续已验收的无损分段缓存和单次最终编码。Self-Lift 使用本仓库内置采样实现。

## Demo v0.6.14 · 创作编排浮窗

当前 Demo 只表现导演台**编辑浮窗**，不模拟生成节点参数。

| 行 | 内容 |
| --- | --- |
| 第一行 | 左侧提示词编辑，右侧共享资产池；中间分隔线可调整宽度 |
| 第二行 | 单行时间线，保留片段移动 / 裁剪、吸附、重叠反馈与总编排时长 |

静态 Demo 中**没有生成预览、分辨率、种子、采样器、Self-Lift / 二采或其他运行参数**，也不存在项目层级、首页或项目级配置。实际 ComfyUI 控件归属以上方节点说明为准；资产池属于当前 TerryDirector 节点保存的编排数据，所有片段共用。

提示词继续支持可视化 / 原文同源编辑、@ 资产引用、/ H3 语法、对白和运镜标签；资产池继续支持上传 Demo、ComfyUI input 示例选择、稳定编号、灯箱和引用清理。时间线交互与已确认的视觉层级不变。

首尾贴合的接缝气泡可在“尾帧参考 / 尾帧续接 / 独立”之间直接切换；新建片段默认值来自 ComfyUI Settings → TerryDirector → 时间线 → 默认镜头衔接，产品默认“尾帧参考”。旧工作流缺少该字段时仍按“尾帧续接”执行。

节点本体遵守既定约定：**保留 ComfyUI 原生节点容器、标题栏和端口，只在节点内容区嵌入与浮窗同源的 TerryDirector 控件与只读迷你时间线。**

## 查看与发布

根目录 `index.html` 是静态入口，保留 `src/`、`assets/` 相对位置即可。无安装、编译或外部 CDN。下载包同时提供内联的 `打开Demo.html`。

GitHub Pages：Settings → Pages → Deploy from a branch → main → /(root)。`.nojekyll` 保留。预计地址：`https://terry-xu-2077.github.io/TerryDirector/`；提交代码不等于已完成 Pages 部署。

静态 Demo 数据仍只在当前页面暂存，刷新还原；ComfyUI 节点模式则把编排与节点参数写入工作流。静态 Demo 不执行生成，也不显示生成参数。

## UI IMPLEMENTATION BLUEPRINT

**当前编辑体验延续蓝图 1.0，但节点形态、参数归属和浮窗布局以 [单节点与页内浮窗架构](docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md) 为最高优先级。** Demo v0.6.14 已按该决策移除预览、生成参数和项目层级；旧版本用于追溯。

## 文档

- [Self-Lift 主分支发布与默认参数](docs/48_SELFLIFT_MAIN_RELEASE.md)
- [单节点与页内浮窗架构（当前节点与编辑入口决策）](docs/09_SINGLE_NODE_MODAL_ARCHITECTURE.md)
- [UI 实现蓝图（实现 Source of Truth）](docs/06_UI_IMPLEMENTATION_BLUEPRINT.md)
- [成熟实现参考清单（新增需求先查这里）](docs/07_REFERENCE_IMPLEMENTATIONS.md)
- [QuantFunc 调研与暂缓接入决策（候选，等待用户明确指令）](docs/08_QUANTFUNC_RESEARCH.md)
- [本轮时间线起点与时长说明](docs/05_TIMELINE_READABILITY.md)
- [当前 UI 与时间线架构（设计演进记录）](docs/02_UI_AND_TIMELINE_ARCHITECTURE.md)
- [H3 编辑器来源与移植对应](docs/H3_EDITOR_PORT.md)
- [Demo 范围与检查记录](docs/DEMO.md)

完整产品和主题文档保留在仓库 `docs/01_PRODUCT_AND_TECH_DECISIONS.md`、`docs/03_VISUAL_THEME_CONTRACT.md`。当前节点形态以 09 为准，未涉及的 UI 范围以 06 实现蓝图及其已确认补充为准。

后续运行功能优先从用户指定的 **Songssx TimelineDirector、AIMixer Director、yolain Easy Media、nkxx188 H3 Easy** 中查找成熟实现。当前生成基础保持 ComfyUI 原生 H3 节点及自有 GraphBuilder 编排；仓库入口、核对版本与具体查找位置集中在上述参考清单。

**QuantFunc 当前仅作调研归档，暂缓接入。** 不新增依赖、UI 控件或生成路径，等待用户明确要求后再复查版本、兼容性和本机收益。

## 代码

`director_node.py` / `director_core.py` 提供当前节点 schema、导演输出适配与序列化配置；`director_h3.py` 展开原生 H3 / 内置 Self-Lift 执行图；`director_selflift*.py` 提供采样、数学、放大器与可选高清分块。`server_routes.py` 提供页内编辑器、ComfyUI input 资产及相关接口；`web/terry_director.js` / `.css` 是节点内嵌 UI。`src/h3-syntax.js` 为 H3 语法与原文标签；`src/h3-editor.js` 为可编辑视图和菜单的静态适配。现有 Canvas 时间线保持独立。

共享 UI 库、Rulesmd Editor、TerryShotMill 和来源节点仓库均未修改。诊断默认关闭；`experiments/acceleration_lab/` 不由正式根入口自动导入。

可选开发检查：`node --test tests/*.test.cjs`；配置模型检查：`python -m unittest discover -s tests -p "test_*.py" -v`。
