# 内置 Self-Lift 主分支与原生 H3 循环器整合验收

## 双边界简化（2026-10-10）

用户确认最终数据层级：循环开始只显示「循环上下文」一个输出（TERRYDIRECTOR_LOOP_CONTEXT）；循环信息节点接收循环上下文，拆解为 Prompt、H3帧数、Seed、图片，并输出另一种类型的「片段数据」（TERRYDIRECTOR_SEGMENT_DATA）；循环条件与循环结束接收片段数据。前者是完整轮次信封，后者是提取的当前片段扁平参数，保留必要的前一段连续性上下文。两者 ComfyUI 类型及运行时 _type 标记均不同，不能混接。取消用户可见的循环缓存/合并节点，由循环结束内部执行无损缓存、context carry 与最终可选合并。

结束节点接收 H3采样结果 / 视频VAE / 音频VAE / 片段数据，直接输出合并画面/合并音频；「合并输出」默认开启，关闭时只保存 .pt。内部 LoopFrame、LoopCache 在 ComfyUI dev-only 分类注册，不作为用户手工接线节点。完整结构以 [29 文档](29_NATIVE_H3_TIMELINE_LOOP.md) 为准；旧三节点工作流不再适用，测试须使用新版 JSON。


状态：整合候选（等待本地短流程 GPU 验收）；不改变已经通过的 Self-Lift / Base / Advanced 运行路径。
基线：`main@dd67aa0fe9b37af2b13897dee9e7e2beb67bfb36`。
源分支：`feat/timeline-loop-native-h3@8f2ba299c1f8cd2b4e90629b2de9b16a45c9c29b`。
整合分支：`integrate/selflift-native-h3-loop`。

## 1. 与 Self-Lift 共存的方式

- 保留 `director_selflift*.py`、`director_node.py`、`director_h3.py` 和 `director_trace.py` 的主分支源码，不用旧循环器分支文件覆盖。
- 从当前主分支的 `__init__.py` 增加六个循环节点的导入及 `node_classes` 注册，同时保留 `TerryDirectorSelfLiftSampler` 和 `director_trace.install(__package__, node_classes)`。
- 在原 `web/terry_director.js` 添加 Looper 类型识别、原生页面时间线编辑器共用、当前节点运行锁与片段完成事件；不更改 Canvas 时间线核心与 CSS。
- 原循环器的 `director_loop.py`、独立测试、说明文档按原文件引入。
- 不新增循环器对 Self-Lift 二采配置的运行时耦合。原二采接线 `二采配置 → 导演配置 → Base/Advanced` 保持原状；循环器中替换 H3 采样器属于用户自行构建的外部工作流。
- 原样保留所有先前的 Self-Lift 验收证据、实验代码和模块，不移植到循环器。

## 2. 编辑器中的执行目标

- 原 Base、Advanced 继续 Partial Execution 到当前导演实例。
- Looper 编辑器从其输出连线定位唯一匹配的 LoopEnd：如没有连接下游 SaveVideo，则 Partial Execution 到 LoopEnd，产生分段无损缓存，循环正常结束。
- 如果恰好一个 `SaveVideo` 沿 LoopEnd 输出链向下游可达，自动将这一个 SaveVideo 作为 Partial Execution 终点，连同循环合并、CreateVideo 一起执行。
- 多个 SaveVideo 或无法唯一确定时回退到 LoopEnd，避免无意生成多份视频；需要全链保存可从标准 ComfyUI 队列执行。
- 同一图中其他不相关导演节点、循环器不作为执行目标。
- 任务编辑锁、事件和只读按当前 Looper 节点实例维护，不影响原 Base/Advanced。

## 3. 新循环器第一轮范围

- LoopStart 继承 ComfyUI 0.39.0 StartLoop，LoopEnd 以自有边界节点接入原生 LoopIteration / LoopProgress / LoopResult 与 external block，普通 MiniMaxH3ReferenceToVideo、AddGuide、SamplerCustomAdvanced 等在循环体中。
- 当前独立媒体节点只实现图片素材。引用视频/音频时明确抛错；待下一轮适配。
- 每段产物复用已验收的 Base `TerryDirectorDecodeSegmentToCache` 无损写盘、上下文剪取；可选 `TerryDirectorMaterializeTimeline` 生成最终 IMAGE/AUDIO，下游 CreateVideo / SaveVideo 编码。
- 不移植 Advanced 局部重跑、断点恢复和 Advanced 单次流式最终编码；旧 Advanced 自身功能仍保留。
- 本版不得声称循环器已经经过 RTX 3090 的真实采样。

## 4. 静态与 CPU 验收

开发机 / 本地 Codex 可运行：

```shell
python -m unittest discover -s tests -p 'test_loop_integration_contract.py' -v
python -m unittest discover -s tests -p 'test_director_loop.py' -v
node --check web/terry_director.js
node --test tests/*.test.cjs
```

静态验收必须至少确认：

1. 根节点注册同时存在 Self-Lift sampler、原有 Base/Advanced、全部六个循环节点和 trace.install。
2. 整合分支与 SelfLift 主分支的生产差异只涉及 `__init__.py`、新增 `director_loop.py`、`web/terry_director.js`；绝不无意重写 `director_h3.py` 或 `director_selflift*.py`。
3. LoopStart/LoopEnd schema 都设有原生 `loop_boundary`，编排数据 JSON 承接当前导入的 Prompt/图片素材，源模型/采样节点在循环体内。
4. 没有启用额外模型，原 Base/Advanced 都仍能被注册与打开。

## 5. 本机实机验收（合入 main 之前）

测试资源：用户已保存的《TerryDirector 循环器 · 官方 H3 示例》，原 9 镜头 / 7 张 input 图片 / Seed9 / 0.2MP，保留挂起状态，仅前三段 4/3/5 秒有效。

A. 启动/配置：插件无 import 错误，SelfLift 二采配置和三种导演节点均可在 ComfyUI 搜索。原 SelfLift 工作流仍能被正常载入，不删除模型设置。
B. 循环器：使用示例第一次 Queue，实际依次采样三次，Base 分段写入 3 个无损 .pt、尾帧参考读上一片段。总共 96+72+120 = 288 帧 / 12秒。检查一次 Final merge 与一次 SaveVideo。
C. UI 部分执行：在循环浮窗点击生成，只执行与当前 Looper 相连的一个 SaveVideo（有下游保存时）；复制另一 Looper 后，它的编辑状态可修改且不会被错误锁定。
D. Base/Advanced 回归：不修改现有测试工作流的模型配置，至少确认注册和原有可编辑性。SelfLift 长时 GPU 测试此前已通过，不重复做 50 秒性能 A/B。
E. 若 B/C 出现崩溃或 ComfyUI LoopValidationError，保留完整错误堆栈 / workflow JSON，在**整合分支**修复并复测，**不要**提前合入 main。

说明：本轮本地 GPU 验收尚未执行；CI/CPU 合格不等于 H3 采样质量、显存或接缝连续性经过实机确认。
