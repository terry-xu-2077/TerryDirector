"""TerryDirector minimal split SelfLift nodes.

Low-resolution *sampling* stays native ComfyUI:
BasicScheduler -> SplitSigmas -> SamplerCustom/Advanced, using standard
Euler, with KJ Model Preview Override optionally attached to the MODEL.
Connect BOTH sampler outputs to Save Checkpoint.
"""
from __future__ import annotations

from comfy_api.latest import io

from .director_selflift_checkpoint import list_checkpoints, save_checkpoint
from .director_selflift_resume import resume_highres

CheckpointData = io.Custom("TERRYDIRECTOR_SELFLIFT_CHECKPOINT")


def _choice(manifest):
    return f"{manifest['name']}  ·  {manifest['checkpoint_id'][:8]}"


class TerryDirectorSaveLowresCheckpoint(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorSaveLowresCheckpoint",
            display_name="TerryDirector 保存低清检查点",
            category="TerryDirector/SelfLift",
            description=("连接原生 SamplerCustom 的 output 和 denoised_output。"
                         "SIGMAS 必须是完整原始日程，低清采样只用前 transition_step 步。"
                         "保存的不是普通完成态 latent，而是 SelfLift 可恢复的过渡检查点。"),
            is_output_node=True,
            inputs=[
                io.Latent.Input("low_state", display_name="低清 output"),
                io.Latent.Input("low_clean", display_name="低清 denoised_output"),
                io.Latent.Input("source", display_name="目标分辨率原始 Latent"),
                io.Sigmas.Input("sigmas", display_name="完整 SIGMAS"),
                io.Int.Input("transition_step", default=6, min=1, max=10000),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff),
                io.Float.Input("cfg", default=5.0, min=0.0, max=100.0),
                io.String.Input("name", default="未命名低清镜头"),
            ],
            outputs=[
                CheckpointData.Output("checkpoint", display_name="检查点引用"),
                io.String.Output("checkpoint_id", display_name="检查点 ID"),
            ],
        )

    @classmethod
    def execute(cls, low_state, low_clean, source, sigmas, transition_step, seed, cfg, name):
        checkpoint_id = save_checkpoint(
            low_state=low_state, low_clean=low_clean, source=source,
            sigmas=sigmas, transition_step=transition_step, seed=seed,
            cfg=cfg, name=name)
        return io.NodeOutput({"checkpoint_id": checkpoint_id}, checkpoint_id)

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Saving creates a new immutable review candidate each explicit run.
        return float("NaN")


class TerryDirectorReadLowresCheckpoint(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        choices = [_choice(m) for m in list_checkpoints()]
        return io.Schema(
            node_id="TerryDirectorReadLowresCheckpoint",
            display_name="TerryDirector 读取低清检查点",
            category="TerryDirector/SelfLift",
            description="最小可运行版：按镜头名称选择磁盘检查点；视频任务卡浏览器后续接入。",
            inputs=[
                io.Combo.Input("task", options=choices or ["（暂无检查点，请先运行保存节点）"]),
            ],
            outputs=[
                CheckpointData.Output("checkpoint", display_name="检查点引用"),
                io.String.Output("checkpoint_id", display_name="检查点 ID"),
            ],
        )

    @classmethod
    def execute(cls, task):
        matched = next((m for m in list_checkpoints() if _choice(m) == task), None)
        if matched is None:
            raise ValueError("低清检查点不存在或已被移走；请刷新节点任务列表")
        return io.NodeOutput({"checkpoint_id": matched["checkpoint_id"]},
                             matched["checkpoint_id"])


class TerryDirectorSelfLiftPauseResume(io.ComfyNode):
    """An explicit, disk-backed pause boundary for a native low-res Euler sampler.

    All four latent/sigma inputs are lazy. In 'continue' mode ComfyUI therefore
    has no reason to evaluate the upstream low-res sampler at all. In 'pause'
    mode an ExecutionBlocker travels along the checkpoint output so an attached
    high-res sampler and its video encoder cannot accidentally run.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorSelfLiftPauseResume",
            display_name="TerryDirector SelfLift 暂停/继续",
            category="TerryDirector/SelfLift",
            description=(
                "暂停：运行低清上游并将可恢复的检查点自动保存到磁盘，高清下游不执行。"
                "继续：跳过全部低清上游，自动读取上次保存的检查点并开始高清。"
                "保存后会自动将检查点 ID 写到本节点，保存工作流后下次仍可继续。"
            ),
            is_output_node=True,
            inputs=[
                io.Combo.Input("mode", options=["暂停并保存", "继续高清"], default="暂停并保存"),
                io.String.Input("checkpoint_id", default="",
                                tooltip="暂停成功后会自动写入。也可以粘贴现有的完整检查点 ID。"),
                io.String.Input("name", default="未命名低清镜头"),
                io.Int.Input("transition_step", default=6, min=1, max=10000),
                io.Int.Input("seed", default=0, min=0, max=0xffffffffffffffff),
                io.Float.Input("cfg", default=5.0, min=0.0, max=100.0),
                io.Latent.Input("low_state", display_name="低清 output", optional=True, lazy=True),
                io.Latent.Input("low_clean", display_name="低清 denoised_output", optional=True, lazy=True),
                io.Latent.Input("source", display_name="目标分辨率原始 Latent", optional=True, lazy=True),
                io.Sigmas.Input("sigmas", display_name="完整 SIGMAS", optional=True, lazy=True),
            ],
            outputs=[
                CheckpointData.Output("checkpoint", display_name="高清检查点"),
                io.String.Output("checkpoint_id", display_name="检查点 ID"),
            ],
        )

    @classmethod
    def check_lazy_status(cls, mode, **kwargs):
        if mode == "继续高清":
            # Crucial: do not touch/evaluate any connected low-res inputs.
            return []
        if mode == "暂停并保存":
            # Absent optional sockets do not exist in input_data_all. Asking
            # ComfyUI to evaluate an absent socket raises NodeInputError before
            # execute() can issue our clear Chinese missing-input message.
            return [
                name for name in ("low_state", "low_clean", "source", "sigmas")
                if name in kwargs and kwargs[name] is None
            ]
        return []

    @classmethod
    def execute(cls, mode, checkpoint_id, name, transition_step, seed, cfg,
                low_state=None, low_clean=None, source=None, sigmas=None):
        from comfy_execution.graph_utils import ExecutionBlocker

        if mode == "暂停并保存":
            missing = [label for label, value in (
                ("低清 output", low_state), ("低清 denoised_output", low_clean),
                ("目标分辨率原始 Latent", source), ("完整 SIGMAS", sigmas)
            ) if value is None]
            if missing:
                raise ValueError("暂停/继续：暂停模式缺少输入：" + "、".join(missing))
            saved_id = save_checkpoint(
                low_state=low_state, low_clean=low_clean, source=source,
                sigmas=sigmas, transition_step=transition_step, seed=seed,
                cfg=cfg, name=name,
            )
            # A soft execution blocker on ONLY the checkpoint output prevents
            # every downstream high-res consumer from executing in pause mode.
            # The ID and UI status are still returned and can be persisted.
            return io.NodeOutput(
                ExecutionBlocker(None), saved_id,
                ui={"terrydirector_selflift_checkpoint": [{
                    "checkpoint_id": saved_id, "mode": "paused",
                    "name": str(name).strip()[:120] or "未命名低清镜头",
                }]},
            )
        if mode == "继续高清":
            selected_id = str(checkpoint_id or "").strip()
            if not selected_id:
                raise ValueError(
                    "暂停/继续：当前没有可继续的检查点，请先以“暂停并保存”模式运行一次"
                )
            from .director_selflift_checkpoint import load_checkpoint
            try:
                saved = load_checkpoint(selected_id)
            except (FileNotFoundError, OSError) as exc:
                raise ValueError("暂停/继续：指定的检查点不存在或已被删除") from exc
            except (KeyError, ValueError, RuntimeError) as exc:
                raise ValueError(f"暂停/继续：检查点损坏或不兼容：{exc}") from exc
            manifest = saved["manifest"]
            return io.NodeOutput(
                {"checkpoint_id": selected_id}, selected_id,
                ui={"terrydirector_selflift_checkpoint": [{
                    "checkpoint_id": selected_id, "mode": "continued",
                    "name": manifest["name"],
                }]},
            )
        raise ValueError("暂停/继续：无效的模式")

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Fresh pause creates a new immutable checkpoint. Continue rechecks
        # disk existence and content rather than using a stale cached ref.
        return float("NaN")


class TerryDirectorSelfLiftHighres(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        from .director_selflift_upscaler import list_models
        available = ["none"] + list_models()
        return io.Schema(
            node_id="TerryDirectorSelfLiftHighres",
            display_name="TerryDirector SelfLift 高清续采",
            category="TerryDirector/SelfLift",
            description=("从已保存的低清 x0 + sigma[k] 音视频状态恢复 SelfLift。"
                         "必须连接与低清生成兼容的 H3 模型、原始条件、VAE 和标准 Euler。"
                         "不会再次运行低清阶段。"),
            inputs=[
                CheckpointData.Input("checkpoint", display_name="低清检查点"),
                io.Model.Input("model", display_name="高清 H3 模型"),
                io.Conditioning.Input("positive"),
                io.Conditioning.Input("negative"),
                io.Vae.Input("vae", display_name="视频 VAE"),
                io.Sampler.Input("sampler", display_name="Euler 采样器"),
                io.Float.Input("rho", default=0.6, min=0.0, max=1.0),
                io.Float.Input("w_min", default=0.5, min=0.0, max=1.0),
                io.Float.Input("w_max", default=1.0, min=0.0, max=1.0),
                io.Combo.Input("upscaler_model", options=available, default="none"),
                io.Boolean.Input("highres_tiling", default=False),
                io.Combo.Input("tiling_mode", options=["auto", "manual"], default="auto"),
                io.Combo.Input("tiling_tiles", options=[2, 4, 6, 8], default=2),
                io.Combo.Input("tiling_axis", options=["auto", "width", "height"], default="auto"),
            ],
            outputs=[io.Latent.Output("latent", display_name="高清音视频 Latent")],
        )

    @classmethod
    def execute(cls, checkpoint, model, positive, negative, vae, sampler,
                rho, w_min, w_max, upscaler_model, highres_tiling=False,
                tiling_mode="auto", tiling_tiles=2, tiling_axis="auto"):
        return io.NodeOutput(resume_highres(
            checkpoint=checkpoint, model=model, positive=positive,
            negative=negative, vae=vae, sampler=sampler,
            rho=rho, w_min=w_min, w_max=w_max, upscaler_model=upscaler_model,
            highres_tiling=highres_tiling, tiling_mode=tiling_mode,
            tiling_tiles=tiling_tiles, tiling_axis=tiling_axis,
        ))
