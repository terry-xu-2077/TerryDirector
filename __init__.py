from __future__ import annotations

from .director_selflift_node import TerryDirectorSelfLiftSampler
from .director_loop_x2_decode import TerryDirectorH3X2LowRAMDecode
from .director_ai_node import TerryDirectorLlamaConfig, TerryDirectorPromptEnhancer

from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .director_node import (
    TerryDirector,
    TerryDirectorAdvanced,
    TerryDirectorConfig,
    TerryDirectorSecondPassConfig,
    TerryDirectorOutput,
)
from .director_loop import (
    TerryDirectorLooper,
    TerryDirectorLoopInfo,
    TerryDirectorLoopCondition,
    TerryDirectorLoopCache,
    TerryDirectorLoopEnd,
    TerryDirectorLoopFrame,
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
            TerryDirectorLlamaConfig,
            TerryDirectorPromptEnhancer,
            TerryDirectorSecondPassConfig,
            TerryDirectorSelfLiftSampler,
            TerryDirectorH3X2LowRAMDecode,
            TerryDirectorConfig,
            TerryDirector,
            TerryDirectorAdvanced,
            TerryDirectorOutput,
            TerryDirectorLooper,
            TerryDirectorLoopInfo,
            TerryDirectorLoopCondition,
            TerryDirectorLoopCache,
            TerryDirectorLoopEnd,
            TerryDirectorLoopFrame,
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
        return node_classes


async def comfy_entrypoint() -> TerryDirectorExtension:
    return TerryDirectorExtension()
