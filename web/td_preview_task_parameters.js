/** Per-task controls that override only the compiled API prompt.
 * Does not mutate ComfyUI's live canvas or the saved configured workflow.
 */
export const PREVIEW_DURATION_MIN=4;
export const PREVIEW_DURATION_MAX=20;
export const PREVIEW_DURATION_DEFAULT=15;
export const PREVIEW_RESOLUTION_OPTIONS=[0.4,0.6,0.8,1.0,1.2,1.5,2.0,3.0,4.0];
export const PREVIEW_RESOLUTION_DEFAULT=2.0;

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
      if(typeof source[key]==="string" && source[key].includes(":"))
        return source[key];
    }
  }
  // The preview has to follow the actual selector, not assume 16:9 when a
  // custom ratio arrives over another node (e.g. ComfyUI wireless bus).
  const ui=(workflow?.nodes||[]).find(n=>n.type==="TerryDirectorDualSamplingResolutionSelector");
  const value=ui?.widgets_values_named?.aspect_ratio || ui?.widgets_values?.[0];
  return typeof value==="string" ? value : "16:9 (Widescreen)";
}
const linked=value=>Array.isArray(value)&&value.length===2;
function scopedNodes(api,settings){
  const roots=[settings.pause_target,settings.highres_target].filter(x=>api?.[String(x)]);
  if(!roots.length)return Object.values(api||{});
  const seen=new Set();
  const visit=id=>{
    id=String(id);if(seen.has(id)||!api[id])return;
    seen.add(id);
    for(const value of Object.values(api[id].inputs||{}))if(linked(value))visit(value[0]);
  };
  roots.forEach(visit);return [...seen].map(id=>api[id]);
}
function numericSource(api,node,field,seen=new Set()){
  const value=node?.inputs?.[field];
  if(typeof value==="number")return {node,field,value};
  if(!linked(value)||Number(value[1])!==0||seen.has(String(value[0])))return null;
  seen.add(String(value[0]));const source=api[String(value[0])];
  if(!["PrimitiveInt","PrimitiveFloat","INTConstant","FloatConstant"].includes(source?.class_type))return null;
  const name=["value","int","float"].find(key=>Object.hasOwn(source.inputs||{},key));
  return name?numericSource(api,source,name,seen):null;
}
function durationSource(api,node){
  const direct=numericSource(api,node,"length");
  if(direct)return {...direct,unit:"frames"};
  const ref=node?.inputs?.length;if(!linked(ref))return null;
  const expression=api[String(ref[0])];
  // This is the documented H3 seconds-to-frames expression. Edit its seconds
  // source; keep the expression and its INT output wired to every consumer.
  const formula="max(5,round(a*24))+(5-(max(5,round(a*24))%17))%17";
  if(expression?.class_type!=="ComfyMathExpression"||
     String(expression.inputs?.expression||"").replace(/\s/g,"")!==formula)return null;
  const source=numericSource(api,expression,"values.a");
  return source?{...source,unit:"seconds"}:null;
}
export function workflowTaskVideoParameters(api,settings={}){
  const nodes=scopedNodes(api,settings);
  const frameSources=nodes.filter(n=>/^MiniMaxH3.*(?:ToVideo|Latent)/.test(n?.class_type)||n?.class_type==="EmptyMiniMaxH3LatentAV")
    .map(n=>durationSource(api,n)).map(source=>source?.unit==="seconds"?
      (Number.isInteger(source.value)&&source.value>=PREVIEW_DURATION_MIN&&source.value<=PREVIEW_DURATION_MAX?taskVideoFrameCount(source.value):null):source?.value)
    .filter(Number.isFinite);
  const lengths=[...new Set(frameSources)];
  const seconds=lengths.length===1?Math.round(lengths[0]/24):null;
  const duration=seconds>=PREVIEW_DURATION_MIN&&seconds<=PREVIEW_DURATION_MAX&&taskVideoFrameCount(seconds)===lengths[0]?seconds:null;
  const resolutions=[...new Set(nodes.filter(n=>n?.class_type==="TerryDirectorDualSamplingResolutionSelector")
    .map(n=>numericSource(api,n,"highres_megapixels")?.value).filter(Number.isFinite))];
  return {duration_seconds:duration,
    highres_megapixels:resolutions.length===1&&PREVIEW_RESOLUTION_OPTIONS.includes(resolutions[0])?resolutions[0]:null};
}
export function applyTaskVideoParameters(apiPrompt, settings={}){
  const change=settings.video_parameter_overrides;
  const seconds=Number(settings.duration_seconds??PREVIEW_DURATION_DEFAULT);
  const highMp=normalizeTaskResolution(settings.highres_megapixels??PREVIEW_RESOLUTION_DEFAULT);
  const frames=taskVideoFrameCount(seconds);
  let frameNodes=0, selectors=0;
  const assignments=[];
  for(const node of scopedNodes(apiPrompt,settings)){
    const type=String(node?.class_type||"");
    if(type==="TerryDirectorDualSamplingResolutionSelector" &&
       Object.prototype.hasOwnProperty.call(node.inputs||{},"highres_megapixels") && change?.resolution!==false){
      const source=numericSource(apiPrompt,node,"highres_megapixels");
      if(!source)throw Error("分辨率来自运算节点，请在工作流中调整；预演台不会覆盖原有连线");
      assignments.push({...source,value:highMp});
      selectors++;
    }
    if((/^MiniMaxH3.*(?:ToVideo|Latent)/.test(type) || type==="EmptyMiniMaxH3LatentAV") &&
       Object.prototype.hasOwnProperty.call(node.inputs||{},"length") && change?.duration!==false){
      const source=durationSource(apiPrompt,node);
      if(!source)throw Error("时长来自运算节点，请在工作流中调整；预演台不会覆盖原有连线");
      assignments.push({...source,value:source.unit==="seconds"?seconds:frames});
      frameNodes++;
    }
  }
  if(change?.resolution===true&&!selectors)throw Error("当前工作流未映射分辨率输入，请在工作流中设置");
  if(change?.duration===true&&!frameNodes)throw Error("当前工作流未映射时长输入，请在工作流中设置");
  // Validate all sources before applying any override. Keep every graph edge.
  const seen=new Map();
  for(const {node,field,value} of assignments){
    let fields=seen.get(node);if(!fields){fields=new Map();seen.set(node,fields);}
    if(fields.has(field)&&fields.get(field)!==value)throw Error("时长与分辨率共用同一个输入源，请先在工作流中分开设置");
    fields.set(field,value);
  }
  for(const {node,field,value} of assignments)node.inputs[field]=value;
  return {duration_seconds:seconds,highres_megapixels:highMp,frames};
}
