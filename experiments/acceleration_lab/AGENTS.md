# Acceleration lab scope

Follow `../../docs/47_ACCELERATION_LAB_TEST.md` and `plan.json`.

The user explicitly requires an independent test node chain before director integration.
All implementation and local-Codex reports belong under this directory. Do not change
root `__init__.py`, `director_*.py` (including trace), server/frontend code, existing
tests, examples, old evidence or production workflow contents. The only new file
outside this directory authorized by this task is `docs/47_ACCELERATION_LAB_TEST.md`.
The frozen production baseline is `0c82cd7bfb2de963304479eda86e02513e106da0`.

Do not queue a director node, DirectorConfig/SecondPassConfig, Advanced or Output in
these experiments. Prefer explicit native nodes. Read-only reuse of the existing
SelfLift sampler/math is allowed. Optional standalone lab nodes must use unique
`TerryAccelLab*` identifiers and be installed only into the experimental instance;
they must never be auto-imported by the production extension. Do not rewrite or
vendor the entire SelfLift/Director implementation. Do not use SelfLiftAvatarH3Sampler.

Build separate UI and API workflow files for B0, B1, V0 and V1. Do not run several
output branches together. Never generate fake prompts/assets or treat illustrative
node IDs as registered code. Keep full private workflows local; commit reproducible
builders and explicitly labelled sanitized templates. Check exact source hashes.

Run isolation checks before and after execution. They are not graph validators.
Do not discard user edits or weaken checks to pass. Do not enable the old global
TerryDirector diagnostic switches for these independent graphs. Run no dependency
upgrades, production service changes, automatic retries or main merge. Do not
promote a working lab result to a production default without user approval.
