# TerryDirector Assembly 内存优化测试报告

## 范围与结论

- 代码测试基线：`24a3afc607d2005d6ff9ab17fd2864f97610b591`（任务指定基线）；当前仓库 HEAD：`1d089334f31a49f2122580feb262e8cbde10b11c`。
- 三种 Advanced 3 段运行均使用 0.5MP、960×544、seed 9、preview off、24 fps、288 帧、12 秒，沿用同一 H3 模型与同一 prompt。
- Base 和 Advanced 的累计拼接基线均成功；日志确认核心图签名完全一致。
- 临时单次 cat 与预分配原型均成功输出 960×544 / 288 帧 MP4，说明本次视频输出正确。
- **本轮不能据此宣布内存优化达标或选择落地方案。** 三种方案的过程 RSS 都达到约 19.8–20.0 GB，单次 cat/预分配没有显示有意义的峰值下降。且有效的 0.5 秒外部进程采样器未正确跟踪 ComfyUI PID（最初绑定到 watcher），故不把 watcher 报出的 26.7 MB 当成 ComfyUI 峰值。
- 依照任务的最低验收（RSS 至少下降 25%、系统 RAM peak 至少下降 10 个百分点），没有方案通过；不落地任何算法改动。

## 固定条件

| 条件 | 值 |
|---|---|
| 画面 | 0.5MP，960×544 |
| 时间线 | 3 段，终点 frame 288；不含 trailing gap |
| seed / preview | 9 / off |
| ComfyUI | 0.39.0，RTX 3090，64 GiB system RAM |
| 模型、VAE、sampler、启动参数 | 沿用此前 Base/Advanced 测试；未切换模型或启动参数 |

本次仅重放 Advanced UI 采样的 API payload，并仅在测试副本内裁成 3 段。原始工作流未修改：测试前备份与原文件 SHA-256 都是 `CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7`。

## 运行结果

| 变体 | 执行 | 总耗时 | ComfyUI RSS 观察值 | Assembly 观测 | 输出 |
|---|---|---:|---:|---|---|
| Base cumulative | 成功 | 493.2 s | 约 19.3 GB，低频观察、非严格峰值 | 输出 288 帧 | Base 输出节点成功 |
| Advanced cumulative（clone on） | 成功 | 497.33 s | 峰值约 19.8 GB（日志 checkpoint）；高频 watcher 曾误测 watcher 自身，弃用 | 三段累计 cat：0.154 s + 0.247 s；clone 合计约 0.211 s；最终 IMAGE 1721.2 MB | `TerryDirector_00043_.mp4`，960×544，288 帧，12 s |
| Advanced single final cat | 成功 | 499.16 s | 峰值约 19.95 GB（最终 assembly checkpoint）；未获得严谨系统峰值采样 | 一次 cat，三段总 IMAGE 1721.2 MB | `TerryDirector_00044_.mp4`，960×544，288 帧，12 s |
| Advanced preallocation | 成功 | 499.21 s | 峰值约 19.93 GB（最终 assembly checkpoint）；未获得严谨系统峰值采样 | 预分配+copy_，三段总 IMAGE 1721.2 MB | `TerryDirector_00045_.mp4`，960×544，288 帧，12 s |

Advanced cumulative 最后的 Assembly checkpoint：`frames=288 images=1721.2MB audio=2.9MB RSS=19779MB`。第 2 次累计 cat 复制 96 帧既有图像约 573.8 MB，第 3 次复制 168 帧既有图像约 1004.1 MB。仅累计 cat 的明确时间合计约 0.401 s；本轮端到端耗时接近 8 分 20 秒，优化 cat 时间不构成显著端到端提速。

Final cat / preallocation 在最后阶段的 RSS 分别为 19923 MB / 19907 MB，均未优于累计基线 checkpoint（19779 MB）；因阶段及进程峰值监测精度有限，这些数只作观察值，不能冒充严格峰值对比。ComfyUI `/system_stats` 在初始空闲时报告 RAM free 约 49.5 GiB；此次完整任务的系统 RAM peak 未可靠采集，故不填造相对百分点。

## 生命周期与正确性

- 有效日志在每个累计 Assembly 后确认张量形状和 dtype：96、72、120 帧分段输入均为 `(frames, 544, 960, 3)`、`torch.float32`；累计结果依次为 96、168、288 帧。
- Base 与 Advanced 累计基线报告 `Base vs Advanced core graph: EXACT MATCH`。
- single-cat 和预分配构造的 Advanced 图各有 6 个预期结构差异：3 个 `assemble` 换成 3 个 `collect_media`；其余核心处理保持同一输入签名 `968dc49a47a8942a`。
- 三种 Advanced 输出 metadata 均为 960×544、24 fps、288 帧、12.0 秒；三个 MP4 均由 ComfyUI SaveVideo 成功生成。
- Base 输出结构与 Advanced terminal success 已复核。本轮没有对三份 MP4 做逐帧像素或音轨 checksum；Base 也没有另行导出比较视频，因此“视觉/音频逐样本完全一致”仍未验证。没有记录每一阶段 audio sample rate/duration，所以本报告不把它们宣称为已做逐样本等价证明。

## Clone A/B 与局限

任务要求 clone on/off 单独 A/B。本次去 clone 的 Advanced 运行尚未完成，因此该子项仍缺证据。累计 clone-on 的三个 trim/clone 日志耗时合计约 0.211 秒；这不能替代同条件 clone-off 对照，也无法证明 clone 可安全移除。现有 clone 语义保留。

更重要的测量限制：首次监控脚本读取到自己的 watcher PID，而非 ComfyUI PID；此后通过服务器日志和外部进程读数确认了约 19.8–20.0 GB 的 RSS 观察值，但没有在全部变体用同一可靠的高频采样器取得完整 process/system-memory 峰值。因此不作 25% RSS 或 10 个百分点 RAM 的达标声明。

## 决策

- 未采用 single final cat 或预分配原型：两者在最后 Assembly 阶段的 RSS 观察值没有比累计 cat 更低，且缺少统一严谨的全程峰值与逐帧/音轨等价证据。
- 不改变正式 Base/Advanced 图、不移除 clone、不改变媒体输出协议。
- 测试期间的 `director_internal.py`、`director_h3.py` 与 `__init__.py` 临时修改均已还原；`director_internal.py` 与 `director_h3.py` SHA-256 已与修改前备份核对一致。任务文档仍保留为未跟踪文件，原始工作流与备份哈希相同。
- 下轮应先修正监控脚本，使其通过 ComfyUI PID（不是 watcher PID）采样 RSS 和系统 RAM，再独立跑 clone-off、single-cat 和 preallocation 的同条件 A/B；完成音频元数据与输出比较后再决定是否落地。