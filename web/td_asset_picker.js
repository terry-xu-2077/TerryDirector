/** Shared, self-contained asset dialog. No dependency on the preview-stage state.
 * openAssetPicker({ fetchApi, kind, onSelect, onClose, source?, parent? })
 * onSelect receives an input-compatible {path,name,kind,source,preview_url}.
 * Returns {close}; close is safe during requests and component disposal.
 */
import { mountAssetGrid } from "./td_asset_grid.js";
const esc = value => String(value ?? "").replace(/[&<>"']/g,
  char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const labels = {image:"图片",video:"视频",audio:"音频"};
const accepts = {
  image:".png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.svg",
  video:".mp4,.mov,.mkv,.webm,.avi,.m4v",audio:".wav,.mp3,.flac,.ogg,.m4a,.aac,.opus",
};
function installStyle() {
  if (document.getElementById("td-asset-picker-style")) return;
  const style = document.createElement("style");
  style.id = "td-asset-picker-style";
  style.textContent = `
.tdap-overlay{position:fixed;inset:0;z-index:100040;display:grid;place-items:center;background:#000c;padding:20px;box-sizing:border-box;color:#eef0f5;font:13px system-ui}
.tdap-dialog{width:min(740px,92vw);max-height:calc(100dvh - 48px);box-sizing:border-box;display:flex;flex-direction:column;gap:8px;overflow:hidden;background:#202329;border:1px solid #454b55;border-radius:12px;padding:22px;box-shadow:0 25px 90px #000c}
.tdap-head,.tdap-tools,.tdap-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tdap-head{justify-content:space-between;margin-bottom:8px}.tdap-head h2{font-size:17px;margin:0}
.tdap-dialog button,.tdap-dialog select,.tdap-dialog input{font:inherit;color:inherit;background:#2e333b;border:1px solid #454b55;border-radius:7px;padding:9px;box-sizing:border-box}.tdap-dialog button{cursor:pointer}.tdap-dialog button:hover{border-color:#6399d5}.tdap-dialog button:disabled{opacity:.55;cursor:wait}.tdap-dialog :focus-visible{outline:2px solid #6399d5;outline-offset:2px}.tdap-tools input{flex:1;min-width:120px}
.tdap-grid{height:min(46vh,520px);overflow:auto;min-height:100px;padding:8px 0;overflow-anchor:none}.tdap-cards{display:grid;gap:8px}.tdap-grid .tdap-card{background:#1b1e24;padding:5px;text-align:left;min-width:0;overflow:hidden;color:#cdd5e0}.tdap-card img,.tdap-icon{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:4px;background:#101319}.tdap-icon{display:grid;place-items:center;font-size:28px}.tdap-name{display:block;margin:5px 2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px}.tdap-status{font-size:12px;color:#aeb6c3;flex:1}.tdap-error{color:#ffb4ab}.tdap-hint{font-size:12px;color:#aeb6c3;margin:0}
.tdap-video-thumb{display:block;position:relative}.tdap-play-badge{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:36px;height:36px;box-sizing:border-box;padding-left:2px;border-radius:50%;background:#000a;color:#eef0f5;font-size:18px;line-height:1;pointer-events:none}
.tdap-preview-layer{position:absolute;inset:0;display:grid;place-items:center;background:#000c;padding:20px;box-sizing:border-box;z-index:1}.tdap-media-dialog{width:min(640px,92vw)}.tdap-media-name{margin:0 0 8px;overflow-wrap:anywhere;color:#cdd5e0}.tdap-player{display:block;width:100%;min-height:0}.tdap-media-dialog video{max-height:50dvh;object-fit:contain;background:#101319;border-radius:7px}.tdap-media-dialog audio{margin:8px 0}.tdap-media-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}.tdap-dialog .tdap-use-media{background:#294b70;border-color:#6399d5}.tdap-media-message{margin:8px 0 0;color:#ffb4ab;font-size:12px;line-height:1.5}
`;
  document.head.append(style);
}

export function openAssetPicker({fetchApi, kind="image", source="input", onSelect,
  onClose=()=>{}, parent=document.body}={}) {
  if (!labels[kind] || typeof fetchApi !== "function" || typeof onSelect !== "function")
    throw new Error("资产选择器需要有效的 kind、fetchApi 和 onSelect");
  installStyle();
  const previousFocus=document.activeElement, label=labels[kind];
  const root=document.createElement("div");
  root.className="tdap-overlay";
  root.innerHTML=`<section class="tdap-dialog" role="dialog" aria-modal="true" aria-label="选择${label}资产">
    <header class="tdap-head"><h2>选择${label}资产</h2><button type="button" data-close aria-label="关闭">×</button></header>
    <div class="tdap-tools"><select data-source aria-label="资产来源"><option value="input">input 文件夹</option><option value="output">output 文件夹</option></select>
    <input data-search type="search" placeholder="按文件名搜索${label}" aria-label="按文件名搜索${label}"><button type="button" data-refresh>刷新</button><button type="button" data-upload>上传${label}</button></div>
    <p class="tdap-hint" hidden>选中的 output 资产将复制到 input/TerryDirector/imported，供工作流使用。</p>
    <div class="tdap-grid" tabindex="0" aria-label="资产列表"></div><footer class="tdap-foot"><span class="tdap-status" role="status" aria-live="polite"></span><button type="button" data-more hidden>加载更多</button></footer></section>`;
  parent.append(root);
  const grid=root.querySelector(".tdap-grid"), status=root.querySelector(".tdap-status"),
    search=root.querySelector("[data-search]"), sourceSelect=root.querySelector("[data-source]"),
    more=root.querySelector("[data-more]");
  sourceSelect.value=source==="output"?"output":"input";
  let closed=false,busy=false,loading=false,version=0,timer,files=[],hasMore=false,listRequest;
  let previewLayer=null,previewMedia=null,previewReturnFocus=null;
  const virtualGrid=mountAssetGrid(grid,{renderItem:createCard,onNearEnd:()=>{
    if(hasMore&&!loading&&!busy&&!closed)void load(true);
  }});
  const close=()=>{
    if(closed)return;
    closed=true;version++;clearTimeout(timer);listRequest?.abort();closeMediaPreview(false);virtualGrid.destroy();root.remove();
    if(previousFocus?.isConnected)previousFocus.focus();
    onClose();
  };
  const report=error=>{
    status.textContent=error?.message||String(error);status.classList.add("tdap-error");
    const message=previewLayer?.querySelector(".tdap-media-message");
    if(message){message.textContent=status.textContent;message.hidden=false;}
  };
  function closeMediaPreview(restoreFocus=true) {
    if(!previewLayer)return;
    previewMedia?.pause();
    previewMedia?.removeAttribute("src");
    previewMedia?.load();
    previewLayer.remove();previewLayer=null;previewMedia=null;
    root.querySelector(".tdap-dialog").inert=false;
    if(restoreFocus&&!closed)(previewReturnFocus?.isConnected?previewReturnFocus:search).focus();
    previewReturnFocus=null;
  }
  function previewAsset(file) {
    if(closed||busy)return;
    closeMediaPreview(false);
    previewReturnFocus=document.activeElement;
    previewLayer=document.createElement("div");previewLayer.className="tdap-preview-layer";
    const action=kind==="video"?"视频":"音频";
    previewLayer.innerHTML=`<section class="tdap-dialog tdap-media-dialog" role="dialog" aria-modal="true" aria-label="预览${action}">
      <header class="tdap-head"><h2>预览${action}</h2><button type="button" data-preview-close aria-label="关闭预览">×</button></header>
      <p class="tdap-media-name">${esc(file.name)}</p>
      <${kind} class="tdap-player" controls playsinline preload="metadata" aria-label="${esc(file.name)}"></${kind}>
      <p class="tdap-media-message" role="status" aria-live="polite" hidden></p>
      <footer class="tdap-media-actions"><button type="button" data-preview-back>返回列表</button><button type="button" class="tdap-use-media" data-preview-use>使用此${action}</button></footer></section>`;
    root.querySelector(".tdap-dialog").inert=true;
    root.append(previewLayer);
    previewMedia=previewLayer.querySelector(kind);
    const media=previewMedia;
    previewMedia.addEventListener("error",()=>{
      if(previewMedia!==media)return;
      const message=previewLayer?.querySelector(".tdap-media-message");
      if(message){message.hidden=false;message.textContent="无法播放此文件，浏览器可能不支持该格式或编码。仍可选择此资产。";}
    });
    previewMedia.src=file.preview_url;
    previewLayer.querySelector("[data-preview-close]").addEventListener("click",()=>busy?close():closeMediaPreview());
    previewLayer.querySelector("[data-preview-back]").addEventListener("click",()=>closeMediaPreview());
    previewLayer.querySelector("[data-preview-use]").addEventListener("click",()=>void select(file));
    previewLayer.querySelector("[data-preview-close]").focus();
  }
  async function request(path,options) {
    const response=await fetchApi("/terrydirector/api"+path,options);
    const data=await response.json();
    if(!response.ok)throw Error(data.error||"读取资产失败");
    return data;
  }
  function setBusy(value) {
    busy=value;
    root.querySelectorAll("button,select,input").forEach(el=>{el.disabled=value;});
    root.querySelector("[data-close]").disabled=false;
    const previewClose=previewLayer?.querySelector("[data-preview-close]");
    if(previewClose)previewClose.disabled=false;
  }
  async function select(file) {
    if(busy||closed)return;
    previewMedia?.pause();
    setBusy(true);status.classList.remove("tdap-error");
    status.textContent=file.source==="output"?"正在导入所选资产…":"正在选择资产…";
    try {
      const selected=await request("/assets/import",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({source:file.source,path:file.path,kind})});
      if(closed)return;
      await onSelect(selected);close();
    } catch(error) { if(!closed)report(error); }
    finally { if(!closed)setBusy(false); }
  }
  function createCard(file) {
      const card=document.createElement("button");card.type="button";card.className="tdap-card";
      card.disabled=busy;
      card.title=file.path;
      const preview=kind==="image"||(kind==="video"&&file.thumbnail_url)?`<img loading="lazy" decoding="async" src="${esc(file.thumbnail_url||file.preview_url)}" alt="">`:
        `<span class="tdap-icon">${kind==="video"?"▶":"♫"}</span>`;
      card.innerHTML=(kind==="video"&&file.thumbnail_url?
        `<span class="tdap-video-thumb">${preview}<span class="tdap-play-badge" aria-hidden="true">▶</span></span>`:preview)+
        `<span class="tdap-name">${esc(file.name)}</span>`;
      card.querySelector("img")?.addEventListener("error",()=>{
        const fallback=document.createElement("span");fallback.className="tdap-icon";fallback.textContent=kind==="video"?"▶":"图片无法预览";
        card.querySelector("img")?.replaceWith(fallback);
        card.querySelector(".tdap-play-badge")?.remove();
      },{once:true});
      if(kind!=="image")card.setAttribute("aria-label","预览"+label+"："+file.name);
      card.addEventListener("click",()=>kind==="image"?void select(file):previewAsset(file));return card;
  }
  async function load(append=false,refresh=false) {
    if(closed||busy||(append&&(loading||!hasMore)))return;
    listRequest?.abort();listRequest=new AbortController();
    const current=++version;
    loading=true;
    status.classList.remove("tdap-error");status.textContent="正在读取资产…";more.hidden=true;
    if(!append){files=[];hasMore=false;virtualGrid.setItems(files,{reset:true});}
    root.querySelector(".tdap-hint").hidden=sourceSelect.value!=="output";
    try{
      const params=new URLSearchParams({source:sourceSelect.value,kind,q:search.value,offset:String(files.length)});
      if(refresh)params.set("refresh","1");
      const data=await request("/assets?"+params,{signal:listRequest.signal});
      if(closed||current!==version||busy)return;
      files.push(...data.files);hasMore=data.files.length>0&&files.length<data.total;
      status.textContent=files.length?`已显示 ${files.length} / ${data.total} 个${label}资产`:"没有匹配的"+label+"资产";
      more.hidden=!hasMore;
      loading=false;virtualGrid.setItems(files);
    }catch(error){if(!closed&&current===version&&error.name!=="AbortError")report(error);}
    finally{if(current===version)loading=false;}
  }
  root.querySelector("[data-close]").addEventListener("click",close);
  sourceSelect.addEventListener("change",()=>{clearTimeout(timer);void load();});
  search.addEventListener("input",()=>{clearTimeout(timer);version++;listRequest?.abort();timer=setTimeout(()=>void load(),200);});
  root.querySelector("[data-refresh]").addEventListener("click",()=>{clearTimeout(timer);void load(false,true);});
  more.addEventListener("click",()=>void load(true));
  root.querySelector("[data-upload]").addEventListener("click",()=>{
    const input=document.createElement("input");input.type="file";input.accept=accepts[kind];
    input.onchange=async()=>{
      const file=input.files?.[0];if(!file||closed||busy)return;
      setBusy(true);version++;status.classList.remove("tdap-error");status.textContent="正在上传…";
      try{
        const form=new FormData();form.append("file",file,file.name);
        const selected=await request("/upload",{method:"POST",body:form});
        if(selected.kind!==kind)throw Error("文件类型与"+label+"槽位不匹配");
        if(!closed){await onSelect(selected);close();}
      }catch(error){if(!closed)report(error);}
      finally{if(!closed)setBusy(false);}
    };input.click();
  });
  root.addEventListener("keydown",event=>{
    if(event.key==="Escape"){
      event.preventDefault();event.stopPropagation();
      if(previewLayer&&!busy)closeMediaPreview();else close();
    }
    if(event.key==="Tab"){
      const controls=[...(previewLayer||root).querySelectorAll("button:not(:disabled):not([hidden]),select:not(:disabled),input:not(:disabled),[tabindex='0'],video[controls],audio[controls]")];
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  search.focus();void load();
  return {close};
}
