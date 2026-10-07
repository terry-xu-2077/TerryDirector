/* Static task composer: prompt + references + timeline.
 * Docked generation feedback + separate asset lightbox. No backend or framework. */
(function () {
  'use strict';
  const embedded=window.parent!==window&&new URLSearchParams(location.search).get('embed')==='1';
  const hostOrigin=location.origin;
  const inputPreviewUrl=path=>`/view?filename=${encodeURIComponent(path)}&type=input`;
  const C=window.TDCore, R=window.TDResolution, $=s=>document.querySelector(s);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths={
    home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
    chevron:'m9 5 7 7-7 7',plus:'M12 5v14M5 12h14',search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',list:'M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1',
    upload:'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    play:'m8 4 12 8-12 8z',pause:'M7 5v14M17 5v14',prev:'M5 5v14m14-14L7 12l12 7z',next:'M19 5v14M5 5l12 7-12 7z',
    expand:'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12m13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    undo:'M3 10h10a7 7 0 0 1 0 14M3 10l5-5M3 10l5 5',redo:'M21 10H11a7 7 0 0 0 0 14m10-14-5-5m5 5-5 5',
    pointer:'m5 3 4 17 4-6 7-3z',hand:'M8 12V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 4-3 7-7 7H10c-2 0-4-2-5-4L2 12c-1-3 2-4 4-1z',
    magnet:'M4 4h5v9a3 3 0 0 0 6 0V4h5v9a8 8 0 0 1-16 0zM4 8h5m6 0h5',
    minus:'M5 12h14',fit:'M3 3v18M21 3v18M7 12h10m-7-4-4 4 4 4m4-8 4 4-4 4',
    link:'M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l2-2',
    film:'M3 4h18v16H3zM7 4v16M17 4v16M3 9h4m10 0h4M3 15h4m10 0h4',
    image:'M3 3h18v18H3zM3 16l6-6 5 5 3-3 4 4M16 7h.1',wave:'M2 10v4M6 6v12M10 3v18M14 7v10M18 5v14M22 10v4',
    clock:'M12 8v5l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    settings:'M5 3v18M12 3v18M19 3v18M2 8h6m1 8h6m1-10h6',
    spark:'m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7z',
    check:'m5 12 4 4L20 5',close:'m6 6 12 12M6 18 18 6',
    trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    duplicate:'M9 9h12v12H9zM15 9V3H3v12h6',
    help:'M9 8a3 3 0 1 1 6 1c-1 2-3 2-3 5m0 3h.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    dice:'M4 4h16v16H4zM8 8h.1M16 8h.1M12 12h.1M8 16h.1M16 16h.1',edit:'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z',folder:'M3 7V4h7l2 3h9v13H3z',
    keyboard:'M2 5h20v14H2zM5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10'
  };
  function icon(name){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.film}"/></svg>`;}
  const actionNames={home:'项目',help:'操作说明',undo:'撤销',redo:'重做',pointer:'选择',hand:'平移',snap:'吸附',chain:'后续联动',duplicate:'复制',delete:'删除','zoom-out':'缩小','zoom-in':'放大',fit:'适应全部','close-dialog':'关闭'};
  function ib(action,name,title,active='',pressed=null){return `<button class="icon-button ${active}" data-action="${action}" title="${title}" aria-label="${title}"${pressed===null?'':` aria-pressed="${pressed}"`}>${icon(name)}<span>${esc(actionNames[action]||title)}</span></button>`;}
  const launch=window.TDStills.launch;
  // Tiny authored starfield placeholder, not a model output.
  const stars=`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><defs><radialGradient id="g"><stop stop-color="#46415a"/><stop offset="1" stop-color="#202432"/></radialGradient></defs><rect width="800" height="450" fill="url(#g)"/>${Array.from({length:88},(_,i)=>`<circle cx="${(i*137.2)%800}" cy="${(i*71.13)%450}" r="${i%13?'.7':'1.5'}" fill="#ded9e8" opacity="${.25+(i%7)/10}"/>`).join('')}<ellipse cx="350" cy="225" rx="150" ry="5" fill="#dca5a6" opacity=".12" transform="rotate(-24 350 225)"/></svg>`;
  const sampleAssets=[{id:'launch-wide',name:'发射场 · 全景',kind:'image',src:launch,detail:'640 × 427 · 示例静帧'},{id:'launch-detail',name:'塔架 · 局部',kind:'image',src:launch,detail:'画面参考 · 同一原图'},{id:'stars',name:'星空 · 视觉占位',kind:'image',src:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(stars),detail:'程序绘制 · 视觉占位'}];
  // Static input examples, never a listing of the user's disk. Source identity
  // is separate from the project's stable Picture/Video/Audio number.
  const demoInputFiles=[
    {path:'demo_launch.jpg',name:'发射场 · 全景',kind:'image',src:launch,sampleId:'launch-wide'},
    {path:'references/demo_tower.jpg',name:'塔架 · 局部',kind:'image',src:launch,sampleId:'launch-detail'},
    {path:'references/demo_stars.svg',name:'星空 · 视觉占位',kind:'image',src:sampleAssets[2].src,sampleId:'stars'},
    {path:'references/demo_launch_alt.jpg',name:'发射场 · 备选示例',kind:'image',src:launch}
  ];
  sampleAssets.forEach(asset=>{asset.source={type:'demo-input',path:demoInputFiles.find(file=>file.sampleId===asset.id).path};});
  // Media objects live once per page. The project stores active asset IDs, so
  // import/delete undo does not copy blobs or invalidate a restored Object URL.
  sampleAssets.forEach((asset,index)=>asset.number=index+1);
  let assets=embedded?[]:sampleAssets.slice(),nextPoolNumber=embedded?{image:1,video:1,audio:1}:{image:4,video:1,audio:1};
  let assetGridKey='';
  const mediaNames={image:'Picture',video:'Video',audio:'Audio'};
  const mediaPattern=()=>/<(Picture|Video|Audio)\s+(\d+)>/gi;
  const mediaKey=(kind,number)=>`${kind.toLowerCase()}:${Number(number)}`;
  const prompts=[
    'integrated_multimodal_description:\n[Shot 1] [00:00] 黎明前的发射场，塔架静立，远处的工作灯映着薄雾。\nThe camera pushes in 缓缓靠近主体。\noverall_soundscape:\n远处的风声与设备低鸣。',
    'subject_definitions:\n<Picture 1> 发射场与塔架，作为场景和构图参考。\n\ndetailed_description:\n[Shot 1] [00:00] 承接上一片段，冷蓝色天幕逐渐被暖光照亮。\nThe camera tilts up 摄影机沿塔架缓慢上移，保持场景与主体一致。\n(S1) <d>[Chinese] 准备好了，我们出发。</d>\n\noverall_soundscape:\n延续环境风声。',
    'detailed_description:\n[Shot 1] [00:00] 摄影机继续靠近主体，金属表面浮现细腻的光泽。\nThe camera pushes in 保持连续的清晨光线。',
    'detailed_description:\n[Shot 1] [00:00] 镜头离开发射场，望向辽阔天幕，让最后一束光自然淡出画面。\noverall_soundscape:\n空间逐渐安静。'
  ];
  const demoInitial=[['发射前夜',0,10],['蓝调时刻',8,18],['靠近光',16,26],['向更远处',24,34]].map((a,i)=>({id:`clip-${i+1}`,name:a[0],start:a[1]*C.FPS,end:a[2]*C.FPS,asset:i===3?'stars':'launch-wide',refs:[],prompt:prompts[i],resolution:{...R.DEFAULT},seed:241907+i,audio:true,guide:'画面参考'}));
  const initial=embedded?[]:demoInitial;
  const activity=new Map(),emptyActivity={status:'idle',progress:0,elapsedSeconds:0,completedAt:null};
  const activityFor=c=>activity.get(c?.id)||emptyActivity;
  function resetActivity(){activity.clear();for(const [id,seconds] of [['clip-1',300],['clip-2',186]])activity.set(id,{status:'completed',progress:1,elapsedSeconds:seconds,completedAt:'2026-09-28T07:00:00Z',example:true});}
  if(!embedded)resetActivity();else activity.clear();
  let state={clips:C.copy(initial),selected:embedded?null:'clip-2',assetIds:embedded?[]:sampleAssets.map(a=>a.id)},history=new C.History();
  let resolutionEditBefore=null;
  let title='远航之前',promptView='visual',editBefore=null,durationEditBefore=null,nextId=embedded?1:5,nextAsset=1,toastTimer=0,jobTimer=0,jobId=null,timeline=null,embedDirty=false;
  let generationPreviewEnabled=true,lastPreviewRun=null;
  let promptEditor=null;
  const app=$('#app');
  if(embedded)document.body.classList.add('td-embedded');
  app.innerHTML=`
    <header class="topbar">
      <div class="brand"><span class="brand-mark">${icon('film')}</span>TerryDirector</div>
      <div class="top-timeline-leading"><button class="button ghost" data-action="new">${icon('plus')}新建片段</button></div>
      <div class="top-timeline-duration"><span>总时长</span><output id="timelineDuration" aria-label="总时长">00:00:00:00</output></div>
      <div class="top-actions">${embedded?'':`<span class="prototype">交互 DEMO · 06.11 EDITOR</span>`}${ib('help','keyboard','操作说明')}<button class="button primary save-close" data-action="save-close">${icon('check')}保存并退出</button>${embedded?`<button class="editor-close" data-action="close-editor" title="关闭并返回 ComfyUI" aria-label="关闭并返回 ComfyUI">${icon('close')}</button>`:''}</div>
    </header>
    <section class="timeline-panel" id="timelinePanel" aria-label="时间轴">
      <div class="timeline-toolbar"><div class="timeline-controls"><div class="timeline-tools">${ib('undo','undo','撤销（Ctrl / ⌘ Z）')}${ib('redo','redo','重做（Ctrl / ⌘ Shift Z）')}<span class="separator"></span>${ib('pointer','pointer','选择与移动片段（V）','is-active')}${ib('hand','hand','平移时间线（H / 鼠标中键）')}${ib('snap','magnet','吸附（S），拖动时 Alt 临时关闭','is-active')}${ib('chain','link','后续联动：移动或调整片段尾部时，后方所有片段跟随；头部裁剪不联动','is-active',true)}${ib('duplicate','duplicate','复制选中片段至末尾')}${ib('delete','trash','删除选中片段（Delete）')}</div><span class="spacer"></span><div class="timeline-zoom">${ib('zoom-out','minus','缩小（−）')}<input type="range" min="0" max="100" value="35" id="zoomRange" aria-label="时间线缩放">${ib('zoom-in','plus','放大（＋）')}${ib('fit','fit','适应全部片段（F）')}</div></div></div>
      <div class="timeline-body" id="timelineBody"><canvas class="timeline-canvas content" aria-hidden="true"></canvas><canvas class="timeline-canvas overlay" tabindex="0" aria-label="单行时间线。拖动片段移动，拖动片段边缘裁剪；重叠区及下方引线标记为只读。左右键步进，Ctrl Z 撤销。"></canvas></div>
      <div class="timeline-bottom"><div class="timeline-scroll" id="scrollBar"><div class="scroll-thumb" id="scrollThumb"></div></div></div>
    </section>
    <div id="timelineResize" class="resize-h" role="separator" tabindex="0" aria-label="调整时间线高度" aria-orientation="horizontal"></div>
    <main id="workspace" class="workspace">
      <section class="prompt-panel" aria-label="提示词编辑">
        <header class="composer-heading"><div class="clip-identity"><span class="clip-number-badge" id="clipNumber"></span><input id="clipName" class="clip-name" aria-label="片段名称" maxlength="60"><button class="clip-name-edit" data-action="edit-clip-name" type="button" title="编辑片段名称" aria-label="编辑片段名称">${icon('edit')}</button></div><div class="clip-duration-control" aria-label="片段时长"><input id="clipDurationNumber" type="number" min="1" step="0.01" aria-label="片段秒数"><span>s</span><input id="clipDurationRange" type="range" min="1" max="15" step="0.0416667" aria-label="片段秒数滑块"></div><button class="prompt-view-switch" data-action="toggle-prompt-view" type="button" aria-label="切换提示词显示方式" aria-pressed="false"><span>可视化</span><i aria-hidden="true"></i><span>纯文本</span></button></header>
        <div class="prompt-editor"><div class="prompt-editor-body"><textarea id="promptText" aria-label="当前片段提示词" placeholder="描述这个片段的画面、动作和声音。" spellcheck="false"></textarea><div id="promptVisual" class="prompt-visual h3-editor" contenteditable="true" role="textbox" aria-label="可视化提示词编辑器" aria-multiline="true" spellcheck="false" tabindex="0" data-placeholder="描述片段，输入 @ 引用素材，输入 / 插入 H3 语法"></div><div id="noClip" class="empty-state" hidden><strong>从一个片段开始</strong><p>在时间线上新建片段，再填写提示词与参考资产。</p><button class="button" data-action="new">${icon('plus')}新建片段</button></div></div><div class="prompt-head prompt-editor-footer"><span class="subtle prompt-help">@ 引用素材　/ H3 语法</span><span id="promptCount" class="subtle prompt-count"></span></div></div>

      </section>
      <div id="referenceResize" class="resize-v" role="separator" tabindex="0" aria-label="调整参考资产区域宽度" aria-orientation="vertical"></div>
        <section class="reference-panel" aria-label="资产池">
        <header class="reference-heading"><strong>资产池 <span id="refCount">0</span></strong><div class="reference-actions" role="group" aria-label="添加资产来源"><button class="button ghost" data-action="upload-assets" title="选择本地图片、视频或音频；Demo 仅在本页读取，不实际上传">${icon('upload')}上传资产</button><button class="button ghost" data-action="pick-input" title="从 ComfyUI input 选择已有文件；当前使用明确标记的示例目录">${icon('folder')}从 ComfyUI input 选取</button></div></header>
        <div class="reference-body" id="referenceDrop"><div class="reference-grid" id="references"></div><p class="reference-hint">上传新文件或从 input 选取已有文件<br>加入资产池，全部片段可引用</p></div>

        </section>
    </main>
    <input type="file" id="fileInput" accept="image/*,video/*,audio/*" multiple hidden>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <dialog id="dialog"><div class="modal-header"><strong id="dialogTitle"></strong>${ib('close-dialog','close','关闭弹窗')}</div><div class="modal-body" id="dialogBody"></div><div class="modal-actions" id="dialogActions"></div></dialog>
    <svg width="0" height="0" aria-hidden="true" style="position:absolute;pointer-events:none"><defs><clipPath id="folder-outline" clipPathUnits="objectBoundingBox"><path d="M0 .15 Q0 0 .06 0 H.32 C.36 0 .36 .13 .42 .13 H.94 Q1 .13 1 .27 V.87 Q1 1 .94 1 H.06 Q0 1 0 .87 Z"/></clipPath></defs></svg>`;
  const current=()=>state.clips.find(c=>c.id===state.selected);
  const getImage=c=>assets.find(a=>c?.refs.includes(a.id)&&a.kind==='image')?.src||'';
  function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3000);}
  function modal(name,body,confirmText,fn){
    promptEditor?.closeMenu();stopDialogMedia();const d=$('#dialog');d.dataset.mode='';$('#dialogTitle').textContent=name;$('#dialogBody').innerHTML=body;
    $('#dialogActions').innerHTML=confirmText?`<button class="button ghost" data-action="close-dialog">取消</button><button class="button primary" id="dialogConfirm">${esc(confirmText)}</button>`:'<button class="button" data-action="close-dialog">完成</button>';
    if(confirmText)$('#dialogConfirm').onclick=()=>{if(fn?.()!==false)d.close();};if(!d.open)d.showModal();
  }
  function markEdited(){
    if(embedded){
      embedDirty=true;
      window.parent.postMessage({type:'terrydirector:dirty',dirty:true},hostOrigin);
    }
  }
  function finishPromptEdit(){if(editBefore){if(history.push(editBefore,state))markEdited();editBefore=null;updateHistory();}}
  function commit(before){syncAllReferences();history.push(before,state);renderAll();markEdited();}
  function mutate(fn){finishResolutionEdit();finishPromptEdit();const before=C.copy(state);fn();commit(before);}
  function updateHistory(){ $('[data-action=undo]').disabled=!history.undoItems.length;$('[data-action=redo]').disabled=!history.redoItems.length; }
  function renderPrompt(){
    const c=current(),text=c?.prompt||'';
    $('#noClip').hidden=!!c;
    promptEditor.setContext(c?.id||null,text,promptView);
    const viewSwitch=$('.prompt-view-switch');
    if(viewSwitch){
      const isText=promptView==='text';
      viewSwitch.classList.toggle('is-text',isText);
      viewSwitch.setAttribute('aria-pressed',String(isText));
      viewSwitch.title=isText?'当前：纯文本，点击切换到可视化':'当前：可视化，点击切换到纯文本';
    }
    $('#promptCount').textContent=c?`${text.length} 字`:'';
  }
  function renderTimelineDuration(clips){
    const frames=C.arrangementFrames(clips),output=$('#timelineDuration');
    const text=C.timecode(frames);
    if(output.textContent!==text)output.textContent=text;
    output.title=`总时长 · 时:分:秒:帧 · ${C.FPS} FPS · ${frames} 帧；从零点到最后片段结尾，包含空隙，重叠不重复计时。`;
    output.setAttribute('aria-label',`总时长 ${C.seconds(frames)}，${frames} 帧`);
  }
  function renderClipDuration(clips=state.clips){
    const c=clips.find(x=>x.id===state.selected);
    const number=$('#clipDurationNumber'),range=$('#clipDurationRange');
    if(!number||!range)return;
    const control=number.closest('.clip-duration-control');
    const enabled=!!c;
    number.disabled=!enabled;range.disabled=!enabled;
    if(!c){number.value='';if(control)control.title='';return;}
    const frames=c.end-c.start,seconds=frames/C.FPS,aligned=C.h3AlignedFrames(frames);
    number.value=Number(seconds.toFixed(2));
    range.max='15';
    range.value=String(Math.min(15,seconds));
    const hint=aligned===frames
      ? `输出 ${Number(seconds.toFixed(2))}s · ${frames} 帧 · H3 已对齐`
      : `输出 ${Number(seconds.toFixed(2))}s · ${frames} 帧 · H3 内部生成 ${aligned} 帧后裁切 ${aligned-frames} 帧`;
    if(control)control.title=hint;
    number.title=hint;range.title=hint;
  }
  function renderTiming(clips=state.clips){
    renderTimelineDuration(clips);
    renderClipDuration(clips);
  }
  function beginDurationEdit(){
    if(!current()||durationEditBefore)return;
    finishPromptEdit();
    durationEditBefore=C.copy(state);
  }
  function previewDuration(seconds){
    const c=current(),value=Number(seconds);
    if(!c||!Number.isFinite(value))return;
    const frames=Math.max(C.FPS,Math.round(value*C.FPS)),targetEnd=c.start+frames;
    state.clips=timeline?.chainEnabled
      ? C.trimEndFollowing(state.clips,c.id,targetEnd)
      : C.editClip(state.clips,c.id,'right',targetEnd);
    timeline?.setClips(state.clips);
    timeline?.select(state.selected);
    renderTiming(state.clips);
  }
  function finishDurationEdit(){
    if(!durationEditBefore)return;
    if(history.push(durationEditBefore,state))markEdited();
    durationEditBefore=null;
    updateHistory();
    renderAll();
    requestAnimationFrame(()=>timeline?.fit());
  }
  function poolEntries(){
    const active=new Set(state.assetIds);
    return assets.filter(a=>active.has(a.id)).map(a=>({...a,token:`${mediaNames[a.kind]} ${a.number}`}));
  }
  function referencesIn(prompt,entries=poolEntries()){
    const lookup=new Map(entries.map(a=>[mediaKey(mediaNames[a.kind],a.number),a.id]));
    const ids=new Set();
    for(const m of String(prompt||'').matchAll(mediaPattern())){
      const id=lookup.get(mediaKey(m[1],m[2]));if(id)ids.add(id);
    }
    return [...ids];
  }
  function syncReferences(clip,entries=poolEntries()){
    if(!clip)return false;
    const refs=referencesIn(clip.prompt,entries),changed=JSON.stringify(refs)!==JSON.stringify(clip.refs);
    clip.refs=refs;return changed;
  }
  function syncAllReferences(){const entries=poolEntries();state.clips.forEach(c=>syncReferences(c,entries));}
  function refreshAssetUsage(){
    const c=current();
    for(const tile of $('#references').querySelectorAll('[data-reference]')){
      const id=tile.dataset.reference,used=!!c?.refs.includes(id);
      const users=state.clips.filter(clip=>clip.refs.includes(id));
      tile.classList.toggle('is-referenced',used);
      const badge=tile.querySelector('.asset-current-use');badge.hidden=!used;
      tile.querySelector('.asset-token').title=users.length
        ? `引用片段：${users.map(clip=>clip.name).join('、')}`:'尚未被片段引用';
      tile.querySelector('[data-insert-ref]').disabled=!c;
    }
  }
  function renderReferences(){
    const entries=poolEntries();$('#refCount').textContent=entries.length;
    // Selection changes only update usage badges. Keep the shared grid and its
    // scroll position stable while moving between clips or editing a prompt.
    const key=entries.map(a=>a.id).join('|');
    if(assetGridKey!==key||!$('#references').children.length){
      const scroll=$('#referenceDrop').scrollTop;assetGridKey=key;
      $('#references').innerHTML=entries.map(a=>`<div class="reference-tile" draggable="true" data-reference="${a.id}"><button class="reference-insert" data-preview-ref="${a.id}" title="查看 ${esc(a.name)}" aria-label="查看 ${esc(a.name)}"><div class="reference-cover">${a.kind==='image'?`<img src="${esc(a.src)}" alt="">`:icon(a.kind==='video'?'film':'wave')}<span class="asset-token">${esc(a.token)}</span><span class="asset-current-use" hidden>当前引用</span></div><strong>${esc(a.name)}</strong><small title="${esc(a.source?.type==='comfy-input'?'ComfyUI input/'+a.source.path:a.source?.path?'示例 input/'+a.source.path:a.local?'仅本页读取，未上传':'示例素材')}">${a.kind==='image'?'图片':a.kind==='video'?'视频':'音频'}${a.source?.type==='comfy-input'?' · input':a.source?.type==='demo-input'?' · input 示例':a.local?' · 本地':''}</small></button><div class="reference-tools"><button data-insert-ref="${a.id}" title="插入 &lt;${a.token}&gt; 到当前片段">${icon('link')}<span>插入引用</span></button><button class="remove-reference" data-delete-asset="${a.id}" title="从资产池删除 ${esc(a.name)}" aria-label="从资产池删除 ${esc(a.name)}">${icon('trash')}<span>删除</span></button></div></div>`).join('');
      $('#referenceDrop').scrollTop=scroll;
    }
    refreshAssetUsage();
  }
  function stopDialogMedia(){
    $('#dialogBody')?.querySelectorAll('video,audio').forEach(media=>{media.pause();media.removeAttribute('src');media.load();});
  }
  function previewAsset(id){
    const asset=assets.find(a=>a.id===id);if(!asset)return;
    promptEditor.closeMenu();stopDialogMedia();
    const d=$('#dialog');d.dataset.mode='media';$('#dialogTitle').textContent=asset.name;
    $('#dialogActions').innerHTML='<button class="button" data-action="close-dialog">关闭</button>';
    const body=$('#dialogBody');body.replaceChildren();
    const wrap=document.createElement('div');wrap.className='asset-lightbox';
    const media=document.createElement(asset.kind==='image'?'img':asset.kind);
    if(asset.kind==='image'){media.alt=asset.name;media.decoding='async';}
    else{media.controls=true;media.preload='metadata';media.playsInline=true;media.setAttribute('aria-label',asset.name);}
    media.addEventListener('error',()=>{if(!media.isConnected||!d.open)return;wrap.replaceChildren();wrap.textContent='浏览器无法预览此格式，素材仍可作为参考保留。';});
    wrap.append(media);body.append(wrap);media.src=asset.src;
    const note=document.createElement('p');note.className='asset-lightbox-note';note.textContent=`${asset.source?.type==='comfy-input'?'ComfyUI input/'+asset.source.path:asset.source?.type==='demo-input'?'示例 input/'+asset.source.path:asset.local?'本地文件 · 未上传':'示例'}参考素材 · 非生成结果`;body.append(note);
    if(!d.open)d.showModal();
  }
  function renderGenerationPreview(){
    const toggle=$('#generationPreviewToggle');
    toggle.setAttribute('aria-checked',String(generationPreviewEnabled));
    toggle.querySelector('.preview-switch-value').textContent=generationPreviewEnabled?'开启':'关闭';
    const img=$('#generationPreviewImage'),empty=$('#generationPreviewEmpty');
    // Progress belongs to the task, not the preview switch or editing selection.
    const run=lastPreviewRun,record=run?activity.get(run.id):null;
    const progress=record?.progress||0;
    $('#generationPreviewClip').textContent=run?run.label:'尚未运行任务';
    $('#generationPreviewBar').style.width=`${Math.round(progress*100)}%`;
    $('#generationPreviewStatus').textContent=record?.status==='running'?`模拟 ${Math.round(progress*100)}% · ${record.elapsedSeconds.toFixed(1)}s`:run?'模拟完成 · 参考静帧占位，非模型输出':'当前未连接 ComfyUI';
    // The panel and its controls stay in layout. OFF only stops displaying preview frames.
    if(!generationPreviewEnabled||!$('#projectHome').hidden){
      img.removeAttribute('src');img.hidden=true;img.style.filter='none';
      $('.generation-preview-noise').style.opacity='0';
      empty.hidden=false;empty.textContent=generationPreviewEnabled?'等待生成预览':'生成预览已关闭';
      return;
    }
    // Never show the newly selected clip's reference as if it were the run's output.
    const src=run?.source||'';
    if(src){if(img.getAttribute('src')!==src)img.src=src;img.hidden=false;empty.hidden=true;}
    else{img.removeAttribute('src');img.hidden=true;empty.hidden=false;empty.textContent=run?'本次模拟没有画面占位':'等待生成预览';}
    img.style.filter=record?.status==='running'?`blur(${(1-progress)*8}px) saturate(${.55+progress*.55})`:'none';
    $('.generation-preview-noise').style.opacity=record?.status==='running'?String((1-progress)*.32):'0';
  }
  function setGenerationPreview(enabled){generationPreviewEnabled=!!enabled;renderGenerationPreview();}
  function resolutionFromControls(){
    const ratio=$('#aspectRatioSelect'),mp=$('#megapixelsInput'),multiple=$('#multipleInput');
    if(!current()||!mp.validity.valid||!multiple.validity.valid)return null;
    const settings={aspect_ratio:ratio.value,megapixels:mp.valueAsNumber,multiple:multiple.valueAsNumber};
    try{return {settings,...R.calculate(settings)};}catch{return null;}
  }
  function renderResolutionResult(){
    const result=resolutionFromControls(),output=$('#resolutionResult');
    output.textContent=result?`${result.width} × ${result.height}`:'— × —';
    output.title=result?'实际宽 × 高（像素）；宽高分别取到最近的指定倍数。':'像素量 0.1–16 MP；倍数 8–128，步长 4。';
    output.classList.toggle('is-invalid',!!current()&&!result);
    for(const field of [$('#megapixelsInput'),$('#multipleInput')])field.setAttribute('aria-invalid',String(!!current()&&!field.validity.valid));
  }
  function renderResolution(){
    const c=current(),settings=c?.resolution||R.DEFAULT;
    $('#aspectRatioSelect').value=settings.aspect_ratio;
    $('#megapixelsInput').value=settings.megapixels;
    $('#multipleInput').value=settings.multiple;
    $('#resolutionControls').querySelectorAll('input,select').forEach(field=>field.disabled=!c);
    renderResolutionResult();
  }
  function finishResolutionEdit(){
    if(!resolutionEditBefore)return;
    if(history.push(resolutionEditBefore,state))markEdited();
    resolutionEditBefore=null;updateHistory();
  }
  function updateResolution(){
    const c=current();if(!c)return;
    if(!resolutionEditBefore)resolutionEditBefore=C.copy(state);
    const result=resolutionFromControls();
    // Partial/invalid input never enters project data; keep the last valid settings.
    if(result)c.resolution=result.settings;
    renderResolutionResult();renderActivity();
  }
  function renderActivity(){
    const c=current(),a=activityFor(c),button=$('#generateButton');button.disabled=!c||!!jobId||!(c.prompt||'').trim()||!resolutionFromControls();
    button.innerHTML=icon('spark')+(jobId?(jobId===c?.id?`模拟生成 ${Math.round(a.progress*100)}%`:'其他片段生成中…'):'模拟生成当前片段');
    button.title='只演示生成进度，不调用 ComfyUI';renderGenerationPreview();
  }
  function renderAll(){
    if(!state.clips.some(c=>c.id===state.selected))state.selected=state.clips[0]?.id||null;
    syncAllReferences();
    const c=current();$('#clipNumber').textContent=c?`片段 ${state.clips.indexOf(c)+1}`:'暂无片段';
    $('#clipName').value=c?.name||'';$('#clipName').disabled=!c;$('#clipName').hidden=!c;
    renderPrompt();renderTiming();renderReferences();updateHistory();
    if(timeline){timeline.setClips(state.clips);timeline.select(state.selected);}
  }
  function select(id,seek=false){finishDurationEdit();finishPromptEdit();state.selected=id;if(timeline){timeline.select(id);if(seek&&current())timeline.setFrame(current().start);}renderAll();}
  promptEditor=new window.TDH3Editor({
    visual:$('#promptVisual'),textarea:$('#promptText'),
    getAssets:()=>poolEntries().map(a=>({id:a.id,name:a.name,kind:a.kind==='image'?'picture':a.kind,raw:`<${a.token}>`,preview:a.kind==='image'?a.src:''})),
    onBeforeChange:()=>{if(!editBefore)editBefore=C.copy(state);},
    onChange:text=>{const c=current();if(c){c.prompt=text;if(syncReferences(c)){refreshAssetUsage();timeline?.invalidate();}}$('#promptCount').textContent=`${text.length} 字`;},
    onCommit:finishPromptEdit,
    onHistory:redo=>actions[redo?'redo':'undo']()
  });
  timeline=new window.TDTimeline($('#timelineBody'),{
    clips:state.clips,selected:state.selected,getImage,getActivity:activityFor,
    onSelect:id=>select(id),onFrame:()=>{},
    onPreview:clips=>renderTiming(clips),onDragEnd:()=>timeline.invalidate(),
    onCommit:(clips,beforeClips)=>{finishPromptEdit();const before={...C.copy(state),clips:beforeClips};state.clips=clips;commit(before);},
    onView:v=>{const max=Math.max(v.visible,v.contentWidth),width=Math.min(100,v.visible/max*100);$('#scrollThumb').style.width=width+'%';$('#scrollThumb').style.left=Math.min(100-width,v.scroll/max*100)+'%';$('#zoomRange').value=Math.log(v.ppf/.22)/Math.log(24/.22)*100;}
  });
  renderAll();timeline.setFrame(embedded?0:8*C.FPS);
  function generate(){
    const c=current();if(jobId||!c||!(c.prompt||'').trim()||!resolutionFromControls())return;
    finishResolutionEdit();
    finishPromptEdit();const id=c.id,start=performance.now();jobId=id;lastPreviewRun={id,label:`片段 ${state.clips.indexOf(c)+1} · ${c.name}`,source:getImage(c)};
    const record={status:'running',progress:0,elapsedSeconds:0,completedAt:null,example:false};activity.set(id,record);renderActivity();timeline.invalidate();
    jobTimer=setInterval(()=>{
      record.elapsedSeconds=(performance.now()-start)/1000;record.progress=Math.min(1,record.elapsedSeconds/6);
      if(record.progress>=1){clearInterval(jobTimer);jobTimer=0;jobId=null;record.status='completed';record.completedAt=new Date().toISOString();toast('模拟完成：已更新耗时，未生成视频。');}
      renderActivity();timeline.invalidate();
    },100);
  }
  function newClip(){appendClip('新的片段');}
  function appendClip(name,template){mutate(()=>{
    const prev=state.clips.at(-1),prev2=state.clips.at(-2),start=prev?Math.max(prev.start+1,prev.end-48,prev2?.end||0):0;
    const c=template?C.copy(template):{name,prompt:'',resolution:{...R.DEFAULT},seed:0,audio:true,guide:'画面参考',refs:[]};
    const duration=template?template.end-template.start:10*C.FPS;
    Object.assign(c,{id:'clip-'+nextId++,name,start,end:Math.max(start+duration,prev?prev.end+1:0)});state.clips.push(c);state.selected=c.id;
  });timeline.fit();}
  // A reference is written into the clip's single prompt. The refs array is a
  // derived list of stable asset IDs; removing a prompt tag never deletes media.
  function appendReferences(clip,ids){
    const entries=poolEntries(),used=new Set(referencesIn(clip.prompt,entries));
    const add=entries.filter(a=>ids.includes(a.id)&&!used.has(a.id));
    if(add.length)clip.prompt+=(clip.prompt&&!clip.prompt.endsWith('\n')?'\n':'')+add.map(a=>`<${a.token}>`).join(' ');
  }
  function addReference(id,clipId=state.selected){
    const clip=state.clips.find(c=>c.id===clipId);
    if(clip&&state.assetIds.includes(id)&&!clip.refs.includes(id))mutate(()=>appendReferences(clip,[id]));
  }
  function deleteAsset(id){
    const asset=poolEntries().find(a=>a.id===id);if(!asset)return;
    finishPromptEdit();
    const users=state.clips.filter(c=>c.refs.includes(id));
    const detail=users.length
      ? `它被 ${users.length} 个片段引用：${users.map(c=>esc(c.name)).join('、')}。确认后也会移除这些片段中的对应引用标签。`
      : '该素材尚未被任何片段引用。';
    modal('从资产池删除',`<p>删除「${esc(asset.name)}」？</p><p>${detail}</p><p>不会删除本地文件；可撤销此操作。仅取消某片段的引用，请在该片段提示词中删除对应标签。</p>`,'删除素材',()=>{
      mutate(()=>{
        state.assetIds=state.assetIds.filter(x=>x!==id);
        const key=mediaKey(mediaNames[asset.kind],asset.number);
        for(const clip of state.clips)clip.prompt=clip.prompt.replace(mediaPattern(),(raw,kind,number)=>mediaKey(kind,number)===key?'':raw);
      });
      // Retain the cached media URL for undo and any active simulation snapshot.
    });
  }
  function insertReference(id){
    const a=poolEntries().find(x=>x.id===id);if(!a||!current())return;
    promptEditor.insert(`<${a.token}>`);
  }
  async function uploadInputFile(file){
    const data=new FormData();data.append('file',file,file.name);
    const response=await fetch('/terrydirector/api/upload',{method:'POST',body:data});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||`上传失败（${response.status}）`);
    return payload;
  }
  async function importFiles(files,targetId=null){
    if(!embedded){importDemoFiles(files,targetId);return;}
    const selected=[...files].filter(file=>['image','video','audio'].includes((file.type||'').split('/')[0]));
    if(!selected.length){toast('请选择图片、视频或音频。');return;}
    const added=[];
    try{
      for(const file of selected){
        const uploaded=await uploadInputFile(file),kind=uploaded.kind;
        let asset=assets.find(a=>a.source?.type==='comfy-input'&&a.source.path===uploaded.path);
        if(!asset){
          asset={id:'input-'+Date.now().toString(36)+'-'+nextAsset++,name:uploaded.name||file.name,kind,
            number:nextPoolNumber[kind]++,src:uploaded.preview_url||inputPreviewUrl(uploaded.path),
            source:{type:'comfy-input',path:uploaded.path}};
          assets.push(asset);
        }
        added.push(asset.id);
      }
      mutate(()=>{
        for(const id of added)if(!state.assetIds.includes(id))state.assetIds.push(id);
        const clip=state.clips.find(c=>c.id===targetId);if(clip)appendReferences(clip,added);
      });
      toast(`已上传并加入资产池 ${added.length} 项${targetId?'，并引用到目标片段':'，所有片段均可引用'}。`);
    }catch(error){toast(error?.message||'上传失败。');}
  }
  function importDemoFiles(files,targetId=null){
    const added=[];for(const file of files){const kind=file.type.split('/')[0];if(!['image','video','audio'].includes(kind))continue;
      const asset={id:'local-'+Date.now().toString(36)+'-'+nextAsset++,name:file.name,kind,number:nextPoolNumber[kind]++,src:URL.createObjectURL(file),local:true,source:{type:'upload-demo',name:file.name}};assets.push(asset);added.push(asset.id);
    }
    if(!added.length){toast('请选择图片、视频或音频。');return;}
    mutate(()=>{
      state.assetIds.push(...added);
      const clip=state.clips.find(c=>c.id===targetId);if(clip)appendReferences(clip,added);
    });
    toast(`已加入资产池 ${added.length} 项${targetId?'，并引用到目标片段':'，所有片段均可引用'}。文件未上传。`);
  }
  async function pickInputAssets(){
    if(!embedded){pickDemoInputAssets();return;}
    finishResolutionEdit();finishPromptEdit();
    let files=[];
    try{
      const response=await fetch('/terrydirector/api/input-files',{cache:'no-store'});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload.error||`读取 input 失败（${response.status}）`);
      files=Array.isArray(payload.files)?payload.files:[];
    }catch(error){toast(error?.message||'无法读取 ComfyUI input。');return;}
    const selected=new Set(),inPool=path=>poolEntries().some(a=>a.source?.type==='comfy-input'&&a.source.path===path);
    modal('从 ComfyUI input 选取',`
      <div class="input-picker-location">${icon('folder')}<span>ComfyUI / input</span><span class="subtle">${files.length} 个媒体文件</span></div>
      <input id="inputAssetSearch" type="search" placeholder="搜索文件名或子目录" aria-label="搜索 input 文件">
      <div id="inputAssetList" class="input-picker-list"></div>
      <p id="inputSelectionCount" class="subtle" aria-live="polite">已选 0 项</p>`,'加入资产池',()=>{
        const chosen=files.filter(file=>selected.has(file.path)&&!inPool(file.path));
        if(!chosen.length)return false;
        mutate(()=>{
          for(const file of chosen){
            let asset=assets.find(a=>a.source?.type==='comfy-input'&&a.source.path===file.path);
            if(!asset){
              asset={id:'input-'+Date.now().toString(36)+'-'+nextAsset++,name:file.name,kind:file.kind,
                number:nextPoolNumber[file.kind]++,src:file.preview_url||inputPreviewUrl(file.path),
                source:{type:'comfy-input',path:file.path}};
              assets.push(asset);
            }
            if(!state.assetIds.includes(asset.id))state.assetIds.push(asset.id);
          }
        });
        toast(`已从 ComfyUI input 加入 ${chosen.length} 项，所有片段均可引用。`);
      });
    $('#dialog').dataset.mode='input-picker';
    const list=$('#inputAssetList'),search=$('#inputAssetSearch'),confirm=$('#dialogConfirm');
    function updateSelection(){
      $('#inputSelectionCount').textContent=`已选 ${selected.size} 项`;
      confirm.disabled=!selected.size;
      confirm.textContent=selected.size?`加入资产池（${selected.size}）`:'加入资产池';
    }
    function renderList(){
      const query=search.value.trim().toLowerCase(),matches=files.filter(file=>`${file.path} ${file.name}`.toLowerCase().includes(query));
      list.innerHTML=matches.map(file=>{
        const added=inPool(file.path);
        return `<label class="input-file-row ${added?'is-added':''}">
          <input type="checkbox" data-input-path="${esc(file.path)}" aria-label="选择 ${esc(file.path)}" ${added?'disabled':''} ${selected.has(file.path)?'checked':''}>
          <span class="input-file-thumb">${file.kind==='image'?`<img src="${esc(file.preview_url||inputPreviewUrl(file.path))}" alt="">`:icon(file.kind==='video'?'film':'wave')}</span>
          <span class="input-file-info"><strong>${esc(file.name)}</strong><small>${esc(file.path)}</small></span>
          <span class="input-file-status">${added?'已在资产池':file.kind==='image'?'图片':file.kind==='video'?'视频':'音频'}</span>
        </label>`;
      }).join('')||'<p class="input-picker-empty">没有匹配的媒体文件</p>';
    }
    list.addEventListener('change',event=>{
      const box=event.target.closest('[data-input-path]');if(!box||box.disabled)return;
      if(box.checked)selected.add(box.dataset.inputPath);else selected.delete(box.dataset.inputPath);
      updateSelection();
    });
    search.addEventListener('input',renderList);renderList();updateSelection();search.focus();
  }
  function pickDemoInputAssets(){
    finishResolutionEdit();finishPromptEdit();
    const selected=new Set();
    const inPool=path=>poolEntries().some(a=>a.source?.type==='demo-input'&&a.source.path===path);
    modal('从 ComfyUI input 选取',`
      <p class="input-demo-note"><strong>示例目录 · 尚未连接 ComfyUI</strong><br>这里只演示选取流程，没有读取你本地的 input，也不会上传或复制文件。</p>
      <div class="input-picker-location">${icon('folder')}<span>ComfyUI / input</span><span class="subtle">演示</span></div>
      <input id="inputAssetSearch" type="search" placeholder="搜索文件名或子目录" aria-label="搜索 input 示例文件">
      <div id="inputAssetList" class="input-picker-list"></div>
      <p id="inputSelectionCount" class="subtle" aria-live="polite">已选 0 项</p>`, '加入资产池',()=>{
        const files=demoInputFiles.filter(file=>selected.has(file.path)&&!inPool(file.path));
        if(!files.length)return false;
        mutate(()=>{
          for(const file of files){
            // Reuse the cached entry after pool deletion / undo; never upload or
            // allocate a second project entry for the same input-relative path.
            let asset=assets.find(a=>a.source?.type==='demo-input'&&a.source.path===file.path);
            if(!asset){
              asset={id:'input-demo-'+nextAsset++,name:file.name,kind:file.kind,src:file.src,
                number:nextPoolNumber[file.kind]++,source:{type:'demo-input',path:file.path}};
              assets.push(asset);
            }
            if(!state.assetIds.includes(asset.id))state.assetIds.push(asset.id);
          }
        });
        toast(`已从示例 input 加入 ${files.length} 项；没有读取真实目录，所有片段可引用。`);
      });
    $('#dialog').dataset.mode='input-picker';
    const list=$('#inputAssetList'),search=$('#inputAssetSearch'),confirm=$('#dialogConfirm');
    function updateSelection(){
      $('#inputSelectionCount').textContent=`已选 ${selected.size} 项`;
      confirm.disabled=!selected.size;
      confirm.textContent=selected.size?`加入资产池（${selected.size}）`:'加入资产池';
    }
    function renderList(){
      const query=search.value.trim().toLowerCase();
      const files=demoInputFiles.filter(file=>`${file.path} ${file.name}`.toLowerCase().includes(query));
      list.innerHTML=files.map(file=>{
        const added=inPool(file.path);
        return `<label class="input-file-row ${added?'is-added':''}">
          <input type="checkbox" data-input-path="${esc(file.path)}" aria-label="选择 ${esc(file.path)}" ${added?'disabled':''} ${selected.has(file.path)?'checked':''}>
          <span class="input-file-thumb"><img src="${esc(file.src)}" alt=""></span>
          <span class="input-file-info"><strong>${esc(file.name)}</strong><small>${esc(file.path)}</small></span>
          <span class="input-file-status">${added?'已在资产池':'示例图片'}</span>
        </label>`;
      }).join('')||'<p class="input-picker-empty">没有匹配的文件</p>';
    }
    list.addEventListener('change',event=>{
      const box=event.target.closest('[data-input-path]');if(!box||box.disabled)return;
      if(box.checked)selected.add(box.dataset.inputPath);else selected.delete(box.dataset.inputPath);
      updateSelection();
    });
    search.addEventListener('input',renderList);
    renderList();updateSelection();search.focus();
  }
  function resetAssetCache(withSamples){
    // Called only after clearing project history: detached local files can now
    // be released. A new project has its own empty pool, not the previous one.
    stopDialogMedia();
    assets.filter(a=>a.local).forEach(a=>URL.revokeObjectURL(a.src));
    assets=withSamples?sampleAssets.slice():[];
    nextPoolNumber={image:withSamples?4:1,video:1,audio:1};assetGridKey='';
  }
  function showHome(){finishPromptEdit();promptEditor.closeMenu();stopDialogMedia();$('#generationPreviewImage').removeAttribute('src');timeline.stop();$('#workspace').hidden=true;$('#timelineResize').hidden=true;$('#timelinePanel').hidden=true;$('#projectHome').hidden=false;
    $('#projectHome').innerHTML=`<div class="home-heading"><div><div class="eyebrow">YOUR CREATIVE SPACE</div><h1>每一个故事，从这里开始。</h1><p>打开项目，回到创作。</p></div><button class="button" data-action="project-new">${icon('plus')}新建项目</button></div><div class="project-grid"><div class="tsd-project-folder-item"><button class="tsd-project-folder-card has-cover" data-action="open-project"><div class="tsd-project-folder-sheet tsd-project-folder-paper"></div><div class="tsd-project-folder-sheet tsd-project-folder-paper-middle"></div><div class="tsd-project-folder-sheet tsd-project-folder-cover" style="background-image:url('${esc(launch)}')"></div><div class="tsd-project-folder-front"><div class="tsd-project-folder-tab">当前演示项目</div><h3>${esc(title)}</h3><p>镜头、提示词与参考资产。</p><footer><span>${state.clips.length} 个片段</span><span>${state.assetIds.length} 个素材</span></footer></div></button></div></div><p class="home-foot">项目仅在当前页面暂存，刷新会还原。可导出配置保留本次编排。</p>`;
  }
  function openProject(){ $('#projectHome').hidden=true;$('#workspace').hidden=false;$('#timelineResize').hidden=false;$('#timelinePanel').hidden=false;timeline.resize();renderGenerationPreview(); }
  function exportConfig(){finishResolutionEdit();finishPromptEdit();const payload={format:'terrydirector-demo',version:8,referenceNumbering:'project-stable',fps:C.FPS,project:{title},clips:state.clips.map(c=>({...C.copy(c),resolution:{...c.resolution,...R.calculate(c.resolution)}})),assets:poolEntries().map(({id,name,kind,number,token,local,source})=>({id,name,kind,number,token,requiresReimport:!!local,source:source?{...source}:undefined})),note:'任务编排 Demo，不是 ComfyUI 工作流。不包含媒体文件。'};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='TerryDirector-demo.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
  }
  function setChainEnabled(enabled){
    timeline.cancel();timeline.chainEnabled=!!enabled;
    const button=$('[data-action=chain]');
    button.classList.toggle('is-active',timeline.chainEnabled);
    button.setAttribute('aria-pressed',String(timeline.chainEnabled));
    button.title=timeline.chainEnabled?'后续联动已开启：移动或调整片段尾部时，后方所有片段跟随；头部裁剪不联动':'后续联动已关闭：移动和裁剪仅影响当前片段';
    button.setAttribute('aria-label',button.title);
  }
  function help(){modal('时间线编排 Demo','<p>导演台浮窗只负责创作编排：顶部是时间线，下方是提示词与资产池。分辨率、采样器、种子、步数、二采和其他生成参数都不在浮窗里设置。</p><p>在时间线选择片段后编辑提示词；输入 @ 搜索资产，输入 / 打开 H3 语法菜单。可视化与纯文本使用同一份原文。</p><p>资产池由当前 TerryDirector 节点的全部片段共用；上传和从 ComfyUI input 选取都只加入资产池，不自动写入片段。</p>');}
  function assetFromDocument(raw,index){
    const path=String(raw?.source?.path||'').replaceAll('\\\\','/').split('/').filter(Boolean).join('/'),kind=String(raw?.kind||'');
    if(!path||!['image','video','audio'].includes(kind))return null;
    return {id:String(raw.id||`asset-${index+1}`),name:String(raw.name||path.split('/').at(-1)||path),kind,
      number:Math.max(1,Number.parseInt(raw.number,10)||1),src:inputPreviewUrl(path),source:{type:'comfy-input',path}};
  }
  function loadDocument(documentData){
    finishPromptEdit();timeline?.cancel();stopDialogMedia();
    const raw=documentData&&typeof documentData==='object'?documentData:{};
    assets=(Array.isArray(raw.assets)?raw.assets:[]).map(assetFromDocument).filter(Boolean);
    nextPoolNumber={image:1,video:1,audio:1};
    for(const asset of assets)nextPoolNumber[asset.kind]=Math.max(nextPoolNumber[asset.kind],asset.number+1);
    const validAssets=new Set(assets.map(a=>a.id));
    const clips=(Array.isArray(raw.clips)?raw.clips:[]).map((clip,index)=>{
      const start=Math.max(0,Number.parseInt(clip?.start,10)||0),end=Math.max(start+1,Number.parseInt(clip?.end,10)||start+C.FPS*10);
      return {id:String(clip?.id||`clip-${index+1}`),name:String(clip?.name||`片段 ${String(index+1).padStart(2,'0')}`),
        start,end,prompt:String(clip?.prompt||''),refs:(Array.isArray(clip?.refs)?clip.refs.map(String):[]).filter(id=>validAssets.has(id)),
        resolution:{...R.DEFAULT},seed:0,audio:true,guide:'画面参考'};
    });
    state={clips,selected:clips.some(c=>c.id===raw.selected)?raw.selected:(clips[0]?.id||null),assetIds:assets.map(a=>a.id)};
    history=new C.History();assetGridKey='';activity.clear();
    nextId=Math.max(0,...clips.map(c=>Number.parseInt(String(c.id).split('-').at(-1),10)||0))+1;
    nextAsset=assets.length+1;embedDirty=false;
    renderAll();timeline.fit();timeline.setFrame(current()?.start||0);
    window.parent.postMessage({type:'terrydirector:dirty',dirty:false},hostOrigin);
  }
  function documentPayload(){
    finishPromptEdit();syncAllReferences();
    return {version:1,fps:C.FPS,selected:state.selected,
      clips:state.clips.map(({id,name,start,end,prompt,refs})=>({id,name,start,end,prompt,refs:[...refs]})),
      assets:poolEntries().filter(a=>a.source?.path).map(a=>({id:a.id,name:a.name,kind:a.kind,number:a.number,
        source:{type:'comfy-input',path:a.source.path}}))};
  }
  function confirmCloseEditor(){
    promptEditor?.closeMenu();stopDialogMedia();
    const d=$('#dialog');
    d.dataset.mode='confirm-close';
    $('#dialogTitle').textContent='保存修改？';
    $('#dialogBody').innerHTML='<p>当前导演台有尚未保存的修改。</p><p class="subtle">保存后退出，或放弃本次修改返回 ComfyUI。</p>';
    $('#dialogActions').innerHTML='<button class="button ghost" data-action="close-dialog">继续编辑</button><button class="button ghost" id="dialogDiscardChanges">放弃修改</button><button class="button primary" id="dialogSaveChanges">✓ 保存并退出</button>';
    $('#dialogDiscardChanges').onclick=()=>{d.close();window.parent.postMessage({type:'terrydirector:discard-close'},hostOrigin);};
    $('#dialogSaveChanges').onclick=()=>{d.close();saveToHost();};
    if(!d.open)d.showModal();
  }
  function saveToHost(){
    finishPromptEdit();
    if(!embedded){markEdited();toast('已保存编排。正式接入 ComfyUI 后会同时隐藏浮窗。');return;}
    embedDirty=false;
    window.parent.postMessage({type:'terrydirector:dirty',dirty:false},hostOrigin);
    window.parent.postMessage({type:'terrydirector:save',document:documentPayload()},hostOrigin);
  }
  const actions={
    new:newClip,
    'upload-assets':()=>$('#fileInput').click(),
    'pick-input':pickInputAssets,
    help,
    'toggle-prompt-view':()=>{finishPromptEdit();promptView=promptView==='visual'?'text':'visual';renderPrompt();},
    'edit-clip-name':()=>{const input=$('#clipName');if(!input?.disabled){input.focus();input.select();}},
    'save-close':saveToHost,
    'close-editor':()=>{if(embedded)window.parent.postMessage({type:'terrydirector:request-close'},hostOrigin);},
    'close-dialog':()=>{stopDialogMedia();$('#dialog').close();},
    undo:()=>{finishPromptEdit();timeline.cancel();const prev=history.undo(state);if(prev){state=prev;renderAll();markEdited();}},
    redo:()=>{finishPromptEdit();timeline.cancel();const next=history.redo(state);if(next){state=next;renderAll();markEdited();}},
    pointer:()=>{timeline.hand=false;$('[data-action=pointer]').classList.add('is-active');$('[data-action=hand]').classList.remove('is-active');},
    hand:()=>{timeline.hand=true;$('[data-action=hand]').classList.add('is-active');$('[data-action=pointer]').classList.remove('is-active');},
    chain:()=>setChainEnabled(!timeline.chainEnabled),
    snap:()=>{timeline.snapEnabled=!timeline.snapEnabled;$('[data-action=snap]').classList.toggle('is-active',timeline.snapEnabled);},
    'zoom-out':()=>timeline.zoom(.8),'zoom-in':()=>timeline.zoom(1.25),fit:()=>timeline.fit(),
    delete:()=>{if(!current())return;timeline.cancel();mutate(()=>{state.clips=state.clips.filter(c=>c.id!==state.selected);state.selected=state.clips[0]?.id||null;});},
    duplicate:()=>{if(current())appendClip(current().name+' · 副本',current());},
    reset:()=>{setChainEnabled(true);finishPromptEdit();resetActivity();timeline.cancel();history=new C.History();resetAssetCache(true);state={clips:C.copy(initial),selected:'clip-2',assetIds:sampleAssets.map(a=>a.id)};renderAll();timeline.fit();timeline.setFrame(192);}
  };
  app.addEventListener('click',e=>{
    const target=e.target,button=target.closest('[data-action]');if(button){if(!button.disabled)actions[button.dataset.action]?.();return;}
    const preview=target.closest('[data-preview-ref]');if(preview){previewAsset(preview.dataset.previewRef);return;}
    const remove=target.closest('[data-delete-asset]');if(remove){deleteAsset(remove.dataset.deleteAsset);return;}
    const insert=target.closest('[data-insert-ref]');if(insert){insertReference(insert.dataset.insertRef);return;}

  });
  $('#clipName').addEventListener('change',e=>{if(current())mutate(()=>current().name=e.target.value.trim()||'未命名片段');});
  const durationRange=$('#clipDurationRange'),durationNumber=$('#clipDurationNumber');
  durationRange.addEventListener('pointerdown',beginDurationEdit);
  durationRange.addEventListener('input',e=>{beginDurationEdit();previewDuration(e.target.valueAsNumber);});
  for(const event of ['pointerup','pointercancel','lostpointercapture','change'])durationRange.addEventListener(event,finishDurationEdit);
  durationNumber.addEventListener('focus',beginDurationEdit);
  durationNumber.addEventListener('input',e=>{beginDurationEdit();if(e.target.validity.valid)previewDuration(e.target.valueAsNumber);});
  durationNumber.addEventListener('change',finishDurationEdit);
  durationNumber.addEventListener('blur',finishDurationEdit);
  durationNumber.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finishDurationEdit();e.target.blur();}});
  $('#fileInput').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
  $('#zoomRange').addEventListener('input',e=>{timeline.zoom((.22*Math.pow(24/.22,Number(e.target.value)/100))/timeline.ppf);});
  app.addEventListener('dragstart',e=>{const ref=e.target.closest('[data-reference]');if(ref){e.dataTransfer.setData('application/x-terrydirector-asset',ref.dataset.reference);e.dataTransfer.effectAllowed='copy';}});
  for(const id of ['referenceDrop','timelineBody']){
    const host=$('#'+id);host.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';if(id==='referenceDrop')host.classList.add('is-dragover');});
    host.addEventListener('dragleave',e=>{if(!host.contains(e.relatedTarget))host.classList.remove('is-dragover');});
    host.addEventListener('drop',e=>{
      e.preventDefault();host.classList.remove('is-dragover');
      let targetId=null;
      if(id==='timelineBody'){const clip=timeline.hitTest(timeline.point(e));if(!clip){toast('请放到一个片段上。');return;}select(clip.id);targetId=clip.id;}
      if(e.dataTransfer.files.length)importFiles(e.dataTransfer.files,targetId);
      else if(targetId)addReference(e.dataTransfer.getData('application/x-terrydirector-asset'),targetId);
    });
  }
  window.addEventListener('keydown',e=>{
    if(e.target.closest('input,textarea,select,[contenteditable=true],dialog,.h3-menu')||$('#dialog').open)return;
    const key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
    if(key==='escape'){timeline.cancel();return;}
    if(mod&&key==='z'){e.preventDefault();actions[e.shiftKey?'redo':'undo']();return;}if(mod&&key==='y'){e.preventDefault();actions.redo();return;}if(mod)return;
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();timeline.setFrame(timeline.frame+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?C.FPS:1));}
    else if(['Delete','Backspace'].includes(e.key)){e.preventDefault();actions.delete();}
    else if(key==='v')actions.pointer();else if(key==='h')actions.hand();else if(key==='s')actions.snap();else if(key==='f')actions.fit();else if(key==='+'||key==='=')actions['zoom-in']();else if(key==='-')actions['zoom-out']();else if(key==='home'){e.preventDefault();timeline.setFrame(0);}else if(key==='end'){e.preventDefault();timeline.setFrame(timeline.total);}
  });
  function resizeHandle(id,variable,min,max,axis,sign){
    const el=$('#'+id);let drag=null;
    const set=value=>app.style.setProperty(variable,C.clamp(value,min,max)+'px');
    el.addEventListener('pointerdown',e=>{e.preventDefault();drag={origin:axis==='x'?e.clientX:e.clientY,value:parseFloat(getComputedStyle(app).getPropertyValue(variable))};el.setPointerCapture(e.pointerId);});
    el.addEventListener('pointermove',e=>{if(drag)set(drag.value+((axis==='x'?e.clientX:e.clientY)-drag.origin)*sign);});
    for(const event of ['pointerup','pointercancel','lostpointercapture'])el.addEventListener(event,()=>drag=null);
    el.addEventListener('dblclick',()=>app.style.removeProperty(variable));
    el.addEventListener('keydown',e=>{const keys=axis==='x'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];if(keys.includes(e.key)){e.preventDefault();e.stopPropagation();set(parseFloat(getComputedStyle(app).getPropertyValue(variable))+(e.key===keys[1]?12:-12)*sign);}});
  }
  resizeHandle('referenceResize','--reference-width',280,680,'x',-1);resizeHandle('timelineResize','--timeline-height',200,400,'y',1);
  let scrollDrag=null;$('#scrollBar').addEventListener('pointerdown',e=>{const r=e.currentTarget.getBoundingClientRect(),v=timeline.viewInfo();scrollDrag={x:e.clientX,initial:timeline.scroll,scale:v.contentWidth/r.width};e.currentTarget.setPointerCapture(e.pointerId);if(e.target!==$('#scrollThumb')){timeline.setScroll((e.clientX-r.left)/r.width*v.contentWidth-v.visible/2);scrollDrag.initial=timeline.scroll;}});
  $('#scrollBar').addEventListener('pointermove',e=>{if(scrollDrag)timeline.setScroll(scrollDrag.initial+(e.clientX-scrollDrag.x)*scrollDrag.scale);});for(const event of ['pointerup','pointercancel','lostpointercapture'])$('#scrollBar').addEventListener(event,()=>scrollDrag=null);
  window.TerryDirectorDemo={getState:()=>C.copy(state),getAssets:()=>C.copy(poolEntries()),getDocument:()=>C.copy(documentPayload()),loadDocument,getActivity:id=>C.copy(activityFor({id})),timeline,editor:promptEditor,applyTheme:palette=>{for(const [key,value] of Object.entries(palette)){if(/^--td-(neutral|violet|warm|ink)-[a-z-]+$/.test(key)&&CSS.supports('color',value))document.body.style.setProperty(key,value);}timeline.readTheme();timeline.invalidate();},reset:()=>actions.reset()};
  $('#dialog').addEventListener('close',()=>{stopDialogMedia();if($('#dialog').dataset.mode==='media')$('#dialogBody').replaceChildren();});
  $('#dialog').addEventListener('click',e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.currentTarget.close();});
  if(embedded){
    window.addEventListener('message',event=>{
      if(event.origin!==hostOrigin||event.source!==window.parent)return;
      const message=event.data||{};
      if(message.type==='terrydirector:load')loadDocument(message.document);
      else if(message.type==='terrydirector:request-save')saveToHost();
      else if(message.type==='terrydirector:confirm-close')confirmCloseEditor();
    });
    window.parent.postMessage({type:'terrydirector:ready'},hostOrigin);
  }
  window.addEventListener('pagehide',()=>{stopDialogMedia();promptEditor.closeMenu();});
  window.addEventListener('beforeunload',()=>{stopDialogMedia();promptEditor.destroy();timeline.destroy();assets.filter(a=>a.local).forEach(a=>URL.revokeObjectURL(a.src));});
})();