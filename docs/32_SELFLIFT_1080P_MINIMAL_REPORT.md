# SelfLift 1080P 档三段最小验收报告

**结果：FAIL（按约定停止，未重跑）**。唯一一次三段任务在第 1 段高清采样时发生 CUDA OOM；没有生成可验收视频。

## 实际提交与输入

- TerryDirector 分支：feat/selflift-internal
- 实际运行提交：eace12bb38e1fb021ccdbf9b70101755f8233fe2
- 原工作流：G:\AIGC\ComfyUI_Codex\user\default\workflows\Terry导演台.json
- 原工作流 SHA-256（运行前）：CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7
- 原工作流 SHA-256（运行后）：CB8C153CEC3141F839E365EDC49BC223779DF46A0EF055E5629668B14FF87FD7（未改变）
- 原工作流完整 globalPrompt、片段提示词、useGlobalPrompt、7 项资产及编号 / source.path、主模型、LoRA、CLIP、视频 / 音频 VAE 均保留；只在提交副本中裁出前三个有效片段，并将 clip-2 / clip-3 衔接改为验收要求的 tail_continuation。原工作流未保存或改写。
- Seed：1000 / fixed；preview 关闭；rerun_clip_id 为空；recovery_mode 为空。
- 分辨率：16:9、2.0 MP、multiple=32。**不裁剪、无尺寸后处理**。目标为原始 1920×1088、24 fps；低清为 960×544（约 0.52 MP），latent H×W 34×60；高清 latent H×W 68×120。
- SelfLift 参数：CFG 1；低清步数 5；低清比例 0.5；Euler；simple；基础步数 6；Denoise 1.0；Sigma 精修启用、extra_steps=1、start=0.7、end=0、spacing=cosine；rho=0、w_min=0.5、w_max=1；权重 minimax_h3_latent_upscaler_3d_fp16.safetensors；高清模型复用主模型；高清分块关闭（auto / 2 / auto）。
- 实际 Sigma 数组：[1.0000, 0.9837, 0.9601, 0.9231, 0.8575, 0.7064, 0.0000]；运行日志为 steps=5+1，与验收文档预期 5+2 不符，记录为 FAIL。
- Prompt ID：586cc7d4-d68f-4a83-9e38-63991c07fb63；执行时长：11 分 14 秒。

## 片段与结果

| 片段 | ID | 帧范围（右端不含） | 帧数 | 运行结果 |
|---|---|---:|---:|---|
| 1 | clip-1 | [0, 96) | 96 | 低清阶段完成并提升 latent；高清采样 OOM，FAIL |
| 2 | clip-2 | [96, 168) | 72 | 未执行；连续性待验收 |
| 3 | clip-3 | [168, 288) | 120 | 未执行；连续性待验收 |

- 执行节点：TerryDirectorAdvanced（API 节点 ID 9000328），三个有效片段只提交 Advanced 及上游依赖，没有 Base 或 TerryDirector 输出分支。
- 失败：第 1 段 TerryDirectorSelfLiftSampler 高清阶段，PyTorch 当前分配 4.86 GiB，申请 10.12 GiB 时设备可用显存为 0；ComfyUI 自动结束此 Prompt 并卸载模型。未自动降分辨率、开启分块、改 Seed 或再次提交。
- 原始视频：无；最终视频尺寸、24 fps、音画解码、音频有效性、两处接缝、Advanced 正常收尾均未产出/未验证。未实际听看，声音与主观连续性**待人工确认**；当前无视频可供人工确认。

## 验收项

| 检查项 | 结果 | 证据 / 说明 |
|---|---|---|
| 目标分支提交实际加载、自有节点注册 | PASS | commit eace12bb38e1fb021ccdbf9b70101755f8233fe2；TerryDirectorSelfLiftSampler 已注册 |
| 原工作流及提示词 / 资产完整性 | PASS | 前后 SHA-256 相同；7 项输入资产均存在 |
| 三段与目标分辨率构造 | PASS | 96 / 72 / 120 帧；运行日志给出低清 / 高清 latent 形状 |
| SelfLift 真实完成及连续性 | FAIL / 未完成 | 第 1 段高清采样 OOM；第 2、3 段未到达 |
| sigma 日程预期 5+2 | FAIL | 实际 steps=5+1；Sigma 数组见上 |
| 最终视频 1920×1088 / 24 fps、音画有效 | BLOCKED | 未生成视频 |
| 两处接缝及主观听看 | 待人工确认 | 无可播放输出 |
| 正常 Advanced 收尾 / checkpoint | BLOCKED | OOM 中断，未完成最终合并 / 编码 |

## 本机证据路径

- 完整提交 payload：G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_minimal_request.json
- ComfyUI history（含 execution_error、执行节点和完整 traceback）：G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_minimal_history.json
- ComfyUI stderr / 完整运行控制台日志：G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_minimal_comfy_stderr.log
- ComfyUI stdout：G:\AIGC\ComfyUI_Codex\ComfyUI\output\.terrydirector_diag\selflift_minimal_comfy_stdout.log
- 输出文件：无

## 完整 traceback

~~~text
torch.OutOfMemoryError: Allocation on device 0 would exceed allowed memory. (out of memory)
Currently allocated     : 4.86 GiB
Requested               : 10.12 GiB
Device limit            : 24.00 GiB
Free (according to CUDA): 0 bytes
PyTorch limit (set by user-supplied memory fraction)
                        : 17179869184.00 GiB
This error means you ran out of memory on your GPU.

TIPS: If the workflow worked before you might have accidentally set the batch_size to a large number.
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\execution.py", line 548, in execute
    output_data, output_ui, has_subgraph, has_pending_tasks = await get_output_data(prompt_id, unique_id, obj, input_data_all, execution_block_cb=execution_block_cb, pre_execute_cb=pre_execute_cb, v3_data=v3_data)
                                                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\execution.py", line 353, in get_output_data
    return_values = await _async_map_node_over_list(prompt_id, unique_id, obj, input_data_all, obj.FUNCTION, allow_interrupt=True, execution_block_cb=execution_block_cb, pre_execute_cb=pre_execute_cb, v3_data=v3_data)
                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\execution.py", line 327, in _async_map_node_over_list
    await process_inputs(input_dict, i)
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\execution.py", line 315, in process_inputs
    result = f(**inputs)
             ^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy_api\internal\__init__.py", line 149, in wrapped_func
    return method(locked_class, **inputs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy_api\latest\_io.py", line 2219, in EXECUTE_NORMALIZED
    to_return = cls.execute(*args, **kwargs)
                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\TerryDirector\director_selflift_node.py", line 43, in execute
    return io.NodeOutput(sample_selflift(
                         ^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\TerryDirector\director_selflift.py", line 276, in sample_selflift
    output = backend.sample(high_model, zero_noise, positive, negative, cfg, sampler,
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\custom_nodes\TerryDirector\director_selflift.py", line 74, in sample
    return self.samplers.sample(
           ^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 1353, in sample
    return cfg_guider.sample(noise, latent_image, sampler, sigmas, denoise_mask, callback, disable_pbar, seed)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 1335, in sample
    output = executor.execute(noise, latent_image, sampler, sigmas, denoise_mask, callback, disable_pbar, seed, latent_shapes=latent_shapes)
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\patcher_extension.py", line 113, in execute
    return self.original(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 1262, in outer_sample
    output = self.inner_sample(noise, latent_image, device, sampler, sigmas, denoise_mask, callback, disable_pbar, seed, latent_shapes=latent_shapes)
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 1237, in inner_sample
    samples = executor.execute(self, sigmas, extra_args, callback, noise, latent_image, denoise_mask, disable_pbar)
              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\patcher_extension.py", line 113, in execute
    return self.original(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 1005, in sample
    samples = self.sampler_function(model_k, noise, sigmas, extra_args=extra_args, callback=k_callback, disable=disable_pbar, **self.extra_options)
              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\utils\_contextlib.py", line 124, in decorate_context
    return func(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\k_diffusion\sampling.py", line 205, in sample_euler
    denoised = model(x, sigma_hat * s_in, **extra_args)
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 640, in __call__
    out = self.inner_model(x, sigma, model_options=model_options, seed=seed)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 1208, in __call__
    return self.outer_predict_noise(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 1215, in outer_predict_noise
    ).execute(x, timestep, model_options, seed)
      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\patcher_extension.py", line 113, in execute
    return self.original(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 1218, in predict_noise
    return sampling_function(self.inner_model, x, timestep, self.conds.get("negative", None), self.conds.get("positive", None), self.cfg, model_options=model_options, seed=seed)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 620, in sampling_function
    out = calc_cond_batch(model, conds, x, timestep, model_options)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 211, in calc_cond_batch
    return _calc_cond_batch_outer(model, conds, x_in, timestep, model_options)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 219, in _calc_cond_batch_outer
    return executor.execute(model, conds, x_in, timestep, model_options)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\patcher_extension.py", line 113, in execute
    return self.original(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\samplers.py", line 335, in _calc_cond_batch
    output = model.apply_model(input_x, timestep_, **c).chunk(batch_chunks)
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\model_base.py", line 210, in apply_model
    return comfy.patcher_extension.WrapperExecutor.new_class_executor(
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\patcher_extension.py", line 113, in execute
    return self.original(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\model_base.py", line 254, in _apply_model
    model_output = self.diffusion_model(xc, t, context=context, control=control, transformer_options=transformer_options, **extra_conds)
                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\nn\modules\module.py", line 1779, in _wrapped_call_impl
    return self._call_impl(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\nn\modules\module.py", line 1790, in _call_impl
    return forward_call(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\ldm\minimax\model.py", line 621, in forward
    graph_out = comfy.patcher_extension.WrapperExecutor.new_class_executor(
                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\patcher_extension.py", line 113, in execute
    return self.original(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\ldm\minimax\model.py", line 770, in _forward
    h = block(h, t_emb, mod_segments, rope_freqs, transformer_options=transformer_options)
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\nn\modules\module.py", line 1779, in _wrapped_call_impl
    return self._call_impl(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\nn\modules\module.py", line 1790, in _call_impl
    return forward_call(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\ldm\minimax\model.py", line 298, in forward
    return _mod_gate(x, gate_mlp, self.mlp(h), mod_segments)
                                  ^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\nn\modules\module.py", line 1779, in _wrapped_call_impl
    return self._call_impl(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\nn\modules\module.py", line 1790, in _call_impl
    return forward_call(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\ldm\minimax\model.py", line 211, in forward
    return self.fc2(self.fc1(x), input_act="swiglu")
                    ^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\nn\modules\module.py", line 1779, in _wrapped_call_impl
    return self._call_impl(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\nn\modules\module.py", line 1790, in _call_impl
    return forward_call(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\ops.py", line 1554, in forward
    output = self.forward_comfy_cast_weights(
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\ops.py", line 1487, in forward_comfy_cast_weights
    return self._forward(input, weight, bias)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\comfy\ops.py", line 1446, in _forward
    return torch.nn.functional.linear(input, weight, bias)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\comfy_kitchen\tensor\base.py", line 362, in __torch_dispatch__
    return op_handlers[parent_cls](qt, args, kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\comfy_kitchen\tensor\int8.py", line 287, in _handle_int8_linear_tensorwise
    return torch.ops.comfy_kitchen.int8_linear(
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\_ops.py", line 1269, in __call__
    return self._op(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\_library\custom_ops.py", line 347, in backend_impl
    result = self._backend_fns[device_type](*args, **kwargs)
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\_compile.py", line 54, in inner
    return disable_fn(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\_dynamo\eval_frame.py", line 1263, in _fn
    return fn(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\torch\_library\custom_ops.py", line 382, in wrapped_fn
    return fn(*args, **kwargs)
           ^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\comfy_kitchen\backends\eager\quantization.py", line 1261, in _op_int8_linear
    return impl(**kwargs)
           ^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\comfy_kitchen\backends\eager\quantization.py", line 1052, in int8_linear
    result = _int8_matmul_accumulate(x_8, weight.T.contiguous())
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\comfy_kitchen\backends\eager\quantization.py", line 780, in _int8_matmul_accumulate
    result = fast_int8_mm(a, b)
             ^^^^^^^^^^^^^^^^^^
  File "G:\AIGC\ComfyUI_Codex\ComfyUI\.venv\Lib\site-packages\comfy_kitchen\backends\eager\quantization.py", line 755, in fast_int8_mm
    return torch._int_mm(lhs, rhs)
           ^^^^^^^^^^^^^^^^^^^^^^^

torch.OutOfMemoryError: Allocation on device 0 would exceed allowed memory. (out of memory)
Currently allocated     : 4.86 GiB
Requested               : 10.12 GiB
Device limit            : 24.00 GiB
Free (according to CUDA): 0 bytes
PyTorch limit (set by user-supplied memory fraction)
                        : 17179869184.00 GiB
This error means you ran out of memory on your GPU.

TIPS: If the workflow worked before you might have accidentally set the batch_size to a large number.
~~~
