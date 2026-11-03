"""Internal graph operation. The public UI remains SecondPass -> Config -> Director."""
from __future__ import annotations

from comfy_api.latest import io
from .director_selflift import sample_selflift


class TerryDirectorSelfLiftSampler(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        from .director_selflift_upscaler import list_models
        preferred = "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"
        models = [m for m in list_models() if m not in {"", "none", "nearest"}]
        default_model = preferred if preferred in models else (models[0] if models else preferred)
        return io.Schema(
            node_id="TerryDirectorSelfLiftSampler",
            display_name="TerryDirector SelfLift (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Model.Input("model"),
                io.Conditioning.Input("positive"), io.Conditioning.Input("negative"),
                io.Latent.Input("latent_image"),
                io.Sampler.Input("sampler"), io.Sigmas.Input("sigmas"),
                io.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF),
                io.Float.Input("cfg", default=1.0, min=0.0, max=100.0),
                io.Int.Input("transition_step", default=5, min=1, max=10000),
                io.Float.Input("lowres_scale", default=0.5, min=0.25, max=1.0),
                io.Combo.Input("upscaler_model", options=models or [preferred],
                               default=default_model),
                io.Boolean.Input("highres_tiling", default=False),
                io.Combo.Input("tiling_mode", options=["auto", "manual"], default="auto"),
                io.Int.Input("tiling_tiles", default=2, min=2, max=8),
                io.Combo.Input("tiling_axis", options=["auto", "width", "height"], default="auto"),
                io.Model.Input("high_res_model", optional=True),
            ],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def execute(cls, model, positive, negative, latent_image, sampler, sigmas,
                seed, cfg, transition_step, lowres_scale,
                upscaler_model, highres_tiling=False, tiling_mode="auto", tiling_tiles=2,
                tiling_axis="auto", high_res_model=None):
        return io.NodeOutput(sample_selflift(
            model=model, positive=positive, negative=negative,
            latent_image=latent_image, sampler=sampler, sigmas=sigmas,
            seed=seed, cfg=cfg, transition_step=transition_step,
            lowres_scale=lowres_scale,
            upscaler_model=upscaler_model, high_res_model=high_res_model,
            highres_tiling=highres_tiling, tiling_mode=tiling_mode,
            tiling_tiles=tiling_tiles, tiling_axis=tiling_axis,
        ))
