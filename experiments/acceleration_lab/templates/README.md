# 脱敏复现模板

这里的模板仅列出构建参数和预期差异，**不能直接排队运行**。真实提示词、七项资产路径及四份完整 UI/API 工作流仅由 `build_workflows.py` 从报告46的真实请求生成到忽略版本控制的 `local/workflows/`。

复现时提供原请求、共享只读 input 目录和原模型目录，构建器先校验请求 SHA-256，再调用冻结版 `compile_timeline` 提取最终提示词和资产顺序。B0/B1 使用相同的实验 Self-Lift 适配器；B1 只额外连接原生 `BlockSparseAttention`。V0/V1 均读取 B0 保存的同一份完整 AV latent。若当前 VAE 与指定 INT8 候选的文件 SHA-256 相同，VAE 结果标为 `ALREADY_ACTIVE`，不将两份相同权重标为 A/B。

本轮 B0 的唯一提交在采样前失败。修正后的构建器和辅助节点已通过无生成测试，但本轮不会再次提交 B0。
