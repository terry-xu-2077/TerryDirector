# TerryDirector

运行在 ComfyUI 环境中的 AI 视频导演工作台。当前先做视觉与交互 Demo，**还没有接入 ComfyUI 或真实视频生成**。

默认开发仓库：`https://github.com/terry-xu-2077/TerryDirector.git`。

## 直接看 Demo

根目录 `index.html` 是静态入口。下载仓库后保持 `src/`、`assets/` 和 `index.html` 的相对位置，使用现代桌面浏览器打开即可。没有安装步骤、构建步骤或外部 CDN 依赖。

也可以在仓库目录运行一个普通静态服务器：

```sh
python -m http.server 8000
```

然后打开 `http://localhost:8000`。

### GitHub Pages

仓库 Settings → Pages → Build and deployment：

1. Source：**Deploy from a branch**。
2. Branch：**main**；文件夹：**/(root)**。
3. Save。

不需要配置 Actions 构建。`.nojekyll` 已包含，所有资源使用相对路径，适用于仓库子路径。发布成功后预期访问地址为 `https://terry-xu-2077.github.io/TerryDirector/`。提交 Demo 不等于已经启用或部署 Pages。

## 当前 Demo v0.2 可以试什么

所有片段现在放在同一行。拖动片段 2，让它与片段 1 交叠：重叠色框、引线及下方时长自动变化。重叠区不是独立控制器，不能拖它来改片段。

还可以试：片段边缘裁剪、吸附、播放头、缩放、撤销 / 重做、卡片 / 列表、提示词切换、只读可视化预览、参数编辑、参考素材、本地媒体预览、模拟生成进度与完成耗时、配置导出，以及顶部房子按钮中的项目文件夹。

播放预置内容是**静帧时间线预演**，不是生成视频。模拟生成与示例增强不会调用任何模型。片段底部可查看进度条和生成耗时，完成时刻可悬停查看。当前不做重新生成的版本管理。数据只在当前页面暂存，刷新还原；导出的 JSON 不包含本地媒体文件。

## 当前技术边界

为直接交付静态网页，这版 Demo 使用原生 DOM 视图和独立双层 Canvas，不引入前端运行依赖。Demo 不进行 React 架构拆分；时间线与帧运算模块可独立复用，不应把当前视图适配扩张为第二个业务框架。

Studio Dark 使用明确标注来源的静态视觉快照，保留项目文件夹、卡片、标签和参数控件的视觉语言；**不是运行了共享 UI 库的 React 组件**。共享 UI 库、Rulesmd Editor、TerryShotMill 均未修改。

完整色板在 `src/theme.css` 集中管理。当前只使用默认暗色，不限制五个源颜色，也不开放主题 UI。Canvas 通过同一套语义颜色更新。

## 目录

```text
index.html              可直接托管的入口
.nojekyll               静态 Pages 标记
src/theme.css           完整源色板与语义颜色
src/studio.css          Studio Dark 静态视觉适配
src/app.css             导演工作区布局
src/core.js             整数帧运算与撤销记录
src/timeline.js         独立 Canvas 时间线
src/app.js              仅 Demo 的视图与交互数据
assets/                 本地示例画面和标识
```

## 文档

- [产品与技术决策](https://github.com/terry-xu-2077/TerryDirector/blob/main/docs/01_PRODUCT_AND_TECH_DECISIONS.md)
- [UI 与时间线架构（当前整合版）](docs/02_UI_AND_TIMELINE_ARCHITECTURE.md)
- [完整视觉主题契约](https://github.com/terry-xu-2077/TerryDirector/blob/main/docs/03_VISUAL_THEME_CONTRACT.md)
- [Demo 范围、操作、来源和验证记录](docs/DEMO.md)

UI 讨论以整合后的 02 为准，历史探索中的双行时间线、独立重叠对象与版本管理等描述不属于当前 Demo。

## 开发原则

产品体验和真实闭环优先，不再重复搭建独立桌面后端、Bridge 或多层调度基础设施。TerryShotMill 暂时冻结，仅作参考。新增功能先证明用户价值，不能用未来兼容性替代当前可用性。

帧运算测试仅需 Node，无依赖安装：

```sh
node --test tests/*.test.cjs
```
