/** Per-task controls that override only the compiled API prompt.
 * Does not mutate ComfyUI's live canvas or the saved configured workflow.
 */
export const PREVIEW_DURATION_MIN=4;
export const PREVIEW_DURATION_MAX=20;
export const PREVIEW_DURATION_DEFAULT=15;
export const PREVIEW_RESOLUTION_OPTIONS=[0.4,0.6,0.8,1.0,1.2,1.5,2.0,3.0,4.0];
export const PREVIEW_RESOLUTION_DEFAULT=0.8;

export function taskVideoFrameCount(seconds){
  const n=Number(seconds);
  if(!Number.isInteger(n)||n<PREVIEW_DURATION_MIN||n>PREVIEW_DURATION_MAX)
    throw Error("预演时长须在 4～20 秒之间");
  // Same shared H3 expression as TerryDirector's default example workflow:
  // max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17
  const base=Math.max(5,Math.round(n*24));
  return base+(5-(base%17)+17)%17;
}
export function normalizeTaskResolution(mp){
  const value=Number(mp);
  if(!PREVIEW_RESOLUTION_OPTIONS.includes(value))throw Error("请选择有效的高清分辨率");
  return value;
}
export function taskResolutionInfo(mp, ratioLabel="16:9"){
  const value=normalizeTaskResolution(mp);
  const match=String(ratioLabel).match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  const ratio=match ? Number(match[1])/Number(match[2]) : 16/9;
  const dims=area=>{
    const width=Math.max(32,Math.ceil(Math.sqrt(area*1e6*ratio)/32-1e-12)*32);
    const height=Math.max(32,Math.ceil(Math.sqrt(area*1e6/ratio)/32-1e-12)*32);
    return {width,height};
  };
  return {highMp:value,lowMp:value/4,high:dims(value),low:dims(value/4)};
}
export function taskAspectRatio(apiPrompt, workflow=null){
  const selector=Object.values(apiPrompt||{}).find(n=>n?.class_type==="TerryDirectorDualSamplingResolutionSelector");
  const ratio=selector?.inputs?.aspect_ratio;
  if(typeof ratio==="string")return ratio;
  if(Array.isArray(ratio)){
    const source=apiPrompt?.[String(ratio[0])]?.inputs || {};
    for(const key of ["aspect_ratio","value","text","string"]){
      if(typeof source[key]==="string" && /^\\s*\\d+(?:\\.\\d+)?\\s*:/.test(source[key]))
        return source[key];
    }
  }
  // The preview has to follow the actual selector, not assume 16:9 when a
  // custom ratio arrives over another node (e.g. ComfyUI wireless bus).
  const ui=(workflow?.nodes||[]).find(n=>n.type==="TerryDirectorDualSamplingResolutionSelector");
  const value=ui?.widgets_values_named?.aspect_ratio || ui?.widgets_values?.[0];
  return typeof value==="string" ? value : "16:9 (Widescreen)";
}
export function applyTaskVideoParameters(apiPrompt, settings={}){
  const seconds=Number(settings.duration_seconds??PREVIEW_DURATION_DEFAULT);
  const highMp=normalizeTaskResolution(settings.highres_megapixels??PREVIEW_RESOLUTION_DEFAULT);
  const frames=taskVideoFrameCount(seconds);
  let frameNodes=0, selectors=0;
  for(const node of Object.values(apiPrompt||{})){
    const type=String(node?.class_type||"");
    if(type==="TerryDirectorDualSamplingResolutionSelector" &&
       Object.prototype.hasOwnProperty.call(node.inputs||{},"highres_megapixels")){
      node.inputs.highres_megapixels=highMp; // also drives low-res outputs (MP / 4)
      selectors++;
    }
    if((/^MiniMaxH3.*(?:ToVideo|Latent)/.test(type) || type==="EmptyMiniMaxH3LatentAV") &&
       Object.prototype.hasOwnProperty.call(node.inputs||{},"length")){
      node.inputs.length=frames;
      frameNodes++;
    }
  }
  if(!selectors)throw Error("工作流未找到 TerryDirector 双采样分辨率选择器，无法设置高清/低清");
  if(!frameNodes)throw Error("工作流未找到 H3 时长输入，请检查生成节点");
  return {duration_seconds:seconds,highres_megapixels:highMp,frames};
}
