/** Effective clip layout shared by the ComfyUI mini-timeline and memory estimates.
 * Must match the projection in src/core.js and director_compile.py. */
export function effectiveClipLayout(clips) {
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


/**
 * Pure display geometry for the OLD one-row clip presentation. Active clips
 * keep their effective time positions; each suspended clip is drawn as a small
 * ghost card occupying visual width only. The paused width never contributes
 * to output video duration, sampler frames, or the loop count.
 *
 * Visual coordinate mapping is invertible for the active time range, including
 * leading/interior/trailing suspensions. The player snaps paused regions to
 * the nearest real time boundary instead of seeking into non-existent frames.
 */
export function previewClipLayout(authoredClips, effective = effectiveClipLayout(authoredClips)) {
  const authored = Array.isArray(authoredClips) ? authoredClips : [];
  const totalFrames = effective.at(-1)?.end ?? 0;
  const suspendedCount = authored.filter(clip => clip?.suspended === true).length;
  const pausedWidth = totalFrames > 0
    ? Math.max(20, Math.min(48, Math.round(totalFrames / Math.max(12, authored.length * 2))))
    : 48;
  const visualFrames = totalFrames + suspendedCount * pausedWidth;
  const entries = [];
  const pauses = [];
  let activeIndex = 0, offset = 0, lastActiveEnd = 0;
  let pendingPaused = [];

  for (const [authoredIndex, clip] of authored.entries()) {
    if (clip?.suspended === true) {
      const start = lastActiveEnd + offset;
      const end = start + pausedWidth;
      const pause = { at: lastActiveEnd, start, end, frames: pausedWidth, beforeActive: false };
      pauses.push(pause);
      pendingPaused.push(pause);
      entries.push({
        clip, authoredIndex, activeIndex: -1, suspended: true,
        visualStart: start, visualEnd: end
      });
      offset += pausedWidth;
      continue;
    }
    const active = effective[activeIndex];
    if (!active) continue;
    for (const pause of pendingPaused) pause.beforeActive = true;
    pendingPaused = [];
    entries.push({
      clip, authoredIndex, activeIndex, suspended: false,
      effectiveStart: active.start, effectiveEnd: active.end,
      visualStart: active.start + offset, visualEnd: active.end + offset
    });
    lastActiveEnd = active.end;
    activeIndex++;
  }

  const realToVisual = frame => {
    const real = Math.max(0, Math.min(totalFrames, Number(frame) || 0));
    let extra = 0;
    for (const pause of pauses) {
      // Pauses after the final generated frame are not part of the playback
      // scale. The end-time playhead stays at the real final clip's end.
      if (!pause.beforeActive || real < pause.at) continue;
      extra += pause.frames;
    }
    return real + extra;
  };
  const visualToReal = frame => {
    const visual = Math.max(0, Math.min(visualFrames, Number(frame) || 0));
    let extra = 0;
    for (const pause of pauses) {
      if (visual < pause.start) break;
      if (visual < pause.end) return pause.at;
      extra += pause.frames;
    }
    return Math.max(0, Math.min(totalFrames, visual - extra));
  };
  const percent = frame => visualFrames > 0 ? frame / visualFrames * 100 : 0;
  return {
    entries, pauses, totalFrames, visualFrames, pausedWidth, suspendedCount,
    realToVisual, visualToReal, percent
  };
}
