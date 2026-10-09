"""Private execution node for TerryDirector's own SelfLift implementation."""
from comfy_api.latest import io
from .director_selflift import sample_h3


class TerryDirectorSelfLiftSampler(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorSelfLiftSampler",
            display_name="TerryDirector SelfLift (Internal)",
            category="MiniMax H3/TerryDirector/Internal",
            is_dev_only=True,
            inputs=[
                io.Model.Input("model"),
                io.Vae.Input("vae"),
                io.Custom("TERRYDIRECTOR_SECOND_PASS_CONFIG").Input("settings"),
                io.Conditioning.Input("positive"),
                io.Conditioning.Input("negative"),
                io.Latent.Input("latent_image"),
                io.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF),
            ],
            outputs=[io.Latent.Output()],
        )

    @classmethod
    def execute(cls, model, vae, settings, positive, negative, latent_image, seed):
        second = settings
        keys = ("cfg", "transition_step", "lowres_scale", "rho", "w_min", "w_max",
                "upscaler_model", "high_res_model", "highres_tiling", "tiling_mode",
                "tiling_tiles", "tiling_axis", "sampler", "sigmas")
        return io.NodeOutput(sample_h3(
            model=model, vae=vae, positive=positive, negative=negative,
            latent_image=latent_image, seed=seed, **{key: second[key] for key in keys}
        ))
