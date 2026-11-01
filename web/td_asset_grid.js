/** DOM-only virtual grid shared by asset picker consumers. */
export function assetGridRange(count,width,height,scrollTop,minWidth=110,gap=8) {
  const columns=Math.max(1,Math.floor((width+gap)/(minWidth+gap)));
  const cardWidth=Math.max(1,(width-gap*(columns-1))/columns);
  const stride=Math.ceil((cardWidth-12)*.75+34)+gap;
  const rows=Math.ceil(count/columns),buffer=2;
  const firstRow=Math.max(0,Math.floor(Math.max(0,scrollTop-8)/stride)-buffer);
  const endRow=Math.min(rows,Math.ceil((scrollTop+height)/stride)+buffer);
  return {columns,stride,start:Math.min(count,firstRow*columns),end:Math.min(count,endRow*columns),
    top:Math.min(rows,firstRow)*stride,bottom:Math.max(0,rows-endRow)*stride};
}

export function mountAssetGrid(viewport,{renderItem,onNearEnd=()=>{}}) {
  const top=document.createElement("div"),grid=document.createElement("div"),bottom=document.createElement("div");
  grid.className="tdap-cards";
  top.setAttribute("aria-hidden","true");bottom.setAttribute("aria-hidden","true");
  viewport.replaceChildren(top,grid,bottom);
  let items=[],frame=0,disposed=false,lastKey="",nodes=new Map();
  function paint() {
    frame=0;if(disposed)return;
    const range=assetGridRange(items.length,viewport.clientWidth||660,viewport.clientHeight||360,viewport.scrollTop);
    const key=[range.start,range.end,range.columns,range.stride].join(":");
    if(key!==lastKey){
      lastKey=key;
      top.style.height=range.top+"px";bottom.style.height=range.bottom+"px";
      grid.style.gridTemplateColumns=`repeat(${range.columns},minmax(0,1fr))`;
      grid.style.gridAutoRows=(range.stride-8)+"px";
      const next=new Map(),cards=[];
      for(let i=range.start;i<range.end;i++){
        const item=items[i],id=item.source+":"+item.path+":"+(item.thumbnail_url||item.preview_url);
        const card=nodes.get(id)||renderItem(item);
        card.setAttribute("aria-posinset",String(i+1));card.setAttribute("aria-setsize",String(items.length));
        next.set(id,card);cards.push(card);
      }
      grid.replaceChildren(...cards);nodes=next;
    }
    if(items.length&&range.end>=items.length)onNearEnd();
  }
  function schedule(){if(!frame&&!disposed)frame=requestAnimationFrame(paint);}
  viewport.addEventListener("scroll",schedule,{passive:true});
  const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(schedule):null;
  observer?.observe(viewport);
  return {
    setItems(value,{reset=false}={}){
      items=value;lastKey="";
      if(reset){viewport.scrollTop=0;nodes.clear();}
      paint();
    },
    destroy(){disposed=true;if(frame)cancelAnimationFrame(frame);observer?.disconnect();
      viewport.removeEventListener("scroll",schedule);nodes.clear();},
  };
}
