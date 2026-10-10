"""Opt-in extension for the isolated acceleration lab ComfyUI instance."""
from comfy_api.latest import ComfyExtension

from .lab_nodes import NODES
from .sol_lowvram_bridge import node_class

LAB_NODES = [*NODES, node_class()]


class AccelerationLabExtension(ComfyExtension):
    async def get_node_list(self):
        return LAB_NODES


async def comfy_entrypoint():
    return AccelerationLabExtension()
