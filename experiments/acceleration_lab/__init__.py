"""Opt-in extension for the isolated acceleration lab ComfyUI instance."""
from comfy_api.latest import ComfyExtension

from .lab_nodes import NODES


class AccelerationLabExtension(ComfyExtension):
    async def get_node_list(self):
        return NODES


async def comfy_entrypoint():
    return AccelerationLabExtension()
