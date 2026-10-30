/** Parse Markdown or copied plain-text shot batches. The batch body is kept intact. */
const BATCH_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(批次\s*\d+.*?)(?:\*\*|__)?\s*$/gm;
const IMAGE_FILE = /^(.+?\.(?:png|jpe?g|webp|bmp|gif|tif|tiff|svg))\s*(?:[：:]|$)/i;
function referenceAssets(body) {
  const lines=String(body||"").split(/\r?\n/),references=[],generatedAssets=[];
  let inside=false;
  for(const line of lines){
    if(/^\s*\[全局参考\]\s*$/.test(line)){inside=true;continue;}
    if(inside && /^\s*\[[^\]]+\]\s*$/.test(line))break;
    if(!inside)continue;
    const value=line.trim().replace(/^(?:[-*+•]\s+|\d+[.)、]\s*)/,"");
    if(!value)continue;
    const generated=value.match(/^待生成资产\s*[｜|:：]\s*(.*)$/);
    if(generated){
      const label=generated[1].split(/\s+生图提示词\s*[：:]/)[0].trim();
      generatedAssets.push(label||"未命名资产");continue;
    }
    const match=value.match(IMAGE_FILE);
    if(match){
      const name=match[1].trim();
      references.push({name,description:value.slice(name.length).replace(/^[：:]\s*/,"").trim()});
    }
  }
  return {references,generatedAssets};
}
export function parsePreviewBatches(value) {
  const text=String(value||"").replace(/\r\n?/g,"\n");
  const headings=[...text.matchAll(BATCH_HEADING)];
  if(!headings.length)return {preamble:"",batches:[],error:"未识别到批次标题。请将“批次01｜镜头名称”单独放在一行；保留或省略 Markdown 标题符号均可。"};
  const preamble=text.slice(0,headings[0].index).replace(/^\s*#\s+[^\n]*\n?/,"").trim();
  const batches=headings.map((match,index)=>{
    const start=match.index+match[0].length,end=index+1<headings.length?headings[index+1].index:text.length;
    const body=text.slice(start,end).trim(),heading=match[1].trim();
    const durationMatch=heading.match(/[（(]?\s*建议\s*(\d+)\s*秒\s*[）)]?\s*$/);
    const name=durationMatch?heading.slice(0,durationMatch.index).trim():heading;
    const assets=referenceAssets(body);
    return {name,heading,body,duration_seconds:durationMatch?Math.max(4,Math.min(20,Number(durationMatch[1]))):15,
      references:assets.references,generatedAssets:assets.generatedAssets};
  }).filter(batch=>batch.body.length>0);
  return {preamble,batches,error:batches.length?"":"已识别标题，但没有找到包含正文的批次"};
}
