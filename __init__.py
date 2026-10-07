from __future__ import annotations

from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .director_node import TerryDirector, TerryDirectorConfig, TerryDirectorOutput
from .director_internal import (
    TerryDirectorAssembleMedia,
    TerryDirectorPackOutput,
    TerryDirectorResampleReferenceVideo,
)
from . import server_routes as _server_routes  # noqa: F401 - register routes on import

WEB_DIRECTORY = "./web"


class TerryDirectorExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            TerryDirectorConfig,
            TerryDirector,
            TerryDirectorOutput,
            TerryDirectorPackOutput,
            TerryDirectorAssembleMedia,
            TerryDirectorResampleReferenceVideo,
        ]


async def comfy_entrypoint() -> TerryDirectorExtension:
    return TerryDirectorExtension()
