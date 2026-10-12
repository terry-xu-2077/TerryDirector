"""Configuration-only node for TerryDirector's optional native llama.cpp backend."""
from __future__ import annotations

from pathlib import Path

import folder_paths
from comfy_api.latest import io

from .director_ai_core import AI_CONFIG_TYPE, AI_CONFIG_VERSION

LlamaConfigData = io.Custom(AI_CONFIG_TYPE)
MODEL_ROOT = Path(folder_paths.models_dir) / "LLM"


def _model_options(projector: bool) -> list[str]:
    names = sorted(
        file.relative_to(MODEL_ROOT).as_posix()
        for file in MODEL_ROOT.rglob("*.gguf")
        if file.is_file()
    ) if MODEL_ROOT.exists() else []
    values = [name for name in names if ("mmproj" in name.casefold()) == projector]
    if projector:
        return ["None", *values]
    return values or ["Qwen3.8-27B-Q4_K_M.gguf"]


class TerryDirectorLlamaConfig(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        models = _model_options(False)
        projectors = _model_options(True)
        preferred = next((v for v in models if "qwen3.8" in v.lower()), models[0])
        mmproj = next((v for v in projectors if "mmproj" in v.lower()), "None")
        return io.Schema(
            node_id="TerryDirectorLlamaConfig",
            display_name="TerryDirector Llama",
            category="MiniMax H3/TerryDirector",
            description="提供 TerryDirector 共享的本地 Llama 推理能力：GGUF / VLM、系统提示词、AI Seed 与采样参数；由接入的编辑器或导演节点按需调用。",
            inputs=[
                io.Combo.Input("model", display_name="GGUF 模型", options=models, default=preferred),
                io.Combo.Input("vision_model", display_name="视觉投影器", options=projectors, default=mmproj),
                io.Combo.Input(
                    "system_prompt_preset",
                    display_name="系统提示词预设",
                    options=["H3 Skill", "无"],
                    default="H3 Skill",
                    tooltip="当「系统提示词」为空时使用。H3 Skill 为 TerryDirector 默认增强规则。",
                ),
                io.String.Input(
                    "system_prompt",
                    display_name="系统提示词",
                    default="",
                    multiline=True,
                    dynamic_prompts=False,
                    socketless=False,
                    tooltip=(
                        "非空时完全替换系统提示词预设和内置 H3 Skill。"
                        "可直接在节点内编辑，也可从外部 STRING 输入连接。"
                    ),
                ),
                io.Int.Input("seed", display_name="AI Seed", default=8888, min=0, max=0xFFFFFFFFFFFFFFFF,
                             step=1, control_after_generate=True),
                io.Boolean.Input("think_mode", display_name="思考模式", default=False),
                io.Int.Input("n_ctx", display_name="上下文长度", default=16384, min=1024, max=131072, step=1024),
                io.Int.Input("max_tokens", display_name="最大输出 Token", default=8192, min=256, max=32768, step=256),
                io.Float.Input("temperature", display_name="温度", default=0.7, min=0.0, max=2.0, step=0.05),
                io.Float.Input("top_p", display_name="Top P", default=0.8, min=0.0, max=1.0, step=0.05),
                io.Int.Input("gpu_layers", display_name="GPU 层数（-1 全部）", default=-1, min=-1, max=999, step=1),
            ],
            outputs=[LlamaConfigData.Output(display_name="Llama")],
        )

    @classmethod
    def execute(cls, model, vision_model, system_prompt_preset, system_prompt, seed, think_mode, n_ctx, max_tokens,
                temperature, top_p, gpu_layers):
        return io.NodeOutput({
            "type": AI_CONFIG_TYPE,
            "version": AI_CONFIG_VERSION,
            "model": str(model),
            "vision_model": str(vision_model),
            "system_prompt_preset": str(system_prompt_preset or "H3 Skill"),
            "system_prompt": str(system_prompt or ""),
            "seed": int(seed),
            "think_mode": bool(think_mode),
            "n_ctx": int(n_ctx),
            "max_tokens": int(max_tokens),
            "temperature": float(temperature),
            "top_p": float(top_p),
            "gpu_layers": int(gpu_layers),
        })
