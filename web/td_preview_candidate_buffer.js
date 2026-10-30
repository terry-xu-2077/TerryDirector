/** Keep a small, bounded window of KJNodes previews in memory.
 *
 * KJ emits an independently encoded fMP4 on each sampling step. A valid MP4
 * header does not guarantee the H.264 NAL units are decodable, so keeping
 * only the newest preview can permanently lose the previous good one.
 *
 * Never write these candidates to disk while sampling. Only one validated
 * candidate will be persisted after execution finishes.
 */
export const MAX_PREVIEW_CANDIDATES = 4;
export const MAX_PREVIEW_CANDIDATE_BASE64_CHARS = 96 * 1024 * 1024;

export function rememberSamplingPreview(job, preview) {
  if (!job || !preview || typeof preview.image !== "string" ||
      !preview.image || !["video/mp4","image/webp","image/jpeg"].includes(preview.mime))
    return false;
  const step=Number(preview.step);
  if (!Number.isInteger(step) || step < 1)return false;
  const current=Number(job.preview?.step)||0;
  if (step<current)return false;
  const next={image:preview.image,mime:preview.mime,step,
    total:Number(preview.total)||null};
  const history=Array.isArray(job.previewCandidates) ? job.previewCandidates : [];
  const candidates=history.filter(p=>p.step!==step);
  candidates.push(next);
  let size=candidates.reduce((sum,p)=>sum+p.image.length,0);
  while(candidates.length>1 &&
        (candidates.length>MAX_PREVIEW_CANDIDATES ||
         size>MAX_PREVIEW_CANDIDATE_BASE64_CHARS)){
    // Pin the first successfully received step as an emergency fallback:
    // later KJ H.264 packets can all be broken even when the first worked.
    // Prefer evicting older intermediate steps; keep the newest step.
    // Under a tight byte limit with only two clips, evict the first.
    const index=candidates.length>2?1:0;
    size-=candidates[index].image.length;
    candidates.splice(index,1);
  }
  job.previewCandidates=candidates;
  job.preview=next;
  return true;
}

export function finalSamplingCandidates(job) {
  if (!job)return [];
  const candidates=Array.isArray(job.previewCandidates)
    ? job.previewCandidates.slice() : [];
  if (job.preview?.image && !candidates.some(p=>p.step===job.preview.step))
    candidates.push(job.preview);
  return candidates.filter(p=>p?.image && p?.mime)
    .sort((a,b)=>b.step-a.step);
}

export function previewFallbackWarning(saved, candidates) {
  if(!saved || !candidates?.length)return null;
  const latest=candidates[0];
  if(saved.step>=latest.step)return null;
  return "最后一轮 TAEH3 视频编码异常，已回退保存第 "+
    saved.step+" / "+(latest.total||latest.step)+" 步的可播放预览";
}
