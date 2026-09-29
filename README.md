# TerryDirector

AI 视频镜头生成任务工作台。当前为 **HTML / CSS / JavaScript 静态交互 Demo**，不连接 ComfyUI，不做 React 拆分。

## Demo v0.6.4

- 提示词内的图片、音视频、语法与对白标签统一行内居中；中间资产区默认从 348px 加宽至 460px。
- 分辨率改用比例 + 像素量 MP + 尺寸倍数，实时显示实际宽 × 高；默认 16:9 / 1.2 MP / 32 → 1504 × 832，每片段独立保存。
- 四周留白加倍、外部背景调暗；时间线默认高度 200px，提示词标题与工具行压缩，正文获得更多空间。
- 上方从左到右为提示词、参考资产配置、固定生成预览，下方为时间线。预览窗始终保留；开关只控制画面更新，不隐藏区域或影响生成。分辨率、开关和生成按钮统一放在预览窗下方。预览仍是模拟反馈，不是模型输出。
- 提示词可视化可以直接编辑，保留纯文本切换。两种方式使用同一份原文。
- 从 Terry 的 H3 编辑器移植 `@` 引用与 `/` 语法菜单：全部 46 条命令、五类入口、镜头运动子菜单及 20 种运镜。支持搜索、键盘选择、标签更换、对白编辑、原文复制与撤销。
- 参考资产仍跟随当前片段；点击素材打开独立大图 / 媒体灯箱，插入引用使用单独按钮。
- 已认可的单行时间线、自动重叠、引线标记、进度及耗时不变。没有 AI 增强或版本管理。

## 查看与发布

根目录 `index.html` 是静态入口，保留 `src/`、`assets/` 相对位置即可。无安装、编译或外部 CDN。下载包同时提供内联的 `打开Demo.html`。

GitHub Pages：Settings → Pages → Deploy from a branch → main → /(root)。`.nojekyll` 保留。预计地址：`https://terry-xu-2077.github.io/TerryDirector/`；提交代码不等于已完成 Pages 部署。

数据只在当前页面暂存，刷新还原；导出配置不包含素材文件。模拟生成约 6 秒，不调用模型。

## 文档

- [当前 UI 与时间线架构](docs/02_UI_AND_TIMELINE_ARCHITECTURE.md)
- [H3 编辑器来源与移植对应](docs/H3_EDITOR_PORT.md)
- [Demo 范围与检查记录](docs/DEMO.md)

完整产品和主题文档保留在仓库 `docs/01_PRODUCT_AND_TECH_DECISIONS.md`、`docs/03_VISUAL_THEME_CONTRACT.md`。当前 UI 范围以 02 为准。

## 代码

`src/h3-syntax.js` 为 H3 语法与原文标签；`src/h3-editor.js` 为可编辑视图和菜单的静态适配；`src/h3-editor.css` 消费现有主题变量。现有 Canvas 时间线保持独立，不增加运行依赖。

共享 UI 库、Rulesmd Editor、TerryShotMill 和来源节点仓库均未修改。

可选开发检查：`node --test tests/*.test.cjs`。
