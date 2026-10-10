"""Lab-only bridge between pinned KJ block forwards and native Sol attention.

No global/class monkey patch, dependency upgrade, or production registration.
Dense calls delegate to the exact existing bound KJ forward. Sparse calls use
ComfyUI's existing DiTBlock.forward with the supplied attention callable. This
matches the two branches in KJNodes d3cfe216's fix without vendoring its code.
See RESUME_SOL_FORWARD.md for fixed source references and measurement limits.
"""
from __future__ import annotations

import inspect
from types import MethodType


def bridge_forward(original, native_forward):
    """Bind a new forward to the SAME block; do not mutate that block here."""
    if not isinstance(original, MethodType):
        raise TypeError("Lab Sol bridge requires a bound KJ block forward")
    if original.__func__.__name__ != "minimax_block_lowmem_forward":
        raise ValueError("Unexpected block owner; inspect the installed KJ patch before proceeding")
    if "attention" in inspect.signature(original).parameters:
        raise ValueError("KJ already accepts attention; this pinned-version bridge is not needed")
    if "attention" not in inspect.signature(native_forward).parameters:
        raise ValueError("Installed native DiTBlock.forward has no attention parameter")
    block = original.__self__

    def forward(self, x, t_emb, mod_segments, rope_freqs,
                transformer_options=None, attention=None):
        if self is not block:
            raise ValueError("Lab Sol bridge bound to a different block")
        options = {} if transformer_options is None else transformer_options
        if attention is None:
            # Keep KJ's list hand-off / early h release and head slicing.
            return original(x, t_emb, mod_segments, rope_freqs,
                            transformer_options=options)
        if not callable(attention):
            raise TypeError("Sol attention override must be callable or None")
        # The native sparse producer expects a tensor, NOT KJ's disposable list.
        # Keep self.mlp/self.attn and their existing patches; never swallow the
        # override or retry as dense if its call fails.
        return native_forward(self, x, t_emb, mod_segments, rope_freqs,
                              transformer_options=options, attention=attention)

    forward._terry_lab_sol_bridge = True
    return MethodType(forward, block)


def bridge_model(model, native_forward, block_type=None):
    """Replace only block-forward entries on a cloned ModelPatcher."""
    diffusion = model.get_model_object("diffusion_model")
    blocks = getattr(diffusion, "blocks", None)
    if not blocks:
        raise ValueError("Lab Sol bridge requires nonempty H3 blocks")
    prepared = []
    for index, block in enumerate(blocks):
        if block_type is not None and not isinstance(block, block_type):
            raise TypeError(f"Block {index} is not the installed native DiTBlock")
        key = f"diffusion_model.blocks.{index}.forward"
        original = model.object_patches.get(key)
        if not isinstance(original, MethodType) or original.__self__ is not block:
            raise ValueError(f"Missing or unexpected bound KJ forward: {key}")
        prepared.append((key, bridge_forward(original, native_forward)))
    # Validate every block before creating any clone-side patch.
    cloned = model.clone()
    if cloned is model or cloned.object_patches is model.object_patches:
        raise ValueError("ModelPatcher.clone must isolate its object_patches mapping")
    for key, patched in prepared:
        cloned.add_object_patch(key, patched)
    return cloned


def node_class():
    """Register only through this explicitly installed experimental extension."""
    from comfy_api.latest import io

    class TerryAccelLabSolLowVRAMBridge(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(
                node_id="TerryAccelLabSolLowVRAMBridge",
                display_name="Lab Sol / KJ block bridge",
                category="Terry Acceleration Lab",
                description="Pinned KJ block signature adapter; no sampling or parameter changes.",
                inputs=[io.Model.Input("model")],
                outputs=[io.Model.Output()],
            )

        @classmethod
        def execute(cls, model):
            from comfy.ldm.minimax.model import DiTBlock
            result = bridge_model(model, DiTBlock.forward, DiTBlock)
            count = len(result.get_model_object("diffusion_model").blocks)
            print(f"[TerryAccelLab] Sol/KJ block bridge installed: {count} blocks on cloned MODEL", flush=True)
            return io.NodeOutput(result)

    return TerryAccelLabSolLowVRAMBridge
