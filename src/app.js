/* Zero-install visual prototype. DOM panels are disposable view adapters;
 * core.js and timeline.js contain the reusable frame/interaction logic.
 * No backend, fake connection status, generated video, or hidden persistence. */
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
  function ib(action,name,title,active=''){return `<button class="icon-button ${active}" data-action="${action}" title="${title}" aria-label="${title}">${icon(name)}</button>`;}
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
  const initial=[['发射前夜',0,8,0],['蓝调时刻',6,15,1],['靠近光',13,22,0],['向更远处',20,28,1]].map((a,i)=>({id:`clip-${i+1}`,name:a[0],start:a[1]*C.FPS,end:a[2]*C.FPS,lane:a[3],asset:i===3?'stars':'launch-wide',refs:['launch-wide'],user:prompts[i],ai:'',source:'user',resolution:'720P',seed:241907+i,audio:true,guide:'画面参考',versions:i<2?['演示 v01','演示 v02']:[],version:i<2?1:0,status:i<2?'completed':'idle'}));
  let state={clips:C.copy(initial),selected:'clip-2'}, history=new C.History();
  let title='远航之前',tab='clips',compact=false,query='',promptView='visual',previewMode='clip',previewAsset=null;
  let currentMedia='',mediaKind='',toastTimer=0,jobTimer=0,jobId=null,editBefore=null,nextId=5;
  const app=$('#app');
  app.innerHTML=`
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path fill="currentColor" d="M7 8h8v5h-3v11H7zm10 0h8v16h-8v-5h3v-6h-3z"/></svg></span>TerryDirector <em>STUDIO</em></div>
      <div class="crumbs">${ib('home','home','打开项目首页')}${icon('chevron')}<strong id="projectName">${title}</strong></div>
      <div class="top-actions"><span class="prototype">交互 DEMO · 01</span><span class="separator"></span>${ib('help','keyboard','快捷键与 Demo 说明')}${ib('reset','undo','还原演示数据')}<button class="button ghost" data-action="export">${icon('download')}<span>导出配置</span></button></div>
    </header>
    <main id="workspace" class="workspace">
      <aside class="browser">
        <div class="panel-head"><strong>项目内容 <span class="small-count" id="browserCount">04</span></strong><div class="actions">${ib('import','upload','导入本地素材')}${ib('new','plus','新建片段')}</div></div>
        <div class="tsd-sliding-tabs browser-tabs" id="browserTabs"><button class="tsd-sliding-tab is-active" data-action="clips">片段</button><button class="tsd-sliding-tab" data-action="assets">素材</button></div>
        <div class="browser-tools"><label class="search">${icon('search')}<input id="search" aria-label="搜索片段或素材" placeholder="搜索片段…"></label>${ib('view','list','切换卡片 / 列表')}</div>
        <div class="browser-content" id="browserContent"></div>
        <div class="browser-foot"><span id="browserFoot">4 个片段 · 2 处已有演示版本</span><button data-action="new">＋ 新建</button></div>
      </aside>
      <div id="leftResize" class="resize-v" role="separator" aria-label="调整素材面板宽度" aria-orientation="vertical"></div>
      <section class="center">
        <div class="monitor">
          <div class="panel-head monitor-head"><div class="monitor-mode"><button class="plain-tab" data-action="preview-timeline" id="modeTimeline">时间线</button><button class="plain-tab is-active" data-action="preview-clip" id="modeClip">当前片段</button></div><div class="actions">${ib('safe','eye','显示 / 隐藏安全框')}<button class="plain-tab" data-action="aspect" title="切换预览画幅">16:9</button>${ib('maximize','expand','最大化 / 恢复预览')}</div></div>
          <div class="monitor-stage" id="monitorStage"><div class="monitor-frame" id="monitorFrame"><div class="screen still-crop" id="screen"><img id="monitorImage" alt="示例画面"><video id="monitorVideo" hidden controls playsinline></video><div class="screen-audio" id="monitorAudioWrap" hidden>${icon('wave')}<span>本地音频预览</span><audio id="monitorAudio" controls></audio></div><div class="monitor-caption"><span class="dot"></span><span id="previewCaption"></span></div><div class="screen-note" id="screenNote">示例静帧 · 非生成视频</div></div></div></div>
          <div class="transport"><span class="timecode" id="monitorTime">00:00:08:00</span><div class="transport-center">${ib('prev','prev','上一片段')}<button class="play-button" data-action="play" id="playButton" title="播放 / 暂停时间线（空格）" aria-label="播放时间线">${icon('play')}</button>${ib('next','next','下一片段')}</div><div class="transport-right"><span id="durationLabel">28.00 秒</span><span>24 FPS</span></div></div>
          <div class="versions" id="versions"></div>
        </div>
        <section class="prompt-panel">
          <div class="prompt-head"><strong>片段提示词</strong><div class="tsd-segmented" id="promptSource"><button class="tsd-segmented-item is-active" data-source="user">用户提示词</button><button class="tsd-segmented-item" data-source="ai">AI 增强</button></div><div class="right"><div class="view-switch"><button class="plain-tab is-active" data-prompt-view="visual">可视化</button><button class="plain-tab" data-prompt-view="text">文本</button></div>${ib('enhance','spark','填入示例增强文本（不调用 AI）')}</div></div>
          <div class="prompt-body"><textarea class="prompt-text" id="promptText" spellcheck="false" aria-label="片段提示词文本" hidden></textarea><div class="prompt-visual" id="promptVisual"></div></div>
          <div class="prompt-foot"><span class="used" id="promptUsed"></span><button data-action="edit-prompt" id="promptEditHint">编辑原文</button></div>
        </section>
      </section>
      <div id="rightResize" class="resize-v" role="separator" aria-label="调整参数面板宽度" aria-orientation="vertical"></div>
      <aside class="inspector">
        <div class="inspector-header"><strong>片段设置</strong><small>跟随当前选择</small></div>
        <div class="inspector-scroll" id="inspectorScroll">
          <div class="clip-id"><b id="clipNumber">片段 02</b><span id="clipStatus">已完成 · 演示</span></div>
          <input class="clip-name" id="clipName" aria-label="片段名称" maxlength="60">
          <div class="config-section"><div class="section-label">${icon('clock')}时间<span class="right">24 fps</span></div><div class="num-grid"><label class="num-field"><span>开始时间</span><div class="number-box"><input type="number" id="startInput" aria-label="片段开始时间（秒）" min="0" step="0.04166667"><span>秒</span></div></label><label class="num-field"><span>片段时长</span><div class="number-box"><input type="number" id="lengthInput" aria-label="片段时长（秒）" min="1" step="0.04166667"><span>秒</span></div></label></div><p class="end-hint">结束于 <span id="endLabel"></span></p></div>
          <div class="config-section"><div class="section-label">${icon('link')}片段承接<span class="right">自动识别重叠</span></div><div class="continuity-card"><div class="continuity-top">${icon('link')}<span id="previousName">与上一片段</span></div><div class="overlap-value"><strong id="overlapSeconds">2.00s</strong><span id="overlapFrames">48 帧重叠</span></div></div><p class="passive-note">重叠区由片段位置自动计算，不单独编辑。</p><div class="tsd-parameter-row"><span>保留声音连续性</span><button class="tsd-switch" id="audioSwitch" data-action="audio" role="switch" aria-label="保留声音连续性" aria-checked="true"></button></div></div>
          <div class="config-section"><div class="section-label">${icon('image')}参考素材<span class="right" id="refCount">1 项</span></div><div class="references" id="references"></div><div class="tsd-parameter-row"><span>素材用途</span><select class="select-field" id="guideSelect" aria-label="素材用途"><option>画面参考</option><option>固定引导</option><option>边界引导</option></select></div></div>
          <div class="config-section"><div class="section-label">${icon('settings')}生成参数<span class="right">预览配置</span></div><div class="tsd-parameter-row"><span>分辨率</span><div class="tsd-sliding-tabs" id="resolutionTabs"><button class="tsd-sliding-tab is-active" data-resolution="720P">720P</button><button class="tsd-sliding-tab" data-resolution="1080P">1080P</button></div></div><div class="tsd-parameter-row"><span>随机种子</span><div class="number-box" style="width:145px"><input type="number" id="seedInput" aria-label="随机种子" min="0" step="1">${ib('seed','dice','更换随机种子')}</div></div></div>
        </div>
        <div class="inspector-footer"><button class="button primary full" id="generateButton" data-action="generate">${icon('spark')}模拟生成当前片段</button><div class="generation-note" id="generationNote">仅演示状态变化，不调用模型</div></div>
      </aside>
    </main>
    <div id="timelineResize" class="resize-h" role="separator" aria-label="调整时间线高度" aria-orientation="horizontal"></div>
    <section class="timeline-panel" id="timelinePanel">
      <div class="timeline-toolbar"><strong>时间线</strong><span class="subtle">主序列</span><span class="separator"></span><div class="timeline-tools">${ib('undo','undo','撤销（Ctrl / ⌘ Z）')}${ib('redo','redo','重做（Ctrl / ⌘ Shift Z）')}<span class="separator"></span>${ib('pointer','pointer','选择与移动片段（V）','is-active')}${ib('hand','hand','平移时间线（H / 鼠标中键）')}${ib('snap','magnet','吸附（S），拖动时 Alt 临时关闭','is-active')}${ib('duplicate','duplicate','复制选中片段至末尾')}${ib('delete','trash','删除选中片段（Delete）')}</div><span class="spacer"></span><span class="subtle" id="clipSummary">4 个片段</span>${ib('wave','wave','显示 / 隐藏示意波形')}<div class="timeline-zoom">${ib('zoom-out','minus','缩小（−）')}<input type="range" min="0" max="100" value="35" id="zoomRange" aria-label="时间线缩放">${ib('zoom-in','plus','放大（＋）')}${ib('fit','fit','适应全部片段（F）')}</div><button class="button ghost" data-action="new">${icon('plus')}新建片段</button></div>
      <div class="timeline-body" id="timelineBody"><canvas class="timeline-canvas content" aria-hidden="true"></canvas><canvas class="timeline-canvas overlay" tabindex="0" aria-label="两行时间线。拖动片段移动，拖动片段边缘裁剪；重叠区自动显示。空格播放，左右键步进，Ctrl Z 撤销。"></canvas></div>
      <div class="timeline-bottom"><div class="timeline-scroll" id="scrollBar"><div class="scroll-thumb" id="scrollThumb"></div></div><small id="zoomLabel">24 FPS</small></div>
    </section>
    <footer class="statusbar"><span class="status-inline"><i class="dot"></i>离线交互 Demo</span><span id="editStatus">演示数据 · 刷新后还原</span><span class="right desktop-hint"><kbd>拖动</kbd> 移动片段　<kbd>Alt</kbd> 暂时关闭吸附　<kbd>Ctrl + 滚轮</kbd> 缩放</span></footer>
    <section class="project-home" id="projectHome" hidden></section>
    <input type="file" id="fileInput" accept="image/*,video/*,audio/*" multiple hidden>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <dialog id="dialog"><div class="modal-header"><strong id="dialogTitle"></strong><button class="icon-button" data-action="close-dialog" aria-label="关闭弹窗">${icon('close')}</button></div><div class="modal-body" id="dialogBody"></div><div class="modal-actions" id="dialogActions"></div></dialog>
    <svg width="0" height="0" aria-hidden="true" style="position:absolute;pointer-events:none"><defs><clipPath id="folder-outline" clipPathUnits="objectBoundingBox"><path d="M0 .15 Q0 0 .06 0 H.32 C.36 0 .36 .13 .42 .13 H.94 Q1 .13 1 .27 V.87 Q1 1 .94 1 H.06 Q0 1 0 .87 Z"/></clipPath></defs></svg>`;

  const current=()=>state.clips.find(c=>c.id===state.selected)||state.clips[0];
  const assetFor=c=>assets.find(a=>a.id===c?.asset);
  const getImage=c=>{const a=assetFor(c);return a?.kind==='image'?a.src:launch;};
  function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3200);}
  function modal(name,body,confirmText,fn){const d=$('#dialog');$('#dialogTitle').textContent=name;$('#dialogBody').innerHTML=body;$('#dialogActions').innerHTML=confirmText?`<button class="button ghost" data-action="close-dialog">取消</button><button class="button primary" id="dialogConfirm">${esc(confirmText)}</button>`:`<button class="button" data-action="close-dialog">知道了</button>`;if(confirmText)$('#dialogConfirm').onclick=()=>{if(fn?.()!==false)d.close();};if(!d.open)d.showModal();}
  function commit(before){history.push(before,state);renderAll();$('#editStatus').textContent='已暂存于本页 · 刷新后还原';}
  function mutate(fn){const before=C.copy(state);fn();commit(before);}
  function renderBrowser(){
    const container=$('#browserContent'),scroll=container.scrollTop;
    $('#browserCount').textContent=String(tab==='clips'?state.clips.length:assets.length).padStart(2,'0');
    $('#browserTabs').style.setProperty('--index',tab==='clips'?0:1);
    $('#browserTabs').querySelectorAll('button').forEach(b=>b.classList.toggle('is-active',b.dataset.action===tab));
    $('#search').placeholder=tab==='clips'?'搜索片段…':'搜索素材…';
    if(tab==='clips'){
      container.innerHTML=`<div class="clip-list ${compact?'compact':''}">${state.clips.map((c,i)=>({c,i})).filter(({c})=>c.name.toLowerCase().includes(query.toLowerCase())).map(({c,i})=>`<button class="tsd-task-card ${state.selected===c.id?'is-selected':''}" data-clip="${c.id}" aria-pressed="${state.selected===c.id}"><div class="tsd-task-card-preview"><img src="${esc(getImage(c))}" alt="${esc(c.name)}的示例静帧" ${i===2?'style="object-position:55% 60%"':''}><span class="card-number">${String(i+1).padStart(2,'0')}</span></div><div class="tsd-task-card-heading"><strong>${esc(c.name)}</strong><span>${((c.end-c.start)/C.FPS).toFixed(1)}s</span></div><footer><span class="card-state"><i class="dot ${c.status==='running'?'running':c.versions.length?'':'pending'}"></i>${c.status==='running'?'模拟生成中':c.versions.length?'已有演示版本':'待生成'}</span><span>${c.versions.length?c.versions.length+' 版本':'—'}</span></footer></button>`).join('')||'<p class="empty">没有匹配的片段</p>'}</div>`;
    }else{container.innerHTML=`<div class="asset-grid">${assets.filter(a=>a.name.toLowerCase().includes(query.toLowerCase())).map(a=>`<button class="asset" data-asset="${a.id}" draggable="true" title="单击预览，双击添加为参考；也可拖到时间线片段上"><div class="asset-cover">${a.kind==='image'?`<img src="${esc(a.src)}" alt="">`:icon(a.kind==='video'?'film':'wave')}</div><strong>${esc(a.name)}</strong><small>${a.kind==='image'?'图像':a.kind==='video'?'视频':'音频'}</small></button>`).join('')}<button class="import-tile" data-action="import">${icon('plus')}导入素材</button></div><p class="passive-note" style="margin-top:18px">单击预览，双击添加为当前片段参考。<br>本地素材仅在当前页面有效，不会上传。</p>`;}
    container.scrollTop=scroll;
    $('#browserFoot').textContent=tab==='clips'?`${state.clips.length} 个片段 · ${state.clips.filter(c=>c.versions.length).length} 处已有版本`:`${assets.length} 个素材 · 本地预览`;
  }
  function renderPrompt(){
    const c=current();if(!c){$('#promptText').value='';$('#promptVisual').textContent='新建一个片段开始创作';return;}
    const text=c[c.source]||'';$('#promptText').value=text;
    $('#promptSource').querySelectorAll('button').forEach(b=>b.classList.toggle('is-active',b.dataset.source===c.source));
    document.querySelectorAll('[data-prompt-view]').forEach(b=>b.classList.toggle('is-active',b.dataset.promptView===promptView));
    $('#promptText').hidden=promptView!=='text';$('#promptVisual').hidden=promptView==='text';
    $('#promptVisual').innerHTML=text?esc(text).replace(/\[([^\]]+)\]/g,(_,label)=>`<span class="tsd-prompt-tag tone-${label.includes('声音')?'audio':label.includes('运镜')?'camera':'shot'}">${label}</span>`).replace(/&lt;(Picture|Video|Audio) (\d+)&gt;/g,(_,kind,num)=>`<span class="tsd-prompt-tag tone-time">${kind} ${num}</span>`).replace(/\n/g,'<br>'):'<span class="passive-note">还没有增强文本。右上角星形按钮可以填入一份示例，不会调用 AI。</span>';
    $('#promptUsed').innerHTML=icon('check')+`当前使用${c.source==='ai'?' AI 增强':'用户'}提示词`;
    $('#promptEditHint').textContent=promptView==='visual'?'编辑原文':'可视化预览';
  }
  function renderTiming(clips=state.clips){
    const c=clips.find(x=>x.id===state.selected);if(!c)return;
    const index=clips.indexOf(c),prev=clips[index-1],o=prev?C.intersection(prev,c):{frames:0};
    if(document.activeElement!==$('#startInput'))$('#startInput').value=(c.start/C.FPS).toFixed(3);
    if(document.activeElement!==$('#lengthInput'))$('#lengthInput').value=((c.end-c.start)/C.FPS).toFixed(3);
    $('#endLabel').textContent=C.timecode(c.end);
    $('#previousName').textContent=o.frames?`承接「${prev.name}」`:prev?'未与上一片段重叠':'首个片段 · 独立起点';
    $('#overlapSeconds').textContent=o.frames?(o.frames/C.FPS).toFixed(2)+'s':'—';
    $('#overlapFrames').textContent=o.frames?`${o.frames} 帧重叠`:'无重叠';
    $('#durationLabel').textContent=(Math.max(0,...clips.map(x=>x.end))/C.FPS).toFixed(2)+' 秒';
  }
  function renderInspector(){
    const c=current();$('#inspectorScroll').hidden=!c;$('#generateButton').disabled=!c||Boolean(jobId);
    $('#generateButton').innerHTML=icon('spark')+(jobId?'模拟生成中…':'模拟生成当前片段');
    if(!c)return;
    $('#clipNumber').textContent=`片段 ${String(state.clips.indexOf(c)+1).padStart(2,'0')}`;$('#clipName').value=c.name;
    $('#clipStatus').textContent=c.status==='running'?'模拟生成中':c.versions.length?'已有演示版本':'待生成';renderTiming();
    $('#audioSwitch').setAttribute('aria-checked',c.audio);$('#guideSelect').value=c.guide;$('#seedInput').value=c.seed;
    $('#resolutionTabs').style.setProperty('--index',c.resolution==='1080P'?1:0);$('#resolutionTabs').querySelectorAll('button').forEach(b=>b.classList.toggle('is-active',b.dataset.resolution===c.resolution));
    $('#refCount').textContent=c.refs.length+' 项';
    $('#references').innerHTML=c.refs.map(id=>assets.find(a=>a.id===id)).filter(Boolean).map(a=>a.kind==='image'?`<img class="ref-image" src="${esc(a.src)}" alt="${esc(a.name)}" title="${esc(a.name)}">`:`<span class="ref-chip">${icon(a.kind==='audio'?'wave':'film')}${esc(a.name)}</span>`).join('')+`<button class="ref-add" data-action="add-ref" title="从素材面板添加参考" aria-label="添加参考素材">${icon('plus')}</button>`;
  }
  function renderVersions(){const c=current();$('#versions').innerHTML=`<span>生成版本</span>${c?.versions.length?c.versions.map((v,i)=>`<button class="version ${i===c.version?'is-active':''}" data-version="${i}">v${String(i+1).padStart(2,'0')}${i===c.version?' ✓':''}</button>`).join(''):'<span>尚未生成</span>'}<span class="version-note">示例静帧，非模型输出</span>`;}
  let aspect=16/9;
  function sizeMonitor(){const r=$('#monitorStage').getBoundingClientRect();const width=Math.max(1,Math.min(r.width-44,(r.height-8)*aspect));$('#monitorFrame').style.width=width+'px';$('#monitorFrame').style.height=width/aspect+'px';}
  const monitorObserver=new ResizeObserver(sizeMonitor);monitorObserver.observe($('#monitorStage'));
  function renderMonitor(frame=timeline?.frame||0,force=false){
    const c=previewMode==='timeline'?(state.clips.find(x=>frame>=x.start&&frame<x.end)||null):current();
    const asset=previewAsset||assetFor(c);
    $('#monitorTime').textContent=C.timecode(frame);
    $('#modeTimeline').classList.toggle('is-active',previewMode==='timeline'&&!previewAsset);$('#modeClip').classList.toggle('is-active',previewMode==='clip'&&!previewAsset);
    const key=`${asset?.id||'gap'}:${c?.id||'none'}:${c?.version||0}:${previewAsset?'asset':'clip'}`;
    if(currentMedia!==key||force){
      currentMedia=key;mediaKind=asset?.kind||'gap';$('#monitorVideo').pause();$('#monitorAudio').pause();
      $('#monitorImage').hidden=mediaKind!=='image';$('#monitorVideo').hidden=mediaKind!=='video';$('#monitorAudioWrap').hidden=mediaKind!=='audio';
      if(mediaKind==='image'){$('#monitorImage').src=asset.src;$('#monitorImage').style.objectPosition=c?.id==='clip-3'?'55% 60%':'50% 50%';$('#monitorImage').style.filter=c?.version===0?'saturate(.72)':'none';}
      if(mediaKind==='video')$('#monitorVideo').src=asset.src;
      if(mediaKind==='audio')$('#monitorAudio').src=asset.src;
      $('#previewCaption').textContent=previewAsset?`素材预览 · ${asset.name}`:c?`片段 ${String(state.clips.indexOf(c)+1).padStart(2,'0')}  /  ${c.name}${c.versions.length?'  ·  v'+String(c.version+1).padStart(2,'0'):''}`:'时间线空隙';
      $('#screenNote').textContent=previewAsset?'本地素材预览':mediaKind==='gap'?'此时间没有片段':mediaKind==='image'?'示例静帧 · 非生成视频':'本地媒体 · 独立播放器';
    }
  }
  function renderAll(){
    if(!state.clips.some(c=>c.id===state.selected))state.selected=state.clips[0]?.id||null;
    renderBrowser();renderPrompt();renderInspector();renderVersions();
    if(timeline){timeline.setClips(state.clips);timeline.select(state.selected);renderMonitor(timeline.frame,true);}
    $('#clipSummary').textContent=`${state.clips.length} 个片段 · ${C.overlaps(state.clips).length} 处重叠`;
    $('[data-action=undo]').disabled=!history.undoItems.length;$('[data-action=redo]').disabled=!history.redoItems.length;
  }
  function select(id,seek=true){state.selected=id;previewAsset=null;previewMode='clip';if(timeline){timeline.select(id);if(seek){const c=current();if(c)timeline.setFrame(c.start+Math.min(C.FPS*2,c.end-c.start-1));}}renderAll();}
  let timeline=null;
  timeline=new window.TDTimeline($('#timelineBody'),{clips:state.clips,selected:state.selected,getImage,
    onSelect:id=>select(id,false),onFrame:frame=>renderMonitor(frame),
    onPlay:playing=>{if(playing){previewMode='timeline';previewAsset=null;}$('#playButton').innerHTML=icon(playing?'pause':'play');$('#playButton').setAttribute('aria-label',playing?'暂停时间线':'播放时间线');},
    onPreview:clips=>renderTiming(clips),
    onCommit:(clips,beforeClips)=>{const before={...C.copy(state),clips:beforeClips};state.clips=clips;commit(before);},
    onView:v=>{const max=Math.max(v.visible,v.contentWidth),width=Math.min(100,v.visible/max*100);$('#scrollThumb').style.width=width+'%';$('#scrollThumb').style.left=Math.min(100-width,v.scroll/max*100)+'%';$('#zoomLabel').textContent=`${Math.round(v.ppf*C.FPS)} px/s`;$('#zoomRange').value=Math.log(v.ppf/.22)/Math.log(24/.22)*100;}
  });
  renderAll();timeline.setFrame(8*C.FPS);sizeMonitor();
  function showHome(){timeline.stop();$('#monitorVideo').pause();$('#monitorAudio').pause();$('#workspace').hidden=true;$('#timelineResize').hidden=true;$('#timelinePanel').hidden=true;$('#projectHome').hidden=false;
    $('#projectHome').innerHTML=`<div class="home-heading"><div><div class="eyebrow">YOUR CREATIVE SPACE</div><h1>每一个故事，从这里开始。</h1><p>打开项目，回到创作。</p></div><button class="button" data-action="project-new">${icon('plus')}新建项目</button></div><div class="project-grid"><div class="tsd-project-folder-item"><button class="tsd-project-folder-card has-cover" data-action="open-project"><div class="tsd-project-folder-sheet tsd-project-folder-paper"></div><div class="tsd-project-folder-sheet tsd-project-folder-paper-middle"></div><div class="tsd-project-folder-sheet tsd-project-folder-cover" style="background-image:url('${esc(launch)}')"></div><div class="tsd-project-folder-front"><div class="tsd-project-folder-tab">当前演示项目</div><h3>${esc(title)}</h3><p>从发射前夜，到更远的天际。</p><footer><span>${state.clips.length} 个片段</span><span>${assets.length} 个素材</span></footer></div></button></div><button class="new-project" data-action="project-new">${icon('plus')}新建项目</button></div><div class="home-foot">这是前端交互原型。项目仅在当前页面暂存；刷新会还原。可以导出配置保留本次编排。</div>`;
  }
  function openProject(){$('#projectHome').hidden=true;$('#workspace').hidden=false;$('#timelineResize').hidden=false;$('#timelinePanel').hidden=false;timeline.resize();sizeMonitor();}
  function newClip(){modal('新建片段','<label>片段名称<input type="text" id="newClipName" value="新的片段" maxlength="60"></label><p>追加到时间线末尾，默认与前一片段重叠 2 秒。之后可直接拖动调整。</p>','创建片段',()=>{const name=$('#newClipName').value.trim();if(!name)return false;appendClip(name);});}
  function appendClip(name,template){mutate(()=>{const prev=state.clips.at(-1),start=prev?Math.max(prev.start+1,prev.end-48):0;const c=template?{...C.copy(template),versions:[],version:0,status:'idle'}:{name,user:'[镜头] 在这里描述你想要的画面。',ai:'',source:'user',resolution:'720P',seed:Math.floor(Math.random()*1e7),audio:true,guide:'画面参考',asset:'launch-wide',refs:['launch-wide'],versions:[],version:0,status:'idle'};const lane=prev?1-prev.lane:0,same=state.clips.filter(x=>x.lane===lane),safeStart=Math.max(start,...same.map(x=>x.end));Object.assign(c,{id:'clip-'+nextId++,name,start:safeStart,end:safeStart+(template?template.end-template.start:8*C.FPS),lane});state.clips.push(c);state.selected=c.id;});previewAsset=null;previewMode='clip';timeline.fit();renderMonitor(timeline.frame,true);}
  function addReference(id){const c=current();if(!c){toast('请先创建一个片段。');return;}if(c.refs.includes(id)){toast('这个素材已经在当前片段的参考中。');return;}mutate(()=>current().refs.push(id));toast('已添加参考素材；未上传任何文件。');}
  function importFiles(files){let n=0;for(const file of files){const kind=file.type.split('/')[0];if(!['image','video','audio'].includes(kind))continue;assets.push({id:'local-'+Date.now()+'-'+n,name:file.name,kind,src:URL.createObjectURL(file),local:true,detail:'本地导入'});n++;}tab='assets';query='';$('#search').value='';renderBrowser();toast(n?`已载入 ${n} 个本地素材，仅此页面有效。`:'请选择图片、视频或音频。');}
  function exportConfig(){const payload={format:'terrydirector-demo',version:1,fps:C.FPS,project:{title},clips:C.copy(state.clips),assets:assets.map(({id,name,kind,local})=>({id,name,kind,requiresReimport:Boolean(local)})),note:'界面原型数据，不是 ComfyUI 工作流。时间范围为整数帧 [start,end)，重叠仅由位置派生。本地素材不包含在此 JSON 中。'};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='TerryDirector-demo.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast('已导出片段编排与提示词配置；不包含媒体文件。');}
  function help(){modal('Demo 操作说明',`<p>这是视觉与交互原型。预置画面是示例静帧，播放按钮预演时间与画面选择；不会连接 ComfyUI、调用 AI 或生成真实视频。</p>${[['移动 / 裁剪','拖动片段 / 片段两端'],['播放 / 暂停','Space'],['前后 1 帧','← / →'],['前后 1 秒','Shift + ← / →'],['选择 / 平移','V / H · 中键平移'],['吸附 / 暂时关闭','S / 拖动时 Alt'],['缩放 / 适应全部','Ctrl + 滚轮 · ＋ − / F'],['撤销 / 重做','Ctrl/⌘ Z / Shift Z'],['删除片段','Delete / Backspace'],['取消当前拖动','Esc']].map(([a,b])=>`<div class="shortcut-row"><span>${a}</span><kbd>${b}</kbd></div>`).join('')}<p>重叠色框和时长气泡只是反馈，不可拖动或选中。参数修改仅影响演示配置；可视化提示词为预览，在「文本」中编辑。</p>`);}
  const actions={
    home:showHome,'open-project':openProject,
    'project-new':()=>modal('新建演示项目','<label>项目名称<input type="text" id="newProjectName" maxlength="60" placeholder="为你的故事取个名字"></label><p>会替换本页演示内容，不影响仓库或磁盘项目。</p>','新建',()=>{const n=$('#newProjectName').value.trim();if(!n)return false;clearInterval(jobTimer);jobId=null;title=n;$('#projectName').textContent=n;state={clips:[],selected:null};history=new C.History();renderAll();openProject();timeline.fit();}),
    clips:()=>{tab='clips';query='';$('#search').value='';renderBrowser();},assets:()=>{tab='assets';query='';$('#search').value='';renderBrowser();},
    view:()=>{compact=!compact;renderBrowser();},import:()=>$('#fileInput').click(),new:newClip,export:exportConfig,help,
    reset:()=>modal('还原演示数据','<p>当前页面的片段编排与提示词会被示例替换。需要保留时，请先导出配置。</p>','还原',()=>{clearInterval(jobTimer);clearTimeout(toastTimer);$('#toast').classList.remove('show');jobId=null;state={clips:C.copy(initial),selected:'clip-2'};history=new C.History();title='远航之前';$('#projectName').textContent=title;previewAsset=null;openProject();renderAll();timeline.fit();timeline.setFrame(192);$('#generationNote').textContent='仅演示状态变化，不调用模型';}),
    play:()=>{if(!state.clips.length){toast('先创建一个片段再播放。');return;}timeline.togglePlayback();},
    prev:()=>{const i=state.clips.findIndex(c=>c.id===state.selected);const c=state.clips[Math.max(0,i-1)];if(c)select(c.id);},next:()=>{const i=state.clips.findIndex(c=>c.id===state.selected);const c=state.clips[Math.min(state.clips.length-1,i+1)];if(c)select(c.id);},
    'preview-timeline':()=>{previewMode='timeline';previewAsset=null;renderMonitor(timeline.frame,true);},'preview-clip':()=>{previewMode='clip';previewAsset=null;renderMonitor(timeline.frame,true);},
    safe:()=>{$('#screen').classList.toggle('safe');$('[data-action=safe]').classList.toggle('is-active');},
    aspect:()=>{aspect=aspect===16/9?2.35:16/9;$('[data-action=aspect]').textContent=aspect===16/9?'16:9':'2.35:1';sizeMonitor();},
    maximize:()=>{app.classList.toggle('maximized-monitor');sizeMonitor();},
    undo:()=>{timeline.cancel();const prev=history.undo(state);if(prev){state=prev;renderAll();toast('已撤销');}},redo:()=>{timeline.cancel();const next=history.redo(state);if(next){state=next;renderAll();toast('已重做');}},
    pointer:()=>{timeline.hand=false;$('[data-action=pointer]').classList.add('is-active');$('[data-action=hand]').classList.remove('is-active');},hand:()=>{timeline.hand=true;$('[data-action=hand]').classList.add('is-active');$('[data-action=pointer]').classList.remove('is-active');},
    snap:()=>{timeline.snapEnabled=!timeline.snapEnabled;$('[data-action=snap]').classList.toggle('is-active',timeline.snapEnabled);},
    'zoom-out':()=>timeline.zoom(.8),'zoom-in':()=>timeline.zoom(1.25),fit:()=>timeline.fit(),
    wave:()=>{timeline.showWave=!timeline.showWave;$('[data-action=wave]').classList.toggle('is-active',timeline.showWave);timeline.invalidate();if(timeline.showWave)toast('这里显示的是示意波形，不是音频分析结果。');},
    delete:()=>{if(!current()||jobId)return;timeline.cancel();mutate(()=>{state.clips=state.clips.filter(c=>c.id!==state.selected);state.selected=state.clips[0]?.id||null;});},duplicate:()=>{if(current())appendClip(current().name+' · 副本',current());},
    'add-ref':()=>{tab='assets';renderBrowser();toast('双击素材，或将素材拖到时间线片段上。');},
    audio:()=>{if(current())mutate(()=>current().audio=!current().audio);},seed:()=>{if(current())mutate(()=>current().seed=Math.floor(Math.random()*1e9));},
    'edit-prompt':()=>{promptView=promptView==='visual'?'text':'visual';renderPrompt();if(promptView==='text')$('#promptText').focus();},
    enhance:()=>{if(!current())return;mutate(()=>{const c=current();c.ai=c.user+'\n\n[视觉基调] 延续参考中的冷暖关系，保持画面真实自然。\n[运镜] 动作与构图连续，镜头克制。';c.source='ai';});toast('已填入示例增强文本，未调用 AI。');},
    generate:()=>{if(jobId||!current())return;if(!(current()[current().source]||'').trim()){toast('先填写当前使用的提示词。');return;}timeline.stop();jobId=current().id;current().status='running';renderAll();let p=0;jobTimer=setInterval(()=>{p+=10;$('#generationNote').textContent=`模拟进度 ${p}% · 不调用模型`;if(p>=100){clearInterval(jobTimer);const before=C.copy(state),old=before.clips.find(x=>x.id===jobId);if(old)old.status=old.versions.length?'completed':'idle';const c=state.clips.find(x=>x.id===jobId);if(c){c.versions.push('演示 v'+String(c.versions.length+1).padStart(2,'0'));c.version=c.versions.length-1;c.status='completed';}jobId=null;commit(before);$('#generationNote').textContent='仅演示状态变化，不调用模型';toast('模拟完成：已新增演示版本，没有生成视频。');}},220);},
    'close-dialog':()=>$('#dialog').close()
  };
  app.addEventListener('click',e=>{
    const action=e.target.closest('[data-action]');if(action&&!action.disabled){actions[action.dataset.action]?.();return;}
    const card=e.target.closest('[data-clip]');if(card){select(card.dataset.clip);return;}
    const asset=e.target.closest('[data-asset]');if(asset){timeline.stop();previewAsset=assets.find(a=>a.id===asset.dataset.asset);renderMonitor(timeline.frame,true);return;}
    const source=e.target.closest('[data-source]');if(source&&current()){mutate(()=>current().source=source.dataset.source);return;}
    const view=e.target.closest('[data-prompt-view]');if(view){promptView=view.dataset.promptView;renderPrompt();return;}
    const res=e.target.closest('[data-resolution]');if(res&&current()){mutate(()=>current().resolution=res.dataset.resolution);return;}
    const version=e.target.closest('[data-version]');if(version&&current())mutate(()=>current().version=Number(version.dataset.version));
  });
  app.addEventListener('dblclick',e=>{const a=e.target.closest('[data-asset]');if(a)addReference(a.dataset.asset);});
  $('#search').addEventListener('input',e=>{query=e.target.value;renderBrowser();});
  $('#promptText').addEventListener('focus',()=>{editBefore=C.copy(state);});
  $('#promptText').addEventListener('input',e=>{const c=current();if(c)c[c.source]=e.target.value;});
  $('#promptText').addEventListener('blur',()=>{if(editBefore){history.push(editBefore,state);editBefore=null;renderPrompt();$('[data-action=undo]').disabled=!history.undoItems.length;$('#editStatus').textContent='已暂存于本页 · 刷新后还原';}});
  $('#clipName').addEventListener('change',e=>{if(current())mutate(()=>current().name=e.target.value.trim()||'未命名片段');});
  for(const [id,mode] of [['startInput','move'],['lengthInput','right']])$('#'+id).addEventListener('change',e=>{const n=Number(e.target.value);if(!current()||!Number.isFinite(n)){renderTiming();return;}const before=C.copy(state),c=current();state.clips=C.editClip(state.clips,c.id,mode,Math.round(n*C.FPS)+(mode==='right'?c.start:0));commit(before);e.target.value=(mode==='move'?current().start/C.FPS:(current().end-current().start)/C.FPS).toFixed(3);});
  $('#seedInput').addEventListener('change',e=>{const n=Number(e.target.value);if(current()&&Number.isFinite(n))mutate(()=>current().seed=C.clamp(Math.round(n),0,4294967295));});
  $('#guideSelect').addEventListener('change',e=>{if(current())mutate(()=>current().guide=e.target.value);});
  $('#fileInput').addEventListener('change',e=>{importFiles(e.target.files);e.target.value='';});
  $('#zoomRange').addEventListener('input',e=>{const next=.22*Math.pow(24/.22,Number(e.target.value)/100);timeline.zoom(next/timeline.ppf);});
  app.addEventListener('dragstart',e=>{const a=e.target.closest('[data-asset]');if(a){e.dataTransfer.setData('application/x-terrydirector-asset',a.dataset.asset);e.dataTransfer.effectAllowed='copy';}});
  $('#timelineBody').addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';});
  $('#timelineBody').addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.files.length){importFiles(e.dataTransfer.files);return;}const id=e.dataTransfer.getData('application/x-terrydirector-asset');if(!assets.some(a=>a.id===id))return;const c=timeline.hitTest(timeline.point(e));if(c){select(c.id,false);addReference(id);}else toast('将素材放到一个时间线片段上，即可添加为参考。');});
  window.addEventListener('keydown',e=>{
    if(e.target.closest('input,textarea,select,[contenteditable=true],dialog')||!$('#projectHome').hidden)return;
    if(e.code==='Escape'){timeline.cancel();return;}
    const mod=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();
    if(mod&&key==='z'){e.preventDefault();actions[e.shiftKey?'redo':'undo']();return;}
    if(mod&&key==='y'){e.preventDefault();actions.redo();return;}
    if(mod)return;
    if(e.code==='Space'&&!e.target.closest('button')){e.preventDefault();actions.play();}
    else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();timeline.stop();previewMode='timeline';previewAsset=null;timeline.setFrame(timeline.frame+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?C.FPS:1));}
    else if(['Delete','Backspace'].includes(e.key)){e.preventDefault();actions.delete();}
    else if(key==='v')actions.pointer();else if(key==='h')actions.hand();else if(key==='s')actions.snap();else if(key==='f')actions.fit();else if(key==='+'||key==='=')actions['zoom-in']();else if(key==='-')actions['zoom-out']();else if(key==='home'){e.preventDefault();timeline.setFrame(0);}else if(key==='end'){e.preventDefault();timeline.setFrame(timeline.total);}
  });
  // Simple split panes: geometry changes only. No persistence/runtime subsystem.
  function resizeHandle(id,variable,min,max,axis,sign){const el=$('#'+id);let drag=null;el.addEventListener('pointerdown',e=>{e.preventDefault();drag={origin:axis==='x'?e.clientX:e.clientY,value:parseFloat(getComputedStyle(app).getPropertyValue(variable))};el.setPointerCapture(e.pointerId);});el.addEventListener('pointermove',e=>{if(!drag)return;const delta=(axis==='x'?e.clientX:e.clientY)-drag.origin;app.style.setProperty(variable,C.clamp(drag.value+delta*sign,min,max)+'px');});el.addEventListener('pointerup',()=>drag=null);el.addEventListener('pointercancel',()=>drag=null);el.addEventListener('dblclick',()=>app.style.removeProperty(variable));}
  resizeHandle('leftResize','--browser-width',190,370,'x',1);resizeHandle('rightResize','--inspector-width',250,400,'x',-1);resizeHandle('timelineResize','--timeline-height',210,400,'y',-1);
  let scrollDrag=null;$('#scrollBar').addEventListener('pointerdown',e=>{const r=e.currentTarget.getBoundingClientRect(),v=timeline.viewInfo();scrollDrag={x:e.clientX,initial:timeline.scroll,scale:v.contentWidth/r.width};e.currentTarget.setPointerCapture(e.pointerId);if(e.target!==$('#scrollThumb')){timeline.setScroll((e.clientX-r.left)/r.width*v.contentWidth-v.visible/2);scrollDrag.initial=timeline.scroll;}});$('#scrollBar').addEventListener('pointermove',e=>{if(scrollDrag)timeline.setScroll(scrollDrag.initial+(e.clientX-scrollDrag.x)*scrollDrag.scale);});$('#scrollBar').addEventListener('pointerup',()=>scrollDrag=null);$('#scrollBar').addEventListener('pointercancel',()=>scrollDrag=null);
  // Small inspection boundary for integration and reproducible browser smoke checks.
  window.TerryDirectorDemo={getState:()=>C.copy(state),timeline,applyTheme:palette=>{for(const [key,value] of Object.entries(palette)){if(/^--td-(neutral|violet|warm|ink)-[a-z-]+$/.test(key)&&CSS.supports('color',value))document.body.style.setProperty(key,value);}timeline.readTheme();timeline.invalidate();},reset:()=>actions.reset()};
  window.addEventListener('beforeunload',()=>{clearInterval(jobTimer);timeline.destroy();monitorObserver.disconnect();assets.filter(a=>a.local).forEach(a=>URL.revokeObjectURL(a.src));});
})();
