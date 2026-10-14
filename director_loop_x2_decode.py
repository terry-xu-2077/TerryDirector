"""TerryDirector-owned low-peak H3 2X decoder adapter.

Calls the installed MiniMaxH3VAEDecodeFast node on short causal windows;
does not patch, fork or modify that third-party plugin.  Only one final IMAGE
tensor is allocated, instead of concatenating all temporally tiled IMAGEs.
"""

from __future__ import annotations

import gc

import torch
from comfy_api.latest import io

from .director_loop_x2_windows import h3_total_frames, h3_decode_windows


class TerryDirectorH3X2LowRAMDecode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorH3X2LowRAMDecode",
            display_name="TerryDirector H3 2X 低内存解码",
            category="TerryDirector/循环",
            description=(
                "调用已安装的 MiniMaxH3VAEDecodeFast 分块解码 H3 2X VAE，"
                "在 TerryDirector 中逐块写入单一最终 IMAGE；不修改第三方插件。"
                "分块使用前导上下文，需验证镜头接缝；目前仍需要整段 IMAGE 的 RAM。"
            ),
            inputs=[
                io.Latent.Input("samples", display_name="视频 LATENT"),
                io.Vae.Input("vae", display_name="2X 视频 VAE"),
                io.Int.Input(
                    "temporal_tile_frames", display_name="每块新帧数",
                    default=51, min=17, max=255, step=17,
                ),
                io.Int.Input(
                    "temporal_context_frames", display_name="前导上下文帧",
                    default=39, min=5, max=702, step=17,
                ),
                io.Int.Input(
                    "spatial_tile_size", display_name="空间 Tile",
                    default=256, min=256, max=4096, step=16,
                ),
                io.Int.Input(
                    "spatial_tile_overlap", display_name="空间重叠",
                    default=64, min=16, max=1024, step=16,
                ),
                io.Float.Input(
                    "seam_warning_threshold", display_name="接缝报警阈值",
                    default=0.02, min=0.0, max=1.0, step=0.001,
                ),
            ],
            outputs=[io.Image.Output(display_name="IMAGE")],
        )

    @classmethod
    def execute(
        cls, samples, vae, temporal_tile_frames=51,
        temporal_context_frames=39, spatial_tile_size=256,
        spatial_tile_overlap=64, seam_warning_threshold=0.02,
    ):
        if not isinstance(samples, dict):
            raise TypeError("请输入 LTXVSeparateAVLatent 的视频 LATENT（字典）")
        latent = samples.get("samples")
        if not isinstance(latent, torch.Tensor) or latent.is_nested or latent.ndim != 5:
            raise ValueError(
                "需要 [batch,channels,time,height,width] 的 H3 视频 LATENT；"
                "请在 SelfLift 后使用 LTXVSeparateAVLatent 拆分音视频。"
            )

        # Do not import or vendor any third-party source.  Resolve the public
        # ComfyUI node class through its normal registration at execution time.
        import nodes
        backend_cls = nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3VAEDecodeFast")
        if backend_cls is None:
            raise RuntimeError(
                "未安装 MiniMaxH3VAEDecodeFast。此节点只调用第三方公开的"
                " ComfyUI 节点接口，不包含该插件代码。"
            )
        backend = backend_cls()

        batch = int(latent.shape[0])
        total_frames = h3_total_frames(int(latent.shape[2]))
        windows = h3_decode_windows(
            int(latent.shape[2]), temporal_tile_frames, temporal_context_frames,
        )
        result_images = None
        peak_seam = 0.0
        print(
            f"[TerryDirector X2] start: output_frames={total_frames} "
            f"windows={len(windows)} tile={temporal_tile_frames} "
            f"context={temporal_context_frames}",
            flush=True,
        )
        for index, window in enumerate(windows):
            sub_latent = latent[:, :, window.latent_start:window.latent_stop]
            # FastDecode's own full-temporal path is now only asked to decode
            # this one small window.  Never enable its outer temporal cat().
            decoded = backend.decode(
                samples={"samples": sub_latent},
                vae=vae,
                tiling=True,
                tile_size=int(spatial_tile_size),
                tile_overlap=int(spatial_tile_overlap),
                output_device="cpu",
                temporal_tiling=False,
            )
            if not isinstance(decoded, (list, tuple)) or not decoded:
                raise RuntimeError("FastDecode 返回值不符合 IMAGE 节点接口")
            piece = decoded[0]
            if not isinstance(piece, torch.Tensor) or piece.ndim != 4:
                raise RuntimeError("FastDecode 未返回 [frames,height,width,3] IMAGE")
            if piece.device.type != "cpu":
                piece = piece.cpu()
            if int(piece.shape[0]) != batch * window.decoded_frames or int(piece.shape[-1]) != 3:
                raise RuntimeError(
                    "FastDecode 时间块帧数或通道错误："
                    f"得到 {tuple(piece.shape)}，预计 {batch * window.decoded_frames} 帧 RGB"
                )
            block = piece.reshape(batch, window.decoded_frames, *piece.shape[1:])
            if result_images is None:
                result_shape = (batch, total_frames, *piece.shape[1:])
                try:
                    result_images = torch.empty(
                        result_shape, dtype=piece.dtype, device="cpu",
                    )
                except (RuntimeError, MemoryError) as exc:
                    size_gib = (
                        batch * total_frames * piece.shape[1] * piece.shape[2] *
                        piece.shape[3] * piece.element_size() / (1024 ** 3)
                    )
                    raise RuntimeError(
                        f"TerryDirector 仍需 {size_gib:.2f} GiB 的最终 IMAGE 输出，"
                        "当前系统内存不足；无法通过不修改第三方插件来完全消除此需求。"
                    ) from exc
            elif tuple(block.shape[2:]) != tuple(result_images.shape[2:]) or block.dtype != result_images.dtype:
                raise RuntimeError("FastDecode 各时间块的尺寸或数据精度不一致")

            offset = window.destination_start
            drop = window.discard_frames
            end = offset + window.keep_frames
            if drop and float(seam_warning_threshold) > 0:
                count = min(drop, offset)
                if count:
                    previous = result_images[:, offset - count:offset].float()
                    repeated = block[:, drop - count:drop].float()
                    deviation = (previous - repeated).abs().mean().item()
                    peak_seam = max(peak_seam, deviation)
                    if deviation > float(seam_warning_threshold):
                        print(
                            f"[TerryDirector X2] WARNING temporal seam at "
                            f"frame={offset}: mean_abs={deviation:.6f}; "
                            "可提高前导上下文帧数并检查画面。",
                            flush=True,
                        )
                    del previous, repeated
            result_images[:, offset:end].copy_(block[:, drop:drop + window.keep_frames])
            print(
                f"[TerryDirector X2] window {index + 1}/{len(windows)}: "
                f"latents={window.latent_start}:{window.latent_stop}, "
                f"saved_frames={offset}:{end}",
                flush=True,
            )
            del block, piece, decoded, sub_latent
            gc.collect()

        print(f"[TerryDirector X2] done: max_seam={peak_seam:.6f}", flush=True)
        return io.NodeOutput(result_images.reshape(-1, *result_images.shape[2:]))
