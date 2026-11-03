"""File-backed loop result compatible with the official SaveVideo node."""

from pathlib import Path

from comfy_api.latest import Types
from comfy_api.latest._input_impl.video_types import VideoFromFile


class TerryDirectorMergedVideo(VideoFromFile):
    """Transcode ProRes when SaveVideo requests an MP4 container."""

    def save_to(self, path, format=Types.VideoContainer.AUTO,
                codec=Types.VideoCodec.AUTO, metadata=None, bit_depth=None,
                crf=None, color_space=None, preset=None):
        requested_format = Types.VideoContainer(format)
        requested_codec = Types.VideoCodec(codec)
        if requested_format == Types.VideoContainer.AUTO:
            suffix = Path(path).suffix.lower() if isinstance(path, (str, Path)) else ""
            requested_format = {
                ".mkv": Types.VideoContainer.MKV,
                ".webm": Types.VideoContainer.WEBM,
            }.get(suffix, Types.VideoContainer.MP4)
        if (
            Path(self.get_stream_source()).suffix.lower() == ".mov"
            and requested_format == Types.VideoContainer.MP4
            and requested_codec == Types.VideoCodec.AUTO
        ):
            # ComfyUI sees MOV and MP4 as aliases of one demuxer and may try
            # to packet-copy ProRes into MP4. MP4 rejects that video codec.
            requested_codec = Types.VideoCodec.H264
        return super().save_to(
            path, format=format, codec=requested_codec, metadata=metadata,
            bit_depth=bit_depth, crf=crf, color_space=color_space,
            preset=preset,
        )
