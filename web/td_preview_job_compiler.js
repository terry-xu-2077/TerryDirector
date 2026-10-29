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
      if(isSeedField(input.name)){
        constrainField(dest.id,type,input.name,null);
        continue;
      }
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
export function compilePreviewTargets(workflow, api, pauseNodeId) {
  const nodes=uiNodes(workflow), pause=nodes.get(id(pauseNodeId));
  if(!pause || apiNode(api,pauseNodeId)?.class_type !== PAUSE_TYPE)
    throw Error("工作流未连接有效的 SelfLift 暂停节点");
  const highres=outgoing(workflow,api,pauseNodeId,0).filter(x=>VIDEO_TYPES.has(x.type));
  if(highres.length!==1) throw Error("高清线路必须恰好连接一个视频保存终点");
  const clean=pause.inputs?.find(x=>x.name==="low_clean");
  const links=new Map((workflow.links||[]).map(l=>[id(l[0]),l]));
  const upstream=links.get(id(clean?.link));
  let decoded=[];
  if(upstream) {
    decoded=outgoing(workflow,api,upstream[1],upstream[2],{stopAtPause:true})
      .filter(x=>x.type==="TerryDirectorLowresReviewSave");
  }
  if(decoded.length>1)throw Error("预演解码线路只能连接一个 TerryDirector 视频保存节点");
  return {pause_target:id(pauseNodeId),highres_target:highres[0].id,
    decoded_target:decoded[0]?.id || null};
}
export function applyPreviewInputs(api, overrides) {
  for(const patch of overrides||[]) {
    const node=apiNode(api,patch.node_id),name=patch.widget_name;
    if(!node || typeof name!=="string" ||
       !Object.prototype.hasOwnProperty.call(node.inputs||{},name))
      throw Error("配置的输入节点不存在："+patch.node_id+"."+name+"，请重新配置预演工作流");
    if(isLink(node.inputs[name]))
      throw Error("不能覆盖连线终点："+patch.node_id+"."+name+"，请选择上游输入源节点");
    if(typeof patch.value!=="string" && typeof patch.value!=="number")
      throw Error("输入值必须是文本或数字："+name);
    node.inputs[name]=patch.value;
  }
}
export function buildPreviewJob(template, overrides=[], mode="pause", checkpointId="", previewType="sampling") {
  if(template?.schema!==2 || !template?.api_prompt)throw Error("工作流未编译，请重新配置");
  if(!["pause","continue"].includes(mode))throw Error("无效的预演任务模式");
  const api=clone(template.api_prompt);
  const pause=apiNode(api,template.pause_node_id);
  if(!pause || pause.class_type!==PAUSE_TYPE)throw Error("已配置的 SelfLift 节点丢失");
  applyPreviewInputs(api,overrides);
  pause.inputs.mode=mode==="pause"?"暂停并保存":"继续高清";
  pause.inputs.checkpoint_id=mode==="pause"?"":checkpointId;
  const target = mode==="continue" ? template.highres_target : template.pause_target;
  const targets=[id(target)];
  if(mode==="pause" && previewType==="decoded"){
    if(!template.decoded_target)throw Error("工作流未连接预演 VAE 解码视频保存节点");
    targets.push(id(template.decoded_target));
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
