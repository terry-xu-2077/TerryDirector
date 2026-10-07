/* Pure frame arithmetic; shared by the UI, drag preview and command history.
 * All ranges are [start, end), integer frames. An overlap has no stored model,
 * selection ID, editing command or hit target. */
(function (global) {
  'use strict';
  const FPS = 24;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const copy = value => JSON.parse(JSON.stringify(value));
  function intersection(a, b) {
    const start = Math.max(a.start, b.start);
    const end = Math.min(a.end, b.end);
    return { start, end: Math.max(start, end), frames: Math.max(0, end - start) };
  }
  function seams(clips) {
    return clips.slice(1).map((b, i) => {
      const a = clips[i];
      const delta = b.start - a.end;
      if (delta < 0) {
        return {
          kind: 'overlap',
          start: b.start,
          end: a.end,
          frames: -delta,
          a: a.id,
          b: b.id,
        };
      }
      if (delta === 0) {
        return {
          kind: 'touch',
          frame: b.start,
          frames: 0,
          a: a.id,
          b: b.id,
        };
      }
      return {
        kind: 'gap',
        start: a.end,
        end: b.start,
        frames: delta,
        a: a.id,
        b: b.id,
      };
    });
  }
  function overlaps(clips) {
    return seams(clips).filter(seam => seam.kind === 'overlap');
  }
  function h3AlignedFrames(frames) {
    const n = Math.max(5, Math.ceil(Number(frames) || 0));
    return n + (5 - (n % 17) + 17) % 17;
  }
  // Actual arranged duration starts at timeline zero; viewport padding is not content.
  const arrangementFrames = clips => clips.reduce((end, clip) => Math.max(end, clip.end), 0);
  function bounds(clips, id, mode) {
    const i = clips.findIndex(c => c.id === id), c = clips[i];
    if (!c) return { min: 0, max: 0 };
    const prev = clips[i - 1], next = clips[i + 1];
    const prev2 = clips[i - 2], next2 = clips[i + 2];
    const duration = c.end - c.start;
    // One visual row, chronological order, at most two overlapping clips.
    // Adjacent clips may overlap; non-adjacent clips may only touch.
    // Keep each clip's head/tail exposed rather than hiding a whole clip.
    const left = Math.max(0, prev ? prev.start + 1 : 0, prev2 ? prev2.end : 0);
    const right = Math.min(next ? next.end - 1 : Infinity, next2 ? next2.start : Infinity);
    let range;
    if (mode === 'left') range = { min: left, max: Math.min(c.end - FPS, next ? next.start - 1 : Infinity) };
    else if (mode === 'right') range = { min: Math.max(c.start + FPS, prev ? prev.end + 1 : 0), max: right };
    else range = {
      min: Math.max(left, prev ? prev.end - duration + 1 : 0),
      max: Math.min(right - duration, next ? next.start - 1 : Infinity)
    };
    const unchanged = mode === 'right' ? c.end : c.start;
    return range.min > range.max ? { min: unchanged, max: unchanged } : range;
  }
  function editClip(clips, id, mode, frame) {
    const c = clips.find(x => x.id === id);
    if (!c || !Number.isFinite(frame)) return clips;
    const b = bounds(clips, id, mode), next = clamp(Math.round(frame), b.min, b.max);
    return clips.map(x => {
      if (x.id !== id) return x;
      if (mode === 'left') return { ...x, start: next };
      if (mode === 'right') return { ...x, end: next };
      return { ...x, start: next, end: next + x.end - x.start };
    });
  }
  function moveFollowing(clips, id, frame) {
    const index = clips.findIndex(c => c.id === id), head = clips[index];
    if (!head || !Number.isFinite(frame)) return clips;
    const prev = clips[index - 1], prev2 = clips[index - 2], next = clips[index + 1];
    const duration = head.end - head.start;
    // The moving suffix keeps all internal gaps and overlaps. Only its boundary
    // with the fixed prefix can change; do not clamp against its own followers.
    const min = Math.max(0,
      prev ? prev.start + 1 : 0,
      prev ? prev.end - duration + 1 : 0,
      prev2 ? prev2.end : 0,
      prev && next ? prev.end - (next.start - head.start) : 0);
    const delta = Math.max(min, Math.round(frame)) - head.start;
    if (!delta) return clips;
    return clips.map((clip, i) => i < index ? clip : {
      ...clip, start: clip.start + delta, end: clip.end + delta
    });
  }
  function trimEndFollowing(clips, id, frame) {
    const index = clips.findIndex(c => c.id === id), head = clips[index];
    if (!head || !Number.isFinite(frame)) return clips;
    const prev = clips[index - 1], next = clips[index + 1];
    // The head's start stays fixed; only its end and the entire suffix move.
    // Keep the head/next seam unchanged, including an existing overlap or gap.
    // When shortening, do not swallow the head or overlap the fixed predecessor
    // with the first follower. Clamp once, then apply the ACTUAL delta to all.
    const min = Math.max(head.start + FPS,
      prev ? prev.end + 1 : 0,
      next ? head.end + head.start - next.start + 1 : 0,
      prev && next ? head.end + prev.end - next.start : 0);
    const end = Math.max(min, Math.round(frame)), delta = end - head.end;
    if (!delta) return clips;
    return clips.map((clip, i) => i < index ? clip : i === index
      ? { ...clip, end }
      : { ...clip, start: clip.start + delta, end: clip.end + delta });
  }
  function snap(value, offsets, targets, threshold) {
    let best = { value, target: null, distance: threshold + 1 };
    for (const offset of offsets) for (const target of targets) {
      const d = Math.abs(value + offset - target);
      if (d <= threshold && d < best.distance) best = { value: target - offset, target, distance: d };
    }
    return best;
  }
  const seconds = frames => `${(frames / FPS).toFixed(2)} 秒`;
  const timecode = frames => {
    const n = Math.max(0, Math.floor(frames)), s = Math.floor(n / FPS);
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, n % FPS].map(x => String(x).padStart(2, '0')).join(':');
  };
  class History {
    constructor(limit = 60) { this.undoItems = []; this.redoItems = []; this.limit = limit; }
    push(before, after) {
      if (JSON.stringify(before) === JSON.stringify(after)) return false;
      this.undoItems.push(copy(before)); this.undoItems = this.undoItems.slice(-this.limit); this.redoItems = []; return true;
    }
    undo(current) { if (!this.undoItems.length) return null; this.redoItems.push(copy(current)); return this.undoItems.pop(); }
    redo(current) { if (!this.redoItems.length) return null; this.undoItems.push(copy(current)); return this.redoItems.pop(); }
  }
  const api = { FPS, clamp, copy, intersection, seams, overlaps, h3AlignedFrames, arrangementFrames, bounds, editClip, moveFollowing, trimEndFollowing, snap, seconds, timecode, History };
  if (typeof module !== 'undefined') module.exports = api;
  global.TDCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
