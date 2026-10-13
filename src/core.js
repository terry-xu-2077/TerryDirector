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
    const active = clips.filter(clip => !clip.suspended);
    return active.slice(1).map((b, i) => {
      const a = active[i];
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
  function effectiveClipLayout(clips) {
      // Mirror director_compile.compile_timeline's suspended-segment projection.
      // A suspended clip disappears from execution; the next active clip joins
      // the previous active tail. Intentional gaps/overlaps between consecutive
      // ACTIVE clips are preserved. No original clip positions are mutated.
      const effective = [];
      let previousOriginalEnd = null;
      let previousEffectiveEnd = 0;
      let suspendedSinceActive = false;
      for (const clip of Array.isArray(clips) ? clips : []) {
        if (clip?.suspended === true) {
          suspendedSinceActive = true;
          continue;
        }
        const originalStart = Math.max(0, Math.trunc(Number(clip?.start) || 0));
        const originalEnd = Math.max(originalStart + 1, Math.trunc(Number(clip?.end) || originalStart + 1));
        const effectiveStart = previousOriginalEnd === null
          ? (suspendedSinceActive ? 0 : originalStart)
          : suspendedSinceActive ? previousEffectiveEnd
            : previousEffectiveEnd + originalStart - previousOriginalEnd;
        const effectiveEnd = effectiveStart + originalEnd - originalStart;
        effective.push({ ...clip, start: effectiveStart, end: effectiveEnd });
        previousOriginalEnd = originalEnd;
        previousEffectiveEnd = effectiveEnd;
        suspendedSinceActive = false;
      }
      return effective;
    }
  // Actual arranged duration starts at timeline zero; viewport padding is not content.
  const arrangementFrames = clips => clips.reduce((end, clip) => Math.max(end, clip.end), 0);
  // List order is also generation order. Keep each clip's ID and metadata intact
  // while ordering by its head frame. At frame zero, the moved clip wins a tie.
  function orderClips(clips, movingId = null) {
    return clips.map((clip, index) => ({ clip, index })).sort((a, b) => {
      const delta = a.clip.start - b.clip.start;
      if (delta) return delta;
      if (movingId && a.clip.start === 0) {
        if (a.clip.id === movingId) return -1;
        if (b.clip.id === movingId) return 1;
      }
      return a.index - b.index;
    }).map(item => item.clip);
  }
  // Ripple-insert at the playhead without trimming or splitting authored clips.
  // A clip crossing the playhead joins the shifted suffix. Preserve every
  // shifted clip's duration, metadata, and existing intra-suffix seam.
  function insertClipAtFrame(clips, clip, frame) {
    if (!clip || !Number.isFinite(frame)) return clips;
    const start = Math.max(0, Math.round(frame));
    const duration = Math.max(1, Math.round(clip.end - clip.start));
    const ordered = orderClips(clips);
    const firstShifted = ordered.findIndex(existing => existing.end > start);
    const inserted = { ...clip, start, end: start + duration };
    if (firstShifted < 0) return [...ordered, inserted];
    const suffix = ordered.slice(firstShifted);
    // Spend any available blank interval first. Only the shortage moves the
    // suffix; a clip already covering the playhead moves entirely beyond it.
    const delta = Math.max(0, inserted.end - suffix[0].start);
    return [...ordered.slice(0, firstShifted), inserted,
      ...suffix.map(existing => ({
        ...existing, start: existing.start + delta, end: existing.end + delta
      }))];
  }
  // Drag sorting uses the original heads as insertion slots; the new order
  // inherits those slots. Nudge later heads only when the swapped durations
  // would violate H3's chronological or two-way-overlap invariants.
  function reorderClips(clips, id, targetIndex) {
    const from = clips.findIndex(c => c.id === id);
    if (from < 0 || clips.length < 2 || !Number.isFinite(targetIndex)) return clips;
    const to = clamp(Math.trunc(targetIndex), 0, clips.length - 1);
    if (from === to) return clips;
    const slots = clips.map(c => c.start), ordered = clips.slice();
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    const arranged = [];
    for (let i = 0; i < ordered.length; i++) {
      const clip = ordered[i], duration = clip.end - clip.start;
      const prev = arranged[i - 1], prev2 = arranged[i - 2];
      const start = Math.max(slots[i], prev ? prev.start + 1 : 0,
        prev ? prev.end - duration + 1 : 0, prev2 ? prev2.end : 0);
      arranged.push({ ...clip, start, end: start + duration });
    }
    return arranged;
  }
  // Reorder around a fixed mouse release frame. The dragged clip is NEVER
  // moved to a preset slot. Other clips yield left/right while remaining whole.
  // Existing intentional overlaps with the dragged clip may be retained, but
  // a newly adjacent clip may not overlap it.
  function reorderClipsAtFrame(clips, id, targetIndex, frame) {
    const from=clips.findIndex(c=>c.id===id);
    if(from<0||!Number.isFinite(frame)||!Number.isFinite(targetIndex))return clips;
    const anchor=Math.max(0,Math.round(frame));
    const requested=clamp(Math.trunc(targetIndex),0,clips.length-1);
    if(from===requested&&anchor===clips[from].start)return clips;
    const allowedOverlap=(a,b)=>{
      const index=clips.findIndex(c=>c.id===a.id);
      return index>=0&&clips[index+1]?.id===b.id
        ? Math.max(0,clips[index].end-clips[index+1].start) : 0;
    };
    // A short drop cannot always fit after a longer clip at timeline zero.
    // In that case move the existing clip to the right of the drop, never
    // move the dragged clip itself.
    for(let index=requested;index>=0;index--){
      const arranged=reorderClips(clips,id,index).map(c=>({...c}));
      const moving=arranged[index],duration=moving.end-moving.start;
      moving.start=anchor;moving.end=anchor+duration;
      if(index>0){
        const prev=arranged[index-1],prev2=arranged[index-2];
        const shift=Math.min(0,
          anchor+allowedOverlap(prev,moving)-prev.end,
          moving.end-1-prev.end,
          anchor-1-prev.start,
          prev2?anchor-prev2.end:0);
        if(arranged[0].start+shift<0)continue;
        // Move the prefix together so its authored seams survive unchanged.
        for(let i=0;i<index;i++){
          arranged[i].start+=shift;arranged[i].end+=shift;
        }
      }
      if(index<arranged.length-1){
        const next=arranged[index+1],next2=arranged[index+2];
        const prev=arranged[index-1];
        const shift=Math.max(0,
          moving.end-allowedOverlap(moving,next)-next.start,
          moving.start+1-next.start,
          moving.end+1-next.end,
          prev?prev.end-next.start:0,
          next2?moving.end-next2.start:0);
        // Move the suffix together; don't alter its internal spacing.
        for(let i=index+1;i<arranged.length;i++){
          arranged[i].start+=shift;arranged[i].end+=shift;
        }
      }
      return arranged;
    }
    return clips;
  }
  // Head crossing changes the rank. A later clip can take the first slot
  // at frame zero even though negative timeline positions are impossible.
  function reorderIndex(clips, id, frame) {
    if (!Number.isFinite(frame)) return -1;
    const from = clips.findIndex(c => c.id === id);
    if (from < 0) return -1;
    let rank = 0;
    clips.forEach((clip, index) => {
      if (index === from) return;
      if (frame > clip.start || (frame === clip.start && frame !== 0 && from > index)) rank++;
    });
    return rank;
  }
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
  const api = { FPS, clamp, copy, intersection, seams, overlaps, h3AlignedFrames, arrangementFrames, effectiveClipLayout, orderClips, insertClipAtFrame, reorderClips, reorderClipsAtFrame, reorderIndex, bounds, editClip, moveFollowing, trimEndFollowing, snap, seconds, timecode, History };
  if (typeof module !== 'undefined') module.exports = api;
  global.TDCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
