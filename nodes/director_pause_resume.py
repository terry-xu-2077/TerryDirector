"""A lazy, disk-backed execution boundary for any native ComfyUI LATENT."""
from __future__ import annotations

from comfy_api.latest import io

from .director_latent_checkpoint import load_checkpoint, save_checkpoint


class TerryDirectorPauseResume(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="TerryDirectorPauseResume",
            display_name="TerryDirector 暂停/继续",
            category="TerryDirector",
            description=("暂停：运行上游并将 LATENT 及其元数据保存到磁盘，阻断下游。"
                         "继续：跳过上游，读取缓存并输出原样 LATENT，交给下游自行采样或解码。"),
            is_output_node=True,
            inputs=[
                io.Combo.Input("mode", options=["暂停并保存", "继续执行"], default="暂停并保存"),
                io.String.Input("checkpoint_id", default="", tooltip="暂停成功后自动写入缓存 ID。"),
                io.String.Input("name", default="未命名缓存"),
                io.Latent.Input("latent", optional=True, lazy=True, display_name="LATENT"),
            ],
            outputs=[io.Latent.Output("latent", display_name="LATENT"),
                     io.String.Output("checkpoint_id", display_name="检查点 ID")],
        )

    @staticmethod
    def _lazy_item(value, key):
        # V3 check_lazy_status receives (value, input_id) dynamic tuples.
        return value[0] if isinstance(value, tuple) and len(value) == 2 and value[1] == key else value

    @classmethod
    def check_lazy_status(cls, mode, **kwargs):
        if cls._lazy_item(mode, "mode") == "暂停并保存" and "latent" in kwargs:
            return ["latent"] if cls._lazy_item(kwargs["latent"], "latent") is None else []
        return []

    @classmethod
    def execute(cls, mode, checkpoint_id, name, latent=None):
        from comfy_execution.graph_utils import ExecutionBlocker
        if mode == "暂停并保存":
            if latent is None:
                raise ValueError("暂停/继续：暂停模式缺少 LATENT 输入")
            saved_id = save_checkpoint(latent, name)
            return io.NodeOutput(ExecutionBlocker(None), saved_id,
                                 ui={"terrydirector_checkpoint": [{
                                     "checkpoint_id": saved_id, "mode": "paused",
                                     "name": str(name).strip()[:120] or "未命名缓存"}]})
        if mode == "继续执行":
            selected_id = str(checkpoint_id or "").strip()
            if not selected_id:
                raise ValueError("暂停/继续：请先以“暂停并保存”运行一次")
            try:
                saved = load_checkpoint(selected_id)
            except (FileNotFoundError, OSError) as exc:
                raise ValueError("暂停/继续：指定的检查点不存在或已被删除") from exc
            except (KeyError, ValueError, TypeError, RuntimeError) as exc:
                raise ValueError(f"暂停/继续：检查点损坏或不兼容：{exc}") from exc
            return io.NodeOutput(saved["latent"], selected_id,
                                 ui={"terrydirector_checkpoint": [{
                                     "checkpoint_id": selected_id, "mode": "continued",
                                     "name": saved["manifest"]["name"]}]})
        raise ValueError("暂停/继续：无效的模式")

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("NaN")
