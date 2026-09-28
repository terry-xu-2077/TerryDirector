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

## 当前 Demo v0.3：只做任务编排

工作区现在只有三个常驻区域：**提示词编辑、参考资产填充、单行时间线**。没有常驻视频预览、左侧片段列表或右侧设置检查器。项目文件夹从顶部入口打开，不占编排区域。

在时间线上选片段，上方直接编辑对应提示词；导入或拖入图片、视频、音频即可填充参考，点击资产插入引用标签。用户 / AI 提示词独立，可视化目前只读，默认使用文本编辑。

时间线保留 v0.2 的移动、裁剪、吸附、缩放、撤销与自动重叠。时长标记由引线放在框下方；片段底部显示模拟进度和生成耗时。当前不做实时播放或片段版本管理。

模拟生成约 6 秒，不调用任何模型。数据只在本页暂存，刷新还原；导出的 JSON 不包含媒体文件。

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

UI 讨论以整合后的 02 为准，历史探索中的预览中心布局、双行时间线、独立重叠对象与版本管理等描述不属于当前 Demo。

## 开发原则

产品体验和真实闭环优先，不再重复搭建独立桌面后端、Bridge 或多层调度基础设施。TerryShotMill 暂时冻结，仅作参考。新增功能先证明用户价值，不能用未来兼容性替代当前可用性。

帧运算测试仅需 Node，无依赖安装：

```sh
node --test tests/*.test.cjs
```
