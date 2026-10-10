"""Standalone, opt-in ComfyUI nodes. Production nodes and globals stay untouched."""
from __future__ import annotations

import json
from pathlib import Path
import threading
import time

import folder_paths
import torch
from comfy_api.latest import io, ui, Types

from . import av_store
from . import frozen


_WRITE_LOCK = threading.Lock()


def _record(run_id, stage, start, end, **extra):
    root = Path(folder_paths.get_output_directory()) / ".acceleration_lab"
    root.mkdir(parents=True, exist_ok=True)
    record = {"run_id": run_id, "stage": stage, "start_ns": start, "end_ns": end,
              "duration_s": (end - start) / 1e9, **extra}
    with _WRITE_LOCK, (root / "stages.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")


def _checkpoint_path(name):
    if name not in ("B0_AV.pt", "B1_AV.pt"):
        raise ValueError("Only fixed lab AV checkpoint names are accepted")
    return Path(folder_paths.get_output_directory()) / ".acceleration_lab" / name


class TerryAccelLabCondition(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TerryAccelLabCondition", display_name="Lab H3 Condition (timed)",
            category="Terry Acceleration Lab", inputs=[
                io.Clip.Input("clip"), io.Vae.Input("vae"), io.Vae.Input("audio_vae"),
                io.String.Input("prompt", multiline=True), io.Int.Input("width", default=1920),
                io.Int.Input("height", default=1088), io.Int.Input("length", default=107),
                io.Combo.Input("ref_image_size", options=["match", "max"], default="match"),
                io.String.Input("run_id", default="B0"),
                *[io.Image.Input(f"ref_image_{i}") for i in range(7)],
            ], outputs=[io.Conditioning.Output(), io.Latent.Output()])

    @classmethod
    def execute(cls, clip, vae, audio_vae, prompt, width, height, length, ref_image_size, run_id, **images):
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
        refs = {f"ref_image_{i}": images[f"ref_image_{i}"] for i in range(7)}
        start = time.perf_counter_ns()
        result = MiniMaxH3ReferenceToVideo.execute(
            clip=clip, vae=vae, audio_vae=audio_vae, prompt=prompt,
            width=width, height=height, length=length, ref_image_size=ref_image_size,
            ref_images=refs)
        _record(run_id, "conditioning", start, time.perf_counter_ns(),
                width=width, height=height, h3_frames=length, reference_images=7)
        return io.NodeOutput(result[0], result[1])


class TerryAccelLabSigmaRefine(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TerryAccelLabSigmaRefine", display_name="Lab frozen Sigma refine",
            category="Terry Acceleration Lab", inputs=[
                io.Sigmas.Input("sigmas"), io.Int.Input("extra_steps", default=1),
                io.Float.Input("start_at_sigma", default=0.7),
                io.Float.Input("end_at_sigma", default=0.0),
                io.Combo.Input("spacing", options=["cosine", "linear", "exponential"], default="cosine"),
            ], outputs=[io.Sigmas.Output()])

    @classmethod
    def execute(cls, sigmas, extra_steps, start_at_sigma, end_at_sigma, spacing):
        _refine_sigmas = frozen.refine_sigmas()
        return io.NodeOutput(_refine_sigmas(sigmas, extra_steps=extra_steps,
            start_at_sigma=start_at_sigma, end_at_sigma=end_at_sigma, spacing=spacing))


class TerryAccelLabSelfLift(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TerryAccelLabSelfLift", display_name="Lab frozen Self-Lift (timed)",
            category="Terry Acceleration Lab", inputs=[
                io.Model.Input("model"), io.Conditioning.Input("positive"),
                io.Conditioning.Input("negative"), io.Vae.Input("vae"),
                io.Latent.Input("latent_image"), io.Sampler.Input("sampler"),
                io.Sigmas.Input("sigmas"), io.Int.Input("seed", default=1000),
                io.Float.Input("cfg", default=1.0), io.Int.Input("transition_step", default=5),
                io.Float.Input("lowres_scale", default=0.5), io.Float.Input("rho", default=0.0),
                io.Float.Input("w_min", default=0.5), io.Float.Input("w_max", default=1.0),
                io.String.Input("upscaler_model", default="minimax_h3_latent_upscaler_3d_fp16.safetensors"),
                io.Boolean.Input("highres_tiling", default=False),
                io.String.Input("run_id", default="B0"),
                io.Boolean.Input("expect_sol", default=False),
            ], outputs=[io.Latent.Output()])

    @classmethod
    def execute(cls, model, positive, negative, vae, latent_image, sampler, sigmas,
                seed, cfg, transition_step, lowres_scale, rho, w_min, w_max,
                upscaler_model, highres_tiling, run_id, expect_sol):
        ComfyBackend, sample_selflift = frozen.selflift_core()
        import comfy_kitchen as ck
        if run_id not in ("B0", "B1") or expect_sol != (run_id == "B1"):
            raise ValueError("Lab run ID and sparse expectation disagree")
        sigma_values = [float(x) for x in sigmas.detach().cpu().tolist()]
        sigma_start = float(model.get_model_object("model_sampling").percent_to_sigma(0.05)) if expect_sol else None
        sigma_end = float(model.get_model_object("model_sampling").percent_to_sigma(1.0)) if expect_sol else None
        sol_calls = [0]
        old_sol = ck.sol_attn_chunked

        def counted_sol(*args, **kwargs):
            sol_calls[0] += 1
            return old_sol(*args, **kwargs)

        class TimedBackend(ComfyBackend):
            def __init__(self):
                super().__init__()
                self.index = 0

            def preview(self, model, steps):
                return None  # The source request had preview disabled.

            def sample(self, model, noise, positive, negative, cfg, sampler, sigmas, latent, callback, seed):
                phase = "low_sampling" if self.index == 0 else "high_sampling"
                self.index += 1
                before_sol = sol_calls[0]
                values = [float(x) for x in sigmas.detach().cpu().tolist()]
                if torch.cuda.is_available():
                    torch.cuda.synchronize()
                    torch.cuda.reset_peak_memory_stats()
                start = time.perf_counter_ns()
                calls = [0]

                def observed_callback(*args, **kwargs):
                    calls[0] += 1
                    index = calls[0] - 1
                    current_sigma = values[index]
                    expected = expect_sol and sigma_end <= current_sigma <= sigma_start
                    if expected and sol_calls[0] <= before_sol:
                        raise RuntimeError("Sol-Attn expected but no actual chunked producer call; stop")
                    return callback(*args, **kwargs)

                try:
                    return super().sample(model, noise, positive, negative, cfg, sampler, sigmas,
                                          latent, observed_callback, seed)
                finally:
                    if torch.cuda.is_available():
                        torch.cuda.synchronize()
                    end = time.perf_counter_ns()
                    _record(run_id, phase, start, end, sigmas=values, callbacks=calls[0],
                            sol_chunked_calls=sol_calls[0] - before_sol,
                            peak_cuda_allocated_bytes=(torch.cuda.max_memory_allocated() if torch.cuda.is_available() else None))

        start = time.perf_counter_ns()
        if expect_sol:
            ck.sol_attn_chunked = counted_sol
        try:
            result = sample_selflift(model=model, positive=positive, negative=negative,
                vae=vae, latent_image=latent_image, sampler=sampler, sigmas=sigmas,
                seed=seed, cfg=cfg, transition_step=transition_step, lowres_scale=lowres_scale,
                rho=rho, w_min=w_min, w_max=w_max, upscaler_model=upscaler_model,
                highres_tiling=highres_tiling, _backend=TimedBackend())
            return io.NodeOutput(result)
        finally:
            ck.sol_attn_chunked = old_sol
            _record(run_id, "selflift_total", start, time.perf_counter_ns(),
                    sigmas=sigma_values, sigma_sparse_start=sigma_start, sigma_sparse_end=sigma_end,
                    sol_chunked_calls=sol_calls[0])


class TerryAccelLabCheckpointAV(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TerryAccelLabCheckpointAV", display_name="Lab save full AV latent",
            category="Terry Acceleration Lab", inputs=[io.Latent.Input("latent"),
                io.Combo.Input("filename", options=["B0_AV.pt", "B1_AV.pt"]),
                io.String.Input("run_id", default="B0")], outputs=[io.Latent.Output()])

    @classmethod
    def execute(cls, latent, filename, run_id):
        from comfy.nested_tensor import NestedTensor
        start = time.perf_counter_ns()
        path = _checkpoint_path(filename)
        av_store.save(path, latent, NestedTensor)
        _record(run_id, "checkpoint_av", start, time.perf_counter_ns(), bytes=path.stat().st_size)
        return io.NodeOutput(latent)


class TerryAccelLabLoadAV(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TerryAccelLabLoadAV", display_name="Lab load full AV latent",
            category="Terry Acceleration Lab", inputs=[
                io.Combo.Input("filename", options=["B0_AV.pt"]),
                io.String.Input("run_id", default="V0")], outputs=[io.Latent.Output()])

    @classmethod
    def execute(cls, filename, run_id):
        from comfy.nested_tensor import NestedTensor
        start = time.perf_counter_ns()
        latent = av_store.load(_checkpoint_path(filename), NestedTensor)
        _record(run_id, "load_av", start, time.perf_counter_ns())
        return io.NodeOutput(latent)


class TerryAccelLabDecodeVideo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TerryAccelLabDecodeVideo", display_name="Lab video VAE decode (timed)",
            category="Terry Acceleration Lab", inputs=[io.Latent.Input("samples"), io.Vae.Input("vae"),
                io.String.Input("run_id", default="V0")], outputs=[io.Image.Output()])

    @classmethod
    def execute(cls, samples, vae, run_id):
        import nodes
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
        start = time.perf_counter_ns()
        try:
            images = nodes.VAEDecode().decode(vae, samples)[0]
            return io.NodeOutput(images)
        finally:
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            _record(run_id, "video_vae_decode", start, time.perf_counter_ns(),
                    peak_cuda_allocated_bytes=(torch.cuda.max_memory_allocated() if torch.cuda.is_available() else None))


class TerryAccelLabDecodeAudio(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TerryAccelLabDecodeAudio", display_name="Lab audio VAE decode (timed)",
            category="Terry Acceleration Lab", inputs=[io.Latent.Input("samples"), io.Vae.Input("vae"),
                io.String.Input("run_id", default="B0")], outputs=[io.Audio.Output()])

    @classmethod
    def execute(cls, samples, vae, run_id):
        from comfy_extras.nodes_audio import VAEDecodeAudio
        start = time.perf_counter_ns()
        try:
            result = VAEDecodeAudio.execute(vae=vae, samples=samples)
            return io.NodeOutput(result[0])
        finally:
            _record(run_id, "audio_vae_decode", start, time.perf_counter_ns())


class TerryAccelLabSaveVideo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TerryAccelLabSaveVideo", display_name="Lab save video (timed)",
            category="Terry Acceleration Lab", is_output_node=True,
            inputs=[io.Video.Input("video"), io.String.Input("filename_prefix", default="video/Lab_B0"),
                    io.String.Input("run_id", default="B0")], outputs=[io.Video.Output()])

    @classmethod
    def execute(cls, video, filename_prefix, run_id):
        width, height = video.get_dimensions()
        root, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory(), width, height)
        name = f"{filename}_{counter:05}_.mp4"
        path = str(Path(root) / name)
        start = time.perf_counter_ns()
        video.save_to(path, format=Types.VideoContainer("mp4"), codec=Types.VideoCodec("h264"))
        _record(run_id, "save_encode", start, time.perf_counter_ns(), bytes=Path(path).stat().st_size)
        return io.NodeOutput(video, ui=ui.PreviewVideo([ui.SavedResult(name, subfolder, io.FolderType.output)]))


NODES = [TerryAccelLabCondition, TerryAccelLabSigmaRefine, TerryAccelLabSelfLift,
         TerryAccelLabCheckpointAV, TerryAccelLabLoadAV, TerryAccelLabDecodeVideo,
         TerryAccelLabDecodeAudio, TerryAccelLabSaveVideo]
