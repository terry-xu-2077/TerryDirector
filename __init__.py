from __future__ import annotations

from .nodes.director_pause_resume import TerryDirectorPauseResume
from .nodes.director_selflift_stage_nodes import TerryDirectorSelfLiftLowres, TerryDirectorSelfLiftHighresSampler
from .nodes.director_selflift_node import TerryDirectorSelfLiftSampler
from .nodes.director_selflift_split_node import (
    TerryDirectorSaveLowresCheckpoint,
    TerryDirectorReadLowresCheckpoint,
    TerryDirectorSelfLiftHighres,
)
from .nodes.director_preview_native import TerryDirectorH3Preview
from .nodes.director_loop_x2_decode import TerryDirectorH3X2LowRAMDecode
from .nodes.director_ai_node import TerryDirectorLlamaConfig, TerryDirectorPromptEnhancer
from .nodes.director_dual_resolution_selector import TerryDirectorDualSamplingResolutionSelector

from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .nodes.director_loop import (
    TerryDirectorLooper,
    TerryDirectorLoopInfo,
    TerryDirectorLoopCondition,
    TerryDirectorLoopCache,
    TerryDirectorLoopEnd,
    TerryDirectorLoopFrame,
    TerryDirectorLoopReuse,
)
from .nodes import server_routes as _server_routes  # noqa: F401 - register routes on import

WEB_DIRECTORY = "./web"


class TerryDirectorExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        node_classes = [
            TerryDirectorLlamaConfig,
            TerryDirectorPromptEnhancer,
            TerryDirectorDualSamplingResolutionSelector,
            TerryDirectorSelfLiftSampler,
            TerryDirectorPauseResume,
            TerryDirectorSelfLiftLowres,
            TerryDirectorSelfLiftHighresSampler,
            TerryDirectorSaveLowresCheckpoint,
            TerryDirectorReadLowresCheckpoint,
            TerryDirectorSelfLiftHighres,
            TerryDirectorH3Preview,
            TerryDirectorH3X2LowRAMDecode,
            TerryDirectorLooper,
            TerryDirectorLoopInfo,
            TerryDirectorLoopCondition,
            TerryDirectorLoopCache,
            TerryDirectorLoopEnd,
            TerryDirectorLoopFrame,
            TerryDirectorLoopReuse,
        ]
        return node_classes


async def comfy_entrypoint() -> TerryDirectorExtension:
    return TerryDirectorExtension()
