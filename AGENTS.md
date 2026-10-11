# TerryDirector — repository maintenance notes

This repository is a **ComfyUI custom node package**, not a development-task archive. The root README describes the product. Current documentation is intentionally limited to:

- `docs/USAGE.md`: user-facing connections and node behaviour
- `docs/ARCHITECTURE.md`: current production module boundaries
- `docs/STABLE_BASELINES.md`: user-validated configurations and Git history anchors

## Production invariants

- Keep the ComfyUI native node containers and the existing TerryDirector timeline/UI architecture. Do not replace the Canvas timeline, alter the accepted spacing/controls, or re-introduce previews or project hierarchy without explicit direction.
- Preserve the separated second-pass configuration chain: `TerryDirector 二采配置 → TerryDirector 配置 → TerryDirector / TerryDirector Advanced`. Do not require the external selflift-Avatar plugin.
- Base exposes IMAGE/AUDIO through `TerryDirector 输出`. Advanced stores and streams its own file-backed output, with interruption recovery and per-clip rerun.
- The separate looper accepts already-decoded IMAGE/AUDIO and exposes only a streaming VIDEO. LoopEnd must not decode LATENT, expose segment LATENT, or require user-wired segment metadata; the current segment envelope is injected internally into LoopCache. Keep the external ComfyUI sampler/decoder group editable and avoid forcing an H3 prefix onto TerryDirector's public loop sockets.
- Model adapter registry: `minimax_h3` ready; `ltx_2_5` reserved/not ready. Never fall back to H3 frame/reference/continuity semantics for unknown model formats.
- The loop's temporary cache and downstream SaveVideo must stay low-memory; successful final saving clears current-run temporary files, failures retain diagnostic source caches.
- Real ComfyUI events drive per-segment sampling progress. Never fake elapsed time or completed states.
- Queue-stage automatic AI enhancement must honor ComfyUI's native Stop/Interrupt flag during streamed token generation. Editor-owned manual AI jobs remain separately cancellable and must not be coupled to Queue interruption.
- Existing core source in `director_core.py`, `director_compile.py`, `director_h3.py`, `director_selflift*.py`, `director_loop*.py` is production functionality. Any refactor must preserve the corresponding recorded behaviour in `docs/STABLE_BASELINES.md`.

## Development conventions

Use `main` as the released implementation; do new capability work on isolated branches and merge only after matching runtime validation. Current release intentionally omits historical tests, benchmark utilities and experimental launchers; do not re-add them to the production tree without a new explicit requirement.

Keep README customer-oriented. Do not append status diaries, pending-task checklists, huge code review reports or unverified performance claims. Archive reproducibility clues in the concise baselines document and use Git history for detailed legacy reports.

The source of truth for the frontend is `src/` and `web/`; the static `index.html` is also a required resource for the in-app editor. The old UI baseline commit remains `408395e7620fe368775515ca515d04fae7a8daed`.
