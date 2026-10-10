# Sol / KJ 块级接口修正：先零生成验证，再只补 B1

> 分支 `feat/selflift-internal`；复核报告提交 `83b23ed6abb585f0e4c2b122f0ddd970b7f2615e`。
> 继续独立实验，不植入导演。生产冻结基线仍为 `0c82cd7bfb2de963304479eda86e02513e106da0`。
> 本轮只允许新增一次 B1；报告03成功 B0、所有旧报告/失败记录保留，不重跑 B0。

## 1. 报告04说明了什么

DynamicCombo 修复与真实参数整理已通过；B1 完成条件编码后，在首个低清前向中报 `minimax_block_lowmem_forward() got an unexpected keyword argument 'attention'`。任务112.626秒至异常，条件编码108.026秒；低清2.084秒至异常、0 callback、0 Sol producer调用。没有新视频，不能计算Sol速度。

原生 H3 的 block driver 即使走密集分支也会传 `attention=args.get('attention')`。因此首步sigma=1（本应密集）也会在当前KJ旧函数上失败。这不是CUDA OOM或Sol kernel失败。此前预检覆盖了请求绑定，没有覆盖两个block forward的组合。

原生 `make_h3_block_patch` 的稀疏分支会提供一个接受tensor的attention回调；原KJ低显存块只支持将h装进list交给自己的attention。**不能仅用 `**kwargs` 吞掉attention，也不能把KJ list传给原生稀疏producer**，否则分别会造成假稀疏或新的输入类型错误。

## 2. 实验侧修正，不改第三方安装

新增 `TerryAccelLabSolLowVRAMBridge`，只通过实验 `__init__.py` 注册。新链为：

```text
原模型/LoRA → Kitchen → KJ LowVRAM(4) → FFN(2/4096)
    → TerryAccelLabSolLowVRAMBridge → 原生 BlockSparseAttention → 原实验Self-Lift
```

`sol_lowvram_bridge.py` 在MODEL clone上仅替换每个block的forward对象补丁：

- `attention=None`：直接调用原有绑定KJ函数一次，保留原密集路径的list释放、head分组和FFN补丁。
- 传入attention回调：复用**本机原生 `DiTBlock.forward`**，完整传递回调、tensor、modulation/rope/options；现有MLP补丁仍通过原block对象执行。不重放、不吞异常、不降级重试。
- 不改模型权重、Sigma/步数、Self-Lift算法、KJ源码、原生ComfyUI源码或生产节点。未识别的块补丁/新版已支持attention时明确报错，不能叠加猜测式兼容。
- 不修改模块/类的全局forward，不改上游MODEL的object_patches；正常ModelPatcher机制只作用于本实验分支，仍使用独立新进程避免clone共享底层模块的跨任务影响。

参考依据（本机已记录版本优先，不升级）：

- KJ旧版 `3f20054214fec9f9234fd3841ae6f1e4287948f6`，`nodes/minimax_nodes.py` 的 `minimax_block_lowmem_forward` 无attention参数。
- 原生ComfyUI `b26625f23a888367b92153b28d93e159e83e677b`，`comfy/ldm/minimax/model.py:DiTBlock.forward` 和 `comfy_extras/nodes_sparse_attention.py:make_h3_block_patch`。
- KJ上游已记录同类问题：https://github.com/kijai/ComfyUI-KJNodes/issues/750 。固定新版本 `d3cfe21625e5170126ce06fbfcfe1d88108688c3` 的同名函数已经增加attention参数：None走list密集分支，回调走tensor分支。此实验复用现成函数实现同样的分支语义，不搬运/安装整份KJ新版本。

## 3. 先做零生成预检

用原ComfyUI `.venv`，保留本地未提交工作，运行实验全部测试与隔离检查；不修改/skip旧测试来放行：

```powershell
python -m unittest discover -s experiments/acceleration_lab/tests -p "test_*.py" -v
python experiments/acceleration_lab/check_isolation.py --repo .
```

新增 `preflight_sol_block_bridge.py` 从**本机源码**摘取KJ旧forward、原生DiTBlock.forward和原生make_h3_block_patch，在小型CPU合成模块上走密集首步、稀疏低清、保护密集块、稀疏高清四条分支。先复现旧函数收到attention=None的错误，再验证新桥接的分派、调用次数、tensor/list约定、结果与RNG。没有模型权重、真实稀疏内核、完整H3前向或GPU内存测试；合成eligibility/math不冒充原生数值验收。

```powershell
python experiments/acceleration_lab/preflight_sol_block_bridge.py `
  --comfy-root "G:\AIGC\ComfyUI_Codex\ComfyUI" `
  --kj-root "G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\comfyui-kjnodes" `
  --output "新的私有目录\block_bridge_preflight.json"
if ($LASTEXITCODE -ne 0) { throw "Block bridge preflight failed; do not queue" }
```

实际解释器/源码hash须与报告04相同；差异先解释，不升级。新节点execute的MODEL clone/块补丁绑定也需在本机无权重替身上检查（可使用原生DiTBlock的轻量实例），确认实验注册列表包含新类，源MODEL、attn/MLP补丁及Kitchen/heads选项不被写掉。这与上述摘取源码分支检查是不同层次，不能互相冒充。

## 4. 只复制B1，在FFN与Sol之间加桥接

源文件为报告04的 `local/workflows/sol_binding_fix/Lab_B1_SolAttn_Clip1.{api.json,json}`。API hash `64cfdf3584e74272d9efc504eb25995d230576a9d672186577c79b78f31eaccc`，UI hash `243cbdf85289a7e1dfbf87be3ac460bc9c6842f85420d9c5ec50ec36850bde8b`。

使用新构建工具，不覆盖原图，不重建提示词或其它节点：

```powershell
python experiments/acceleration_lab/build_sol_bridge_workflow.py `
  --api "旧目录\Lab_B1_SolAttn_Clip1.api.json" `
  --ui "旧目录\Lab_B1_SolAttn_Clip1.json" `
  --output-dir "新目录\sol_forward_bridge"
```

它校验两份源hash，只追加一个实验MODEL桥接节点、重连原Sol的model输入，并同步UI连线/内嵌API。B0不读取、不写入。`build_workflows.py`仍保留原实验构建行为，不作为自动启用桥接的入口。

对新B1继续执行既有 `preflight_sparse_binding.py`、API隔离及新8190实例的schema/连线校验。`validate_workflows.py`原命令会遍历四图；本轮可在小型本地驱动中只调用其 `validate(new_api,new_ui,registry)` 检查新B1，不能为绕过错误关闭DynamicCombo检查。确认只有一个保存目标；前端实际打开/导出若未做，要明确标未验证。

## 5. 一次B1与判定

不重启8188，不升级依赖，不启用旧导演trace/Profiler。沿用实验启动器的新命名run目录，例如 `sol_forward_b1`。新实例注册新类、核心源码/hash核对及以上预检通过后，只提交一次B1；错误立即保留证据并停止，不自动重试。

原内容、七资产及顺序、1920×1088不裁剪、24fps/96输出帧/H3对齐107帧、Seed1000、原主模型/LoRA/CLIP/两VAE、Self-Lift全参数均保持。Sol仍是tau1、percent=.05–1、dense_blocks=0/1/48/49、min_tokens12288、extra_tokens256、exact_kv_and_rows。不改成全稀疏或关保护以取得更快数字。INT8 VAE仍ALREADY_ACTIVE；不运行VAE/Veda。

启动记录新桥接实际50个block映射；采样期仍核对原生chunked producer的真实调用。第一次本应稀疏的回调后若无调用，停止而不是把密集结果当Sol；记录密集首步/保护块与稀疏路径的观测范围，未记录的具体比例/layout标UNKNOWN。小型预检不保证长序列、稀疏内核或显存成功。

对照继续用报告03 B0：低清357.2919559秒、高清201.419842秒，合计558.7117979秒；Self-Lift561.8316424秒；history总804.685秒。保持原阶段同步/峰值计时方法，不重复相加父子区间。新桥接引入的Python分派及运行热状态都是限制，不能把差额当纯kernel收益；不重跑B0挑更好数字。

分别记录运行成功、桥接/实际稀疏调用、速度与音画质量。B1无输出就不算技术跑通；成功也不自动植入导演。原B0和新B1均仍需完整人工看听。

新增且只提交：

```text
experiments/acceleration_lab/reports/05_SOL_ATTN_FORWARD_BRIDGE.md
experiments/acceleration_lab/evidence/sol_attn_forward_bridge.json
```

含本机新节点与桥接来源、零生成检查结果、API白名单差异、任务ID/起止、阶段计时和真实调用数、输出路径及限制；完整私人图/日志/视频留本机。保留01–04报告原文，结束停止实验实例，不合并main。

## 本次交付验证范围

交付侧为Linux、PyTorch 2.10.0+cpu，无完整ComfyUI/Windows/GPU。18项新增便携单测通过；用已读取固定源码的函数摘录跑过上述4条小型CPU分派场景，旧错误复现，新桥接结果与参考分支一致。归一化/gating/MLP及稀疏eligibility/attention为合成替身，不能声称真实H3数值一致。四个新/修改Python脚本语法检查通过。未跑完整实验测试集、实际本机注册/加载、B1 GPU或任何视频生成。
