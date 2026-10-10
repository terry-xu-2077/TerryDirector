"""Opt-in extension for the isolated acceleration lab ComfyUI instance."""
import os
from comfy_api.latest import ComfyExtension

from .lab_nodes import NODES
from .sol_lowvram_bridge import node_class

LAB_NODES = [*NODES, node_class()]


class AccelerationLabExtension(ComfyExtension):
    async def get_node_list(self):
        if os.environ.get("TERRY_ACCEL_LAB_SOL_AUDIT") == "1":
            from .sol_runtime_audit import startup_audit_if_enabled
            startup_audit_if_enabled()
        return LAB_NODES


async def comfy_entrypoint():
    return AccelerationLabExtension()
