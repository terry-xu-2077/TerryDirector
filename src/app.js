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
  const actionNames={home:'项目',help:'操作说明',undo:'撤销',redo:'重做',pointer:'选择',hand:'平移',snap:'吸附',chain:'后续联动',duplicate:'复制',delete:'删除',suspend:'挂起','zoom-out':'缩小','zoom-in':'放大',fit:'适应全部','close-dialog':'关闭'};
  function ib(action,name,title,active='',pressed=null){return `<button class="icon-button ${active}" data-action="${action}" title="${title}" aria-label="${title}"${pressed===null?'':` aria-pressed="${pressed}"`}>${icon(name)}<span>${esc(actionNames[action]||title)}</span></button>`;}
  const launch=window.TDStills.launch;
  // The stand-alone website uses the exact three-clip acceptance workflow.
  // Embedded ComfyUI nodes still receive their live documents from the host.
  const sampleAssets=[];
  const demoInputFiles=[];
  const demoInitial=[];
  const initial=[];
  let assets=[],nextPoolNumber={image:1,video:1,audio:1};
  let siteDemoDocument=null;
  const siteDemoPath='examples/TerryDirector_AI_3clips_0.2MP.json';
  const siteDemoAiPath='examples/TerryDirector_AI_3clips_demo_prompts.json';
  const siteDemoLabels=['人物参考','载具参考','场景遗迹','荒星地貌','避难所','货币道具','地下虫群'];
  function siteDemoThumbnail(number){
    // Explicit placeholder: the seven original source images are NOT in Git.
    const n=Math.max(1,Math.min(7,Math.floor(Number(number)||1)));
    const colors=['#716451','#626c79','#70637e','#5e617b','#687586','#83767c','#62727f'];
    const shade=colors[n-1];
    const label=siteDemoLabels[n-1];
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">'
      +'<defs><linearGradient id="g" x2="0.8" y2="1"><stop stop-color="'+shade+'"/><stop offset="1" stop-color="#242834"/></linearGradient></defs>'
      +'<rect width="240" height="240" fill="url(#g)"/>'
      +'<rect x="19" y="19" width="202" height="202" rx="8" fill="none" stroke="#d4c6dc" stroke-opacity=".15"/>'
      +'<circle cx="120" cy="79" r="29" fill="#c9c0d9" fill-opacity=".08" stroke="#dfd9eb" stroke-opacity=".26"/>'
      +'<path d="M108 79h24m-12-12v24" stroke="#e4dcec" stroke-opacity=".45" stroke-width="2"/>'
      +'<text x="120" y="138" text-anchor="middle" fill="#f1eafa" font-size="18" font-family="sans-serif">'
      +label+'</text>'
      +'<text x="120" y="163" text-anchor="middle" fill="#d5d1dd" font-size="11" font-family="sans-serif">PREVIEW UNAVAILABLE</text>'
      +'<text x="120" y="187" text-anchor="middle" fill="#c8c0d0" font-size="11" font-family="sans-serif">Picture '+n+'</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  }
  async function loadSiteDemo(){
    try{
      const response=await fetch(new URL(siteDemoPath,document.baseURI),{cache:'no-store'});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const workflow=await response.json();
      const node=workflow.nodes?.find(item=>item.type==='TerryDirector');
      const serialized=node?.widgets_values_named?.config_json;
      if(typeof serialized!=='string')throw new Error('找不到 TerryDirector 时间线');
      const documentData=JSON.parse(serialized).document;
      if(!Array.isArray(documentData?.clips)||!Array.isArray(documentData?.assets))
        throw new Error('示例文件缺少片段或资产');
      const sampleResponse=await fetch(new URL(siteDemoAiPath,document.baseURI),{cache:'no-store'});
      if(!sampleResponse.ok)throw new Error('无法加载 H3 Skill 静态示例增强稿 (HTTP '+sampleResponse.status+')');
      const sample=await sampleResponse.json();
      if(sample?.skill!=='h3-prompt-writing'||sample?.mode!=='Ref2VA'
          ||sample?.workflow!==siteDemoPath||sample?.clips?.length!==documentData.clips.length)
        throw new Error('H3 Skill 示例增强稿和验收工作流不一致');
      for(const result of sample.clips){
        const clip=documentData.clips.find(item=>item.id===result.id);
        if(!clip||typeof result.aiPrompt!=='string'||!result.aiPrompt.trim())
          throw new Error('示例增强稿片段缺失：'+String(result.id));
        // These are manually authored fixture texts, never actual Qwen results.
        // Deliberately use a nonnumeric seed so imported demo data cannot be
        // silently mistaken for a valid AI Seed cache in a real Queue.
        clip.aiPrompt=result.aiPrompt;
        clip.promptMode='ai';
        clip.aiMetadata={
          seed:'demo',provenance:'skill-authored-demo',model:'Static site example',
          skill:'h3-prompt-writing',sourcePrompt:clip.prompt,
          sourceGlobalPrompt:clip.useGlobalPrompt===false?'':documentData.globalPrompt
        };
      }
      if(typeof sample.globalAiPrompt!=='string'||!sample.globalAiPrompt.trim())
        throw new Error('静态全局增强稿缺失');
      documentData.aiGlobalPrompt=sample.globalAiPrompt;
      documentData.globalPromptMode='user';
      documentData.globalAiMetadata={
        seed:'demo',provenance:'skill-authored-demo',model:'Static site example',
        skill:'h3-prompt-writing-global',sourcePrompt:documentData.globalPrompt
      };
      siteDemoDocument=C.copy(documentData);
      // Only the ?global-ai=1&show-ai-global=1 screenshot route defaults
      // to the enhanced tab. Normal website visits still show the original.
      if(new URLSearchParams(location.search).get('show-ai-global')==='1')
        siteDemoDocument.globalPromptMode='ai';
      demoInputFiles.splice(0,demoInputFiles.length,...documentData.assets.map(item=>({
        path:item.source?.path||'',name:item.name,kind:item.kind,
        src:siteDemoThumbnail(item.number),number:item.number,id:item.id
      })));
      loadDocument(siteDemoDocument);
      app.dataset.demoSource=siteDemoPath;
      app.dataset.demoAiSource=siteDemoAiPath;
      app.dataset.demoAiVersion='skill-authored-demo';
      app.dataset.demoClipCount=String(state.clips.length);
      app.dataset.demoAssetCount=String(state.assetIds.length);
      // Enable controls for visual QA; no actual inference will run here.
      aiConfig={previewOnly:true};renderAiControls();
      title='特瑞 · 荒星三镜头';
      toast('已载入 3 段和全局 H3 Skill 静态增强稿，支持与原文切换。');
      if(new URLSearchParams(location.search).get('global-ai')==='1')
        requestAnimationFrame(()=>openGlobalPrompt());
      return documentData;
    }catch(error){
      console.error('[TerryDirector Demo] Failed to load acceptance workflow:',error);
      toast('无法加载示例工作流，请从网页服务器或分支在线预览链接打开。');
      return null;
    }
  }
  let assetGridKey='';
  const mediaNames={image:'Picture',video:'Video',audio:'Audio'};
  const mediaPattern=()=>/<(Picture|Video|Audio)\s+(\d+)>/gi;
  const mediaKey=(kind,number)=>`${kind.toLowerCase()}:${Number(number)}`;
  const transitionLabels={tail_reference:'尾帧参考',tail_continuation:'尾帧续接',independent:'独立'};
  const normalizeTransitionMode=(value,fallback='tail_continuation')=>Object.hasOwn(transitionLabels,value)?value:fallback;
  const activity=new Map(),emptyActivity={status:'idle',progress:0,elapsedSeconds:0,completedAt:null};
  const activityFor=c=>activity.get(c?.id)||emptyActivity;
  function resetActivity(){activity.clear();}
  if(!embedded)resetActivity();else activity.clear();
  let state={globalPrompt:'',aiGlobalPrompt:'',globalPromptMode:'user',globalAiMetadata:{},autoAiEnhance:false,clips:C.copy(initial),selected:null,assetIds:[]},history=new C.History();
  let resolutionEditBefore=null;
  let title='特瑞 · 荒星三镜头',promptView='visual',globalPromptView='visual',editBefore=null,durationEditBefore=null,nextId=embedded?1:5,nextAsset=1,toastTimer=0,timeline=null,embedDirty=false,hostReadonly=false,defaultTransitionMode='tail_reference';
  let promptEditor=null,globalPromptEditor=null,globalModal=null,transitionMenu=null;
  let aiConfig=null,aiConfigStatus='disconnected',aiJob=null,aiPolling=false,aiSeen=new Set();
  const app=$('#app');
  if(embedded)document.body.classList.add('td-embedded');
  app.innerHTML=`
    <header class="topbar">
      <div class="brand"><span class="brand-mark">${icon('film')}</span>TerryDirector</div>
      <div class="top-timeline-leading"><button class="button ghost" data-action="new">${icon('plus')}新建片段</button><button class="button ghost global-prompt-button" data-action="global-prompt" type="button" title="编辑对启用片段生效的全局提示词">${icon('edit')}全局提示词</button><button class="button ghost ai-all-button" data-action="enhance-all" type="button" disabled title="使用 Llama 批量增强片段提示词">${icon('spark')}一键增强所有提示词</button><label class="ai-auto-label" title="工作流运行前统一增强全部片段"><input id="autoAiEnhance" type="checkbox" disabled><span>生成前自动AI增强提示</span></label></div>
      <div class="top-timeline-duration"><span>总时长</span><output id="timelineDuration" aria-label="总时长">00:00:00:00</output><button class="timeline-generate" data-action="queue-workflow" type="button" title="生成整个 ComfyUI 工作流" aria-label="生成整个 ComfyUI 工作流">${icon('play')}<span>生成</span></button></div>
      <div class="top-actions">${embedded?'':`<span class="prototype">H3 Skill · 静态增强稿</span>`}<div class="top-data-actions"><button class="button ghost top-data-button" data-action="import-timeline" type="button" title="导入 TerryDirector 时间线数据">${icon('upload')}导入</button><button class="button ghost top-data-button" data-action="export-timeline" type="button" title="导出 TerryDirector 时间线数据">${icon('download')}导出</button></div><button class="button primary save-close" data-action="save-close">${icon('check')}保存并退出</button>${embedded?`<button class="editor-close" data-action="close-editor" title="关闭并返回 ComfyUI" aria-label="关闭并返回 ComfyUI">${icon('close')}</button>`:''}</div>
    </header>
    <section class="timeline-panel" id="timelinePanel" aria-label="时间轴">
      <div class="timeline-toolbar"><div class="timeline-controls"><div class="timeline-tools">${ib('undo','undo','撤销（Ctrl / ⌘ Z）')}${ib('redo','redo','重做（Ctrl / ⌘ Shift Z）')}<span class="separator"></span>${ib('pointer','pointer','选择与移动片段（V）','is-active')}${ib('hand','hand','平移时间线（H / 鼠标中键）')}${ib('snap','magnet','吸附（S），拖动时 Alt 临时关闭','is-active')}${ib('chain','link','后续联动：移动或调整片段尾部时，后方所有片段跟随；头部裁剪不联动','is-active',true)}${ib('duplicate','duplicate','复制选中片段至末尾')}${ib('delete','trash','删除选中片段（Delete）')}${ib('suspend','pause','挂起当前片段：编译时视为空白','',false)}</div><span class="spacer"></span><div class="timeline-zoom">${ib('zoom-out','minus','缩小（−）')}<input type="range" min="0" max="100" value="35" id="zoomRange" aria-label="时间线缩放">${ib('zoom-in','plus','放大（＋）')}${ib('fit','fit','适应全部片段（F）')}</div></div></div>
      <div class="timeline-body" id="timelineBody"><canvas class="timeline-canvas content" aria-hidden="true"></canvas><canvas class="timeline-canvas overlay" tabindex="0" aria-label="单行时间线。拖动片段移动，拖动片段边缘裁剪；重叠区及下方引线标记为只读。左右键步进，Ctrl Z 撤销。"></canvas></div>
      <div class="timeline-bottom"><div class="timeline-run-progress" id="timelineRunProgress" hidden><i></i></div><div class="timeline-scroll" id="scrollBar"><div class="scroll-thumb" id="scrollThumb"></div></div></div>
    </section>
    <div id="timelineResize" class="resize-h" role="separator" tabindex="0" aria-label="调整时间线高度" aria-orientation="horizontal"></div>
    <main id="workspace" class="workspace">
      <section class="prompt-panel" aria-label="提示词编辑">
        <header class="composer-heading"><div class="clip-identity"><span class="clip-number-badge" id="clipNumber"></span><input id="clipName" class="clip-name" aria-label="片段名称" maxlength="60"><button class="clip-name-edit" data-action="edit-clip-name" type="button" title="编辑片段名称" aria-label="编辑片段名称">${icon('edit')}</button></div><div class="clip-duration-control" aria-label="片段时长"><input id="clipDurationNumber" type="number" min="1" step="0.01" aria-label="片段秒数"><span>s</span><input id="clipDurationRange" type="range" min="1" max="15" step="0.0416667" aria-label="片段秒数滑块"></div><label class="clip-global-toggle" title="编译时在当前片段提示词前拼接全局提示词"><input id="useGlobalPrompt" type="checkbox" checked><span>使用全局</span></label><button class="prompt-view-switch" data-action="toggle-prompt-view" type="button" aria-label="切换提示词显示方式" aria-pressed="false"><span>可视化</span><i aria-hidden="true"></i><span>纯文本</span></button></header>
        <div class="ai-prompt-toolbar"><div class="ai-prompt-tabs" role="group" aria-label="提示词版本"><button type="button" class="ai-prompt-tab is-selected" data-action="prompt-user">用户提示词</button><button type="button" class="ai-prompt-tab" data-action="prompt-ai">AI 增强提示词</button></div><div class="ai-prompt-actions"><button class="button ghost ai-prompt-button" type="button" data-action="ai-enhance" disabled>${icon('spark')}AI 提示增强</button><button class="button ghost ai-cancel-button" type="button" data-action="ai-cancel" hidden>取消增强</button></div></div>
        <div class="prompt-editor"><div class="prompt-editor-body"><textarea id="promptText" aria-label="当前片段提示词" placeholder="描述这个片段的画面、动作和声音。" spellcheck="false"></textarea><div id="promptVisual" class="prompt-visual h3-editor" contenteditable="true" role="textbox" aria-label="可视化提示词编辑器" aria-multiline="true" spellcheck="false" tabindex="0" data-placeholder="描述片段，输入 @ 引用素材，输入 / 插入 H3 语法"></div><div id="noClip" class="empty-state" hidden><strong>从一个片段开始</strong><p>在时间线上新建片段，再填写提示词与参考资产。</p><button class="button" data-action="new">${icon('plus')}新建片段</button></div></div><div class="prompt-head prompt-editor-footer"><span class="subtle prompt-help">@ 引用素材　/ H3 语法</span><span id="aiStatus" class="subtle ai-prompt-status"></span><span id="promptCount" class="subtle prompt-count"></span></div></div>

      </section>
      <div id="referenceResize" class="resize-v" role="separator" tabindex="0" aria-label="调整参考资产区域宽度" aria-orientation="vertical"></div>
        <section class="reference-panel" aria-label="资产池">
        <header class="reference-heading"><strong>资产池 <span id="refCount">0</span></strong><div class="reference-actions" role="group" aria-label="添加资产来源"><button class="button ghost" data-action="upload-assets" title="选择本地图片、视频或音频；Demo 仅在本页读取，不实际上传">${icon('upload')}上传资产</button><button class="button ghost" data-action="pick-input" title="从 ComfyUI input 选择已有文件；当前使用明确标记的示例目录">${icon('folder')}从 ComfyUI input 选取</button></div></header>
        <div class="reference-body" id="referenceDrop"><div class="reference-grid" id="references"></div><p class="reference-hint">上传新文件或从 input 选取已有文件<br>加入资产池，全部片段可引用</p></div>

        </section>
    </main>
    <input type="file" id="fileInput" accept="image/*,video/*,audio/*" multiple hidden>
    <input type="file" id="timelineImportInput" accept="application/json,.json" hidden>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <dialog id="dialog"><div class="modal-header"><strong id="dialogTitle"></strong>${ib('close-dialog','close','关闭弹窗')}</div><div class="modal-body" id="dialogBody"></div><div class="modal-actions" id="dialogActions"></div></dialog>
    <svg width="0" height="0" aria-hidden="true" style="position:absolute;pointer-events:none"><defs><clipPath id="folder-outline" clipPathUnits="objectBoundingBox"><path d="M0 .15 Q0 0 .06 0 H.32 C.36 0 .36 .13 .42 .13 H.94 Q1 .13 1 .27 V.87 Q1 1 .94 1 H.06 Q0 1 0 .87 Z"/></clipPath></defs></svg>`;
  const current=()=>state.clips.find(c=>c.id===state.selected);
  const clipLocalPrompt=c=>(c?.promptMode==='ai'&&String(c.aiPrompt||'').trim())?c.aiPrompt:(c?.prompt||'');
  const effectiveGlobalPrompt=()=>state.globalPromptMode==='ai'&&String(state.aiGlobalPrompt||'').trim()
    ?state.aiGlobalPrompt:state.globalPrompt;
  const editablePrompt=c=>c?.promptMode==='ai'?(c?.aiPrompt||''):(c?.prompt||'');
  const canEnhance=()=>!!aiConfig&&!hostReadonly&&!aiJob;
  const aiUnavailableReason=()=>aiConfigStatus==='bypassed'
    ?'TerryDirector Llama 配置已 Bypass'
    :aiConfigStatus==='muted'
      ?'TerryDirector Llama 配置已禁用'
      :'请先连接 TerryDirector Llama 配置节点';
  const getImage=c=>assets.find(a=>effectiveReferences(c).includes(a.id)&&a.kind==='image')?.src||'';
  function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3000);}
  function closeTransitionMenu(){
    transitionMenu?.remove();
    transitionMenu=null;
  }
  function setHostReadonly(value){
    const next=!!value;
    if(hostReadonly===next)return;
    hostReadonly=next;
    if(hostReadonly)closeTransitionMenu();
    document.body.classList.toggle('td-run-readonly',hostReadonly);
    app.setAttribute('aria-busy',String(hostReadonly));
    const text=$('#promptText'),visual=$('#promptVisual'),name=$('#clipName');
    if(text)text.readOnly=hostReadonly;
    if(visual)visual.contentEditable=hostReadonly?'false':'true';
    if(name)name.readOnly=hostReadonly;
    const globalButton=$('[data-action=global-prompt]');if(globalButton)globalButton.disabled=hostReadonly;
    const importButton=$('[data-action=import-timeline]');if(importButton)importButton.disabled=hostReadonly;
    renderAll();
  }
  function modal(name,body,confirmText,fn){
    promptEditor?.closeMenu();stopDialogMedia();const d=$('#dialog');d.dataset.mode='';$('#dialogTitle').textContent=name;$('#dialogBody').innerHTML=body;
    $('#dialogActions').innerHTML=confirmText?`<button class="button ghost" data-action="close-dialog">取消</button><button class="button primary" id="dialogConfirm">${esc(confirmText)}</button>`:'<button class="button" data-action="close-dialog">完成</button>';
    if(confirmText)$('#dialogConfirm').onclick=()=>{if(fn?.()!==false)d.close();};if(!d.open)d.showModal();
  }
  function markEdited(){
    if(hostReadonly)return;
    if(embedded){
      embedDirty=true;
      window.parent.postMessage({type:'terrydirector:dirty',dirty:true},hostOrigin);
    }
  }
  function finishPromptEdit(){if(editBefore){if(history.push(editBefore,state))markEdited();editBefore=null;updateHistory();}}
  function commit(before){syncAllReferences();history.push(before,state);renderAll();markEdited();}
  function mutate(fn){if(hostReadonly)return;finishResolutionEdit();finishPromptEdit();const before=C.copy(state);fn();commit(before);}
  function updateHistory(){ $('[data-action=undo]').disabled=hostReadonly||!history.undoItems.length;$('[data-action=redo]').disabled=hostReadonly||!history.redoItems.length; }
  function renderPrompt(){
    const c=current(),text=editablePrompt(c);
    $('#noClip').hidden=!!c;
    promptEditor.setContext(c?(c.id+':'+(c.promptMode||'user')):null,text,promptView);
    $('#promptText').readOnly=hostReadonly;
    $('#promptVisual').contentEditable=hostReadonly?'false':String(!!c);
    const useGlobal=$('#useGlobalPrompt');
    if(useGlobal){useGlobal.checked=!!c&&c.useGlobalPrompt!==false;useGlobal.disabled=!c||hostReadonly;}
    const viewSwitch=$('.composer-heading .prompt-view-switch');
    if(viewSwitch){
      const isText=promptView==='text';
      viewSwitch.classList.toggle('is-text',isText);
      viewSwitch.setAttribute('aria-pressed',String(isText));
      viewSwitch.title=isText?'当前：纯文本，点击切换到可视化':'当前：可视化，点击切换到纯文本';
    }
    $('#promptCount').textContent=c?`${text.length} 字`:'';
    const aiSelected=c?.promptMode==='ai';
    $('[data-action=prompt-user]')?.classList.toggle('is-selected',!aiSelected);
    $('[data-action=prompt-ai]')?.classList.toggle('is-selected',!!aiSelected);
    const warning=$('#aiStatus');
    if(warning){
      const meta=c?.aiMetadata||{};
      const old=!!c?.aiPrompt&&!!meta.sourcePrompt&&(
        meta.sourcePrompt!==c.prompt ||
        meta.sourceGlobalPrompt!==(c.useGlobalPrompt===false?'':effectiveGlobalPrompt()));
      if(!embedded&&meta.provenance==='skill-authored-demo'){
        warning.textContent=aiSelected?'H3 Skill 静态示例 · 非模型实测输出':'已提供 H3 Skill 静态增强示例';
        warning.title='仅供网站展示双提示词 UI。原始工作流的 aiPrompt 仍为空，真实运行必须调用 Qwen 增强。';
      }else{
        warning.textContent=old?'原文已更新 · AI 结果未重新增强':c?.aiPrompt?'AI 结果已保存':'';
        warning.title=old?'仅修改 AI Seed 或手动增强会重新生成，修改原文不会自动重跑。':'';
      }
    }
    renderAiControls();
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
    const enabled=!!c&&!hostReadonly;
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
  function renderRunProgress(){
    const bar=$('#timelineRunProgress');
    if(!bar)return;
    const activeClips=state.clips.filter(c=>!c.suspended);
    const totalWork=activeClips.reduce((sum,c)=>sum+Math.max(1,c.end-c.start),0);
    let doneWork=0,hasRunState=false,currentClip=null,currentProgress=0;
    for(const clip of activeClips){
      const record=activityFor(clip);
      const running=record.status==='running',completed=record.status==='completed',failed=record.status==='error';
      if(running||completed||failed)hasRunState=true;
      const progress=completed?1:running?C.clamp(Number(record.progress)||0,0,1):0;
      doneWork+=Math.max(1,clip.end-clip.start)*progress;
      if(running){currentClip=clip;currentProgress=progress;}
    }
    const overall=totalWork?C.clamp(doneWork/totalWork,0,1):0;
    bar.hidden=!hasRunState;
    bar.querySelector('i').style.width=`${Math.round(overall*1000)/10}%`;
    bar.title=currentClip
      ? `正在生成：${currentClip.name} · ${Math.round(currentProgress*100)}%`
      : `总生成进度 ${Math.round(overall*100)}%`;
  }
  function beginDurationEdit(){
    if(hostReadonly||!current()||durationEditBefore)return;
    finishPromptEdit();
    durationEditBefore=C.copy(state);
  }
  function previewDuration(seconds){
    if(hostReadonly)return;
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
    const refs=referencesIn(clipLocalPrompt(clip),entries),changed=JSON.stringify(refs)!==JSON.stringify(clip.refs);
    clip.refs=refs;return changed;
  }
  function effectiveReferences(clip,entries=poolEntries()){
    if(!clip)return [];
    const ids=new Set(referencesIn(clipLocalPrompt(clip),entries));
    if(clip.useGlobalPrompt!==false)for(const id of referencesIn(effectiveGlobalPrompt(),entries))ids.add(id);
    return [...ids];
  }

  const referenceLimits={image:9,video:3,audio:3};
  const referenceKindLabels={image:'图片',video:'视频',audio:'音频'};

  function referencesByKind(prompt,entries=poolEntries()){
    const byId=new Map(entries.map(a=>[a.id,a]));
    const result={image:new Set(),video:new Set(),audio:new Set()};
    for(const id of referencesIn(prompt,entries)){
      const asset=byId.get(id);
      if(asset&&result[asset.kind])result[asset.kind].add(id);
    }
    return result;
  }

  function previousActiveClip(clip,clips=state.clips){
    const index=clips.findIndex(item=>item.id===clip?.id);
    if(index<0)return null;
    for(let i=index-1;i>=0;i--)if(!clips[i].suspended)return clips[i];
    return null;
  }

  function reservesTailReferenceSlot(clip,clips=state.clips,transitionMode=clip?.transitionMode){
    if(!clip||clip.suspended)return false;
    const previous=previousActiveClip(clip,clips);
    if(!previous)return false;
    return Number(clip.start)===Number(previous.end)
      && normalizeTransitionMode(transitionMode,'tail_continuation')==='tail_reference';
  }

  function referenceBudgetForClip(clip,{
    localPrompt=clipLocalPrompt(clip),
    globalPrompt=effectiveGlobalPrompt(),
    useGlobal=clip?.useGlobalPrompt!==false,
    transitionMode=clip?.transitionMode,
    entries=poolEntries(),
    clips=state.clips
  }={}){
    const local=referencesByKind(localPrompt,entries);
    const global=useGlobal?referencesByKind(globalPrompt,entries):{image:new Set(),video:new Set(),audio:new Set()};
    const counts={},limits={},violations=[];
    const tailReserved=reservesTailReferenceSlot(clip,clips,transitionMode);
    for(const kind of Object.keys(referenceLimits)){
      const merged=new Set([...local[kind],...global[kind]]);
      counts[kind]=merged.size;
      limits[kind]=referenceLimits[kind]-(kind==='image'&&tailReserved?1:0);
      if(counts[kind]>limits[kind])violations.push({
        kind,count:counts[kind],limit:limits[kind],tailReserved:kind==='image'&&tailReserved
      });
    }
    return {ok:!violations.length,counts,limits,violations,tailReserved};
  }

  function referenceLimitReason(clip,budget){
    const violation=budget?.violations?.[0];
    if(!violation)return '';
    const extra=violation.tailReserved?'；尾帧参考会额外占用 1 个图片参考位':'';
    return `片段「${clip?.name||'未命名片段'}」的${referenceKindLabels[violation.kind]}参考为 ${violation.count}/${violation.limit}${extra}`;
  }

  function replaceOneRawTag(text,raw){
    const source=String(text||''),needle=String(raw||'');
    if(!needle)return source;
    const index=source.toLowerCase().indexOf(needle.toLowerCase());
    return index<0?source:source.slice(0,index)+source.slice(index+needle.length);
  }

  function promptWithAsset(text,asset,replacingRaw=null){
    let next=replaceOneRawTag(text,replacingRaw);
    const raw=`<${asset.token||String(asset.raw||'').replace(/^<|>$/g,'')}>`;
    if(!raw||raw==='<>')return next;
    if(next&&!/\s$/.test(next))next+=' ';
    return next+raw;
  }

  function clipAssetAvailability(asset,{value,replacingRaw}={}){
    const clip=current();
    if(!clip)return {allowed:false,reason:'请先选择片段'};
    const entries=poolEntries(),source=entries.find(item=>item.id===asset.id);
    if(!source)return {allowed:false,reason:'资产不在当前资产池'};
    const localPrompt=promptWithAsset(value??editablePrompt(clip),source,replacingRaw);
    const budget=referenceBudgetForClip(clip,{localPrompt,entries});
    return budget.ok?{allowed:true}:{allowed:false,reason:referenceLimitReason(clip,budget)};
  }

  function globalAssetAvailability(asset,{value,replacingRaw}={}){
    const entries=poolEntries(),source=entries.find(item=>item.id===asset.id);
    if(!source)return {allowed:false,reason:'资产不在当前资产池'};
    const globalPrompt=promptWithAsset(value??state.globalPrompt,source,replacingRaw);
    const globalSets=referencesByKind(globalPrompt,entries);
    for(const kind of Object.keys(referenceLimits)){
      if(globalSets[kind].size>referenceLimits[kind]){
        return {allowed:false,reason:`全局提示词的${referenceKindLabels[kind]}参考最多 ${referenceLimits[kind]} 个`};
      }
    }
    for(const clip of state.clips){
      if(clip.suspended||clip.useGlobalPrompt===false)continue;
      const budget=referenceBudgetForClip(clip,{globalPrompt,useGlobal:true,entries});
      if(!budget.ok)return {allowed:false,reason:referenceLimitReason(clip,budget)};
    }
    return {allowed:true};
  }

  function validateGlobalPrompt(globalPrompt){
    const entries=poolEntries(),globalSets=referencesByKind(globalPrompt,entries);
    for(const kind of Object.keys(referenceLimits)){
      if(globalSets[kind].size>referenceLimits[kind]){
        return {ok:false,reason:`全局提示词的${referenceKindLabels[kind]}参考最多 ${referenceLimits[kind]} 个`};
      }
    }
    for(const clip of state.clips){
      if(clip.suspended||clip.useGlobalPrompt===false)continue;
      const budget=referenceBudgetForClip(clip,{globalPrompt,useGlobal:true,entries});
      if(!budget.ok)return {ok:false,clip,budget,reason:referenceLimitReason(clip,budget)};
    }
    return {ok:true};
  }

  function showReferenceLimitDialog(title,clip,budget){
    const reason=referenceLimitReason(clip,budget);
    const violation=budget?.violations?.[0];
    const detail=violation?.tailReserved
      ? '<p class="subtle">当前片段使用尾帧参考，上一片段尾帧会占用 1 个图片参考位，因此普通图片引用最多 8 个。</p>'
      : '<p class="subtle">全局提示词与片段提示词会合并后按唯一资产计数；重复引用同一资产只算一次。</p>';
    modal(title,`<p>${esc(reason||'当前参考资产数量超过 MiniMax H3 上限。')}</p>${detail}`);
  }
  function syncAllReferences(){const entries=poolEntries();state.clips.forEach(c=>syncReferences(c,entries));}
  function refreshAssetUsage(){
    const c=current(),entries=poolEntries();
    const globalRefs=new Set(referencesIn(effectiveGlobalPrompt(),entries));
    const currentLocalRefs=new Set(c?referencesIn(clipLocalPrompt(c),entries):[]);
    for(const tile of $('#references').querySelectorAll('[data-reference]')){
      const id=tile.dataset.reference;
      const globalUsed=globalRefs.has(id);
      const localUsed=currentLocalRefs.has(id);
      const effectiveCurrent=localUsed||(!!c&&c.useGlobalPrompt!==false&&globalUsed);
      const users=state.clips.filter(clip=>effectiveReferences(clip,entries).includes(id));
      tile.classList.toggle('is-referenced',globalUsed||localUsed);
      tile.classList.toggle('is-effective-reference',effectiveCurrent);
      const badge=tile.querySelector('.asset-current-use');
      badge.hidden=!(globalUsed||localUsed);
      badge.textContent=globalUsed&&localUsed?'全局 + 当前':globalUsed?'全局引用':'当前引用';
      tile.querySelector('.asset-token').title=globalUsed
        ? ('全局提示词已引用；'+(users.length?'作用片段：'+users.map(clip=>clip.name).join('、'):'当前没有片段启用全局提示词'))
        : users.length
          ? ('引用片段：'+users.map(clip=>clip.name).join('、'))
          : '尚未被片段引用';
      const insertButton=tile.querySelector('[data-insert-ref]');
      const source=entries.find(item=>item.id===id);
      const availability=c&&source
        ? clipAssetAvailability({id:source.id,raw:`<${source.token}>`,token:source.token},{value:c.prompt})
        : {allowed:false,reason:'请先选择片段'};
      insertButton.disabled=!c||hostReadonly||!availability.allowed;
      insertButton.title=availability.allowed
        ? `插入 <${source?.token||''}> 到当前片段`
        : (availability.reason||'当前参考资产额度已满');
      const removeButton=tile.querySelector('[data-delete-asset]');if(removeButton)removeButton.disabled=hostReadonly;
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
    if(!embedded)note.textContent='站点仅用占位缩略图展示原参考图位置。真正的图片文件仍在本机 ComfyUI/input，不在公开仓库中。';
    if(!d.open)d.showModal();
  }
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
    renderResolutionResult();
  }

  function applyHostAiPatch(records){
    if(!records||typeof records!=='object')return;
    let changed=false;
    for(const clip of state.clips){
      const patch=records[String(clip.id)];
      if(!patch?.aiPrompt||!patch?.aiMetadata)continue;
      const nextSeed=Number(patch.aiMetadata.seed);
      if(clip.aiPrompt&&Number(clip.aiMetadata?.seed)===nextSeed)continue;
      clip.aiPrompt=String(patch.aiPrompt);
      clip.aiMetadata=C.copy(patch.aiMetadata);
      if(!clip.aiOptOut)clip.promptMode='ai';
      changed=true;
    }
    if(changed){renderAll();}
  }
  function renderAiControls(){
    const connected=!!aiConfig,busy=!!aiJob,unavailable=aiUnavailableReason();
    const single=$('[data-action=ai-enhance]'),all=$('[data-action=enhance-all]');
    if(single){
      single.disabled=!connected||hostReadonly||busy||!current()?.prompt?.trim();
      single.textContent=busy?'AI 增强中…':'✦ AI 提示增强';
      single.title=!embedded?'仅展示界面；真实增强请在 ComfyUI 中执行':connected?'调用本地 Llama 增强片段':unavailable;
    }
    if(all){
      all.disabled=!connected||hostReadonly||busy||!state.clips.some(c=>!c.suspended&&c.prompt?.trim());
      all.title=!embedded?'仅展示界面；真实增强请在 ComfyUI 中执行':connected?'全部片段按原文重新增强':unavailable;
    }
    const cancel=$('[data-action=ai-cancel]');
    if(cancel){cancel.hidden=!busy;cancel.disabled=!busy;}
    globalModal?.updateBusy?.();
    const raw=$('#promptText'),visual=$('#promptVisual');
    if(raw)raw.readOnly=hostReadonly||busy;
    if(visual)visual.contentEditable=(hostReadonly||busy||!current())?'false':'true';
    const checkbox=$('#autoAiEnhance');
    if(checkbox){
      checkbox.checked=!!state.autoAiEnhance;
      checkbox.disabled=!connected||hostReadonly||busy;
      checkbox.title=connected?'Queue 时先完成批量 AI 增强，再执行 H3':unavailable;
    }
  }
  function switchPromptMode(mode){
    if(hostReadonly||!current()||aiJob)return;
    if(current().promptMode===mode)return;
    mutate(()=>{const c=current();c.promptMode=mode;c.aiOptOut=mode==='user'&&!!c.aiPrompt;});
  }
  async function startAiEnhance(all){
    if(!embedded){toast('网站只展示创作界面，不会启动 Qwen 或 ComfyUI Queue。');return;}
    if(!canEnhance()){toast(aiUnavailableReason());return;}
    const clips=(all?state.clips:[current()]).filter(c=>c&&!c.suspended&&c.prompt?.trim());
    if(!clips.length){toast('没有可增强的片段');return;}
    finishPromptEdit();
    try{
      const response=await fetch('/terrydirector/api/ai-enhance',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({llama_config:aiConfig,document:documentPayload(),clip_ids:clips.map(c=>c.id)})
      });
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||'无法启动 AI 增强');
      aiJob=payload.job_id;aiSeen=new Set();
      markEdited();renderAiControls();toast('正在使用本地 Qwen 增强提示词');
      void pollAiJob();
    }catch(error){aiJob=null;renderAiControls();toast(error?.message||'启动 AI 增强失败');}
  }
  async function cancelAiJob(){
    if(!aiJob)return;
    try{
      const response=await fetch('/terrydirector/api/ai-jobs/'+encodeURIComponent(aiJob)+'/cancel',{method:'POST'});
      if(!response.ok)throw new Error('无法取消当前增强任务');
      toast('正在请求取消 AI 增强');
    }catch(error){toast(error?.message||'取消失败');}
  }
  async function pollAiJob(){
    if(!aiJob||aiPolling)return;
    aiPolling=true;
    const targetJob=aiJob;
    try{
      const response=await fetch('/terrydirector/api/ai-jobs/'+encodeURIComponent(targetJob),{cache:'no-store'});
      if(!response.ok)throw new Error('AI 任务状态不可用');
      const job=await response.json();
      for(const result of job.results||[]){
        if(aiSeen.has(result.id))continue;aiSeen.add(result.id);
        const clip=state.clips.find(c=>c.id===result.id);
        if(!clip)continue;
        mutate(()=>{
          clip.aiPrompt=String(result.prompt||'');
          clip.aiMetadata=result.metadata||{};
          clip.promptMode='ai';clip.aiOptOut=false;
        });
      }
      if(['completed','error','cancelled'].includes(job.status)){
        aiJob=null;renderAll();
        if(job.status==='completed')toast('AI 增强完成 '+job.done+'/'+job.total);
        else toast(job.error||'AI 增强已取消，已完成片段得到保留');
      }else{$('#aiStatus').textContent='正在增强 '+job.done+'/'+job.total+' 个片段';}
    }catch(error){aiJob=null;toast(error?.message||'AI 增强连接失败');}
    finally{
      aiPolling=false;
      if(aiJob===targetJob)setTimeout(()=>void pollAiJob(),650);
      else renderAiControls();
    }
  }
  function renderAll(){
    if(!state.clips.some(c=>c.id===state.selected))state.selected=state.clips[0]?.id||null;
    syncAllReferences();
    const c=current();$('#clipNumber').textContent=c?`片段 ${state.clips.indexOf(c)+1}`:'暂无片段';
    $('#clipName').value=c?.name||'';$('#clipName').disabled=!c||hostReadonly;$('#clipName').hidden=!c;
    const suspendButton=$('[data-action=suspend]');
    if(suspendButton){
      suspendButton.disabled=!c||hostReadonly;
      suspendButton.classList.toggle('is-active',!!c?.suspended);
      suspendButton.setAttribute('aria-pressed',String(!!c?.suspended));
      suspendButton.title=c?.suspended?'恢复当前片段生成':'挂起当前片段：编译时视为空白';
    }
    renderPrompt();renderTiming();renderRunProgress();renderReferences();updateHistory();
    if(timeline){timeline.setClips(state.clips);timeline.select(state.selected);}
  }
  function select(id,seek=false){finishDurationEdit();finishPromptEdit();state.selected=id;if(timeline){timeline.select(id);if(seek&&current())timeline.setFrame(current().start);}renderAll();}
  promptEditor=new window.TDH3Editor({
    visual:$('#promptVisual'),textarea:$('#promptText'),
    getAssets:()=>poolEntries().map(a=>({id:a.id,name:a.name,kind:a.kind==='image'?'picture':a.kind,raw:`<${a.token}>`,preview:a.kind==='image'?a.src:''})),
    getAssetAvailability:clipAssetAvailability,
    onBeforeChange:()=>{if(hostReadonly)return false;if(!editBefore)editBefore=C.copy(state);},
    onChange:text=>{if(hostReadonly)return;const c=current();if(c){c[c.promptMode==='ai'?'aiPrompt':'prompt']=text;if(syncReferences(c)){refreshAssetUsage();timeline?.invalidate();}}$('#promptCount').textContent=`${text.length} 字`;},
    onCommit:finishPromptEdit,
    onHistory:redo=>actions[redo?'redo':'undo']()
  });
  timeline=new window.TDTimeline($('#timelineBody'),{
    clips:state.clips,selected:state.selected,getImage,getActivity:activityFor,readonly:()=>hostReadonly,
    getTransitionMode:id=>normalizeTransitionMode(state.clips.find(c=>c.id===id)?.transitionMode,'tail_continuation'),
    onTransitionMenu:(seam,point)=>openTransitionMenu(seam,point),
    onSelect:id=>select(id),onFrame:()=>{},
    onPreview:clips=>renderTiming(clips),onDragEnd:()=>timeline.invalidate(),
    onCommit:(clips,beforeClips)=>{finishPromptEdit();const before={...C.copy(state),clips:beforeClips};state.clips=clips;commit(before);},
    onView:v=>{const max=Math.max(v.visible,v.contentWidth),width=Math.min(100,v.visible/max*100);$('#scrollThumb').style.width=width+'%';$('#scrollThumb').style.left=Math.min(100-width,v.scroll/max*100)+'%';$('#zoomRange').value=Math.log(v.ppf/.22)/Math.log(24/.22)*100;}
  });
  renderAll();timeline.setFrame(embedded?0:8*C.FPS);
  function openTransitionMenu(seam,point){
    if(hostReadonly||seam?.kind!=='touch')return;
    closeTransitionMenu();
    const clip=state.clips.find(c=>c.id===seam.b);if(!clip)return;
    const current=normalizeTransitionMode(clip.transitionMode,'tail_continuation');
    const menu=document.createElement('div');menu.className='transition-mode-menu';menu.setAttribute('role','menu');
    menu.innerHTML=Object.entries(transitionLabels).map(([value,label])=>`<button type="button" role="menuitemradio" aria-checked="${value===current}" data-transition-mode="${value}" class="${value===current?'is-active':''}"><span>${label}</span>${value===current?'<b>✓</b>':''}</button>`).join('');
    document.body.append(menu);transitionMenu=menu;
    const margin=8,rect=menu.getBoundingClientRect();
    menu.style.left=C.clamp(point.clientX,margin,window.innerWidth-rect.width-margin)+'px';
    menu.style.top=C.clamp(point.clientY+6,margin,window.innerHeight-rect.height-margin)+'px';
    menu.addEventListener('pointerdown',e=>e.stopPropagation());
    menu.addEventListener('click',e=>{
      const button=e.target.closest('[data-transition-mode]');if(!button)return;
      const mode=normalizeTransitionMode(button.dataset.transitionMode,'tail_reference');
      const target=state.clips.find(c=>c.id===seam.b);
      if(target){
        const budget=referenceBudgetForClip(target,{transitionMode:mode});
        if(!budget.ok){
          closeTransitionMenu();
          showReferenceLimitDialog('无法切换片段承接方式',target,budget);
          return;
        }
      }
      mutate(()=>{const target=state.clips.find(c=>c.id===seam.b);if(target)target.transitionMode=mode;});
      closeTransitionMenu();timeline?.invalidate();
    });
  }
  function newClip(){appendClip('新的片段');}
  function appendClip(name,template){mutate(()=>{
    const prev=state.clips.at(-1),prev2=state.clips.at(-2),start=prev?Math.max(prev.start+1,prev.end-48,prev2?.end||0):0;
    const c=template?C.copy(template):{name,prompt:'',aiPrompt:'',promptMode:'user',aiOptOut:false,aiMetadata:{},useGlobalPrompt:true,transitionMode:defaultTransitionMode,resolution:{...R.DEFAULT},audio:true,guide:'画面参考',refs:[],suspended:false};
    if(template)Object.assign(c,{aiPrompt:'',promptMode:'user',aiOptOut:false,aiMetadata:{}});
    const duration=template?template.end-template.start:10*C.FPS;
    Object.assign(c,{id:'clip-'+nextId++,name,start,end:Math.max(start+duration,prev?prev.end+1:0)});state.clips.push(c);state.selected=c.id;
  });timeline.fit();}
  // A reference is written into the clip's single prompt. The refs array is a
  // derived list of stable asset IDs; removing a prompt tag never deletes media.
  function appendReferences(clip,ids){
    const field=clip.promptMode==='ai'?'aiPrompt':'prompt';
    const entries=poolEntries(),used=new Set(referencesIn(clip[field],entries));
    const add=entries.filter(a=>ids.includes(a.id)&&!used.has(a.id));
    const blocked=[];
    for(const asset of add){
      const nextPrompt=promptWithAsset(clip[field],asset);
      const budget=referenceBudgetForClip(clip,{localPrompt:nextPrompt,entries});
      if(!budget.ok){blocked.push({asset,budget});continue;}
      clip[field]=nextPrompt;
      used.add(asset.id);
    }
    return blocked;
  }
  function addReference(id,clipId=state.selected){
    const clip=state.clips.find(c=>c.id===clipId);
    if(clip&&state.assetIds.includes(id)&&!clip.refs.includes(id))mutate(()=>appendReferences(clip,[id]));
  }
  function deleteAsset(id){
    const asset=poolEntries().find(a=>a.id===id);if(!asset)return;
    finishPromptEdit();
    const entries=poolEntries(),globalUsed=referencesIn(effectiveGlobalPrompt(),entries).includes(id);
    const users=state.clips.filter(c=>effectiveReferences(c,entries).includes(id));
    const detail=globalUsed
      ? `它被全局提示词引用，并会作用于 ${users.length} 个启用全局提示词的片段。确认后会同时移除全局与片段提示词中的对应引用标签。`
      : users.length
        ? `它被 ${users.length} 个片段引用：${users.map(c=>esc(c.name)).join('、')}。确认后也会移除这些片段中的对应引用标签。`
        : '该素材尚未被任何提示词引用。';
    modal('从资产池删除',`<p>删除「${esc(asset.name)}」？</p><p>${detail}</p><p>不会删除本地文件；可撤销此操作。仅取消某片段的引用，请在该片段提示词中删除对应标签。</p>`,'删除素材',()=>{
      mutate(()=>{
        state.assetIds=state.assetIds.filter(x=>x!==id);
        const key=mediaKey(mediaNames[asset.kind],asset.number),removeTag=(prompt)=>String(prompt||'').replace(mediaPattern(),(raw,kind,number)=>mediaKey(kind,number)===key?'':raw);
        state.globalPrompt=removeTag(state.globalPrompt);
        state.aiGlobalPrompt=removeTag(state.aiGlobalPrompt);
        for(const clip of state.clips){clip.prompt=removeTag(clip.prompt);clip.aiPrompt=removeTag(clip.aiPrompt);}
      });
      // Retain the cached media URL for undo and any active simulation snapshot.
    });
  }
  function insertReference(id){
    const a=poolEntries().find(x=>x.id===id),clip=current();if(!a||!clip)return;
    const availability=clipAssetAvailability({id:a.id,raw:`<${a.token}>`,token:a.token},{value:editablePrompt(clip)});
    if(!availability.allowed){toast(availability.reason||'当前参考资产额度已满');return;}
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
    const inPool=path=>poolEntries().some(a=>a.source?.path===path);
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
            let asset=assets.find(a=>a.source?.path===file.path);
            if(!asset){
              asset={id:'input-demo-'+nextAsset++,name:file.name,kind:file.kind,src:file.src,
                number:nextPoolNumber[file.kind]++,source:{type:'comfy-input',path:file.path}};
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
  function showHome(){finishPromptEdit();promptEditor.closeMenu();stopDialogMedia();timeline.stop();$('#workspace').hidden=true;$('#timelineResize').hidden=true;$('#timelinePanel').hidden=true;$('#projectHome').hidden=false;
    $('#projectHome').innerHTML=`<div class="home-heading"><div><div class="eyebrow">YOUR CREATIVE SPACE</div><h1>每一个故事，从这里开始。</h1><p>打开项目，回到创作。</p></div><button class="button" data-action="project-new">${icon('plus')}新建项目</button></div><div class="project-grid"><div class="tsd-project-folder-item"><button class="tsd-project-folder-card has-cover" data-action="open-project"><div class="tsd-project-folder-sheet tsd-project-folder-paper"></div><div class="tsd-project-folder-sheet tsd-project-folder-paper-middle"></div><div class="tsd-project-folder-sheet tsd-project-folder-cover" style="background-image:none"></div><div class="tsd-project-folder-front"><div class="tsd-project-folder-tab">当前演示项目</div><h3>${esc(title)}</h3><p>镜头、提示词与参考资产。</p><footer><span>${state.clips.length} 个片段</span><span>${state.assetIds.length} 个素材</span></footer></div></button></div></div><p class="home-foot">项目仅在当前页面暂存，刷新会还原。可导出配置保留本次编排。</p>`;
  }
  function openProject(){ $('#projectHome').hidden=true;$('#workspace').hidden=false;$('#timelineResize').hidden=false;$('#timelinePanel').hidden=false;timeline.resize();}
  function exportTimelineData(){
    finishResolutionEdit();finishPromptEdit();syncAllReferences();
    const payload={
      format:'terrydirector-timeline',
      version:1,
      exportedAt:new Date().toISOString(),
      document:documentPayload()
    };
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='TerryDirector-timeline.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    toast('已导出 TerryDirector 时间线数据。');
  }
  function importedDocument(raw){
    if(!raw||typeof raw!=='object')throw new Error('文件内容不是有效的 TerryDirector 数据。');
    if(raw.format==='terrydirector-timeline'&&raw.document&&typeof raw.document==='object')return raw.document;
    if(raw.document&&typeof raw.document==='object'&&Array.isArray(raw.document.clips))return raw.document;
    if(Array.isArray(raw.clips)){
      return {
        version:2,
        fps:Number(raw.fps)||C.FPS,
        selected:raw.selected||raw.clips[0]?.id||null,
        globalPrompt:String(raw.globalPrompt||''),
        aiGlobalPrompt:String(raw.aiGlobalPrompt||''),
        globalPromptMode:raw.globalPromptMode==='ai'?'ai':'user',
        globalAiMetadata:raw.globalAiMetadata&&typeof raw.globalAiMetadata==='object'?C.copy(raw.globalAiMetadata):{},
        autoAiEnhance:raw.autoAiEnhance===true,
        clips:raw.clips,
        assets:Array.isArray(raw.assets)?raw.assets:[]
      };
    }
    throw new Error('没有找到 TerryDirector 时间线数据。');
  }
  async function importTimelineFile(file){
    if(hostReadonly||!file)return;
    try{
      const raw=JSON.parse(await file.text()),documentData=importedDocument(raw);
      if(Number(documentData.fps||C.FPS)!==C.FPS)throw new Error(`时间线帧率必须为 ${C.FPS} fps。`);
      loadDocument(documentData);
      embedDirty=true;
      if(embedded)window.parent.postMessage({type:'terrydirector:dirty',dirty:true},hostOrigin);
      toast(`已导入 ${state.clips.length} 个片段；保存并退出后写回节点。`);
    }catch(error){
      modal('导入失败',`<p>${esc(error?.message||'无法读取该 JSON 文件。')}</p>`);
    }
  }
  function setChainEnabled(enabled){
    timeline.cancel();timeline.chainEnabled=!!enabled;
    const button=$('[data-action=chain]');
    button.classList.toggle('is-active',timeline.chainEnabled);
    button.setAttribute('aria-pressed',String(timeline.chainEnabled));
    button.title=timeline.chainEnabled?'后续联动已开启：移动或调整片段尾部时，后方所有片段跟随；头部裁剪不联动':'后续联动已关闭：移动和裁剪仅影响当前片段';
    button.setAttribute('aria-label',button.title);
  }
  function help(){modal('时间线编排 Demo','<p>导演台浮窗只负责创作编排：顶部是时间线，下方是提示词与资产池。分辨率、采样器、种子、总步数、二采和其他生成参数都不在浮窗里设置。</p><p>全局提示词通过顶栏按钮在浮窗中编辑；新建片段默认启用“使用全局”。编译时先拼接全局提示词，再拼接片段提示词，并从合并后的 Prompt 扫描实际引用素材。</p><p>时间线接缝会显示生成语义：重叠 = 连续生成；存在空隙 = 独立生成；首尾贴合时可在“尾帧参考 / 尾帧续接 / 独立”之间下拉切换。新建片段默认值来自 ComfyUI Settings 的 TerryDirector → 时间线 → 默认镜头衔接。</p><p>片段时长仍按普通秒数编辑；悬停时可查看 H3 内部对齐帧数与最终裁切信息，不需要手动处理 5 + 17n 帧网格。</p><p>在时间线选择片段后编辑提示词；输入 @ 搜索资产，输入 / 打开 H3 语法菜单。资产池由当前 TerryDirector 节点的全部片段共用。</p>');}
  function assetFromDocument(raw,index){
    const path=String(raw?.source?.path||'').replaceAll('\\\\','/').split('/').filter(Boolean).join('/'),kind=String(raw?.kind||'');
    if(!path||!['image','video','audio'].includes(kind))return null;
    return {id:String(raw.id||`asset-${index+1}`),name:String(raw.name||path.split('/').at(-1)||path),kind,
      number:Math.max(1,Number.parseInt(raw.number,10)||1),
      src:embedded?inputPreviewUrl(path):siteDemoThumbnail(raw.number),
      source:{type:'comfy-input',path}};
  }
  function applyHostActivity(payload){
    if(!embedded)return;
    setHostReadonly(!!payload?.readonly);
    const records=payload?.clips&&typeof payload.clips==='object'?payload.clips:{};
    activity.clear();
    for(const clip of state.clips){
      const raw=records[clip.id];
      if(!raw)continue;
      activity.set(clip.id,{
        status:['idle','running','completed','error'].includes(raw.status)?raw.status:'idle',
        progress:C.clamp(Number(raw.progress)||0,0,1),
        elapsedSeconds:Math.max(0,Number(raw.elapsedSeconds)||0),
        completedAt:raw.completedAt||null,
        error:String(raw.error||''),
        real:true
      });
    }
    const queueButton=$('[data-action=queue-workflow]');
    const running=[...activity.values()].some(record=>record.status==='running');
    if(queueButton){
      queueButton.disabled=running;
      queueButton.classList.toggle('is-running',running);
      const label=queueButton.querySelector('span');
      if(label)label.textContent=running?'生成中':'生成';
    }
    renderRunProgress();
    timeline?.invalidate();
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
        start,end,prompt:String(clip?.prompt||''),aiPrompt:String(clip?.aiPrompt||''),promptMode:clip?.promptMode==='ai'?'ai':'user',
        aiOptOut:clip?.aiOptOut===true,aiMetadata:clip?.aiMetadata&&typeof clip.aiMetadata==='object'?C.copy(clip.aiMetadata):{},
        refs:(Array.isArray(clip?.refs)?clip.refs.map(String):[]).filter(id=>validAssets.has(id)),
        useGlobalPrompt:clip?.useGlobalPrompt!==false,transitionMode:normalizeTransitionMode(clip?.transitionMode,'tail_continuation'),suspended:clip?.suspended===true,resolution:{...R.DEFAULT},seed:0,audio:true,guide:'画面参考'};
    });
    state={globalPrompt:String(raw.globalPrompt||''),aiGlobalPrompt:String(raw.aiGlobalPrompt||''),
      globalPromptMode:raw.globalPromptMode==='ai'?'ai':'user',
      globalAiMetadata:raw.globalAiMetadata&&typeof raw.globalAiMetadata==='object'?C.copy(raw.globalAiMetadata):{},
      autoAiEnhance:raw.autoAiEnhance===true,clips,
      selected:clips.some(c=>c.id===raw.selected)?raw.selected:(clips[0]?.id||null),
      assetIds:assets.map(a=>a.id)};
    history=new C.History();assetGridKey='';activity.clear();
    nextId=Math.max(0,...clips.map(c=>Number.parseInt(String(c.id).split('-').at(-1),10)||0))+1;
    nextAsset=assets.length+1;embedDirty=false;
    renderAll();timeline.fit();timeline.setFrame(current()?.start||0);
    if(embedded)window.parent.postMessage({type:'terrydirector:dirty',dirty:false},hostOrigin);
  }
  function documentPayload(){
    finishPromptEdit();syncAllReferences();
    return {version:2,fps:C.FPS,selected:state.selected,globalPrompt:state.globalPrompt,
      aiGlobalPrompt:state.aiGlobalPrompt||'',globalPromptMode:state.globalPromptMode==='ai'?'ai':'user',
      globalAiMetadata:state.globalAiMetadata||{},autoAiEnhance:!!state.autoAiEnhance,
      clips:state.clips.map(({id,name,start,end,prompt,aiPrompt,promptMode,aiMetadata,aiOptOut,refs,useGlobalPrompt,transitionMode,suspended})=>({id,name,start,end,prompt,aiPrompt:aiPrompt||'',promptMode:promptMode==='ai'?'ai':'user',aiMetadata:aiMetadata||{},aiOptOut:!!aiOptOut,refs:[...refs],useGlobalPrompt:useGlobalPrompt!==false,transitionMode:normalizeTransitionMode(transitionMode,'tail_reference'),suspended:!!suspended})),
      assets:poolEntries().filter(a=>a.source?.path).map(a=>({id:a.id,name:a.name,kind:a.kind,number:a.number,
        source:{type:'comfy-input',path:a.source.path}}))};
  }
  function destroyGlobalPromptEditor(){
    if(globalPromptEditor){globalPromptEditor.destroy();globalPromptEditor=null;}
    globalModal=null;
  }
  function openGlobalPrompt(){
    if(hostReadonly)return;
    finishPromptEdit();promptEditor?.closeMenu();stopDialogMedia();destroyGlobalPromptEditor();
    const d=$('#dialog');d.dataset.mode='global-prompt';$('#dialogTitle').textContent='全局提示词';
    $('#dialogBody').innerHTML=[
      '<div class="global-prompt-shell">',
        '<div class="global-prompt-toolbar">',
          '<div class="ai-prompt-tabs global-version-tabs" role="group" aria-label="全局提示词版本">',
            '<button type="button" class="ai-prompt-tab" id="globalPromptUserTab">用户提示词</button>',
            '<button type="button" class="ai-prompt-tab" id="globalPromptAiTab">AI 增强提示词</button>',
          '</div>',
          '<div class="global-prompt-actions">',
            '<button class="button ghost" type="button" id="globalAiEnhanceButton">✦ AI 提示增强</button>',
            '<button class="button ghost" type="button" id="globalAiCancelButton" hidden>取消增强</button>',
            '<button class="prompt-view-switch global-prompt-view-switch" type="button" aria-label="切换全局提示词显示方式" aria-pressed="false">',
              '<span>可视化</span><i aria-hidden="true"></i><span>纯文本</span>',
            '</button>',
          '</div>',
        '</div>',
        '<div class="prompt-editor global-prompt-editor">',
          '<div class="prompt-editor-body">',
            '<textarea id="globalPromptText" aria-label="全局提示词" placeholder="填写人物、场景、服装、声音或公共参考；输入 @ 引用资产，输入 / 插入 H3 语法。" spellcheck="false"></textarea>',
            '<div id="globalPromptVisual" class="prompt-visual h3-editor" contenteditable="true" role="textbox"',
                 ' aria-label="全局可视化提示词编辑器" aria-multiline="true" spellcheck="false" tabindex="0"',
                 ' data-placeholder="填写全局提示词，输入 @ 引用资产，输入 / 插入 H3 语法"></div>',
          '</div>',
          '<div class="prompt-head prompt-editor-footer">',
            '<span class="subtle prompt-help">全局约束作用于启用它的所有片段</span>',
            '<span class="subtle global-ai-status" id="globalAiStatus" role="status"></span>',
            '<span id="globalPromptCount" class="subtle prompt-count"></span>',
          '</div>',
        '</div>',
      '</div>',
    ].join('');
    $('#dialogActions').innerHTML='<button class="button ghost" id="globalPromptCancel">取消</button><button class="button primary" id="globalPromptSave">保存全局提示词</button>';

    const fields={
      user:{text:state.globalPrompt||'',undo:[],redo:[],before:null},
      ai:{text:state.aiGlobalPrompt||'',undo:[],redo:[],before:null}
    };
    let version=state.globalPromptMode==='ai'?'ai':'user';
    let metadata=C.copy(state.globalAiMetadata||{});
    const currentField=()=>fields[version];
    const commitDraft=()=>{
      const field=currentField();
      if(field.before!==null&&field.before!==field.text){
        field.undo.push(field.before);field.redo.length=0;
      }
      field.before=null;
    };
    const isBusy=()=>!!aiJob;
    const updateBusy=()=>{
      if(d.dataset.mode!=='global-prompt')return;
      const active=!!aiConfig&&!hostReadonly&&!isBusy();
      const enhance=$('#globalAiEnhanceButton');
      if(enhance){
        enhance.disabled=!active||!fields.user.text.trim();
        enhance.title=!embedded?'查看静态 H3 Skill 全局提示词示例':
          !aiConfig?aiUnavailableReason():'使用本地 Qwen 增强全局提示词';
        enhance.textContent=isBusy()?'正在增强全局提示词…':'✦ AI 提示增强';
      }
      const cancel=$('#globalAiCancelButton');
      if(cancel){cancel.hidden=!isBusy();cancel.disabled=!isBusy();}
      for(const id of ['globalPromptUserTab','globalPromptAiTab']){
        const button=$('#'+id);if(button)button.disabled=isBusy();
      }
      const view=$('.global-prompt-view-switch');
      if(view)view.disabled=isBusy();
      const raw=$('#globalPromptText'),visual=$('#globalPromptVisual');
      if(raw)raw.readOnly=hostReadonly||isBusy();
      if(visual)visual.contentEditable=hostReadonly||isBusy()?'false':'true';
      for(const id of ['globalPromptSave','globalPromptCancel']){
        const button=$('#'+id);if(button)button.disabled=isBusy();
      }
    };
    const refresh=()=>{
      globalPromptEditor.setContext('global-prompt-'+version,currentField().text,globalPromptView);
      const view=$('.global-prompt-view-switch'),isText=globalPromptView==='text';
      view.classList.toggle('is-text',isText);
      view.setAttribute('aria-pressed',String(isText));
      view.title=isText?'当前：纯文本，点击切换到可视化':'当前：可视化，点击切换到纯文本';
      $('#globalPromptUserTab').classList.toggle('is-selected',version==='user');
      $('#globalPromptAiTab').classList.toggle('is-selected',version==='ai');
      $('#globalPromptCount').textContent=currentField().text.length+' 字';
      const message=$('#globalAiStatus');
      const stale=!!fields.ai.text&&!!metadata.sourcePrompt&&metadata.sourcePrompt!==fields.user.text;
      message.textContent=metadata.provenance==='skill-authored-demo'
        ?'H3 Skill 静态示例 · 非 Qwen 实测输出'
        :stale?'原文已更新 · AI 全局结果未重新增强'
        :fields.ai.text?'已有 AI 全局增强稿':'全局原文与 AI 结果分别保存';
      message.title=stale?'修改原文不会自动重做；手动点击增强即可更新全局稿':'';
      updateBusy();
    };
    globalModal={updateBusy};
    globalPromptEditor=new window.TDH3Editor({
      visual:$('#globalPromptVisual'),textarea:$('#globalPromptText'),menuRoot:d,
      getAssets:()=>poolEntries().map(a=>({id:a.id,name:a.name,kind:a.kind==='image'?'picture':a.kind,
        raw:'<'+a.token+'>',preview:a.kind==='image'?a.src:''})),
      getAssetAvailability:(asset,options)=>globalAssetAvailability(asset,{
        ...options,value:options?.value??currentField().text
      }),
      onBeforeChange:()=>{if(currentField().before===null)currentField().before=currentField().text;},
      onChange:text=>{
        currentField().text=text;
        $('#globalPromptCount').textContent=text.length+' 字';
        updateBusy();
        if(version==='user'&&fields.ai.text&&metadata.sourcePrompt&&metadata.sourcePrompt!==text)
          $('#globalAiStatus').textContent='原文已更新 · AI 全局结果未重新增强';
      },
      onCommit:commitDraft,
      onHistory:isRedo=>{
        commitDraft();const field=currentField();
        const from=isRedo?field.redo:field.undo,to=isRedo?field.undo:field.redo;
        if(!from.length)return;to.push(field.text);field.text=from.pop();refresh();
      }
    });
    function switchVersion(next){
      if(isBusy()||next===version)return;
      commitDraft();version=next;refresh();
    }
    $('#globalPromptUserTab').onclick=()=>switchVersion('user');
    $('#globalPromptAiTab').onclick=()=>switchVersion('ai');
    $('.global-prompt-view-switch').addEventListener('click',()=>{
      if(isBusy())return;
      commitDraft();globalPromptView=globalPromptView==='visual'?'text':'visual';refresh();
    });
    async function pollGlobalEnhancement(jobId){
      const status=$('#globalAiStatus');
      try{
        const response=await fetch('/terrydirector/api/ai-jobs/'+encodeURIComponent(jobId),{cache:'no-store'});
        if(!response.ok)throw new Error('全局增强任务状态不可用');
        const job=await response.json();
        const result=(job.results||[]).find(item=>item.id==='__global__');
        if(result&&result.prompt){
          fields.ai.text=String(result.prompt);
          fields.ai.undo.length=0;fields.ai.redo.length=0;fields.ai.before=null;
          metadata=result.metadata||{};
          version='ai';
          refresh();
        }
        if(['completed','error','cancelled'].includes(job.status)){
          aiJob=null;renderAiControls();
          if(job.status==='completed')toast('全局提示词 AI 增强已完成，点击保存应用');
          else toast(job.error||'全局提示词增强已取消');
        }else{
          status.textContent='正在增强全局提示词…';
          setTimeout(()=>{if(aiJob===jobId&&d.open)void pollGlobalEnhancement(jobId);},650);
        }
      }catch(error){
        aiJob=null;renderAiControls();toast(error?.message||'无法获取全局 AI 结果');
      }
    }
    $('#globalAiEnhanceButton').onclick=async()=>{
      if(!embedded){
        if(fields.ai.text){version='ai';refresh();toast('展示按 H3 Skill 编写的全局增强稿（非模型推理）');}
        else toast('网站只展示静态 UI，真实增强请在 ComfyUI 中执行。');
        return;
      }
      if(!aiConfig||isBusy()||!fields.user.text.trim())return;
      commitDraft();
      const validation=validateGlobalPrompt(fields.user.text);
      if(!validation.ok){toast(validation.reason||'全局提示词引用无效');return;}
      const source=documentPayload();
      source.globalPrompt=fields.user.text;
      source.globalPromptMode='user';
      try{
        const response=await fetch('/terrydirector/api/ai-enhance',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({scope:'global',llama_config:aiConfig,document:source})
        });
        const payload=await response.json();
        if(!response.ok)throw new Error(payload.error||'无法启动全局 AI 增强');
        aiJob=payload.job_id;renderAiControls();
        $('#globalAiStatus').textContent='正在增强全局提示词…';
        void pollGlobalEnhancement(aiJob);
      }catch(error){aiJob=null;renderAiControls();toast(error?.message||'无法增强全局提示词');}
    };
    $('#globalAiCancelButton').onclick=()=>void cancelAiJob();
    $('#globalPromptCancel').onclick=()=>{if(!isBusy())d.close();};
    $('#globalPromptSave').onclick=()=>{
      if(isBusy())return;
      commitDraft();
      const globalChoice=version==='ai'&&fields.ai.text.trim()?fields.ai.text:fields.user.text;
      const validation=validateGlobalPrompt(globalChoice);
      if(!validation.ok){toast(validation.reason||'全局提示词的参考资产超过当前可用额度');return;}
      const before=C.copy(state);
      state.globalPrompt=fields.user.text;
      state.aiGlobalPrompt=fields.ai.text;
      state.globalPromptMode=version==='ai'&&fields.ai.text.trim()?'ai':'user';
      state.globalAiMetadata=C.copy(metadata);
      commit(before);
      d.close();
    };
    refresh();if(!d.open)d.showModal();updateBusy();
  }
  function confirmCloseEditor(){
    if(aiJob){toast('AI 增强仍在运行，请完成后再退出');return;}
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
  function queueWorkflow(){
    if(hostReadonly||aiJob){if(aiJob)toast('AI 增强执行中，不能提交视频生成');return;}
    finishDurationEdit();finishPromptEdit();syncAllReferences();
    if(!embedded){toast('正式嵌入 ComfyUI 后可从这里运行整个工作流。');return;}
    embedDirty=false;
    window.parent.postMessage({type:'terrydirector:dirty',dirty:false},hostOrigin);
    window.parent.postMessage({
      type:'terrydirector:queue-workflow',
      document:documentPayload()
    },hostOrigin);
  }
  function saveToHost(){
    if(hostReadonly)return;
    if(aiJob){toast('AI 增强仍在进行，请完成或取消后再保存');return;}
    finishPromptEdit();
    if(!embedded){markEdited();toast('已保存编排。正式接入 ComfyUI 后会同时隐藏浮窗。');return;}
    embedDirty=false;
    window.parent.postMessage({type:'terrydirector:dirty',dirty:false},hostOrigin);
    window.parent.postMessage({type:'terrydirector:save',document:documentPayload()},hostOrigin);
  }
  const actions={
    new:newClip,
    'prompt-user':()=>switchPromptMode('user'),
    'prompt-ai':()=>switchPromptMode('ai'),
    'ai-enhance':()=>void startAiEnhance(false),
    'ai-cancel':()=>void cancelAiJob(),
    'enhance-all':()=>void startAiEnhance(true),
    'toggle-auto-ai':()=>{if(aiConfig&&!hostReadonly)mutate(()=>state.autoAiEnhance=!state.autoAiEnhance);},
    'global-prompt':openGlobalPrompt,
    'import-timeline':()=>{if(!hostReadonly)$('#timelineImportInput').click();},
    'export-timeline':exportTimelineData,
    'upload-assets':()=>$('#fileInput').click(),
    'pick-input':pickInputAssets,
    help,
    'toggle-prompt-view':()=>{finishPromptEdit();promptView=promptView==='visual'?'text':'visual';renderPrompt();},
    'edit-clip-name':()=>{const input=$('#clipName');if(!input?.disabled){input.focus();input.select();}},
    'save-close':saveToHost,
    'queue-workflow':queueWorkflow,
    'close-editor':()=>{if(aiJob){toast('AI 增强仍在运行，请完成后再退出');return;}if(embedded)window.parent.postMessage({type:'terrydirector:request-close'},hostOrigin);},
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
    suspend:()=>{if(current())mutate(()=>{current().suspended=!current().suspended;});},
    reset:()=>{setChainEnabled(true);finishPromptEdit();resetActivity();timeline.cancel();history=new C.History();resetAssetCache(false);
      if(!embedded&&siteDemoDocument){loadDocument(C.copy(siteDemoDocument));aiConfig={previewOnly:true};renderAiControls();return;}
      state={globalPrompt:'',aiGlobalPrompt:'',globalPromptMode:'user',globalAiMetadata:{},
        autoAiEnhance:false,clips:C.copy(initial),selected:null,assetIds:[]};
      renderAll();timeline.fit();timeline.setFrame(0);}
  };
  app.addEventListener('click',e=>{
    const target=e.target,button=target.closest('[data-action]');
    if(button){
      const allowedWhileRunning=new Set(['close-editor','close-dialog','toggle-prompt-view','pointer','hand','zoom-out','zoom-in','fit','export-timeline']);
      if(hostReadonly&&!allowedWhileRunning.has(button.dataset.action))return;
      if(!button.disabled)actions[button.dataset.action]?.();
      return;
    }
    const preview=target.closest('[data-preview-ref]');if(preview){previewAsset(preview.dataset.previewRef);return;}
    const remove=target.closest('[data-delete-asset]');if(remove){if(!hostReadonly)deleteAsset(remove.dataset.deleteAsset);return;}
    const insert=target.closest('[data-insert-ref]');if(insert){if(!hostReadonly)insertReference(insert.dataset.insertRef);return;}

  });
  $('#clipName').addEventListener('change',e=>{if(current())mutate(()=>current().name=e.target.value.trim()||'未命名片段');});
  $('#autoAiEnhance').addEventListener('change',e=>{
    if(!aiConfig||hostReadonly){e.target.checked=!!state.autoAiEnhance;return;}
    const checked=e.target.checked;mutate(()=>state.autoAiEnhance=checked);
  });
  $('#useGlobalPrompt').addEventListener('change',e=>{
    const clip=current();if(!clip)return;
    const enabled=!!e.target.checked;
    if(enabled){
      const budget=referenceBudgetForClip(clip,{useGlobal:true});
      if(!budget.ok){
        e.target.checked=false;
        showReferenceLimitDialog('无法启用全局提示词',clip,budget);
        return;
      }
    }
    mutate(()=>clip.useGlobalPrompt=enabled);
  });
  $('#dialog').addEventListener('close',()=>{if($('#dialog').dataset.mode==='global-prompt')destroyGlobalPromptEditor();});
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
  $('#timelineImportInput').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';if(file)void importTimelineFile(file);});
  $('#zoomRange').addEventListener('input',e=>{timeline.zoom((.22*Math.pow(24/.22,Number(e.target.value)/100))/timeline.ppf);});
  app.addEventListener('dragstart',e=>{const ref=e.target.closest('[data-reference]');if(ref){if(hostReadonly){e.preventDefault();return;}e.dataTransfer.setData('application/x-terrydirector-asset',ref.dataset.reference);e.dataTransfer.effectAllowed='copy';}});
  for(const id of ['referenceDrop','timelineBody']){
    const host=$('#'+id);host.addEventListener('dragover',e=>{e.preventDefault();if(hostReadonly){e.dataTransfer.dropEffect='none';return;}e.dataTransfer.dropEffect='copy';if(id==='referenceDrop')host.classList.add('is-dragover');});
    host.addEventListener('dragleave',e=>{if(!host.contains(e.relatedTarget))host.classList.remove('is-dragover');});
    host.addEventListener('drop',e=>{
      e.preventDefault();host.classList.remove('is-dragover');if(hostReadonly)return;
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
    if(hostReadonly){
      if(mod)return;
      if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();timeline.setFrame(timeline.frame+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?C.FPS:1));}
      else if(key==='v')actions.pointer();else if(key==='h')actions.hand();else if(key==='f')actions.fit();else if(key==='+'||key==='=')actions['zoom-in']();else if(key==='-')actions['zoom-out']();else if(key==='home'){e.preventDefault();timeline.setFrame(0);}else if(key==='end'){e.preventDefault();timeline.setFrame(timeline.total);}
      return;
    }
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
  $('#dialog').addEventListener('cancel',event=>{
    if($('#dialog').dataset.mode==='global-prompt'&&aiJob){
      event.preventDefault();toast('全局 AI 增强仍在进行，请完成或取消后关闭');
    }
  });
  $('#dialog').addEventListener('click',e=>{
    if(e.target!==e.currentTarget)return;
    const r=e.currentTarget.getBoundingClientRect();
    if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom){
      if(e.currentTarget.dataset.mode==='global-prompt'&&aiJob){
        toast('全局 AI 增强仍在进行，请先取消');return;
      }
      e.currentTarget.close();
    }
  });
  window.addEventListener('pointerdown',e=>{if(transitionMenu&&!transitionMenu.contains(e.target))closeTransitionMenu();},true);
  if(embedded){
    window.addEventListener('message',event=>{
      if(event.origin!==hostOrigin||event.source!==window.parent)return;
      const message=event.data||{};
      if(message.type==='terrydirector:load')loadDocument(message.document);
      else if(message.type==='terrydirector:ai-config'){
        aiConfig=message.config||null;
        aiConfigStatus=String(message.status||(aiConfig?'active':'disconnected'));
        renderAiControls();
      }
      else if(message.type==='terrydirector:ai-patch')applyHostAiPatch(message.clips);
      else if(message.type==='terrydirector:preferences')defaultTransitionMode=normalizeTransitionMode(message.defaultTransitionMode,'tail_reference');
      else if(message.type==='terrydirector:activity')applyHostActivity(message.activity);
      else if(message.type==='terrydirector:request-save')saveToHost();
      else if(message.type==='terrydirector:confirm-close')confirmCloseEditor();
    });
    window.parent.postMessage({type:'terrydirector:ready'},hostOrigin);
  }
  if(!embedded){
    const previewControls=$('#demoPreviewControls');
    if(previewControls){
      previewControls.hidden=false;
      previewControls.addEventListener('click',event=>{
        const button=event.target.closest('[data-demo-width]');
        if(!button)return;
        const width=button.dataset.demoWidth;
        app.style.maxWidth=width==='auto'?'':String(Number(width))+'px';
        previewControls.querySelectorAll('[data-demo-width]').forEach(item=>{
          item.setAttribute('aria-pressed',String(item===button));
        });
        requestAnimationFrame(()=>{timeline?.resize();timeline?.fit();});
      });
    }
    window.TerryDirectorDemo.ready=loadSiteDemo();
  }
  window.addEventListener('pagehide',()=>{stopDialogMedia();promptEditor.closeMenu();});
  window.addEventListener('beforeunload',()=>{stopDialogMedia();promptEditor.destroy();timeline.destroy();assets.filter(a=>a.local).forEach(a=>URL.revokeObjectURL(a.src));});
})();