"""Loop RAM measurements and scoped eviction of completed body results."""

from __future__ import annotations

import os

import psutil
import torch


def _cached_cpu_bytes(cache):
    seen_objects = set()
    seen_storages = set()
    total = 0

    def visit(value):
        nonlocal total
        identity = id(value)
        if identity in seen_objects:
            return
        seen_objects.add(identity)
        if isinstance(value, torch.Tensor):
            if value.device.type == "cpu":
                try:
                    storage = value.untyped_storage()
                    key = (storage.data_ptr(), storage.nbytes())
                    if key not in seen_storages:
                        seen_storages.add(key)
                        total += storage.nbytes()
                except (RuntimeError, NotImplementedError):
                    pass
        elif isinstance(value, dict):
            for member in value.values():
                visit(member)
        elif isinstance(value, (list, tuple)):
            for member in value:
                visit(member)
        elif hasattr(value, "outputs"):
            visit(value.outputs)

    def walk(part):
        for value in getattr(part, "cache", {}).values():
            visit(value)
        for child in getattr(part, "subcaches", {}).values():
            walk(child)

    if cache is not None:
        walk(cache)
    return total


def log_loop_ram(stage, segment_id, execution_list=None, cache_path=None):
    process = psutil.Process(os.getpid())
    rss = process.memory_info().rss
    available = psutil.virtual_memory().available
    output_cache = getattr(execution_list, "output_cache", None)
    cache_bytes = _cached_cpu_bytes(output_cache)
    disk_bytes = 0
    if cache_path and os.path.isfile(cache_path):
        disk_bytes = os.path.getsize(cache_path)
    print(
        f"[TerryDirector RAM] {stage} clip={segment_id} "
        f"rss={rss / 2**30:.2f}GiB available={available / 2**30:.2f}GiB "
        f"node_cache_cpu={cache_bytes / 2**30:.2f}GiB "
        f"segment_disk={disk_bytes / 2**20:.1f}MiB",
        flush=True,
    )


def release_completed_body(execution_list, node_ids):
    """Drop only prior iteration copies after their dependencies have finished.

    ComfyUI 0.39 retains each copied node's CacheEntry for the entire prompt.
    The next LoopInfo runs after the prior LoopCache and optional output branch,
    so no later iteration consumes these copied body outputs. Keep LoopCache's
    descriptor and continuity outputs for LoopResult and the next iteration.
    """
    if not node_ids or execution_list is None:
        return 0
    output_cache = getattr(execution_list, "output_cache", None)
    if output_cache is None:
        return 0
    pending = getattr(execution_list, "pendingNodes", {})
    completed = set(node_ids) - set(pending)
    removed = 0
    for node_id in completed:
        # Classic uses hierarchical data caches; RAM_PRESSURE/LRU keep the
        # entries in a flat cache even though they track loop subgraphs.
        part = (output_cache._get_cache_for(node_id)
                if hasattr(output_cache, "_get_cache_for") else output_cache)
        if part is None:
            continue
        key = part.cache_key_set.get_data_key(node_id)
        if key is not None and key in part.cache:
            del part.cache[key]
            removed += 1
    # ExecutionList has a second set of strong references to input CacheEntry
    # objects. Only finished consumers can be released here.
    for consumer_id, links in list(execution_list.execution_cache.items()):
        if consumer_id not in pending:
            for node_id in completed:
                links.pop(node_id, None)
            if not links:
                del execution_list.execution_cache[consumer_id]
    return removed
