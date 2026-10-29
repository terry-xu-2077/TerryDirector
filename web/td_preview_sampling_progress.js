/** Format native ComfyUI sampler progress as tqdm-style text.
 * No log interception, stderr monkeypatching or additional sampler callbacks.
 * Uses real value/max progress from progress_state (ComfyUI 0.39+) or progress.
 * Time estimates are derived from the executing prompt's clock, not parsed
 * from ComfyUI terminal output, which is not forwarded to the browser.
 */
export function isSamplingProgressNode(node) {
  const name=String(node?.class_type||node?.type||"");
  return name==="SamplerCustom" || name==="SamplerCustomAdvanced" ||
    name==="KSampler" || name==="KSamplerAdvanced" ||
    name==="TerryDirectorSelfLiftSampler" ||
    (/sampler/i.test(name) && !/select|scheduler|config|loader/i.test(name));
}
function knownSamplerId(job,id){
  if(id==null)return false;
  const map=job?.api_prompt||{};
  const text=String(id);
  if(isSamplingProgressNode(map[text]))return true;
  // Native expansion can include dotted IDs or copied sampler suffixes.
  const suffix=text.split(".").pop();
  if(isSamplingProgressNode(map[suffix]))return true;
  const match=suffix.match(/^\d+_(\d+)$/);
  return !!(match && isSamplingProgressNode(map[match[1]]));
}
function current(job,id){
  return job?.progressNode && String(job.progressNode)===String(id);
}
export function progressFromEvent(detail,job){
  if(!job || !detail || typeof detail!=="object")return null;
  const max=Number(detail.max);
  const value=Number(detail.value);
  if(!Number.isFinite(value)||!Number.isFinite(max)||max<=1||
     value<0 || value>max)return null;
  const id=String(detail.display_node_id??detail.node??detail.node_id??"");
  // A progress event for an unrelated node must not overwrite sampler steps.
  if(!knownSamplerId(job,id) && !current(job,id))return null;
  return {nodeId:id,value,max};
}
export function progressFromState(detail,job){
  if(!job || !detail || !detail.nodes || typeof detail.nodes!=="object")return null;
  let latest=null;
  for(const node of Object.values(detail.nodes)){
    if(node?.state!=="running")continue;
    const candidate=progressFromEvent({
      value:node.value,max:node.max,
      display_node_id:node.display_node_id ?? node.node_id,
    },job);
    if(candidate && (!latest || candidate.value/candidate.max >= latest.value/latest.max))
      latest=candidate;
  }
  return latest;
}
function clock(seconds){
  if(!Number.isFinite(seconds) || seconds<0)return "--:--";
  const total=Math.floor(seconds);
  const mins=Math.floor(total/60),secs=total%60;
  return mins+":"+String(secs).padStart(2,"0");
}
function bar(fraction){
  const n=Math.max(0,Math.min(10,fraction*10));
  const whole=Math.floor(n);
  const pieces=["","▏","▎","▍","▌","▋","▊","▉"];
  const part=whole<10?Math.floor((n-whole)*8):0;
  return "█".repeat(whole)+(part?pieces[part]:"")+" ".repeat(10-whole-(part?1:0));
}
export function formatSamplingProgress(progress,now=Date.now()){
  if(!progress || !progress.max)return "";
  const value=Math.max(0,Math.min(progress.max,progress.value));
  const fraction=value/progress.max;
  const elapsed=Math.max(0,(now-(progress.startedAt??now))/1000);
  const perStep=value>0?elapsed/value:null;
  const remaining=perStep==null?null:perStep*(progress.max-value);
  const duration=value>0
    ? clock(elapsed)+"<"+clock(remaining)+", "+perStep.toFixed(2)+"s/it"
    : clock(elapsed)+"<?, ?s/it";
  return Math.round(fraction*100)+"%|"+bar(fraction)+"| "+
    value+"/"+progress.max+" ["+duration+"]";
}
export function recordSamplerProgress(job,detail,now=Date.now()){
  if(!job || !detail)return null;
  const value=Number(detail.value),max=Number(detail.max);
  if(!Number.isFinite(value)||!Number.isFinite(max)||max<=1||
     value<0||value>max)return null;
  const nodeId=String(detail.nodeId||"");
  const prev=job.samplingProgress;
  if(prev && prev.nodeId===nodeId && prev.max===max && value<prev.value)
    return null;
  const startedAt=prev && prev.nodeId===nodeId && prev.max===max
    ? prev.startedAt : (job.progressStartedAt || now);
  const next={nodeId,value,max,startedAt,stage:job.mode==="continue"?"high":"low"};
  job.progressNode=nodeId;
  job.samplingProgress=next;
  return next;
}
