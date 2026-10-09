from __future__ import annotations

from .director_selflift_node import TerryDirectorSelfLiftSampler

from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .director_node import (
    TerryDirector,
    TerryDirectorAdvanced,
    TerryDirectorConfig,
    TerryDirectorSecondPassConfig,
    TerryDirectorOutput,
)
from .director_internal import (
    TerryDirectorCacheLatent,
    TerryDirectorLoadCachedLatent,
    TerryDirectorDecodeSegmentToCache,
    TerryDirectorMaterializeTimeline,
    TerryDirectorDecodeAdvancedSegmentToCache,
    TerryDirectorLoadAdvancedSegmentContext,
    TerryDirectorAdvancedLosslessFinish,
    TerryDirectorAssembleMedia,
    TerryDirectorPackOutput,
    TerryDirectorPackAdvancedOutput,
    TerryDirectorResampleReferenceVideo,
)
from . import server_routes as _server_routes  # noqa: F401 - register routes on import

WEB_DIRECTORY = "./web"


class TerryDirectorExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        node_classes = [
            TerryDirectorSecondPassConfig,
            TerryDirectorSelfLiftSampler,
            TerryDirectorConfig,
            TerryDirector,
            TerryDirectorAdvanced,
            TerryDirectorOutput,
            TerryDirectorPackOutput,
            TerryDirectorCacheLatent,
            TerryDirectorLoadCachedLatent,
            TerryDirectorDecodeSegmentToCache,
            TerryDirectorMaterializeTimeline,
            TerryDirectorDecodeAdvancedSegmentToCache,
            TerryDirectorLoadAdvancedSegmentContext,
            TerryDirectorAdvancedLosslessFinish,
            TerryDirectorAssembleMedia,
            TerryDirectorPackAdvancedOutput,
            TerryDirectorResampleReferenceVideo,
        ]
        from .director_trace import install
        install(__package__, node_classes)
        return node_classes


async def comfy_entrypoint() -> TerryDirectorExtension:
    return TerryDirectorExtension()
