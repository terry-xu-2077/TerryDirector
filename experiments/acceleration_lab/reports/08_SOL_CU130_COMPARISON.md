# Sol cu130 对照实验报告

## 结论

| 项目 | 结果 |
|---|---|
| 环境 | `environment_ready=true`（依据 07 已迁移环境记录；本轮没有启动新的实验后端） |
| B0 | `b0_success=false`；预检阻塞，生成提交数 0 |
| B1 | `b1_success=false`；按顺序条件未达到，没有启动或提交 |
| Sol 调用 | `sol_observed=false`；本轮没有运行采样，实际稀疏调用未知 |
| 速度 | 无 cu130 B0/B1 数据，不能比较或计算 Sol 收益 |
| 输出规格 | 本轮没有视频或 checkpoint；规格不适用 |
| 画质 | 待人工确认；无本轮媒体可检查 |

本轮已拉取 `feat/selflift-internal`，确认远端和本地包含 `134d309`；当前审计提交为 `134d309`（完整提交号见对应 Git 元数据）。迁移后的 cu130 环境记录为 Python 3.12.13、torch/torchvision/torchaudio `2.11.0+cu130 / 0.26.0+cu130 / 2.11.0+cu130`、`torch.version.cuda=13.0`、comfy-kitchen 0.2.37、ComfyUI 0.39.0、KJNodes 报告07锁定版本。环境、旧 cu128 备份及其哈希清单均未改动；本轮未安装或升级依赖。生产导演节点和正式工作流未修改，未合并 main。

## 预检与停止原因

实验单元测试 67/67 通过。隔离检查先遇到沙盒账号的 Git dubious ownership；以单次 `safe.directory` 环境配置重跑后通过，`production_files_unchanged=true`、`forbidden_changed_paths=[]`。当前 8188 服务队列为空，GPU 快照约 1547 MiB / 24576 MiB、利用率 1%。

两份固定 API 已核对 SHA-256：B0 `d867be9289b4f91e4d61feb6b9ee4e3172a61370fcbad9a35dd7c5912083e864`；B1 桥接图 `b1cfd6576406102d31bc2868c605a24a9adf72edab213135398d5ac0daf911b5`。B1 实际使用 `sol_forward_bridge` 子目录中与报告05对应的文件；同名默认目录副本哈希不同，未使用。B1 的零生成绑定预检通过：`normalized_selection={"selection":"sol-attn","tau":1.0}`，旧格式反例被拒绝，`generation_submissions=0`。

工作流注册和连线验证未通过：验证器请求正式 8188 的 `/object_info` 后，报告 API 图包含实验专用节点 `TerryAccelLabCondition`，而正式服务没有注册该节点（`KeyError: 'TerryAccelLabCondition'`）。第一次访问 `/object_info` 瞬时返回 502；只读重查时 `/object_info`、`/system_stats` 和 `/queue` 均返回 200，队列为空。再次用稳定端点验证后，缺少实验节点仍然成立。验证器指定的默认 `http://127.0.0.1:8190` 是停止状态；为避免对正式 8188 或非实验实例造成副作用，本轮没有启动新实验进程。依照文档，预检失败即停止。

## B0 / B1 运行记录

| 项目 | B0（Kitchen 密集） | B1（Sol＋桥接） |
|---|---|---|
| API 哈希 | `d867be…3e864`，与文档一致 | `b1cfd6…11b5`，与文档一致 |
| 新实验 PID / 实际解释器 / Sol gate | 未启动；不适用 | 未启动；不适用 |
| 提交数 / 任务 ID | 0 / 无 | 0 / 无 |
| 起止事件 / 耗时 | 无 | 无 |
| 阶段耗时 | 无；未生成 | 无；未生成 |
| 实际 `ck.sol_attn_chunked` 调用 | 未运行，未知 | 未运行，未知 |
| 输出规格 / 画质 | 无输出；待人工确认 | 无输出；待人工确认 |

B0 未成功完成，因此按顺序不启动 B1。无任务 history、采样 stdout/stderr、阶段日志或 traceback；零生成预检 traceback 与错误摘要保留在本机临时目录及命令记录中。不能拿报告03的 cu128 B0（低清357.2919559秒、高清201.419842秒、总计804.685秒）替代本轮 cu130 B0，也不把跨环境历史时间混入 Sol 对照。

## 未知项

没有本轮实验进程，故无法提供逐 PID 解释器、该进程启动时的 Sol gate、H3 长序列 kernel 加载、实际稀疏 producer 调用、阶段计时、视频规格和画质。报告07的 8190 gate 与微张量结果只说明迁移验收时可用，不替代本轮新实验进程检查或长序列生成证明。

报告 01–07 和本机原始证据保留；完整私人请求、环境日志和 cu128 备份未提交。本轮生成次数为 0。