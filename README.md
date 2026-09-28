# TerryDirector

运行在 ComfyUI 环境中的 AI 视频导演工作台。当前是 **HTML / CSS / JavaScript 视觉交互 Demo**，尚未接入 ComfyUI 或真实生成。

默认仓库：`https://github.com/terry-xu-2077/TerryDirector.git`。

## 直接查看

根目录 `index.html` 为静态入口，保留 `src/`、`assets/` 的相对位置即可托管，无安装步骤、构建步骤或外部 CDN 依赖。下载包的 `打开Demo.html` 是同内容内联单文件。

GitHub Pages：Settings → Pages → Deploy from a branch → main → /(root) → Save。`.nojekyll` 已包含。预期地址为 `https://terry-xu-2077.github.io/TerryDirector/`；提交代码不代表已开启或完成部署。

也可在本地运行普通静态服务器：

```sh
python -m http.server 8000
```

## Demo v0.5

主工作区仍然只有 **提示词编辑、参考资产填充、单行时间线**。

- “生成预览”改为生成过程的中间画面反馈：可开关、悬浮显示、关闭不占空间；Demo 仅模拟，正式版接 ComfyUI 原生采样预览。
- 参考素材点击打开独立大图 / 媒体灯箱，不再嵌入参考资产区；插入引用使用单独按钮。
- 提示词只保留 **可视化 / 纯文本**，共享一份内容；移除 AI 增强、双来源及示例增强逻辑。可视化目前只读。
- 时间线工具按钮加可见名称，**新建片段移至左侧**，缩放 / 适应全部留在右侧。
- 保留单行叠放、移动、裁剪、吸附、撤销，以及被动重叠和下方引线时长。片段底部显示模拟进度及耗时。

参考素材灯箱只用于查看素材；生成预览只用于生成过程反馈，两者完全分离。模拟生成约 6 秒，不调用模型，不创建版本。刷新还原，导出 JSON 不包含媒体文件或预览开关。

## 技术和复用边界

保持原生 DOM + 独立双层 Canvas，不拆 React，不新增运行依赖。Studio Dark 为注明来源的静态视觉适配，不是运行共享库 React 组件。未修改共享 UI 库、Rulesmd Editor 或 TerryShotMill。

完整色板集中在 `src/theme.css`，不限定五个源色，Canvas 与页面同源。目前只有默认暗色，不开放主题设置。

## 文档

- [产品与技术决策](docs/01_PRODUCT_AND_TECH_DECISIONS.md)
- [当前 UI 与时间线架构](docs/02_UI_AND_TIMELINE_ARCHITECTURE.md)
- [完整视觉主题契约](docs/03_VISUAL_THEME_CONTRACT.md)
- [Demo 操作、来源与检查边界](docs/DEMO.md)

当前布局以 02 为准。历史探索中的监视器中心、双行时间线、AI 增强和片段版本管理不属于本轮实现。

## 开发原则

只实现用户确认的实际需求。参考 TimelineDirector 的实用功能，不把导演工作台扩张为通用剪辑软件或治理平台。TerryShotMill 暂时冻结，仅作参考。

帧运算检查无需依赖安装：

```sh
node --test tests/*.test.cjs
```