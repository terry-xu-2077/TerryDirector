# TerryDirector 时间线循环器 · 流式视频输出（当前 H3 适配）

> 整合测试分支：integrate/selflift-native-h3-loop。基于 ComfyUI 0.39.0 原生循环、原 Base 无损 .pt 分段缓存；尚待用户 RTX 3090 实际视频生成验收。原 Base/Advanced/SelfLift 采样逻辑保持不变。

## 用户看到的节点

TerryDirector 循环开始 → 【循环上下文】→ TerryDirector 循环信息
→ 【片段数据】→ TerryDirector 循环条件、TerryDirector 循环结束
→ 官方 MiniMaxH3ReferenceToVideo / BasicGuider / SamplerCustomAdvanced
→ TerryDirector 循环结束（接收采样结果、两个 VAE、片段数据）
→ 【视频 VIDEO】直接连接官方 SaveVideo
→ 【分段潜变量 LATENT 列表】仅在需要时连接其他节点

循环开始保留同一套时间线和编辑窗口；循环信息节点输出提示词、采样帧数、Seed、片段数据与最多 9 张参考图。循环上下文类型 TERRYDIRECTOR_LOOP_CONTEXT 和片段数据类型 TERRYDIRECTOR_SEGMENT_DATA 仍然区分，无法混接。

循环结束仅有两个输出：**视频 VIDEO（输出0）**和**分段潜变量 LATENT 列表（输出1）**。不再有合并 IMAGE/AUDIO，不需要 CreateVideo，也不提供 A/B 模式切换或合并开关。无需兼容旧版循环结束工作流。


## 模型中立接口与当前适配边界

对外用户界面统一使用模型中立名称：

| 节点 / 位置 | 对外名称 | 含义 |
| --- | --- | --- |
| 循环开始 → 循环信息 | 循环上下文 | 当前片段、上一轮上下文与循环状态 |
| 循环信息 → 视频生成链 | 采样帧数 | 当前生成节点需要采样的帧数，不等于剪辑后的最终输出帧数 |
| 循环信息 → 循环条件 / 循环结束 | 片段数据 | 处理过的片段参数与承接上下文 |
| 循环结束 ← 采样节点 | 采样结果 | 上游视频生成器的潜变量结果 |
| 循环结束 → SaveVideo | 视频 | 低内存流式 VIDEO 输出 |

循环节点统一位于 \`TerryDirector/循环\` 分类，隐藏内部适配节点位于 \`TerryDirector/循环/内部\`。**类别与接口不再附带固定 H3 前缀。** 但当前 H3 测试工作流中的原生 MiniMaxH3ReferenceToVideo 等模型专属节点仍保留它们本来的名称。

**注意：对外接口名称通用，不等于任意模型已自动兼容。** 当前版本这些内部环节仍是 H3 适配实现：

- \`director_compile.py\` 使用 H3 的 5+17n 帧数对齐与 Guide 规则，循环信息输出的「采样帧数」目前来自 \`h3_frames\`。
- \`TerryDirectorLoopInfo\` 以最多 9 张图片参考槽位组织 H3 素材，其他模型可能需要不同的输入组织方式。
- \`TerryDirectorLoopCondition\` 的尾帧续接 / 重叠条件调用 \`MiniMaxH3AddGuide\`，不能直接代替 LTX 的条件构造。
- \`TerryDirectorLoopCache\` 复用 H3 联合音视频 LATENT 解码与 Base 缓存；其他模型必须先适配各自的潜变量、视频和音频解码。
- 「循环开始 / 结束」的动态 GraphBuilder、无损文件化缓存与 VIDEO 保存机制可作为模型间复用的底层基础。若需 LTX 2.5，下一步应单独实现帧数规划、素材/条件构造和解码适配，并对其原生节点链做本机验证。

## VIDEO 的真正低内存实现

1. 原有 TerryDirectorDecodeSegmentToCache 每轮将 IMAGE float32 和 AUDIO 无损写入 .pt。下一个片段只承接上一段必需的尾帧/重叠图像与音频；不会累积整条 IMAGE。
2. 所有片段生成后，TerryDirectorLoopEnd 不调用 TerryDirectorMaterializeTimeline，也不预分配完整 IMAGE/AUDIO。它返回实现 ComfyUI 官方 VideoInput 接口的 TerryDirectorStreamVideo 轻量对象，只包含各段缓存路径、fps、位深、色彩空间等元信息。
3. 官方 SaveVideo 查询该对象的 get_dimensions()，随后调用 save_to()。VIDEO 逐段加载无损 .pt、逐帧送入一个视频编码会话、逐段送入同一音频编码会话，再释放本段画面/音频。最终仅进行一次有损视频/音频编码，不产生中间 H.264。
4. SaveVideo 成功保存文件后删除本次运行的无损缓存目录；失败时删除不完整的目标视频、保留缓存便于定位错误。仅运行循环结束未连接 SaveVideo 时，.pt 保留至下一次该循环实例生成之前。
5. 分段潜变量按需生成：只有输出1连接下游时，才在每轮将完整原始 H3 AV LATENT 存为 CPU .latent.pt 并于结束时加载为列表；正常仅输出 VIDEO 时不消耗额外 LATENT 缓存。
6. 循环结束内嵌卡片改成**「视频输出检查」**，显示时长、上游真实分辨率、24 fps、启用片段数，以及按原始 RGB float32 画面与音频估算的临时缓存空间（加约 25% 余量），而不是抽象地强调节省了多少内存。ComfyUI 通过只读接口 GET /terrydirector/api/temp-space 查询实际临时目录所在磁盘的剩余容量，只返回可用字节与盘符，不泄露完整本地路径。空间接近不足时用日常中文提示清理磁盘；保存成功自动清理缓存。此处**不是最终 MP4 大小预测**。

## 参数位置和职责

- 帧率为时间线固定的 24 fps，不增加普通控件。
- 循环结束的高级输入：bit_depth 为 auto/8/10，默认 auto；color_space 为 sRGB/HDR/HDR PQ，默认 sRGB。按官方 CreateVideo 的相同语义，auto 对 SDR 选择8位，对 HDR 选择10位。color_space 仅设置编码色彩空间，不会将 SDR 自动转换成 HDR。
- 视频格式 MP4/MKV/WebM、编码 H.264/AV1、CRF、文件名全部由官方 SaveVideo 设置。官方 SaveVideo 已支持标准 VIDEO 输入，无需定制保存节点。

## 边界

- 长视频仍需要足够磁盘空间保存逐段无损缓存，也需要容纳**一个片段**的解码张量以及视频/音频编码器本身的内存；不能保证任意配置下都不会耗尽内存。磁盘预计值用于提前提示，不是可靠的最大开销保证；运行时其他软件也可能占用磁盘。
- 该 VIDEO 在首次 SaveVideo 成功保存前不能被要求直接物化完整图像，例如 GetVideoComponents 或视频裁剪；会明确提示先保存。保存后从已生成的视频文件正常按官方接口访问。
- 当前循环信息仍只处理图片参考；视频/音频引用会显式报错。高级断点恢复、局部重跑仍保留在原 Advanced 中，未迁入此循环器。
- 这版新输出协议不用兼容旧工作流。导入新版 JSON：17 节点、36 连线，原九镜头提示词与七张图片资产完整保留，默认仅前3段启用。

## 本地验收

    python -m unittest discover -s tests -p "test_director_loop.py" -v
    python -m unittest discover -s tests -p "test_loop_video.py" -v
    python -m unittest discover -s tests -p "test_loop_integration_contract.py" -v
    node --check web/terry_director.js
    node --test tests/*.test.cjs
    python -m unittest discover -s tests -p "test_loop_temp_space.py" -v

用新版示例做 4s+3s+5s 的官方 H3 循环：期望三次采样、三个 .pt 分段、24fps 下共288帧12秒、一条 SaveVideo 直连输出。检查保存时内存不会增加整段 IMAGE、最终视频音画、保存后缓存删除与失败保留。真实 GPU 生成尚未完成，不能把静态/隔离测试当作实机验收。
