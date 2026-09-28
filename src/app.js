/* Static task composer: prompt + references + timeline.
 * Optional reference preview only; no editing monitor, versions or generation backend. */
(function () {
  'use strict';
  const C=window.TDCore, $=s=>document.querySelector(s);
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
    dice:'M4 4h16v16H4zM8 8h.1M16 8h.1M12 12h.1M8 16h.1M16 16h.1',folder:'M3 7V4h7l2 3h9v13H3z',
    keyboard:'M2 5h20v14H2zM5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10'
  };
  function icon(name){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.film}"/></svg>`;}
  const actionNames={home:'项目',help:'操作说明',undo:'撤销',redo:'重做',pointer:'选择',hand:'平移',snap:'吸附',duplicate:'复制',delete:'删除','zoom-out':'缩小','zoom-in':'放大',fit:'适应全部','close-dialog':'关闭'};
  function ib(action,name,title,active=''){return `<button class="icon-button ${active}" data-action="${action}" title="${title}" aria-label="${title}">${icon(name)}<span>${esc(actionNames[action]||title)}</span></button>`;}
  const launch=window.TDStills.launch;
  // Tiny authored starfield placeholder, not a model output.
  const stars=`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><defs><radialGradient id="g"><stop stop-color="#46415a"/><stop offset="1" stop-color="#202432"/></radialGradient></defs><rect width="800" height="450" fill="url(#g)"/>${Array.from({length:88},(_,i)=>`<circle cx="${(i*137.2)%800}" cy="${(i*71.13)%450}" r="${i%13?'.7':'1.5'}" fill="#ded9e8" opacity="${.25+(i%7)/10}"/>`).join('')}<ellipse cx="350" cy="225" rx="150" ry="5" fill="#dca5a6" opacity=".12" transform="rotate(-24 350 225)"/></svg>`;
  const assets=[{id:'launch-wide',name:'发射场 · 全景',kind:'image',src:launch,detail:'640 × 427 · 示例静帧'},{id:'launch-detail',name:'塔架 · 局部',kind:'image',src:launch,detail:'画面参考 · 同一原图'},{id:'stars',name:'星空 · 视觉占位',kind:'image',src:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(stars),detail:'程序绘制 · 视觉占位'}];
  const prompts=[
    '[镜头 01] 黎明前的发射场，塔架静立，远处的工作灯映着薄雾。\n[运镜] 固定机位，缓慢推进。\n[声音] 远处的风声与设备低鸣。',
    '[镜头 02] 承接上一片段，摄影机沿塔架缓慢上移，冷蓝色天幕逐渐被暖光照亮。<Picture 1> 保持场景与主体一致。\n[运镜] 微幅仰拍，自然跟随。\n[声音] 延续环境风声。',
    '[镜头 03] 摄影机继续靠近主体，金属表面浮现细腻的光泽。镜头克制，保持连续的清晨光线。\n[运镜] 缓慢推近。',
    '[镜头 04] 镜头离开发射场，望向辽阔天幕，让最后一束光自然淡出画面。\n[声音] 空间逐渐安静。'
  ];
  const initial=[['发射前夜',0,10],['蓝调时刻',8,18],['靠近光',16,26],['向更远处',24,34]].map((a,i)=>({id:`clip-${i+1}`,name:a[0],start:a[1]*C.FPS,end:a[2]*C.FPS,asset:i===3?'stars':'launch-wide',refs:['launch-wide'],prompt:prompts[i],resolution:'720P',seed:241907+i,audio:true,guide:'画面参考'}));
  const activity=new Map(),emptyActivity={status:'idle',progress:0,elapsedSeconds:0,completedAt:null};
  const activityFor=c=>activity.get(c?.id)||emptyActivity;
  function resetActivity(){activity.clear();for(const [id,seconds] of [['clip-1',300],['clip-2',186]])activity.set(id,{status:'completed',progress:1,elapsedSeconds:seconds,completedAt:'2026-09-28T07:00:00Z',example:true});}
  resetActivity();
  let state={clips:C.copy(initial),selected:'clip-2'},history=new C.History();
  let title='远航之前',promptView='text',editBefore=null,nextId=5,nextAsset=1,toastTimer=0,jobTimer=0,jobId=null,timeline=null;
  let previewOpen=false,previewAssetId=null,previewClipId=null,previewKey='';
  const app=$('#app');
  app.innerHTML=`
    <header class="topbar">
      <div class="brand"><span class="brand-mark">${icon('film')}</span>TerryDirector<span class="brand-sub">STUDIO</span></div>
      <div class="crumbs">${ib('home','home','项目首页')}${icon('chevron')}<button id="projectName" data-action="rename-project">远航之前</button></div>
      <div class="top-actions"><span class="prototype">交互 DEMO · 04</span>${ib('help','keyboard','操作说明')}<button class="button ghost" data-action="export">${icon('download')}导出配置</button></div>
    </header>
    <main id="workspace" class="workspace">
      <section class="prompt-panel" aria-label="提示词编辑">
        <header class="composer-heading"><div class="clip-identity"><span class="eyebrow" id="clipNumber"></span><input id="clipName" class="clip-name" aria-label="片段名称" maxlength="60"></div><span id="clipTiming" class="clip-timing"></span></header>
        <div class="prompt-head"><strong>提示词</strong><div class="prompt-views" aria-label="提示词显示方式"><button data-prompt-view="visual">可视化</button><button data-prompt-view="text">纯文本</button></div></div>
        <div class="prompt-editor"><textarea id="promptText" aria-label="当前片段提示词" placeholder="描述这个片段的画面、动作和声音。" spellcheck="false"></textarea><div id="promptVisual" class="prompt-visual" hidden></div><div id="noClip" class="empty-state" hidden><strong>从一个片段开始</strong><p>在时间线上新建片段，再填写提示词与参考资产。</p><button class="button" data-action="new">${icon('plus')}新建片段</button></div></div>
        <footer class="composer-footer"><span id="promptUsed" class="subtle"></span><span class="subtle" id="promptCount"></span><div class="submit-controls"><label class="resolution">分辨率<select id="resolutionSelect" aria-label="生成分辨率"><option>720P</option><option>1080P</option></select></label><button class="button primary" id="generateButton" data-action="generate">${icon('spark')}模拟生成当前片段</button></div></footer>
      </section>
      <div id="referenceResize" class="resize-v" role="separator" tabindex="0" aria-label="调整参考资产区域宽度" aria-orientation="vertical"></div>
      <section class="reference-panel" aria-label="参考资产填充">
        <header class="reference-heading"><strong>参考资产 <span id="refCount">0</span></strong><button id="previewToggle" class="icon-button" data-action="toggle-preview" aria-expanded="false" aria-controls="previewPanel">${icon('eye')}<span>显示预览</span></button></header>
        <div class="reference-actions"><button class="button ghost" data-action="pick-assets">${icon('folder')}从项目选取</button><button class="button ghost" data-action="import">${icon('upload')}导入</button></div>
        <div class="reference-body" id="referenceDrop"><section id="previewPanel" class="reference-preview" aria-label="参考预览" hidden><div class="preview-heading"><span id="previewName">参考预览</span></div><div id="previewMedia" class="preview-media"></div><p id="previewNote" class="preview-note"></p></section><div class="reference-grid" id="references"></div><p class="reference-hint">拖入图片、视频或音频<br>只填充到当前片段</p></div>
        <footer class="reference-footer">点击资产插入引用标签 · 本地文件不会上传</footer>
      </section>
    </main>
    <div id="timelineResize" class="resize-h" role="separator" tabindex="0" aria-label="调整时间线高度" aria-orientation="horizontal"></div>
    <section class="timeline-panel" id="timelinePanel" aria-label="时间轴">
      <div class="timeline-toolbar"><strong>时间线</strong><button class="button ghost" data-action="new">${icon('plus')}新建片段</button><span class="separator"></span><div class="timeline-tools">${ib('undo','undo','撤销（Ctrl / ⌘ Z）')}${ib('redo','redo','重做（Ctrl / ⌘ Shift Z）')}<span class="separator"></span>${ib('pointer','pointer','选择与移动片段（V）','is-active')}${ib('hand','hand','平移时间线（H / 鼠标中键）')}${ib('snap','magnet','吸附（S），拖动时 Alt 临时关闭','is-active')}${ib('duplicate','duplicate','复制选中片段至末尾')}${ib('delete','trash','删除选中片段（Delete）')}</div><span class="spacer"></span><span class="timecode" id="timelineTime">00:00:00:00</span><div class="timeline-zoom">${ib('zoom-out','minus','缩小（−）')}<input type="range" min="0" max="100" value="35" id="zoomRange" aria-label="时间线缩放">${ib('zoom-in','plus','放大（＋）')}${ib('fit','fit','适应全部片段（F）')}</div></div>
      <div class="timeline-body" id="timelineBody"><canvas class="timeline-canvas content" aria-hidden="true"></canvas><canvas class="timeline-canvas overlay" tabindex="0" aria-label="单行时间线。拖动片段移动，拖动片段边缘裁剪；重叠区及下方引线标记为只读。左右键步进，Ctrl Z 撤销。"></canvas></div>
      <div class="timeline-bottom"><div class="timeline-scroll" id="scrollBar"><div class="scroll-thumb" id="scrollThumb"></div></div><small id="clipSummary"></small><small id="zoomLabel">24 FPS</small></div>
    </section>
    <footer class="statusbar"><span>离线交互 Demo · 生成仅为模拟</span><span id="editStatus">仅本页暂存 · 刷新还原</span><span class="right desktop-hint">拖动片段编排　·　Alt 暂停吸附　·　Ctrl + 滚轮缩放</span></footer>
    <section class="project-home" id="projectHome" hidden></section>
    <input type="file" id="fileInput" accept="image/*,video/*,audio/*" multiple hidden>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <dialog id="dialog"><div class="modal-header"><strong id="dialogTitle"></strong>${ib('close-dialog','close','关闭弹窗')}</div><div class="modal-body" id="dialogBody"></div><div class="modal-actions" id="dialogActions"></div></dialog>
    <svg width="0" height="0" aria-hidden="true" style="position:absolute;pointer-events:none"><defs><clipPath id="folder-outline" clipPathUnits="objectBoundingBox"><path d="M0 .15 Q0 0 .06 0 H.32 C.36 0 .36 .13 .42 .13 H.94 Q1 .13 1 .27 V.87 Q1 1 .94 1 H.06 Q0 1 0 .87 Z"/></clipPath></defs></svg>`;
  const current=()=>state.clips.find(c=>c.id===state.selected);
  const getImage=c=>assets.find(a=>c?.refs.includes(a.id)&&a.kind==='image')?.src||'';
  function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3000);}
  function modal(name,body,confirmText,fn){
    const d=$('#dialog');d.dataset.mode='';$('#dialogTitle').textContent=name;$('#dialogBody').innerHTML=body;
    $('#dialogActions').innerHTML=confirmText?`<button class="button ghost" data-action="close-dialog">取消</button><button class="button primary" id="dialogConfirm">${esc(confirmText)}</button>`:'<button class="button" data-action="close-dialog">完成</button>';
    if(confirmText)$('#dialogConfirm').onclick=()=>{if(fn?.()!==false)d.close();};if(!d.open)d.showModal();
  }
  function markEdited(){ $('#editStatus').textContent='已暂存于本页 · 刷新后还原'; }
  function finishPromptEdit(){if(editBefore){if(history.push(editBefore,state))markEdited();editBefore=null;updateHistory();}}
  function commit(before){history.push(before,state);renderAll();markEdited();}
  function mutate(fn){finishPromptEdit();const before=C.copy(state);fn();commit(before);}
  function updateHistory(){ $('[data-action=undo]').disabled=!history.undoItems.length;$('[data-action=redo]').disabled=!history.redoItems.length; }
  function renderPrompt(){
    const c=current(),text=c?.prompt||'',editor=$('#promptText');
    if(document.activeElement!==editor||editor.value!==text)editor.value=text;
    $('#noClip').hidden=!!c;editor.hidden=!c||promptView!=='text';$('#promptVisual').hidden=!c||promptView==='text';
    editor.disabled=!c;
    document.querySelectorAll('[data-prompt-view]').forEach(b=>{b.classList.toggle('is-active',b.dataset.promptView===promptView);b.setAttribute('aria-pressed',String(b.dataset.promptView===promptView));});
    $('#promptVisual').innerHTML=text?esc(text).replace(/\[([^\]]+)\]/g,(_,label)=>`<span class="tsd-prompt-tag tone-${label.includes('声音')?'audio':label.includes('运镜')?'camera':'shot'}">${label}</span>`).replace(/&lt;(Picture|Video|Audio) (\d+)&gt;/g,(_,kind,num)=>`<span class="tsd-prompt-tag tone-time">${kind} ${num}</span>`).replace(/\n/g,'<br>'):'<span class="subtle">尚未填写。切换到「纯文本」开始编辑。</span>';
    $('#promptUsed').textContent=c?(promptView==='visual'?'可视化只读 · 切换纯文本编辑':'纯文本编辑'):'';
    $('#promptCount').textContent=c?`${text.length} 字`:'';
  }
  function renderTiming(clips=state.clips){
    const c=clips.find(x=>x.id===state.selected),i=clips.indexOf(c),prev=clips[i-1],o=c&&prev?C.intersection(prev,c):{frames:0};
    $('#clipTiming').textContent=c?`${Number(((c.end-c.start)/C.FPS).toFixed(2))}s${o.frames?` · 重叠 ${Number((o.frames/C.FPS).toFixed(2))}s`:''}`:'';
    $('#clipTiming').title=c?`${C.timecode(c.start)} — ${C.timecode(c.end)}${o.frames?` · 与上一片段重叠 ${o.frames} 帧`:''}`:'';
  }
  function referenceEntries(c=current()){
    const counts={image:0,video:0,audio:0},names={image:'Picture',video:'Video',audio:'Audio'};
    return (c?.refs||[]).map(id=>assets.find(a=>a.id===id)).filter(Boolean).map(a=>({...a,token:`${names[a.kind]} ${++counts[a.kind]}`}));
  }
  function renderReferences(){
    const c=current(),entries=referenceEntries();$('#refCount').textContent=entries.length;
    $('#references').innerHTML=entries.map(a=>`<div class="reference-tile" draggable="true" data-reference="${a.id}"><button class="reference-insert" data-insert-ref="${a.id}" title="插入 &lt;${a.token}&gt;" aria-label="插入 ${esc(a.token)} 引用"><div class="reference-cover">${a.kind==='image'?`<img src="${esc(a.src)}" alt="">`:icon(a.kind==='video'?'film':'wave')}<span class="asset-token">${esc(a.token)}</span></div><strong>${esc(a.name)}</strong><small>${a.kind==='image'?'图片参考':a.kind==='video'?'视频参考':'音频参考'}</small></button><div class="reference-tools"><button data-preview-ref="${a.id}" title="预览 ${esc(a.name)}">${icon('eye')}<span>预览</span></button><button class="remove-reference" data-remove-ref="${a.id}" title="移除参考" aria-label="移除 ${esc(a.name)}">${icon('close')}<span>移除</span></button></div></div>`).join('')+`<button class="reference-add" data-action="import" ${!c?'disabled':''}>${icon('plus')}<span>添加参考</span><small>图片 / 视频 / 音频</small></button>`;
    for(const action of ['import','pick-assets'])document.querySelectorAll(`[data-action="${action}"]`).forEach(b=>b.disabled=!c);
  }
  // Only mount media on demand. Closing or changing the source stops decoding/playback.
  function clearPreview(){
    const host=$('#previewMedia');
    host.querySelectorAll('video,audio').forEach(media=>{media.pause();media.removeAttribute('src');media.load();});
    host.replaceChildren();previewKey='';
  }
  function pausePreview(){ $('#previewMedia').querySelectorAll('video,audio').forEach(media=>media.pause()); }
  function renderPreview(){
    const toggle=$('#previewToggle'),panel=$('#previewPanel');
    toggle.setAttribute('aria-expanded',String(previewOpen));
    toggle.classList.toggle('is-active',previewOpen);
    toggle.querySelector('span').textContent=previewOpen?'关闭预览':'显示预览';
    panel.hidden=!previewOpen;
    if(!previewOpen||!$('#projectHome').hidden){clearPreview();return;}
    const c=current(),entries=referenceEntries(c);
    if(previewClipId!==c?.id){previewAssetId=null;previewClipId=c?.id||null;}
    const asset=entries.find(a=>a.id===previewAssetId)||entries[0];
    previewAssetId=asset?.id||null;
    const key=c?`${c.id}:${asset?.id||'empty'}:${asset?.src||''}`:'no-clip';
    if(previewKey===key)return;
    clearPreview();previewKey=key;
    const host=$('#previewMedia'),note=$('#previewNote');
    host.classList.toggle('is-audio',asset?.kind==='audio');
    $('#previewName').textContent=asset?.name||'参考预览';
    note.textContent=asset?`${asset.kind==='image'?'图片':asset.kind==='video'?'视频':'音频'}参考 · ${asset.local?'本地文件':'示例素材'}，非生成结果`:'';
    if(!asset){host.textContent=c?'填充参考资产后可在这里预览':'先在时间线上选择片段';return;}
    const media=document.createElement(asset.kind==='image'?'img':asset.kind);
    if(asset.kind==='image'){media.alt=asset.name;media.decoding='async';}
    else {media.controls=true;media.preload='metadata';media.playsInline=true;media.setAttribute('aria-label',asset.name);}
    media.addEventListener('error',()=>{if(previewOpen&&previewKey===key){host.replaceChildren();host.textContent='无法预览此文件';note.textContent='浏览器可能不支持此格式，仍可作为参考资产保留。';}});
    host.append(media);media.src=asset.src;
  }
  function setPreview(open,assetId){
    previewOpen=open;
    if(assetId){previewAssetId=assetId;previewClipId=current()?.id||null;}
    renderPreview();
    if(open)$('#referenceDrop').scrollTop=0;
  }
  function renderActivity(){
    const c=current(),a=activityFor(c),button=$('#generateButton');button.disabled=!c||!!jobId||!(c.prompt||'').trim();
    button.innerHTML=icon('spark')+(jobId?(jobId===c?.id?`模拟生成 ${Math.round(a.progress*100)}%`:'其他片段生成中…'):'模拟生成当前片段');
    button.title='只演示生成进度，不调用 ComfyUI';
  }
  function renderAll(){
    if(!state.clips.some(c=>c.id===state.selected))state.selected=state.clips[0]?.id||null;
    const c=current();$('#clipNumber').textContent=c?`片段 ${String(state.clips.indexOf(c)+1).padStart(2,'0')}`:'暂无片段';
    $('#clipName').value=c?.name||'';$('#clipName').disabled=!c;$('#clipName').hidden=!c;
    $('#resolutionSelect').disabled=!c;$('#resolutionSelect').value=c?.resolution||'720P';
    renderPrompt();renderTiming();renderReferences();renderPreview();renderActivity();updateHistory();
    if(timeline){timeline.setClips(state.clips);timeline.select(state.selected);}
    $('#clipSummary').textContent=`${state.clips.length} 个片段 · ${C.overlaps(state.clips).length} 处重叠`;
  }
  function select(id,seek=false){finishPromptEdit();state.selected=id;if(timeline){timeline.select(id);if(seek&&current())timeline.setFrame(current().start);}renderAll();}
  timeline=new window.TDTimeline($('#timelineBody'),{
    clips:state.clips,selected:state.selected,getImage,getActivity:activityFor,
    onSelect:id=>select(id),onFrame:frame=>$('#timelineTime').textContent=C.timecode(frame),
    onPreview:clips=>renderTiming(clips),onDragEnd:()=>timeline.invalidate(),
    onCommit:(clips,beforeClips)=>{finishPromptEdit();const before={...C.copy(state),clips:beforeClips};state.clips=clips;commit(before);},
    onView:v=>{const max=Math.max(v.visible,v.contentWidth),width=Math.min(100,v.visible/max*100);$('#scrollThumb').style.width=width+'%';$('#scrollThumb').style.left=Math.min(100-width,v.scroll/max*100)+'%';$('#zoomLabel').textContent=`${Math.round(v.ppf*C.FPS)} px/s`;$('#zoomRange').value=Math.log(v.ppf/.22)/Math.log(24/.22)*100;}
  });
  renderAll();timeline.setFrame(8*C.FPS);
  function generate(){
    const c=current();if(jobId||!c||!(c.prompt||'').trim())return;
    finishPromptEdit();const id=c.id,start=performance.now();jobId=id;
    const record={status:'running',progress:0,elapsedSeconds:0,completedAt:null,example:false};activity.set(id,record);renderActivity();timeline.invalidate();
    jobTimer=setInterval(()=>{
      record.elapsedSeconds=(performance.now()-start)/1000;record.progress=Math.min(1,record.elapsedSeconds/6);
      if(record.progress>=1){clearInterval(jobTimer);jobTimer=0;jobId=null;record.status='completed';record.completedAt=new Date().toISOString();toast('模拟完成：已更新耗时，未生成视频。');}
      renderActivity();timeline.invalidate();
    },100);
  }
  function newClip(){modal('新建片段','<label>片段名称<input id="newClipName" type="text" value="新的片段" maxlength="60"></label><p>默认追加到末尾，与前一片段重叠 2 秒。之后可直接拖动调整。</p>','创建片段',()=>{const name=$('#newClipName').value.trim();if(!name)return false;appendClip(name);});}
  function appendClip(name,template){mutate(()=>{
    const prev=state.clips.at(-1),prev2=state.clips.at(-2),start=prev?Math.max(prev.start+1,prev.end-48,prev2?.end||0):0;
    const c=template?C.copy(template):{name,prompt:'',resolution:'720P',seed:0,audio:true,guide:'画面参考',refs:[]};
    const duration=template?template.end-template.start:10*C.FPS;
    Object.assign(c,{id:'clip-'+nextId++,name,start,end:Math.max(start+duration,prev?prev.end+1:0)});state.clips.push(c);state.selected=c.id;
  });timeline.fit();}
  function addReference(id){if(current()&&!current().refs.includes(id)&&assets.some(a=>a.id===id))mutate(()=>current().refs.push(id));}
  function removeReference(id){
    if(!current())return;const before=referenceEntries();mutate(()=>{
      const c=current();c.refs=c.refs.filter(x=>x!==id);const after=new Map(referenceEntries(c).map(a=>[a.id,a.token]));
      const replacements=new Map(before.map(a=>[a.token,after.has(a.id)?`<${after.get(a.id)}>`:'']));
      c.prompt=(c.prompt||'').replace(/<(Picture|Video|Audio) \d+>/g,token=>replacements.get(token.slice(1,-1))??token);
    });
  }
  function insertReference(id){
    const a=referenceEntries().find(x=>x.id===id);if(!a)return;
    const field=$('#promptText'),start=field.selectionStart,end=field.selectionEnd,token=`<${a.token}>`;
    mutate(()=>{const c=current(),text=c.prompt||'';c.prompt=text.slice(0,start)+token+text.slice(end);});promptView='text';renderPrompt();field.focus();field.setSelectionRange(start+token.length,start+token.length);
  }
  function importFiles(files){
    if(!current()){toast('先在时间线上新建或选择一个片段。');return;}
    const added=[];for(const file of files){const kind=file.type.split('/')[0];if(!['image','video','audio'].includes(kind))continue;
      const asset={id:'local-'+Date.now().toString(36)+'-'+nextAsset++,name:file.name,kind,src:URL.createObjectURL(file),local:true};assets.push(asset);added.push(asset.id);
    }
    if(added.length){mutate(()=>{current().refs.push(...added);if(previewOpen){previewClipId=current().id;previewAssetId=added[0];}});toast(`已填充 ${added.length} 项参考资产，文件未上传。`);}else toast('请选择图片、视频或音频。');
  }
  function pickAssets(){if(!current())return;modal('选择参考资产','',null);$('#dialog').dataset.mode='assets';renderPicker();}
  function renderPicker(){
    $('#dialogBody').innerHTML='<div class="asset-picker">'+assets.map(a=>`<button class="picker-item ${current()?.refs.includes(a.id)?'is-added':''}" data-pick-asset="${a.id}" ${current()?.refs.includes(a.id)?'disabled':''}><span class="picker-image">${a.kind==='image'?`<img src="${esc(a.src)}" alt="">`:icon(a.kind==='video'?'film':'wave')}</span><span><strong>${esc(a.name)}</strong><small>${current()?.refs.includes(a.id)?'已添加':'点击添加到当前片段'}</small></span>${icon(current()?.refs.includes(a.id)?'check':'plus')}</button>`).join('')+'</div>';
  }
  function showHome(){finishPromptEdit();pausePreview();clearPreview();timeline.stop();$('#workspace').hidden=true;$('#timelineResize').hidden=true;$('#timelinePanel').hidden=true;$('#projectHome').hidden=false;
    $('#projectHome').innerHTML=`<div class="home-heading"><div><div class="eyebrow">YOUR CREATIVE SPACE</div><h1>每一个故事，从这里开始。</h1><p>打开项目，回到创作。</p></div><button class="button" data-action="project-new">${icon('plus')}新建项目</button></div><div class="project-grid"><div class="tsd-project-folder-item"><button class="tsd-project-folder-card has-cover" data-action="open-project"><div class="tsd-project-folder-sheet tsd-project-folder-paper"></div><div class="tsd-project-folder-sheet tsd-project-folder-paper-middle"></div><div class="tsd-project-folder-sheet tsd-project-folder-cover" style="background-image:url('${esc(launch)}')"></div><div class="tsd-project-folder-front"><div class="tsd-project-folder-tab">当前演示项目</div><h3>${esc(title)}</h3><p>镜头、提示词与参考资产。</p><footer><span>${state.clips.length} 个片段</span><span>${assets.length} 个素材</span></footer></div></button></div></div><p class="home-foot">项目仅在当前页面暂存，刷新会还原。可导出配置保留本次编排。</p>`;
  }
  function openProject(){ $('#projectHome').hidden=true;$('#workspace').hidden=false;$('#timelineResize').hidden=false;$('#timelinePanel').hidden=false;timeline.resize();renderPreview(); }
  function exportConfig(){finishPromptEdit();const payload={format:'terrydirector-demo',version:4,fps:C.FPS,project:{title},clips:C.copy(state.clips),assets:assets.map(({id,name,kind,local})=>({id,name,kind,requiresReimport:!!local})),note:'任务编排 Demo，不是 ComfyUI 工作流。不包含媒体文件。'};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='TerryDirector-demo.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
  }
  function help(){modal('任务编排 Demo','<p>在时间线上选片段 → 编辑提示词 → 填充参考资产。新建片段在时间线工具栏左侧。</p><p>提示词只有「可视化 / 纯文本」两种显示方式，共用一份内容；可视化目前只读。</p><p>参考资产右上角可开启或关闭预览，也可点击资产的「预览」。图片、视频和音频使用本地媒体；关闭预览或切换片段会停止播放。预览不与时间线联播，也不改变当前编辑的片段。</p><p>拖动本体移动；拖动边缘裁剪。重叠框与引线时长自动显示，不可单独编辑。</p><p>Ctrl + 滚轮缩放；中键或 H 平移；V 选择；S 吸附；Alt 临时关闭吸附；左右键移动播放头；Ctrl Z 撤销；Ctrl Shift Z 重做；Delete 删除；Esc 取消拖动。</p><p>生成仅为进度模拟，不调用模型。刷新还原数据，导出不包含本地文件。当前不做片段版本管理。</p>');}
  const actions={
    home:showHome,'open-project':openProject,new:newClip,import:()=>$('#fileInput').click(),'pick-assets':pickAssets,export:exportConfig,help,generate,
    'close-dialog':()=>$('#dialog').close(),
    'toggle-preview':()=>setPreview(!previewOpen),
    'rename-project':()=>modal('项目名称',`<label>名称<input type="text" id="projectTitleInput" value="${esc(title)}" maxlength="60"></label>`,'确定',()=>{const name=$('#projectTitleInput').value.trim();if(!name)return false;title=name;$('#projectName').textContent=title;markEdited();}),
    'project-new':()=>modal('新建演示项目','<label>项目名称<input type="text" id="projectTitleInput" value="新的故事" maxlength="60"></label><p>本 Demo 只暂存一个项目，将替换当前编排。请先导出需要保留的配置。</p>','创建',()=>{const name=$('#projectTitleInput').value.trim();if(!name)return false;clearInterval(jobTimer);jobId=null;activity.clear();timeline.cancel();history=new C.History();state={clips:[],selected:null};title=name;$('#projectName').textContent=title;openProject();renderAll();timeline.fit();}),
    undo:()=>{finishPromptEdit();timeline.cancel();const prev=history.undo(state);if(prev){state=prev;renderAll();markEdited();}},
    redo:()=>{finishPromptEdit();timeline.cancel();const next=history.redo(state);if(next){state=next;renderAll();markEdited();}},
    pointer:()=>{timeline.hand=false;$('[data-action=pointer]').classList.add('is-active');$('[data-action=hand]').classList.remove('is-active');},
    hand:()=>{timeline.hand=true;$('[data-action=hand]').classList.add('is-active');$('[data-action=pointer]').classList.remove('is-active');},
    snap:()=>{timeline.snapEnabled=!timeline.snapEnabled;$('[data-action=snap]').classList.toggle('is-active',timeline.snapEnabled);},
    'zoom-out':()=>timeline.zoom(.8),'zoom-in':()=>timeline.zoom(1.25),fit:()=>timeline.fit(),
    delete:()=>{if(!current())return;if(jobId===current().id){toast('请等待当前模拟生成完成。');return;}timeline.cancel();mutate(()=>{state.clips=state.clips.filter(c=>c.id!==state.selected);state.selected=state.clips[0]?.id||null;});},
    duplicate:()=>{if(current())appendClip(current().name+' · 副本',current());},
    reset:()=>{setPreview(false);clearInterval(jobTimer);jobId=null;finishPromptEdit();resetActivity();timeline.cancel();history=new C.History();state={clips:C.copy(initial),selected:'clip-2'};title='远航之前';$('#projectName').textContent=title;openProject();renderAll();timeline.fit();timeline.setFrame(192);}
  };
  app.addEventListener('click',e=>{
    const target=e.target,button=target.closest('[data-action]');if(button){if(!button.disabled)actions[button.dataset.action]?.();return;}
    const preview=target.closest('[data-preview-ref]');if(preview){setPreview(true,preview.dataset.previewRef);return;}
    const remove=target.closest('[data-remove-ref]');if(remove){removeReference(remove.dataset.removeRef);return;}
    const insert=target.closest('[data-insert-ref]');if(insert){insertReference(insert.dataset.insertRef);return;}
    const pick=target.closest('[data-pick-asset]');if(pick&&!pick.disabled){addReference(pick.dataset.pickAsset);renderPicker();return;}
    const view=target.closest('[data-prompt-view]');if(view){finishPromptEdit();promptView=view.dataset.promptView;renderPrompt();}
  });
  $('#promptText').addEventListener('focus',()=>{editBefore=C.copy(state);});
  $('#promptText').addEventListener('input',e=>{const c=current();if(c){if(!editBefore)editBefore=C.copy(state);c.prompt=e.target.value;}$('#promptCount').textContent=`${e.target.value.length} 字`;renderActivity();});
  $('#promptText').addEventListener('blur',finishPromptEdit);
  $('#clipName').addEventListener('change',e=>{if(current())mutate(()=>current().name=e.target.value.trim()||'未命名片段');});
  $('#resolutionSelect').addEventListener('change',e=>{if(current())mutate(()=>current().resolution=e.target.value);});
  $('#fileInput').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
  $('#zoomRange').addEventListener('input',e=>{timeline.zoom((.22*Math.pow(24/.22,Number(e.target.value)/100))/timeline.ppf);});
  app.addEventListener('dragstart',e=>{const ref=e.target.closest('[data-reference]');if(ref){e.dataTransfer.setData('application/x-terrydirector-asset',ref.dataset.reference);e.dataTransfer.effectAllowed='copy';}});
  for(const id of ['referenceDrop','timelineBody']){
    const host=$('#'+id);host.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';if(id==='referenceDrop')host.classList.add('is-dragover');});
    host.addEventListener('dragleave',e=>{if(!host.contains(e.relatedTarget))host.classList.remove('is-dragover');});
    host.addEventListener('drop',e=>{
      e.preventDefault();host.classList.remove('is-dragover');
      if(id==='timelineBody'){const clip=timeline.hitTest(timeline.point(e));if(!clip){toast('请放到一个片段上。');return;}select(clip.id);}
      if(e.dataTransfer.files.length)importFiles(e.dataTransfer.files);else addReference(e.dataTransfer.getData('application/x-terrydirector-asset'));
    });
  }
  window.addEventListener('keydown',e=>{
    if(e.target.closest('input,textarea,select,[contenteditable=true],dialog,#previewPanel')||$('#dialog').open||!$('#projectHome').hidden)return;
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
  resizeHandle('referenceResize','--reference-width',280,520,'x',-1);resizeHandle('timelineResize','--timeline-height',220,400,'y',-1);
  let scrollDrag=null;$('#scrollBar').addEventListener('pointerdown',e=>{const r=e.currentTarget.getBoundingClientRect(),v=timeline.viewInfo();scrollDrag={x:e.clientX,initial:timeline.scroll,scale:v.contentWidth/r.width};e.currentTarget.setPointerCapture(e.pointerId);if(e.target!==$('#scrollThumb')){timeline.setScroll((e.clientX-r.left)/r.width*v.contentWidth-v.visible/2);scrollDrag.initial=timeline.scroll;}});
  $('#scrollBar').addEventListener('pointermove',e=>{if(scrollDrag)timeline.setScroll(scrollDrag.initial+(e.clientX-scrollDrag.x)*scrollDrag.scale);});for(const event of ['pointerup','pointercancel','lostpointercapture'])$('#scrollBar').addEventListener(event,()=>scrollDrag=null);
  window.TerryDirectorDemo={getState:()=>C.copy(state),getActivity:id=>C.copy(activityFor({id})),timeline,applyTheme:palette=>{for(const [key,value] of Object.entries(palette)){if(/^--td-(neutral|violet|warm|ink)-[a-z-]+$/.test(key)&&CSS.supports('color',value))document.body.style.setProperty(key,value);}timeline.readTheme();timeline.invalidate();},reset:()=>actions.reset()};
  window.addEventListener('pagehide',clearPreview);
  window.addEventListener('pageshow',()=>{if(previewOpen)renderPreview();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pausePreview();});
  window.addEventListener('beforeunload',()=>{clearPreview();clearInterval(jobTimer);timeline.destroy();assets.filter(a=>a.local).forEach(a=>URL.revokeObjectURL(a.src));});
})();
