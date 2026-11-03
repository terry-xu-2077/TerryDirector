"""Public SelfLift low/high sampling nodes with independent step controls."""
from comfy_api.latest import io

from .director_selflift_stages import sample_highres, sample_lowres


class TerryDirectorSelfLiftLowres(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorSelfLiftLowres", display_name="TerryDirector SelfLift 低清采样",
            category="TerryDirector/SelfLift",
            description=("按输入 LATENT 的实际宽高执行 low_steps 次低清 Euler 采样，不再额外缩小。"
                         "输出可直接审片的低清 LATENT，携带高清过渡所需的数据，支持经过通用暂停/继续缓存。"),
            inputs=[io.Model.Input("model"), io.Conditioning.Input("positive"), io.Conditioning.Input("negative"),
                    io.Latent.Input("latent_image", display_name="低清分辨率 LATENT"),
                    io.Sampler.Input("sampler"), io.Sigmas.Input("sigmas", display_name="完整 SIGMAS"),
                    io.Int.Input("low_steps", default=5, min=1, max=10000, display_name="低清步数"),
                    io.Int.Input("seed", default=8, min=0, max=0xffffffffffffffff),
                    io.Float.Input("cfg", default=1.0, min=0.0, max=100.0)],
            outputs=[io.Latent.Output("latent", display_name="低清 LATENT / 高清过渡")],
        )

    @classmethod
    def execute(cls, model, positive, negative, latent_image, sampler, sigmas,
                low_steps, seed, cfg):
        return io.NodeOutput(sample_lowres(
            model=model, positive=positive, negative=negative, latent_image=latent_image,
            sampler=sampler, sigmas=sigmas, low_steps=low_steps, seed=seed, cfg=cfg))


class TerryDirectorSelfLiftHighresSampler(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        from .director_selflift_upscaler import list_models
        preferred = "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"
        models = [name for name in list_models() if name not in {"", "none", "nearest"}]
        default = preferred if preferred in models else (models[0] if models else preferred)
        return io.Schema(
            node_id="TerryDirectorSelfLiftHighresSampler", display_name="TerryDirector SelfLift 高清采样",
            category="TerryDirector/SelfLift",
            description=("读取低清 LATENT 中的过渡数据，按目标宽高（像素）通过 H3 3D Latent Upscaler 放大视频，时长继承低清。"
                         "high_steps 必须等于完整 SIGMAS 步数减去 low_steps；原样执行剩余日程，不插值 Sigma。两个节点使用相同 Seed/CFG 时对齐 Avatar 的 latent-only 路径。音频不重复加噪。"),
            inputs=[io.Latent.Input("latent", display_name="低清 LATENT / 高清过渡"),
                    io.Model.Input("model", display_name="高清 MODEL"),
                    io.Conditioning.Input("positive"), io.Conditioning.Input("negative"),
                    io.Sampler.Input("sampler"),
                    io.Int.Input("high_steps", default=1, min=1, max=10000, display_name="高清步数"),
                    io.Int.Input("seed", default=8, min=0, max=0xffffffffffffffff),
                    io.Float.Input("cfg", default=1.0, min=0.0, max=100.0),
                    io.Int.Input("width", default=1216, min=32, max=16384, step=32, display_name="目标宽度"),
                    io.Int.Input("height", default=672, min=32, max=16384, step=32, display_name="目标高度"),
                    io.Combo.Input("upscaler_model", options=models or [preferred], default=default),
                    io.Boolean.Input("highres_tiling", default=False),
                    io.Combo.Input("tiling_mode", options=["auto", "manual"], default="manual"),
                    io.Combo.Input("tiling_tiles", options=[2, 4, 6, 8], default=4),
                    io.Combo.Input("tiling_axis", options=["auto", "width", "height"], default="auto")],
            outputs=[io.Latent.Output("latent", display_name="高清音视频 LATENT")],
        )

    @classmethod
    def execute(cls, latent, model, positive, negative, sampler, high_steps, seed, cfg,
                width, height, upscaler_model, highres_tiling=False, tiling_mode="manual", tiling_tiles=4,
                tiling_axis="auto"):
        return io.NodeOutput(sample_highres(
            latent=latent, model=model, positive=positive, negative=negative, sampler=sampler,
            high_steps=high_steps, seed=seed, cfg=cfg, width=width, height=height, upscaler_model=upscaler_model,
            highres_tiling=highres_tiling, tiling_mode=tiling_mode, tiling_tiles=tiling_tiles,
            tiling_axis=tiling_axis))
