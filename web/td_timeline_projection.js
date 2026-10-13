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
