/**
 * Trace an H3 generator's prompt input backwards through ComfyUI wiring.
 *
 * Never guess from unrelated text widgets. Handles TerryXu wireless buses,
 * cleanup pass-through, boolean switches, and H3 edit/copy source modes.
 * Returns editable prompt source bindings only, not display-only previews.
 */
export function traceH3PromptInputs(workflow) {
  const nodes=new Map((workflow?.nodes||[]).map(n=>[String(n.id),n]));
  const links=new Map((workflow?.links||[]).map(l=>[String(l[0]),l]));
  const results=new Map(), failures=[];
  const id=x=>String(x);
  const isH3Generator=n=>/^(MiniMaxH3ReferenceToVideo|MiniMaxH3TextToVideo|MiniMaxH3ImageToVideo)$/.test(n.type) ||
    (/MiniMaxH3.*(?:Video|Generation)/i.test(n.type) &&
     (n.outputs||[]).some(p=>p.type==="CONDITIONING"||p.type==="LATENT"));
  const name=n=>n.title||n.type||"节点";
  const getPort=(n,k)=>n?.inputs?.find(p=>p.name===k);
  const val=(n,k)=>n?.widgets_values_named?.[k];
  const sourceRecord=(n,key,route)=>{
    if(typeof val(n,key)!=="string")return null;
    if(getPort(n,key)?.link!=null)return null;
    return {node_id:n.id,widget_name:key,label:`${name(n)} #${n.id} · ${key}`,
      route};
  };
  function backLink(linkId,depth,path,route) {
    const edge=links.get(id(linkId));
    if(!edge){failures.push("提示词连线不存在："+linkId);return [];}
    return visit(edge[1],edge[2],depth+1,path,route);
  }
  function visit(nodeId,outputSlot,depth,path,route) {
    const node=nodes.get(id(nodeId));
    if(!node)return [];
    const key=`${node.id}:${outputSlot}`;
    if(depth>32 || path.has(key)) {
      failures.push("提示词连接存在循环或超过 32 层："+name(node)+" #"+node.id);return [];
    }
    const visited=new Set(path);visited.add(key);
    const type=node.type||"";
    const next=(port,context=route)=>port?.link==null?[]:backLink(port.link,depth,visited,context);
    // Generic passthrough nodes pass through data from one explicit inlet.
    if(type==="TerryXuMemoryCleanup") {
      return next(getPort(node,"anything"),route);
    }
    if(type==="TerryXuBoolSwitch") {
      const control=getPort(node,"enabled");
      const enabled=val(node,"enabled");
      if(control?.link!=null || typeof enabled!=="boolean"){
        // Runtime choice is unknown. Show both real sources; do not guess.
        return [...next(getPort(node,"input_false"),route+" · 分支 1"),
                ...next(getPort(node,"input_true"),route+" · 分支 2")];
      }
      return next(getPort(node,enabled?"input_true":"input_false"),
        route+(enabled?" · 增强分支":" · 原始分支"));
    }
    if(type==="TerryXuWirelessBusUnpack") {
      const channel=node.properties?.terry_wireless_bus_channel ||
        val(node,"选择总线");
      const laneId=node.properties?.terry_wire_bus_lane_ids?.[outputSlot];
      const laneName=node.outputs?.[outputSlot]?.name;
      const connected=getPort(node,"bus");
      let packs=[];
      if(connected?.link!=null) {
        const edge=links.get(id(connected.link));
        const pack=nodes.get(id(edge?.[1]));
        if(pack?.type==="TerryXuWirelessBusPack")packs=[pack];
      } else {
        packs=[...nodes.values()].filter(candidate=>
          candidate.type==="TerryXuWirelessBusPack" &&
          (candidate.properties?.terry_wireless_bus_channel ||
           val(candidate,"名称"))===channel);
      }
      if(packs.length!==1){
        failures.push("无线总线「"+channel+"」没有唯一发送端："+packs.length+" 个");
        return [];
      }
      const pack=packs[0];
      const lane=laneId
        ? (pack.properties?.terry_wire_bus_lanes||[]).find(p=>p.id===laneId)
        : null;
      const port=pack.inputs?.find(p=>p.name===(lane?.name||laneName));
      if(!port){
        failures.push("无线总线「"+channel+"」找不到输出通道 "+laneName);
        return [];
      }
      return next(port,route+" · 总线 "+channel);
    }
    if(type==="TerryXuWirelessBusPack") {
      failures.push("不能直接把无线总线对象作为文本输入："+node.id);
      return [];
    }
    if(type==="TerryXuH3PromptEditor"){
      const editing=val(node,"edit_mode")===true ||
        node.properties?.terry_h3_edit_mode===true;
      if(!editing && getPort(node,"source_text")?.link!=null){
        return next(getPort(node,"source_text"),route+" · 跟随来源");
      }
      const binding=sourceRecord(node,"prompt",route);
      if(binding)return [binding];
      failures.push("H3 编辑器 #"+node.id+" 没有可覆盖的原文输入");
      return [];
    }
    // Text processors may produce dynamic text. Trace only their typed
    // prompt/source_text upstream, never generic non-prompt widget fields.
    const textInlets=(node.inputs||[]).filter(p=>p.link!=null &&
      (p.type==="STRING"||p.type==="STRING,TEXT") &&
      /^(prompt|text|source_text|input_text|string)$/i.test(p.name));
    if(textInlets.length===1)return next(textInlets[0],route);
    if(textInlets.length>1){
      failures.push(name(node)+" #"+node.id+" 有多个文本来源，请明确选择");
      return textInlets.flatMap(p=>next(p,route+" · "+p.name));
    }
    for(const field of ["prompt","text","source_text","string","value"]){
      const binding=sourceRecord(node,field,route);
      if(binding && (node.outputs||[])[outputSlot]?.type==="STRING")return [binding];
    }
    // No evidence that other fields control this output.
    failures.push(name(node)+" #"+node.id+" 未提供可编辑的提示词来源");
    return [];
  }
  const generators=[...nodes.values()].filter(isH3Generator);
  if(!generators.length)failures.push("未找到带提示词输入的 MiniMax H3 生成节点");
  for(const generator of generators) {
    const ports=(generator.inputs||[]).filter(p=>
      (p.name==="prompt"||p.name==="text_prompt") && p.type==="STRING");
    if(!ports.length)continue;
    for(const port of ports){
      const route=`MiniMax H3 #${generator.id}.${port.name}`;
      let matches=[];
      if(port.link!=null)matches=backLink(port.link,0,new Set(),route);
      else {
        const binding=sourceRecord(generator,port.name,route);
        if(binding)matches=[binding];
      }
      if(!matches.length)failures.push("无法找到 "+route+" 的上游文本源");
      for(const entry of matches){
        const key=String(entry.node_id)+":"+entry.widget_name;
        if(!results.has(key))results.set(key,entry);
      }
    }
  }
  return {fields:[...results.values()],failures};
}
