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
  function overlaps(clips) {
    return clips.slice(1).flatMap((b, i) => {
      const a = clips[i], range = intersection(a, b);
      return range.frames > 0 ? [{ ...range, a: a.id, b: b.id }] : [];
    });
  }
  function bounds(clips, id, mode) {
    const i = clips.findIndex(c => c.id === id), c = clips[i];
    if (!c) return { min: 0, max: 0 };
    const same = clips.filter(x => x.lane === c.lane && x.id !== id);
    const before = same.filter(x => x.start <= c.start), after = same.filter(x => x.start > c.start);
    const left = before.length ? Math.max(...before.map(x => x.end)) : 0;
    const right = after.length ? Math.min(...after.map(x => x.start)) : Infinity;
    if (mode === 'left') return { min: Math.max(left, i ? clips[i - 1].start + 1 : 0), max: c.end - FPS };
    if (mode === 'right') return { min: c.start + FPS, max: right };
    return {
      min: Math.max(left, i ? clips[i - 1].start + 1 : 0),
      max: Math.min(right - (c.end - c.start), clips[i + 1] ? clips[i + 1].start - 1 : Infinity)
    };
  }
  function editClip(clips, id, mode, frame) {
    const c = clips.find(x => x.id === id);
    if (!c) return clips;
    const b = bounds(clips, id, mode), next = clamp(Math.round(frame), b.min, b.max);
    return clips.map(x => {
      if (x.id !== id) return x;
      if (mode === 'left') return { ...x, start: next };
      if (mode === 'right') return { ...x, end: next };
      return { ...x, start: next, end: next + x.end - x.start };
    });
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
  const api = { FPS, clamp, copy, intersection, overlaps, bounds, editClip, snap, seconds, timecode, History };
  if (typeof module !== 'undefined') module.exports = api;
  global.TDCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
