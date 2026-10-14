# Loop resume and Final rebuild: RTX 3090 acceptance, 2026-10-15

## Scope and result

Tested `feature/loop-resume-final-rebuild` at `49a4536` on the local RTX 3090 (24 GiB), ComfyUI, existing MiniMax H3 and SelfLift workflow. The production code needed no changes. The GPU/API paths for interrupted resume, incompatible signature rejection, isolated B rerun, Final rebuild, stale downstream tracking, context validation, entity context, MP4, memory cleanup and X2 VAE passed. The editor's actual buttons were clicked in a browser harness and emitted the expected queue payloads. A complete click-to-GPU run from the integrated ComfyUI host page remains unverified; see **UI limit** below. This is therefore a qualified acceptance, not a claim of full end-to-end UI acceptance.

The base workflow used the existing H3 INT8 model, Qwen3VL text encoder, H3 audio/video VAE, SelfLift sampler, LoRA, 8-step scheduler, 24 fps, and three 48-frame authored segments. The 0.2 MP latent produced 608×352 MOVs. Only timeline content and the X2 VAE decode/resolution were changed for the intended tests. No third-party node source or model parameter was changed.

## Main recovery and Final evidence

1. Started A/B/C, interrupted after A and B MOVs were saved and before C was saved. Run signature `4878921a90c84f5f91624701e0fabcee`, prompt `7386e61f-428c-4444-a199-bc086b742402`. The interrupted manifest contained A/B only.
2. An exact `resume_previous=true` request, prompt `4991de78-b9b5-4291-acdb-8a5b7a706726`, matched two completed segments, saved only `003...C.mov`, and created the original `Final.mov` in the same run directory. The A/B files retained their hashes and timestamps. Final contains 144 frames and 288,000 samples per channel at 48 kHz (6 seconds).
3. A B-only rerun, prompt `21ed7171-9d13-4cec-835c-6d60d6fff214`, created run signature `d97a8b3f47b74eaf9a99ca24531fccfa`. It generated only a new B MOV, reused old A/C, and wrote a new Final without changing the old B or old Final. The new B hash differs from the old B hash. The new `timeline.json` records `stale_downstream: ["C"]`, correctly identifying that C still depends on old B. It also preserves the original overlap/trim plan; the new Final is 144 frames/288,000 audio samples.
4. FFprobe verified each source MOV as ProRes 422 HQ with 48 frames and 96,000 stereo PCM samples per channel. Packet-by-packet video SHA-256 sequences in the original Final equal A+old B+C; those in the rebuilt Final equal A+new B+C. This confirms ProRes video stream copy without a second video encode. Both Finals have matching 6-second video/audio durations. Evidence: local `media_inspection.json` under `.codex-run/td_clip_acceptance`.

The four incompatible resume requests (prompt text, Seed, reference asset, scheduler step count) were rejected before sampling with a signature mismatch. The reference test used two real input PNG files; it interrupted after A/B, changed the referenced source from `td_resume_ref_a.png` to `td_resume_ref_b.png`, and rejected resume request `5c5a8646-480c-4b1f-91be-31f9e6e924ad`. The original reference run signature was `a049f9aa950947a28ae06f3f34c3ce91`. A subsequent exact-reference resume, prompt `03100068-2d3e-4ef9-8292-e09283796aca`, completed C and Final in that original run directory, confirming the rejected change did not damage the checkpoint.

## Additional GPU cases

| Case | Result | Wall time | Peak system RAM used | Peak process RSS | Peak GPU used |
| --- | --- | ---: | ---: | ---: | ---: |
| Interrupted 0.2 MP A/B/C | A/B saved; C interrupted | 135.47 s | 50.36 GiB | 29.38 GiB | 23.14 GiB |
| Exact resume, C only | Original Final completed | 59.94 s | 50.99 GiB | 29.72 GiB | 24.00 GiB |
| Rerun B, rebuild Final | New B/Final; old files preserved | 59.82 s | 49.95 GiB | 29.33 GiB | 24.00 GiB |
| 0.2 MP latent, X2 VAE, A/B/C | 1216×704 Final, 144 frames, 6 s | 145.76 s | 51.97 GiB | 30.10 GiB | 23.42 GiB |
| 0.5 MP latent, X2 VAE, one clip | 1920×1088 Final, 48 frames, 2 s | 62.20 s | 51.52 GiB | 30.37 GiB | 23.23 GiB |
| Entity A context → generated B | B and 48-frame Final completed | 55.38 s | 51.27 GiB | 29.34 GiB | 22.78 GiB |
| MP4 mode, one clip | H.264/AAC Final, 48 frames, 2 s | 47.74 s | 51.19 GiB | 29.32 GiB | 23.07 GiB |

The X2 VAE cases used the installed `MiniMax-H3-X2-Detail-v1.safetensors` through TerryDirector's low-RAM decode adapter. This exercises actual GPU decode at both resolutions. Each 48-frame clip used one temporal decode window, so multi-window seam behavior is outside this run's coverage. The model/LoRA/sampler settings remained those of the workflow.

Before B/C and after successful X2 Final saving, the log showed temporary body cache decreasing from about 0.55–0.61 GiB to 0.01–0.03 GiB. No `.pt` or `.npz` temporary cache remained in the successful run directories. The peak GPU-used readings are whole-device NVML samples at two-second intervals; `24.00 GiB` is the card's reported capacity rounded to two decimals, not a precise allocation size. RAM-used readings are whole-system readings and include other processes.

Missing predecessor context was rejected before B sampling with a clear “no valid MOV/MP4” error. A deliberately incomplete predecessor MOV (47 actual frames against 48 manifest frames) was rejected as too short. A physical A MOV was accepted as B's context and recorded with `upstream_type=entity`. MP4 mode produced a valid H.264/AAC Final. The loop unit suite passed: 31 tests in 3.505 s.

## UI limit and errors

In the actual editor embedded in a browser test harness, clicking **继续未完成** emitted `resumePrevious:true` for the three clips. Clicking **仅重跑此片段**, then confirming **开始重跑**, emitted `rerunClipId:"B"` and `resumePrevious:false`. Those are genuine DOM button clicks and the editor's real message payloads. The temporary harness was removed after testing. In the ComfyUI host page, the mini-editor overlay did not remain open in the available in-app browser, so a full UI click that queues a GPU job through the host bridge was not demonstrated. The GPU jobs above were queued through ComfyUI's API using the same payload semantics. This is the remaining acceptance gap; its cause is not established from this run, so no speculative source change was made.

The initial reference run reports ComfyUI `error` after the intentional interrupt; its A/B files and manifest were intact. The changed-reference resume reports the expected compatibility error. The missing/incomplete context cases report expected validation errors. No unexpected GPU or encoding failure occurred. ComfyUI's history error text was garbled in one Python-console capture due to locale decoding; PowerShell UTF-8 retrieval showed the original Chinese messages.

## Reproduction records

The live media and `timeline.json` files are in the local ComfyUI output at `TerryDirector/renders/loop-295/<run-signature>`. Per-run diagnostic JSON/Markdown files are in `TerryDirector/reports`; report timestamps range from `20261015_001102` to `20261015_003025`. Input payloads, mismatch/context results, and packet inspection are in the workspace's `.codex-run/td_clip_acceptance` directory. The launcher-managed ComfyUI run ID was `39108-1791994161687-9`.

No merge into `main` was performed.
