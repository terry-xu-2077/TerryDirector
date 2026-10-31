import { applyTaskVideoParameters } from "./td_preview_task_parameters.js";
/**
 * Pure Preview Stage pipeline compiler.
 * A configured UI workflow and its ComfyUI API prompt are snapshots. Each
 * task gets a cloned API prompt with only its owned inputs/outputs substituted.
 * No graph.configure, canvas widgets, tabs or rgthree source objects are touched.
 */
export const RGTHREE_MAX_SEED = 1125899906842624; // rgthree Seed backend, 2^50
const OUTPUT_TYPES = new Set(["SaveVideo","VHS_VideoCombine","TerryDirectorLowresReviewSave"]);
const VIDEO_TYPES = new Set(["SaveVideo","VHS_VideoCombine"]);
const PAUSE_TYPE = "TerryDirectorSelfLiftPauseResume";

const RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export function sanitizeTaskFilename(value) {
  let name=String(value ?? "").normalize("NFC").trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,"_")
    .replace(/[：／＼｜？＊]/g,"_")
    .replace(/\s+/g,"_")
    .replace(/_+/g,"_")
    .replace(/^[_ .]+|[_ .]+$/g,"")
    .slice(0,100).replace(/[_ .]+$/g,"");
  if(RESERVED_FILENAME.test(name))name="_"+name;
  return name || "TerryDirector";
}

const id = value => String(value);
const isLink = value => Array.isArray(value) && value.length === 2 &&
  (typeof value[0] === "string" || typeof value[0] === "number") &&
  Number.isInteger(Number(value[1]));
const clone = obj => structuredClone(obj);
const uiNodes = workflow => new Map((workflow?.nodes || []).map(node => [id(node.id),node]));
const apiNode = (api,nodeId) => api[id(nodeId)];

const isSeedField = name => /^(seed|noise_seed|random_seed|sampling_seed)$/i.test(String(name));
const num = x => typeof x === "number" && Number.isSafeInteger(x) ? x : null;
const constrained = (bounds,lim) => {
  if(num(lim?.min)!==null)bounds.min=Math.max(bounds.min,lim.min);
  if(num(lim?.max)!==null)bounds.max=Math.min(bounds.max,lim.max);
};
const rangeFromDef = (defs,apiNodeType,inputName) => {
  const definition=defs?.[apiNodeType]?.input || {};
  const tuple=definition.required?.[inputName] || definition.optional?.[inputName];
  return Array.isArray(tuple) && tuple[1] && typeof tuple[1] === "object"
    ? {min:num(tuple[1].min),max:num(tuple[1].max)} : null;
};

/**
 * Find all seed consumers in this workflow, including ComfyUI samplers and the
 * paused SelfLift node. The source rgthree Seed value is not modified; only
 * the submitted API prompt receives the selected task's seed override.
 */
export function resolvePreviewSeedBounds(workflow,binding,apiPrompt={},nodeDefinitions={},
                                          runtimeNode=null) {
  const nodes=uiNodes(workflow);
  const source=nodes.get(id(binding?.node_id));
  if(!source)throw Error("种子源节点不存在");
  const sourceType=String(apiPrompt[id(source.id)]?.class_type || source.type || "");
  const bound={min:0,max:Number.MAX_SAFE_INTEGER};
  const seedFields=[];
  const constrainField=(nodeId,type,name,live) => {
    const schema=rangeFromDef(nodeDefinitions,type,name);
    if(schema)constrained(bound,schema);
    const widget=live?.widgets?.find(w=>w.name===name);
    if(widget)constrained(bound,{
      min:num(widget.options?.min),max:num(widget.options?.max),
    });
    if(/rgthree.*seed|seed.*rgthree/i.test(type) || type==="SeedNode")
      bound.max=Math.min(bound.max,RGTHREE_MAX_SEED);
    seedFields.push({node_id:id(nodeId),class_type:type,input:name,range:schema || null});
  };
  constrainField(source.id,sourceType,binding.widget_name,runtimeNode);
  // Follow explicit ComfyUI edges *and* well-defined virtual routing.
  // TerryXu WirelessBus and Set/Get use matching channels rather than
  // ordinary graph links, so a plain BFS over node IDs misses both consumers.
  const links=workflow.links||[];
  const list=[...nodes.values()];
  const nodeChannel=n=>n.properties?.terry_wireless_bus_channel ||
    n.widgets_values_named?.["名称"] || n.widgets_values_named?.["选择总线"] ||
    (Array.isArray(n.widgets_values)?n.widgets_values[0]:null);
  const setGetKey=n=>n.widgets_values_named?.Constant ||
    (Array.isArray(n.widgets_values)?n.widgets_values[0]:null) ||
    n.title?.replace(/^(Set|Get)_/,"");
  const pending=[],visited=new Set();
  const addOutputs=node=>{
    (node?.outputs||[]).forEach((_,slot)=>pending.push({nodeId:id(node.id),slot}));
  };
  addOutputs(source);
  while(pending.length){
    const {nodeId,slot}=pending.shift();
    const key=nodeId+":"+slot;
    if(visited.has(key))continue;
    visited.add(key);
    for(const link of links){
      if(id(link[1])!==nodeId || Number(link[2])!==slot)continue;
      const dest=nodes.get(id(link[3]));
      if(!dest)continue;
      const input=dest.inputs?.[link[4]];
      if(!input)continue;
      const type=String(apiPrompt[id(dest.id)]?.class_type || dest.type || "");
      // Wireless bus lanes can be named "SEED" but are not sampler seed
      // consumers. Resolve virtual routing before enforcing numeric limits.
      if(dest.type==="SetNode"){
        const channel=setGetKey(dest);
        if(channel){
          for(const candidate of list){
            if(candidate.type==="GetNode" && setGetKey(candidate)===channel)
              addOutputs(candidate);
          }
        }
        continue;
      }
      if(dest.type==="TerryXuWirelessBusPack"){
        const busName=nodeChannel(dest);
        const lane=dest.properties?.terry_wire_bus_lanes?.[link[4]];
        for(const receiver of list){
          if(receiver.type!=="TerryXuWirelessBusUnpack" || nodeChannel(receiver)!==busName)
            continue;
          const laneSlot=lane?.id
            ? receiver.properties?.terry_wire_bus_lane_ids?.indexOf(lane.id)
            : receiver.outputs?.findIndex(x=>x.name===input.name);
          if(laneSlot>=0 && receiver.outputs?.[laneSlot])
            pending.push({nodeId:id(receiver.id),slot:laneSlot});
        }
        continue;
      }
      if(isSeedField(input.name) && /sampler|selflift|seednode/i.test(type)) {
        constrainField(dest.id,type,input.name,null);
        continue;
      }
      if(!/sampler|selflift/i.test(type))addOutputs(dest);
    }
  }
  if(!seedFields.some(field=>/sampler/i.test(field.class_type))) {
    throw Error("配置的种子源没有连接 ComfyUI 采样器的 seed/noise_seed 输入，请先修正工作流连线");
  }
  if(bound.max<bound.min)
    throw Error("种子源和采样器的有效范围不相交，无法创建预演任务");
  return {...bound,consumers:seedFields};
}

function outgoing(workflow, api, startNode, startSlot, {stopAtPause=false}={}) {
  const nodes=uiNodes(workflow);
  const links = new Map((workflow.links || []).map(link => [id(link[0]),link]));
  const queue=[{nodeId:id(startNode),slot:Number(startSlot)}];
  const visited=new Set(), terminals=[];
  while(queue.length) {
    const entry=queue.shift(), key=entry.nodeId+":"+entry.slot;
    if(visited.has(key))continue;
    visited.add(key);
    const ui = nodes.get(entry.nodeId);
    const outputs=ui?.outputs || [];
    for(const linkId of outputs[entry.slot]?.links || []) {
      const link=links.get(id(linkId));
      if(!link || id(link[1])!==entry.nodeId || Number(link[2])!==entry.slot)continue;
      const nextId=id(link[3]), target=nodes.get(nextId);
      if(!target)continue;
      const type=String(apiNode(api,nextId)?.class_type || target.type);
      if(stopAtPause && type===PAUSE_TYPE)continue;
      if(OUTPUT_TYPES.has(type)) {
        if(apiNode(api,nextId))terminals.push({id:nextId,type});
        continue;
      }
      // Never cross the pause boundary while looking for a low-stage saver.
      if(type===PAUSE_TYPE)continue;
      for(let i=0;i<(target.outputs||[]).length;i++){
        if((target.outputs[i]?.links || []).length)queue.push({nodeId:nextId,slot:i});
      }
    }
  }
  return [...new Map(terminals.map(t=>[t.id,t])).values()];
}
/** Identify the user's actual low-res VAE branch, not just a TerryDirector
 * saver. In a normal H3 graph, sampler.denoised_output fans out to the pause
 * checkpoint and to VAEDecode/VAEDecodeAudio -> VHS_VideoCombine.
 *
 * An existing VHS node is an *output template*: when running a VAE review, we
 * replace that node in the cloned API prompt with TerryDirectorLowresReviewSave
 * (same ID, no canvas edits). This writes review.mp4 into the checkpoint.
 */
export function detectLowresReviewSink(workflow, api, pauseNodeId) {
  const nodes=uiNodes(workflow), pause=nodes.get(id(pauseNodeId));
  const clean=pause?.inputs?.find(x=>x.name==="low_clean");
  const links=new Map((workflow?.links||[]).map(l=>[id(l[0]),l]));
  const origin=links.get(id(clean?.link));
  if(!origin)return null;
  const rootId=id(origin[1]),rootSlot=Number(origin[2]);
  // Runtime API links are authoritative. The UI-link fallback permits a
  // useful detection message before the imported workflow is compiled.
  const incoming=(nodeId,name)=>{
    const runtime=apiNode(api,nodeId)?.inputs?.[name];
    if(isLink(runtime))return runtime;
    const node=nodes.get(id(nodeId));
    const linkId=node?.inputs?.find(i=>i.name===name)?.link;
    const link=links.get(id(linkId));
    return link?[id(link[1]),Number(link[2])]:null;
  };
  const dependsOnClean=(ref, decoderType, decoded=false, seen=new Set())=>{
    if(!isLink(ref))return false;
    const nodeId=id(ref[0]),slot=Number(ref[1]);
    if(nodeId===rootId && slot===rootSlot)return decoded;
    const node=nodes.get(nodeId);
    const type=apiNode(api,nodeId)?.class_type||node?.type;
    if(!type || type===PAUSE_TYPE || seen.has(nodeId))return false;
    const nextSeen=new Set(seen);nextSeen.add(nodeId);
    const hasDecoder=decoded || type===decoderType;
    const inputNames=new Set([
      ...Object.keys(apiNode(api,nodeId)?.inputs||{}),
      ...(node?.inputs||[]).map(input=>input.name),
    ]);
    return [...inputNames].some(name=>dependsOnClean(
      incoming(nodeId,name),decoderType,hasDecoder,nextSeen));
  };
  // Before configuration compilation, the imported graph has no API prompt
  // yet. Use its node types for discovery; execution-time validation still
  // uses the real compiled prompt.
  const scanApi=Object.keys(api||{}).length?api:Object.fromEntries(
    [...nodes].map(([nodeId,node])=>[nodeId,{class_type:node.type,inputs:{}}]));
  const candidates=outgoing(workflow,scanApi,rootId,rootSlot,{stopAtPause:true});
  const dedicated=candidates.filter(x=>x.type==="TerryDirectorLowresReviewSave");
  if(dedicated.length>1)throw Error("检测到多个低清审片保存节点，请保留一条低清保存支路");
  if(dedicated.length)return dedicated[0];
  const vhs=candidates.filter(x=>x.type==="VHS_VideoCombine" &&
    dependsOnClean(incoming(x.id,"images"),"VAEDecode") &&
    dependsOnClean(incoming(x.id,"audio"),"VAEDecodeAudio"));
  if(vhs.length>1)throw Error("检测到多条低清 VAE 视频输出，请保留一条低清审片支路");
  return vhs[0]||null;
}
export function compilePreviewTargets(workflow, api, pauseNodeId) {
  const nodes=uiNodes(workflow), pause=nodes.get(id(pauseNodeId));
  if(!pause || apiNode(api,pauseNodeId)?.class_type !== PAUSE_TYPE)
    throw Error("工作流未连接有效的 SelfLift 暂停节点");
  const highres=outgoing(workflow,api,pauseNodeId,0).filter(x=>VIDEO_TYPES.has(x.type));
  if(highres.length!==1) throw Error("高清线路必须恰好连接一个视频保存终点");
  const decoded=detectLowresReviewSink(workflow,api,pauseNodeId);
  return {pause_target:id(pauseNodeId),highres_target:highres[0].id,
    decoded_target:decoded?.id || null};
}
export function applyPreviewInputs(api, overrides) {
  const mediaPatches=[];
  for(const patch of overrides||[]) {
    if(patch?.role==="h3_media"){
      mediaPatches.push(patch);
      continue;
    }
    const node=apiNode(api,patch.node_id),name=patch.widget_name;
    if(!node || typeof name!=="string" ||
       !Object.prototype.hasOwnProperty.call(node.inputs||{},name))
      throw Error("配置的输入节点不存在："+patch.node_id+"."+name+"，请重新配置预演工作流");
    const directH3Prompt=patch.role==="h3_prompt" &&
      node.class_type==="MiniMaxH3ReferenceToVideo" && name==="prompt";
    if(isLink(node.inputs[name]) && !directH3Prompt)
      throw Error("不能覆盖连线终点："+patch.node_id+"."+name+"，请选择上游输入源节点");
    if(typeof patch.value!=="string" && typeof patch.value!=="number")
      throw Error("输入值必须是文本或数字："+name);
    node.inputs[name]=patch.value;
  }
  return mediaPatches;
}

const H3_MEDIA_INPUT=/^(?:ref_images\.ref_image_\d+|ref_videos\.ref_video_\d+|ref_video_audios\.ref_video_audio_\d+|ref_audios\.ref_audio_\d+)$/;
const H3_MEDIA_INPUT_LIMITS=[
  [/^ref_images\.ref_image_(\d+)$/,9],
  [/^ref_videos\.ref_video_(\d+)$/,3],
  [/^ref_video_audios\.ref_video_audio_(\d+)$/,3],
  [/^ref_audios\.ref_audio_(\d+)$/,3],
];
function isSupportedH3MediaInput(name) {
  for(const [pattern,limit] of H3_MEDIA_INPUT_LIMITS){
    const match=String(name||"").match(pattern);
    if(match)return Number(match[1])<limit;
  }
  return false;
}
function h3SupportedMediaInputNames() {
  return [
    ...Array.from({length:9},(_,i)=>"ref_images.ref_image_"+i),
    ...Array.from({length:3},(_,i)=>"ref_videos.ref_video_"+i),
    ...Array.from({length:3},(_,i)=>"ref_video_audios.ref_video_audio_"+i),
    ...Array.from({length:3},(_,i)=>"ref_audios.ref_audio_"+i),
  ];
}
export function applyH3MediaAssets(api,h3NodeId,patches=[],workflow={},knownInputs=[]) {
  const h3=apiNode(api,h3NodeId);
  if(!h3 || h3.class_type!=="MiniMaxH3ReferenceToVideo")
    throw Error("配置的 H3 参考生成节点不存在："+h3NodeId);
  h3.inputs ||= {};
  const uiNode=(workflow?.nodes||[]).find(node=>id(node.id)===id(h3NodeId));
  const available=new Set([
    ...h3SupportedMediaInputNames(),
    ...(knownInputs||[]).map(String),
    ...(uiNode?.inputs||[]).map(input=>String(input?.name||"")),
    ...Object.keys(h3.inputs||{}),
  ]);
  for(const name of Object.keys(h3.inputs||{}))
    if(H3_MEDIA_INPUT.test(name))delete h3.inputs[name];

  let nextId=Math.max(0,...Object.keys(api).map(Number).filter(Number.isSafeInteger))+1;
  const add=(classType,inputs,title)=>{
    const nodeId=String(nextId++);
    api[nodeId]={class_type:classType,inputs,_meta:{title}};
    return nodeId;
  };
  let hasImage=false,hasVideo=false;
  const selected=(patches||[]).filter(p=>String(p?.value||"").trim());
  for(const patch of selected){
    if(id(patch.node_id)!==id(h3NodeId))
      throw Error("H3 参考资产映射到了其他节点："+patch.node_id);
    const name=String(patch.widget_name||"");
    if(!isSupportedH3MediaInput(name) || name.startsWith("ref_video_audios."))
      throw Error("H3 参考资产输入端无效："+name);
    const expected=name.startsWith("ref_images.")?"image":
      name.startsWith("ref_videos.")?"video":"audio";
    if(patch.kind!==expected)
      throw Error("H3 参考资产类型不匹配："+name+"（需要"+expected+"）");
    const value=String(patch.value).trim();
    if(expected==="image"){
      const loader=add("LoadImage",{image:value},"TerryDirector H3 参考图片");
      h3.inputs[name]=[loader,0];hasImage=true;
    }else if(expected==="audio"){
      const loader=add("LoadAudio",{audio:value},"TerryDirector H3 参考音频");
      h3.inputs[name]=[loader,0];
    }else{
      const loader=add("LoadVideo",{file:value},"TerryDirector H3 参考视频");
      const components=add("GetVideoComponents",{video:[loader,0]},"TerryDirector H3 视频帧与音轨提取");
      h3.inputs[name]=[components,0];hasVideo=true;
      const index=Number(name.match(/_(\d+)$/)?.[1]||0);
      const paired="ref_video_audios.ref_video_audio_"+index;
      if(available.has(paired))h3.inputs[paired]=[components,1];
    }
  }
  if(!hasImage && !hasVideo)
    throw Error("MiniMax H3 参考生成至少需要一张参考图片或一个参考视频");
}
export function normalizePreviewOptions(value="sampling") {
  if(typeof value==="string")return value==="decoded"
    ? {sampling_preview_enabled:false,vae_decode_enabled:true}
    : {sampling_preview_enabled:true,vae_decode_enabled:false};
  const legacy=value?.previewType ?? value?.preview_type;
  const sampling=typeof value?.sampling_preview_enabled==="boolean"
    ? value.sampling_preview_enabled
    : typeof value?.samplingPreviewEnabled==="boolean"
      ? value.samplingPreviewEnabled : legacy==="decoded" ? false : true;
  const decoded=typeof value?.vae_decode_enabled==="boolean"
    ? value.vae_decode_enabled
    : typeof value?.vaeDecodeEnabled==="boolean"
      ? value.vaeDecodeEnabled : legacy==="decoded";
  return {sampling_preview_enabled:sampling,vae_decode_enabled:decoded};
}
export function buildPreviewJob(template, overrides=[], mode="pause", checkpointId="", previewOptions="sampling") {
  if(template?.schema!==2 || !template?.api_prompt)throw Error("工作流未编译，请重新配置");
  if(!["pause","continue"].includes(mode))throw Error("无效的预演任务模式");
  const preview=normalizePreviewOptions(previewOptions);
  const api=clone(template.api_prompt);
  const pause=apiNode(api,template.pause_node_id);
  if(!pause || pause.class_type!==PAUSE_TYPE)throw Error("已配置的 SelfLift 节点丢失");
  const mediaPatches=applyPreviewInputs(api,overrides);
  if(template.h3_node_id!=null)
    applyH3MediaAssets(api,template.h3_node_id,mediaPatches,template.workflow,template.h3_media_bindings||[]);
  const taskName=String(pause.inputs.name || "").trim();
  if(taskName){
    const safeName=sanitizeTaskFilename(taskName);
    const highresNode=apiNode(api,template.highres_target);
    if(highresNode && highresNode.inputs && VIDEO_TYPES.has(highresNode.class_type)){
      const prior=String(highresNode.inputs?.filename_prefix || "TerryDirector");
      const normalized=prior.replace(/\\/g,"/");
      const slash=normalized.lastIndexOf("/");
      highresNode.inputs.filename_prefix=(slash>=0?normalized.slice(0,slash+1):"")+safeName;
    }
  }
  // Older saved templates still naming KJ are translated within the submitted
  // job only; the new preview does not import KJNodes or send fMP4 over WS.
  let nativeTinyVae=null;
  for(const item of Object.values(api)){
    if(item?.class_type!=="ModelPreviewOverrideKJ")continue;
    const prior=item.inputs||{};
    nativeTinyVae=typeof prior.tiny_vae==="string" ? prior.tiny_vae : "taeh3.safetensors";
    item.class_type="TerryDirectorH3Preview";
    item.inputs={
      model:prior.model, tiny_vae:nativeTinyVae,
      preview_frames:prior.preview_frames ?? 6,
      preview_fps:prior.preview_fps ?? 12,
      max_resolution:prior.max_resolution ?? 768,
    };
  }
  if(template.duration_seconds!=null && template.highres_megapixels!=null)
    applyTaskVideoParameters(api,template);
  pause.inputs.mode=mode==="pause"?"暂停并保存":"继续高清";
  if(mode==="pause") {
    if(Number.isFinite(Number(template.duration_seconds)))
      pause.inputs.preview_duration=Number(template.duration_seconds);
    if(!pause.inputs.preview_tiny_vae && nativeTinyVae && nativeTinyVae!=="none")
      pause.inputs.preview_tiny_vae=nativeTinyVae;
    if(!pause.inputs.preview_tiny_vae &&
       Object.values(api).some(n=>n?.class_type==="TerryDirectorH3Preview"))
      pause.inputs.preview_tiny_vae=Object.values(api).find(
        n=>n?.class_type==="TerryDirectorH3Preview")?.inputs?.tiny_vae||"none";
    if(!preview.sampling_preview_enabled){
      // Sampling preview is independent from the full VAE decode output.
      // Disable the quick decoder only when its own switch is off.
      pause.inputs.preview_tiny_vae="none";
      for(const n of Object.values(api))
        if(n?.class_type==="TerryDirectorH3Preview")n.inputs.tiny_vae="none";
    }
  }
  pause.inputs.checkpoint_id=mode==="pause"?"":checkpointId;
  const target = mode==="continue" ? template.highres_target : template.pause_target;
  const targets=[id(target)];
  if(mode==="pause" && preview.vae_decode_enabled){
    // Old configs saved before automatic recognition have decoded_target=null.
    // Resolve the real low-clean VAE branch again rather than forcing reimport.
    const targetId=id(template.decoded_target ||
      detectLowresReviewSink(template.workflow,api,template.pause_node_id)?.id||"");
    const node=apiNode(api,targetId);
    if(!node)throw Error("未识别到低清 VAE 审片线路，请检查视频和音频是否连接同一个低清保存节点");
    if(node.class_type==="VHS_VideoCombine"){
      // Keep the input video+audio decoders, but replace only the queued
      // output node. No duplicate VHS encode, changes to the canvas, or
      // output-directory copies; checkpoint ID enforces execution order.
      const images=node.inputs?.images,audio=node.inputs?.audio;
      if(!isLink(images)||!isLink(audio))
        throw Error("低清 VHS 视频节点缺少已连接的 VAE 画面或音频");
      api[targetId]={class_type:"TerryDirectorLowresReviewSave",inputs:{
        checkpoint_id:[id(template.pause_node_id),1],images,audio,
      },_meta:{title:"TerryDirector 自动低清 VAE 审片保存"}};
    }else if(node.class_type!=="TerryDirectorLowresReviewSave"){
      throw Error("无法自动归档的低清 VAE 保存节点类型："+node.class_type);
    }
    targets.push(targetId);
  }
  if(targets.some(nodeId=>!apiNode(api,nodeId)))
    throw Error("所需预演输出不存在，请重新配置");
  return {output:api,targets,workflow:clone(template.workflow)};
}
export function validatePreviewSeed(value, config) {
  const trimmed=String(value).trim();
  const seed=Number(trimmed);
  const min=Math.max(0, Number(config?.seed_min ?? 0));
  const max=Math.min(Number.MAX_SAFE_INTEGER, Number(config?.seed_max ?? RGTHREE_MAX_SEED));
  if(!/^\d+$/.test(trimmed) || !Number.isSafeInteger(seed) || seed<min || seed>max)
    throw Error("种子必须在 "+min+"～"+max+" 范围内");
  return seed;
}
export function randomPreviewSeed(config, randomBytes) {
  const min=Math.max(0,Number(config?.seed_min ?? 0));
  const max=Math.min(Number.MAX_SAFE_INTEGER,Number(config?.seed_max ?? RGTHREE_MAX_SEED));
  if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||max<min)throw Error("种子范围无效");
  const source = randomBytes || (bytes => globalThis.crypto.getRandomValues(bytes));
  const bytes=new Uint32Array(2);
  source(bytes);
  const range=BigInt(max-min)+1n;
  const integer=(BigInt(bytes[0])<<32n)|BigInt(bytes[1]);
  return String(min+Number(integer%range));
}
