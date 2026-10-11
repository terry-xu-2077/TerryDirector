"""Background, non-Queue AI jobs used by the TerryDirector editor.

The llama.cpp call runs on a daemon worker thread. Polling never blocks the
ComfyUI HTTP event loop, and cancelling checks between generated tokens.
"""
from __future__ import annotations

import copy
import threading
import uuid
from dataclasses import dataclass, field
from time import time

from .director_ai import AI_MANAGER, CancelledAI
from .director_ai_core import require_ai_config

MAX_JOBS = 24


@dataclass
class AIJob:
    job_id: str
    ids: list[str]
    status: str = "queued"
    done: int = 0
    total: int = 0
    current: str = ""
    results: list[dict] = field(default_factory=list)
    error: str = ""
    started_at: float = field(default_factory=time)
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict:
        return {
            "job_id": self.job_id,
            "status": self.status,
            "done": self.done,
            "total": self.total,
            "current": self.current,
            "results": copy.deepcopy(self.results),
            "error": self.error,
        }


class AIJobService:
    def __init__(self):
        self._lock = threading.RLock()
        self._jobs: dict[str, AIJob] = {}

    def submit(self, config: dict, document: dict, ids: list[str]) -> str:
        config = require_ai_config(config)
        wanted = set(str(i) for i in ids)
        clips = [c for c in document.get("clips", [])
                 if str(c.get("id")) in wanted
                 and not c.get("suspended")
                 and str(c.get("prompt") or "").strip()]
        if not clips or len(clips) != len(wanted):
            raise ValueError("选中的片段不存在、为空或已挂起")
        with self._lock:
            if AI_MANAGER.busy or any(j.status in {"queued", "running"} for j in self._jobs.values()):
                raise RuntimeError("另一个 AI 增强任务正在运行")
            job_id = uuid.uuid4().hex
            job = AIJob(job_id, [str(c["id"]) for c in clips], total=len(clips))
            self._jobs[job_id] = job
            self._cleanup_jobs()
            worker = threading.Thread(
                target=self._run, args=(job, config, copy.deepcopy(document), clips),
                name=f"TerryDirector-AI-{job_id[:8]}", daemon=True
            )
            worker.start()
            return job_id

    def _cleanup_jobs(self):
        if len(self._jobs) <= MAX_JOBS:
            return
        oldest = sorted(self._jobs.values(), key=lambda j: j.started_at)
        for old in oldest:
            if len(self._jobs) <= MAX_JOBS:
                break
            if old.status not in {"queued", "running"}:
                self._jobs.pop(old.job_id, None)

    def _run(self, job: AIJob, config: dict, document: dict, clips: list[dict]):
        job.status = "running"
        try:
            def on_result(result, done, total):
                with self._lock:
                    job.results.append(result)
                    job.current = str(result["id"])
                    job.done = done
            AI_MANAGER.enhance_batch(
                config, document, clips, on_result=on_result, cancel=job.cancel_event,
            )
            job.status = "cancelled" if job.cancel_event.is_set() else "completed"
        except CancelledAI:
            job.status = "cancelled"
        except Exception as exc:
            job.error = f"{type(exc).__name__}: {exc}"
            job.status = "error"

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(str(job_id))
            return job.snapshot() if job else None

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(str(job_id))
            if not job:
                return False
            if job.status in {"queued", "running"}:
                job.cancel_event.set()
            return True


AI_JOBS = AIJobService()
