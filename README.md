# TerryDirector

TerryDirector 是一个面向 AI 视频生成的 **ComfyUI 内置导演工作台**。

项目当前处于 **文档与产品架构阶段**。在 UI 视觉方向、时间线交互和核心生成流程确认之前，不急于进入正式功能开发。

## 当前核心方向

- 以 **ComfyUI Custom Node 插件**形式安装和运行。
- 不再制作独立桌面应用，不使用 Tauri 作为产品壳。
- 插件在 ComfyUI 运行时内部启动独立本地 Web 工作台，浏览器访问单独端口。
- 项目、素材、生成结果直接工作在 ComfyUI 本地环境中，避免外部应用与 ComfyUI 之间反复做 Bridge、路径映射、连接验证和进程管理。
- 产品核心是 **导演工作流**：项目、素材、片段、Prompt、片段承接、时间线、生成版本、批量执行和最终组合。
- **时间线是核心工作区之一，必须做到接近 Adobe Premiere Pro 的丝滑拖动、裁剪、缩放、吸附和播放头交互体验。**
- UI 使用 Terry React UI Library 中独立的 **Studio Dark** 视觉类别；产品本身仅做暗色界面。
- TerryShotMill 暂时冻结，仅作为已有 UI / UX 与需求经验的参考项目，不继续继承其重型运行架构。

## 文档

- [产品与技术决策](docs/01_PRODUCT_AND_TECH_DECISIONS.md)
- [UI 与时间线架构](docs/02_UI_AND_TIMELINE_ARCHITECTURE.md)
- [视觉与主题颜色契约](docs/03_VISUAL_THEME_CONTRACT.md)

## 当前开发原则

> 功能复杂，架构简单。产品闭环优先于架构完整性。

任何新增抽象、服务层或运行时机制，都必须首先回答：**它解决了当前真实用户问题，还是只是在为假设中的未来做准备？**

当前默认仓库：

```text
https://github.com/terry-xu-2077/TerryDirector.git
```