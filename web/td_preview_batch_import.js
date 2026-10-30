const BATCH_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(批次\s*\d+.*?)(?:\*\*|__)?\s*$/gm;

const MEDIA_EXTENSIONS = {"image":[".png",".jpg",".jpeg",".webp",".bmp",".gif",".tif",".tiff",".svg"],"video":[".mp4",".mov",".mkv",".webm",".avi",".m4v"],"audio":[".wav",".mp3",".flac",".ogg",".m4a",".aac",".opus"]};

const MEDIA_TYPE_NAMES = {"图片":"image","音频":"audio","视频":"video"};

function mediaKind(name){
 const ext=(String(name||"").match(/\.[^.\\/]+$/)||[])[0]?.toLowerCase();
 return Object.keys(MEDIA_EXTENSIONS).find(kind=>MEDIA_EXTENSIONS[kind].includes(ext))||null;
}

function splitMarkdownSections(body,headingLevel=3){
 const lines=String(body||"").split("\n"),sections=[];
 let current={heading:null,lines:[]},fence=null;
 for(const line of lines){
  const fm=line.match(/^\s*(`{3,}|~{3,})/);
  if(fm){
   const marker=fm[1][0];
   if(!fence)fence={marker,length:fm[1].length};
   else if(marker===fence.marker&&fm[1].length>=fence.length)fence=null;
   current.lines.push(line);continue;
  }
  const re=new RegExp("^\\s*#{"+headingLevel+"}\\s+(.+?)\\s*$");
  const match=!fence&&line.match(re);
  if(match){sections.push(current);current={heading:match[1].replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)$/,"$1").trim(),lines:[]};}
  else current.lines.push(line);
 }
 sections.push(current);return sections;
}

function cleanHeadingMarkers(lines){
 const output=[];let fence=null;
 for(const line of lines){
  const match=line.match(/^\s*(`{3,}|~{3,})/);
  if(match){
   const marker=match[1][0];
   if(!fence)fence={marker,length:match[1].length};
   else if(marker===fence.marker&&match[1].length>=fence.length)fence=null;
   output.push(line);continue;
  }
  output.push(!fence?line.replace(/^(\s{0,3})#{1,6}\s+/,"$1"):line);
 }
 return output.join("\n").trim();
}

function parseReferenceSection(lines){
 const references=[],errors=[];
 const pattern=/^\s*[-*+]\s*(图片|音频|视频)\s*[:：]\s*`([^`]+)`\s*(?:[—–-]\s*(.*))?$/;
 for(const line of lines){
  if(!line.trim())continue;
  const match=line.match(pattern);
  if(!match){errors.push("引用资产格式无法识别："+line.trim());continue;}
  const kind=MEDIA_TYPE_NAMES[match[1]],name=match[2].trim(),extensionKind=mediaKind(name);
  if(extensionKind&&extensionKind!==kind)errors.push("引用资产类型与文件扩展名不匹配："+name+"（声明为"+match[1]+"）");
  references.push({name,kind,description:String(match[3]||"").trim()});
 }
 return {references,errors};
}

function readFencedPrompt(lines,startIndex){
 for(let i=startIndex;i<lines.length;i++){
  const opening=lines[i].match(/^\s*(`{3,}|~{3,})(?:[a-zA-Z0-9_-]+)?\s*$/);
  if(!opening)continue;
  const marker=opening[1][0],length=opening[1].length,content=[];
  for(let j=i+1;j<lines.length;j++){
   const closing=lines[j].match(/^\s*(`{3,}|~{3,})\s*$/);
   if(closing&&closing[1][0]===marker&&closing[1].length>=length)return {prompt:content.join("\n").trim(),endIndex:j};
   content.push(lines[j]);
  }
  return {prompt:content.join("\n").trim(),endIndex:lines.length-1,unclosed:true};
 }
 return null;
}

function parseGeneratedAssetSection(lines){
 const assets=[],warnings=[],unparsed=[],headings=[];
 let fence=null;
 for(let i=0;i<lines.length;i++){
  const fm=lines[i].match(/^\s*(`{3,}|~{3,})/);
  if(fm){
   const marker=fm[1][0];
   if(!fence)fence={marker,length:fm[1].length};
   else if(marker===fence.marker&&fm[1].length>=fence.length)fence=null;
   continue;
  }
  const match=!fence&&lines[i].match(/^\s*####\s+(.+?)\s*$/);
  if(match)headings.push({index:i,value:match[1].trim()});
 }
 if(!headings.length){
  if(lines.some(line=>line.trim())){warnings.push("待生成资产章节中没有识别到“#### 类型｜名称｜比例”标题。");unparsed.push(lines.join("\n").trim());}
  return {assets,warnings,unparsed};
 }
 if(lines.slice(0,headings[0].index).some(line=>line.trim()))unparsed.push(lines.slice(0,headings[0].index).join("\n").trim());
 for(let h=0;h<headings.length;h++){
  const entry=headings[h],end=h+1<headings.length?headings[h+1].index:lines.length,content=lines.slice(entry.index+1,end);
  const header=entry.value.match(/^(图片|音频|视频)\s*[｜|]\s*(.+?)(?:\s*[｜|]\s*(\d+(?:\.\d+)?\s*:\s*1))?\s*$/);
  if(!header){warnings.push("待生成资产标题格式无法识别："+entry.value);unparsed.push([lines[entry.index],...content].join("\n").trim());continue;}
  const type=MEDIA_TYPE_NAMES[header[1]],name=header[2].trim(),aspectRatio=String(header[3]||"").replace(/\s+/g,"");
  const promptLabel=content.findIndex(line=>/^\s*提示词\s*[:：]/.test(line)),promptStart=promptLabel>=0?promptLabel:0;
  const fenced=readFencedPrompt(content,promptStart);
  let prompt="";
  if(fenced){prompt=fenced.prompt;if(fenced.unclosed)warnings.push(name+"：提示词代码块没有闭合。");}
  else if(promptLabel>=0){
   const labelLine=content[promptLabel].replace(/^\s*提示词\s*[:：]\s*/,"");
   prompt=[labelLine,...content.slice(promptLabel+1)].join("\n").trim();
   if(prompt)warnings.push(name+"：提示词未使用代码块，已按普通文本提取。");
  }else{
   prompt=content.join("\n").trim();
   if(prompt)warnings.push(name+"：未找到“提示词：”标记，已提取资产正文。");
  }
  if(!prompt)warnings.push(name+"：缺少资产生成提示词。");
  if(type==="image"&&!aspectRatio)warnings.push(name+"：建议补充图片画幅比例。");
  assets.push({type,name,aspect_ratio:aspectRatio,prompt});
 }
 return {assets,warnings,unparsed};
}

function parseLegacyReferences(body){
 const lines=String(body||"").split(/\r?\n/),references=[],generatedAssets=[];let inside=false;
 for(const line of lines){
  if(/^\s*\[全局参考\]\s*$/.test(line)){inside=true;continue;}
  if(inside&&/^\s*\[[^\]]+\]\s*$/.test(line))break;
  if(!inside)continue;
  const value=line.trim().replace(/^(?:[-*+•]\s+|\d+[.)、]\s*)/,"");
  if(!value)continue;
  const generated=value.match(/^待生成资产\s*[｜|:：]\s*(.*)$/);
  if(generated){const label=generated[1].split(/\s+生图提示词\s*[:：]/)[0].trim();generatedAssets.push(label||"未命名资产");continue;}
  const match=value.match(/^(.+?\.(?:png|jpe?g|webp|bmp|gif|tif|tiff|svg|mp4|mov|mkv|webm|avi|m4v|wav|mp3|flac|ogg|m4a|aac|opus))\s*(?:[：:]|$)/i);
  if(match){const name=match[1].trim(),kind=mediaKind(name);if(kind)references.push({name,kind,description:value.slice(name.length).replace(/^[：:]\s*/,"").trim()});}
 }
 return {references,generatedAssets};
}

function parseStructuredBatchBody(rawBody){
 const sections=splitMarkdownSections(rawBody,3);
 const hasReferenceSection=sections.some(section=>section.heading==="引用资产");
 const hasGeneratedSection=sections.some(section=>section.heading==="待生成资产");
 if(!hasReferenceSection&&!hasGeneratedSection){
  const legacy=parseLegacyReferences(rawBody);
  return {body:String(rawBody||"").trim(),sourceBody:String(rawBody||"").trim(),references:legacy.references,
   generatedAssets:legacy.generatedAssets,parseErrors:[],parseWarnings:[],unparsedGeneratedAssets:[]};
 }
 const references=[],generatedAssets=[],parseErrors=[],parseWarnings=[],unparsedGeneratedAssets=[],bodyParts=[];
 for(const section of sections){
  if(section.heading==="引用资产"){
   const parsed=parseReferenceSection(section.lines);references.push(...parsed.references);parseErrors.push(...parsed.errors);
   if(parsed.references.length)bodyParts.push("[全局参考]\n"+parsed.references.map(ref=>ref.name+(ref.description?"："+ref.description:"")).join("\n"));
   continue;
  }
  if(section.heading==="待生成资产"){
   const parsed=parseGeneratedAssetSection(section.lines);generatedAssets.push(...parsed.assets);
   parseWarnings.push(...parsed.warnings);unparsedGeneratedAssets.push(...parsed.unparsed);continue;
  }
  const content=cleanHeadingMarkers(section.lines);
  if(section.heading){
   const known={"导演说明":"[导演说明]","连续性状态":"[连续性状态]","视觉基调":"[视觉基调]","色彩光影":"[色彩光影]","分镜脚本":"[分镜脚本]"};
   bodyParts.push([known[section.heading]||section.heading,content].filter(Boolean).join("\n"));
  }else if(content)bodyParts.push(content);
 }
 return {body:bodyParts.filter(Boolean).join("\n\n").trim(),sourceBody:String(rawBody||"").trim(),
  references,generatedAssets,parseErrors,parseWarnings,unparsedGeneratedAssets};
}

function extractGlobalRules(text){
 const lines=String(text||"").split("\n"),start=lines.findIndex(line=>/^\s*#\s+全局规则\s*$/.test(line));
 if(start<0)return null;
 let end=lines.length;
 for(let i=start+1;i<lines.length;i++)if(/^\s*#\s+/.test(lines[i])||/^\s*##\s*批次\s*\d+/.test(lines[i])){end=i;break;}
 return lines.slice(start+1,end).join("\n").trim();
}

function legacyPreamble(text,firstBatchIndex){return String(text||"").slice(0,firstBatchIndex).replace(/^\s*#\s+[^\n]*\n?/,"").trim();}

export function parsePreviewBatches(value){
 const text=String(value||"").replace(/\r\n?/g,"\n"),headings=[...text.matchAll(BATCH_HEADING)];
 if(!headings.length)return {preamble:"",batches:[],error:"未识别到批次标题。请使用“## 批次01｜名称”单独占一行。"};
 const globalRules=extractGlobalRules(text),preamble=globalRules===null?legacyPreamble(text,headings[0].index):globalRules;
 const batches=headings.map((match,index)=>{
  const start=match.index+match[0].length,end=index+1<headings.length?headings[index+1].index:text.length;
  const rawBody=text.slice(start,end).trim(),heading=match[1].trim();
  const durationMatch=heading.match(/[（(]?\s*建议\s*(\d+)\s*秒\s*[）)]?\s*$/);
  const name=durationMatch?heading.slice(0,durationMatch.index).trim():heading,parsed=parseStructuredBatchBody(rawBody);
  return {name,heading,body:parsed.body,sourceBody:parsed.sourceBody,
   duration_seconds:durationMatch?Math.max(4,Math.min(20,Number(durationMatch[1]))):15,
   references:parsed.references,generatedAssets:parsed.generatedAssets,parseErrors:parsed.parseErrors,
   parseWarnings:parsed.parseWarnings,unparsedGeneratedAssets:parsed.unparsedGeneratedAssets};
 }).filter(batch=>batch.sourceBody.length>0);
 return {preamble,batches,error:batches.length?"":"已识别标题，但没有找到包含正文的批次"};
}