# H3 加速实验台：独立节点链验证，暂不接入导演

> 分支：`feat/selflift-internal`；正式代码冻结基线：`0c82cd7bfb2de963304479eda86e02513e106da0`。  
> 用户确认：不动现有节点内容，新开测试链，技术跑通后再植入导演节点。  
> 本轮交付的是实验任务、配置清单与边界检查工具；独立 ComfyUI 工作流和可选实验辅助节点由本地 Codex 构建，尚无本轮 GPU 结果。

## 1. 隔离边界（覆盖旧任务允许修改 director_trace 的授权）

**不得继续把新加速项或诊断入口加到导演节点里。** 根 `__init__.py`、所有 `director_*.py`、`server_routes.py`、`src/`、`web/`、现有 tests、默认值和旧示例均保持冻结基线原样。报告46与已认可的原工作流不覆盖；不合并 main。

实验实现、测试、构建脚本、脱敏模板及报告仅放 `experiments/acceleration_lab/`。新辅助节点统一使用 `TerryAccelLab*` 类名和独立分类；只在显式安装的实验扩展中注册，根扩展不得自动导入实验目录。优先用原生现成节点，勿为实验复制整套导演系统。

运行时测试图**不含** TerryDirector、Advanced、导演配置、二采配置、导演输出或其它导演编排 helper；既不是修改原节点，也不是复制一个 Advanced 改名字继续跑。允许只读复用已验证的 `TerryDirectorSelfLiftSampler`／其 `sample_selflift` 数学核心，但不能改变其源码、schema、函数对象或恢复外部 `SelfLiftAvatarH3Sampler` 依赖。

在独立 ComfyUI 实验实例/独立 custom_nodes 装载目录运行，沿用已验证版本和同一 Python 环境，不升级依赖；可只读共用模型和输入素材，输出、用户目录、临时文件及端口独立。实际 CLI 以本机支持项为准，不猜启动参数。不要并发占用同一 GPU，不中断其他任务、不清空其他队列、不重启或改写正式服务。需要新工作区可用本机固定 ComfyUI 提交的独立 worktree；新实验扩展只装入该实例。

不要启用旧 `TERRYDIRECTOR_TRACE`、`TERRYDIRECTOR_OP_PROFILE`、`TERRYDIRECTOR_BACKEND_VERIFY`：它们依赖导演上下文或密集 Kitchen 计数，不能用来判定新稀疏链。实验计时放在独立辅助节点/驱动中，不能反向修改正式 trace。

## 2. 内容与参数来源

内容基底是报告46的成功请求 `selflift_kitchen_attention_clip1_request.json`：

```text
SHA-256: fa15bd5cc127969374d565f2caad664dd9bdc0c41e800c5f59521544328e5a64
旧任务: 287705bf-9d2d-400b-874e-84e21de4b1d7
已认可成片: TerryDirector_SelfLift_Kitchen_Clip1_00001_.mp4
```

位置见报告46；可定位同哈希文件，但不能拿原附件的战壕提示词替换导演台驾驶舱片段。保留 clip-1 全字段、globalPrompt、useGlobalPrompt、实际编译后的最终提示词、七项资产及稳定编号/顺序/路径。片段 refs 为空不意味着无资产。可以离线只读调用冻结版编译函数解析数据，**不要调用导演 execute 或向服务提交导演图来提取工作流**。

独立图把原输入显式展开为资产加载、`MiniMaxH3ReferenceToVideo`、负向条件、Sigma 和采样。逐项对照原真实输入；若现有 history 没保存完整展开图，按本机冻结源码解析，不手工改写提示词。首次构建输出映射表、提示词/资产哈希与白名单 diff。找不到来源/资产则 BLOCKED，不下载替代素材。

固定：原 ref2va INT8 主模型、原 ref2v Turbo LoRA及强度、CLIP、原两种VAE、参考图尺寸、Kitchen密集后端、LowVRAM(4)、FFN(2/4096)；1920×1088、不做空间裁剪或缩放，24fps、96输出帧、4秒，H3内部对齐107帧（核对实际编译结果）。时间裁切沿用原输出索引并记录，不能把107帧直接当4秒保存。

Self-Lift：Seed1000/fixed、CFG1、低清5步、比例0.5、Euler/simple/基础6步/Denoise1；Sigma精修开，加1步，阈值0.7到0、cosine；rho/w_min/w_max=0/0.5/1；`minimax_h3_latent_upscaler_3d_fp16.safetensors`；不另接高清模型，highres_tiling=false，预览关闭。参数来自最初附件，**不运行原插件**。精修只按冻结逻辑有条件触发，不硬凑5+2。

## 3. 构建四个独立工作流文件，不共用可误运行的输出图

### B0：密集基线

```text
原模型 → 原LoRA → Kitchen → LowVRAM(4) → FFN(2/4096)
                                               ↓ MODEL
原提示词/七项资产 → 原生H3条件构造 → 实验Self-Lift采样
                         原Sigma日程 ──────────┘
                                  ↓ 完整音视频LATENT
                 音画分离/原VAE解码 → 原时间裁切 → 原生保存
```

新实验采样节点是薄适配，不重写算法。确需低/高清计时时，可通过冻结 `sample_selflift` 已有 `_backend` 注入一个**仅在实验节点实例持有**的 `ComfyBackend` 子类，`sample` 与 callback各原样转发一次，其余行为继承原实现；不得修改生产类或全局 monkeypatch。把私有注入视为固定版本实验接口，不作为正式API发布。辅助Sigma节点同样只读复用冻结精修函数，不引用导演配置节点执行。

完整AV latent使用独立格式保存，保留视频/音频、mask和必要元数据，读写往返逐值检查；不得把AV错误地拆成单视频张量、乘latent缩放、丢noise_mask或重建音频噪声。保存点不产生第二个隐含输出任务。

### B1：仅增加原生 Sol-Attn

复制B0为另一文件，只在MODEL链末端加入 `BlockSparseAttention(selection=sol-attn)`，输出接同一个实验采样器；不更换VAE、模型、LoRA、参考或Self-Lift日程。原生稀疏可能改写H3注意力forward/producer，必须检查与已有KJ补丁的组合，不能保证稀疏路径仍按原四组实现执行，也不能把所有收益都叫kernel替换。

首轮只用以下**实验预设，不宣称官方最优参数**：

| 参数 | 值 |
|---|---|
| selection | sol-attn |
| tau | 1.0 |
| start_percent / end_percent | 0.05 / 1.0 |
| dense_blocks | `0,1,48,49`（先确认实际50块，禁止用-1代指末层） |
| min_tokens / extra_tokens | 12288 / 256 |
| sink_conditioning | exact_kv_and_rows |
| verbose | true |

按实际模型 `percent_to_sigma` 计算启用边界，逐个Sigma给出预计稀疏/密集判定；start_percent不是步序号。预检需要预计低/高清均至少有一个可用稀疏调用；不符合时先报告，不自动搜索参数。保护条件行降低风险，但不保证身份/音频绝不变化。

原生V3 DynamicCombo的UI值、API序列化值与Python execute参数不是同一表示，使用本机object_info/原生前端生成正确输入，勿把字符串直接塞进需要字典的Python execute。

### V0 / V1：同一个已保存LATENT，仅比较视频VAE解码

```text
同一份已验证的完整AV LATENT → 取视频分量 → 原视频VAE（V0）→ 保存
                                     → INT8视频VAE（V1）→ 保存
```

两行分别保存为文件、分别提交，**图里没有UNET、CLIP、条件编码或采样器**。优先复用报告46 checkpoint并核对来源/尺寸/latent缩放；没有可安全读取的旧文件可用本轮B0新保存的同一LATENT，不可从MP4反编码伪造。两份输入文件/元数据哈希相同；不得对B0、B1各自产生的不同LATENT做VAE A/B。

候选为官方 `Comfy-Org/MiniMax-H3` 的 `vae/minimax_h3_video_vae_int8_convrot.safetensors`。本地已有同名文件必须核对实际权重，不能仅看文件名；官方2.81GB版本与较早Kijai同名实验版不是同一文件。

```text
固定来源 revision: 0d21e5fdcfd05eb679dcca8573c1960a8f87ddf7
SHA-256: 52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e
```

缺文件且许可/本地策略允许时只取得这一指定官方权重，记录来源和hash，放实验模型目录，不覆盖旧VAE或升级环境；网络、许可或空间受限则仅V1 BLOCKED，不阻止已就绪的Sol实验。若当前基线已是此候选且实际路径相同，记ALREADY_ACTIVE，不制造假A/B。

VAE首轮仅换权重。**不同时启用 `--fast fp16_accumulation`**，音频VAE不变，原解码tile/chunk/dtype设置保持一致；记录实际运行路径、OOM重试/自动分块和驻留状态。不让两种VAE同时驻留竞争显存。两条均解码完整对应视频latent，再沿同一时间裁切取96帧；不以缩短待解码帧数换速度。解码本身、权重加载、保存/编码分别计时，不能拿旧报告的decode_cache总耗时作纯VAE基线。

这轮只筛选decode；尚不覆盖编码参考、rho像素回编及三段尾帧传播，后续集成必须单独回归。

## 4. 先验证实验台，再执行有界测试

本轮最多 **B0一次4秒生成 + B1一次4秒生成 + V0/V1各一次无采样解码**。不同时排队，不扫tau、层列表、启用区间或分组矩阵；不自动测试Veda/叠加Sol和INT8 VAE。任一路首次异常保留记录后停止该路，不按降质重试凑通过。B0失败则不跑B1。

先构建但不生成：保存4份可打开的ComfyUI UI工作流及匹配API文件；加载校验注册、连线、单一输出目标、只引用本实验命名空间，无跨入正式链的link。已有节点内容与原工作流前后hash一致。任何额外辅助节点必须有真实schema和实现，不能交付虚构node_id的“可运行工作流”。完整含私人提示词/绝对路径的工作流只保留本机；仓库提交生成器与明确标为模板的脱敏版本。

边界工具（仓库根目录）：

```powershell
python -m unittest discover -s experiments/acceleration_lab/tests -p "test_*.py" -v
python experiments/acceleration_lab/check_isolation.py --repo .
python experiments/acceleration_lab/check_isolation.py --repo . --api "本机B0.api.json" --mode sample
python experiments/acceleration_lab/check_isolation.py --repo . --api "本机V1.api.json" --mode decode
```

对所有API分别执行；失败码2就停止。工具只检查Git与API的隔离边界，不替代运行注册/schema/图有效性检查，也不能审计任意helper内部调用。发现用户已有正式代码改动时保留并报告，不通过reset/checkout或放宽baseline来绕过。

新增lab helper的合成测试覆盖原函数仅调用一次、参数/对象不变、不消耗RNG、AV格式往返、任务隔离、异常原样传播、实验结束没有遗留包装。只在实验目录新增测试；冻结版原预检可只读复跑，不修改/跳过失败项。

Sol预检核对本机 `ck.sol_attn_is_available`、原生BlockSparseAttention schema和实际SM86编译能力。必要时允许一次小张量稀疏内核能力冒烟（不是速度基准，不加载H3）；未可用则该路BLOCKED，不升级依赖。不能只凭菜单或布尔返回宣称长序列可用。

B0和B1使用相同实验环境/计时方法，顺序执行且各自干净进程恢复模型状态，避免MODEL clone共享底层对象与补丁残留。**主要对照是新实验台B0，不是报告46的704.077秒**；报告46仅作历史合理性检查。首次编译/初始化成本单列，有冷启动偏差就说明，不额外重跑以挑最快值。

记录条件编码、低清、分辨率切换、高清、视频/音频解码、保存；使用同进程单调时钟、任务/阶段ID。不开重型Profiler；不做逐层同步/逐调用写盘、不额外保存tensor副本。需验证稀疏身份时只在实验实例内使用可移除的薄计数包装或原生verbose，并在阶段末汇总；分清预计启用、实际producer/kernel入口、保护条件行的layout和有意密集fallback。首次本应稀疏的前向后无实际调用证据就停止该路，不能把未生效链的速度列为Sol结果。

## 5. 交付与植入门槛

在 `experiments/acceleration_lab/` 提交实际构建脚本、实验辅助节点及安装/移除说明、测试、脱敏模板，以及：

```text
reports/01_SOL_ATTN.md
reports/02_VAE_INT8.md
evidence/sol_attn.json
evidence/vae_int8.json
```

报告独立给出环境/代码hash、输入白名单diff、API/UI生成路径、任务数量与ID、运行/隔离/计时/实际后端验证、逐阶段时间与相同基线差值、峰值显存的测量口径、完整Sigma、AV规格、质量状态及未知项。失败不覆盖旧结果。可复现模板不能含真实私人提示词；schema示意模板不得冒充已可排队版本。

视觉复核看原4秒的身份、脸手细节、运动/闪烁、曝光；声音和同步单列。有同源像素可附PSNR/SSIM，但不把数值或少数截图代替完整人工看听，不预设“加速多少就忽略质量”。新链空间分辨率始终1920×1088。

**独立链技术跑通 + 可解释的速度改善 + 用户画质认可**后，才提出导演植入方案；不自动修改正式默认值或合并main。植入前仍要回归原3个连续片段、尾帧/Guide、音频、二阶段尺寸/缓存状态重置、Base/Advanced及原输出边界。

Veda R2VA列为第二批候选，首轮不安装、不排任务，不能与原生Sol同时叠加。先用这两项独立实验的证据决定是否继续，避免再次堆优化开关。

## 来源与本轮验证范围

- 本项目报告46及其人工验收补充：已认可的Kitchen内容与参数基线；最初附件只用于Self-Lift参数参考。
- 原生稀疏实现（本机已记录的固定提交）：https://github.com/Comfy-Org/ComfyUI/blob/b26625f23a888367b92153b28d93e159e83e677b/comfy_extras/nodes_sparse_attention.py ，blob `006d1eb352f946a7c85595edf75d3cda9ac79194`；其参数、percent_to_sigma、H3 sink保护与不满足条件时的密集路径为依据，不能当作本机GPU成功证明。
- 官方节点文档：https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/BlockSparseAttention/en.md 。本机注册schema优先。
- 官方VAE说明：https://blog.comfy.org/p/making-the-minimax-h3-video-vae-2x （2026-09-22）；不把作者RTX5090数字套到3090。
- 指定VAE：https://huggingface.co/Comfy-Org/MiniMax-H3/blob/0d21e5fdcfd05eb679dcca8573c1960a8f87ddf7/vae/minimax_h3_video_vae_int8_convrot.safetensors 。本轮未下载权重或测试解码。

交付侧仅执行了边界工具的14项标准库/Git测试（全部通过），没有构建本机4份实际工作流、运行ComfyUI、Sol/INT8 VAE或进行GPU生成；不能将隔离测试通过写成技术路线已通过。
