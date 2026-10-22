"""Pure resolution math for TerryDirector's dual sampling selector."""
from __future__ import annotations

import math
import re


ASPECT_RATIO_OPTIONS = [
    "1:1 (Square)",
    "4:3 (Standard)",
    "3:2 (Photo)",
    "5:4 (Classic)",
    "16:9 (Widescreen)",
    "2:1 (Cinema)",
    "21:9 (Ultrawide)",
    "9:16 (Portrait)",
    "3:4 (Portrait)",
    "2:3 (Portrait Photo)",
    "4:5 (Portrait Classic)",
    "9:21 (Vertical Ultrawide)",
]


def parse_aspect_ratio(value: str | tuple[float, float] | list[float]) -> float:
    """Return width / height from a ratio pair or a labelled ratio option."""
    if isinstance(value, (tuple, list)) and len(value) == 2:
        width, height = float(value[0]), float(value[1])
    else:
        match = re.match(
            r"^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)",
            str(value or "16:9"),
        )
        if not match:
            raise ValueError("宽高比必须是类似 16:9 的有效比例")
        width, height = float(match.group(1)), float(match.group(2))
    if (not math.isfinite(width) or not math.isfinite(height)
            or width <= 0 or height <= 0):
        raise ValueError("宽高比必须是正的有限数值")
    return width / height


def _round_up_to_grid(value: float, grid: int = 32) -> int:
    # Subtract a tiny epsilon so exact grid multiples stay on that multiple.
    return max(grid, int(math.ceil(value / grid - 1e-12)) * grid)


def compute_resolution(megapixels: float, aspect_ratio: str = "16:9 (Widescreen)") -> tuple[int, int]:
    """Calculate dimensions, rounding each side up to H3-friendly multiples of 32."""
    try:
        target_mp = float(megapixels)
    except (TypeError, ValueError) as exc:
        raise ValueError("百万像素必须是有效数值") from exc
    if not math.isfinite(target_mp) or target_mp <= 0:
        raise ValueError("百万像素必须是大于零的有限数值")
    ratio = parse_aspect_ratio(aspect_ratio)
    target_pixels = target_mp * 1_000_000
    width = _round_up_to_grid(math.sqrt(target_pixels * ratio))
    height = _round_up_to_grid(math.sqrt(target_pixels / ratio))
    return width, height


def actual_megapixels(width: int, height: int) -> float:
    """Return the actual pixel area in megapixels after grid rounding."""
    return int(width) * int(height) / 1_000_000
