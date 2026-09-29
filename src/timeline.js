/* Single-row timeline on two independent Canvas layers. No rendering framework in the drag loop.
 * Public boundary: setClips / select / setFrame / callbacks / destroy.
 * Overlap is drawn from TDCore.intersection; it is deliberately absent from hitTest. */
(function () {
  'use strict';
  const C = window.TDCore;
  class Timeline {
    constructor(host, options) {
      this.host = host; this.options = options; this.clips = options.clips;
      this.selected = options.selected; this.frame = 0; this.ppf = 1.8; this.scroll = 0;
      this.inset = 70; this.ruler = 32; this.width = 1; this.height = 1;
      this.snapEnabled = true; this.chainEnabled = true; this.hand = false; this.showWave = false;
      this.images = new Map(); this.hover = null; this.drag = null; this.playing = false;
      this.dirty = true; this.raf = 0; this.snapFrame = null;
      this.content = host.querySelector('.content'); this.overlay = host.querySelector('.overlay');
      this.ctx = this.content.getContext('2d'); this.ox = this.overlay.getContext('2d');
      this.abort = new AbortController(); const signal = this.abort.signal;
      this.readTheme();
      this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
      const on = (name, fn, extra = {}) => this.overlay.addEventListener(name, fn.bind(this), { signal, ...extra });
      on('pointerdown', this.down); on('pointermove', this.move); on('pointerup', this.up);
      on('pointercancel', this.cancel); on('lostpointercapture', this.cancel);
      on('pointerleave', function () { if (!this.drag) { this.hover = null; this.invalidate(); } });
      on('wheel', this.wheel, { passive:false });
      on('contextmenu', function(e) { e.preventDefault(); });
      this.resize(); this.fit();
    }
    readTheme() {
      const names = {bg:'timeline-bg',grid:'timeline-grid',ruler:'timeline-ruler',playhead:'timeline-playhead',selection:'timeline-selection',snap:'timeline-snap',overlap:'timeline-overlap',clip:'timeline-clip',selected:'timeline-clip-selected',edge:'timeline-clip-edge',highlight:'timeline-clip-highlight',wave:'timeline-waveform',text:'text-main',muted:'text-secondary',inset:'bg-inset',border:'border',effect:'effect',progress:'timeline-progress',progressTrack:'timeline-progress-track',success:'status-success',warning:'status-warning'};
      this.theme = {};
      const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'; document.body.append(probe);
      for (const [key,value] of Object.entries(names)) { probe.style.color = `var(--td-${value})`; this.theme[key] = getComputedStyle(probe).color; }
      probe.remove(); this.dirty = true;
    }
    resize() {
      const rect = this.host.getBoundingClientRect(); this.width = rect.width; this.height = rect.height;
      const ratio = Math.min(3, window.devicePixelRatio || 1);
      for (const c of [this.content,this.overlay]) { c.width = Math.max(1,Math.round(this.width*ratio)); c.height = Math.max(1,Math.round(this.height*ratio)); c.getContext('2d').setTransform(ratio,0,0,ratio,0,0); }
      this.clampScroll(); this.invalidate();
    }
    get total() { return Math.max(C.FPS, ...this.clips.map(c=>c.end)); }
    // Keep title/status legible at the compact minimum; reserve 48px for the leader and bubble.
    get trackHeight() { return Math.max(54,Math.min(82,this.height-this.ruler-10-48)); }
    y() { return this.ruler+10; }
    x(frame) { return this.inset+frame*this.ppf-this.scroll; }
    frameAt(x) { return Math.max(0,Math.round((x-this.inset+this.scroll)/this.ppf)); }
    point(e) { const r=this.host.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; }
    setClips(clips) { this.clips=clips; this.clampScroll(); this.invalidate(); }
    select(id) { this.selected=id; this.invalidate(); }
    setFrame(frame,notify=true) { this.frame=C.clamp(Math.round(frame),0,this.total); if(notify)this.options.onFrame?.(this.frame); this.invalidate(false); }
    invalidate(content=true) { if(content)this.dirty=true; if(!this.raf)this.raf=requestAnimationFrame(t=>this.paint(t)); }
    clampScroll() { this.scroll=C.clamp(this.scroll,0,Math.max(0,(this.total+C.FPS*3)*this.ppf-(this.width-this.inset-20))); this.options.onView?.(this.viewInfo()); }
    viewInfo() { return {scroll:this.scroll,contentWidth:(this.total+C.FPS*3)*this.ppf,visible:this.width-this.inset-20,ppf:this.ppf}; }
    fit() { this.ppf=C.clamp((this.width-this.inset-45)/(this.total+C.FPS),.22,20); this.scroll=0; this.clampScroll(); this.invalidate(); }
    zoom(factor,anchor=this.x(this.frame)) { anchor=C.clamp(anchor,this.inset,this.width-15); const f=(anchor-this.inset+this.scroll)/this.ppf; this.ppf=C.clamp(this.ppf*factor,.22,24); this.scroll=f*this.ppf-anchor+this.inset; this.clampScroll(); this.invalidate(); }
    wheel(e) { e.preventDefault(); if(e.ctrlKey||e.metaKey)this.zoom(Math.exp(-e.deltaY*.007),this.point(e).x); else { this.scroll+=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY; this.clampScroll(); this.invalidate(); } }
    setScroll(value) { this.scroll=value;this.clampScroll();this.invalidate(); }
    togglePlayback() {
      if(this.playing){this.playing=false;this.options.onPlay?.(false);return;}
      if(this.frame>=this.total)this.setFrame(0);
      this.playing=true;this.playStart=performance.now();this.playFrame=this.frame;
      this.options.onPlay?.(true);this.invalidate(false);
    }
    stop() { if(this.playing){this.playing=false;this.options.onPlay?.(false);} }
    edgeAt(c,p) {
      const left=Math.abs(p.x-this.x(c.start)),right=Math.abs(p.x-this.x(c.end));
      const threshold=Math.min(9,(c.end-c.start)*this.ppf/3);
      return Math.min(left,right)<=threshold?(left<=right?'left':'right'):'move';
    }
    hitTest(p) {
      // Later clips sit in front. The passive overlap and its callout never hit.
      if(p.y<this.y()||p.y>this.y()+this.trackHeight||p.x<this.inset)return;
      const front=[...this.clips].reverse().find(c=>p.x>=this.x(c.start)&&p.x<=this.x(c.end));
      const selected=this.clips.find(c=>c.id===this.selected);
      // A selected earlier clip can still be trimmed at its concealed tail.
      if(selected&&this.edgeAt(selected,p)!=='move'){
        const distance=c=>Math.min(Math.abs(p.x-this.x(c.start)),Math.abs(p.x-this.x(c.end)));
        if(!front||distance(selected)<distance(front))return selected;
      }
      return front;
    }
    down(e) {
      if(e.button!==0&&e.button!==1)return;
      e.preventDefault();this.overlay.focus({preventScroll:true});this.stop();
      const p=this.point(e); if(p.x<this.inset)return;
      this.overlay.setPointerCapture(e.pointerId);
      if(e.button===1||this.hand){this.drag={mode:'pan',origin:p,scroll:this.scroll,pointer:e.pointerId};this.overlay.style.cursor='grabbing';return;}
      const c=this.hitTest(p);
      if(p.y<this.ruler||(!c&&Math.abs(this.x(this.frame)-p.x)<7)||!c){this.drag={mode:'seek',pointer:e.pointerId};this.setFrame(this.frameAt(p.x));return;}
      const mode=this.edgeAt(c,p);
      this.selected=c.id;this.options.onSelect?.(c.id);
      this.drag={mode,id:c.id,origin:p,original:C.copy(this.clips),start:c.start,end:c.end,pointer:e.pointerId,last:p,follow:mode==='move'&&this.chainEnabled};
      this.overlay.style.cursor=mode==='move'?'grabbing':'ew-resize';this.invalidate();
    }
    move(e) {
      const p=this.point(e);
      if(!this.drag){const c=this.hitTest(p);this.hover=c?.id||null;const activity=c?this.options.getActivity?.(c):null;this.overlay.title=activity?.completedAt?`${c.name} · 完成于 ${new Date(activity.completedAt).toLocaleString()} · ${activity.example?'示例记录':'模拟生成'}`:'';this.overlay.style.cursor=this.hand?'grab':c?(this.edgeAt(c,p)!=='move'?'ew-resize':'grab'):'default';this.invalidate();return;}
      const d=this.drag;
      if(d.mode==='pan'){this.scroll=d.scroll+d.origin.x-p.x;this.clampScroll();this.invalidate();return;}
      if(d.mode==='seek'){this.setFrame(this.frameAt(p.x));return;}
      d.last=p;this.updateDrag(e.altKey);
    }
    updateDrag(alt=false) {
      const d=this.drag;if(!d||!d.original)return;
      const delta=Math.round((d.last.x-d.origin.x)/this.ppf);
      const initial=d.mode==='right'?d.end:d.start;
      let value=initial+delta;this.snapFrame=null;
      if(this.snapEnabled&&!alt){
        // Followers move with the head: their old edges are not stationary snap targets.
        const fixed=d.follow?d.original.slice(0,d.original.findIndex(c=>c.id===d.id)):d.original.filter(c=>c.id!==d.id);
        const targets=[0,this.frame,...fixed.flatMap(c=>[c.start,c.end])];
        const offsets=d.mode==='move'?[0,d.end-d.start]:[0];
        const result=C.snap(value,offsets,targets,7/this.ppf);value=result.value;this.snapFrame=result.target;
      }
      this.clips=d.follow?C.moveFollowing(d.original,d.id,value):C.editClip(d.original,d.id,d.mode,value);
      const edited=this.clips.find(c=>c.id===d.id);if(!edited)return;const actual=d.mode==='right'?edited.end:edited.start;
      if(Math.abs(actual-value)>.5)this.snapFrame=null;
      this.options.onPreview?.(this.clips);this.invalidate();
    }
    up(e) {
      if(!this.drag)return;
      const d=this.drag;this.drag=null;this.snapFrame=null;
      if(this.overlay.hasPointerCapture(e.pointerId))this.overlay.releasePointerCapture(e.pointerId);
      this.overlay.style.cursor=this.hand?'grab':'default';
      if(d.original){this.options.onCommit?.(this.clips,d.original);this.options.onDragEnd?.();}
      this.clampScroll();this.invalidate();
    }
    cancel() {
      if(!this.drag)return;const d=this.drag;this.drag=null;this.snapFrame=null;
      if(d.original){this.clips=d.original;this.options.onPreview?.(this.clips);this.options.onDragEnd?.();}
      this.overlay.style.cursor='default';this.invalidate();
    }
    image(src) {
      if(!src)return null;
      if(!this.images.has(src)){const image=new Image();image.onload=()=>this.invalidate();image.src=src;this.images.set(src,image);}
      const image=this.images.get(src);return image.complete&&image.naturalWidth?image:null;
    }
    rect(ctx,x,y,w,h,r,fill,stroke) { if(w<=0||h<=0)return;ctx.beginPath();ctx.roundRect(x,y,w,h,Math.min(r,w/2,h/2));if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();} }
    label(ctx,text,x,y,max) { if(max<=0)return;let str=text;while(str.length>1&&ctx.measureText(str).width>max)str=str.slice(0,-1);if(str!==text)str=str.slice(0,-1)+'…';ctx.fillText(str,x,y); }
    drawContent() {
      const ctx=this.ctx,t=this.theme,w=this.width,h=this.height;
      ctx.clearRect(0,0,w,h);ctx.fillStyle=t.bg;ctx.fillRect(0,0,w,h);
      const intervals=[1,2,4,6,12,24,48,72,120,240,480,960];const step=intervals.find(n=>n*this.ppf>=72)||1920;
      const start=Math.floor(this.frameAt(this.inset)/step)*step;
      ctx.font='10px Consolas, monospace';ctx.textBaseline='middle';
      for(let f=start;this.x(f)<w;f+=step){const x=this.x(f);if(x<this.inset)continue;ctx.strokeStyle=t.grid;ctx.beginPath();ctx.moveTo(x+.5,29);ctx.lineTo(x+.5,h-5);ctx.stroke();ctx.fillStyle=t.ruler;const text=step<C.FPS?`${Math.floor(f/C.FPS)}s ${f%C.FPS}f`:`${String(Math.floor(f/(C.FPS*60))).padStart(2,'0')}:${String(Math.floor(f/C.FPS)%60).padStart(2,'0')}`;ctx.fillText(text,x+4,14);if(step/2*this.ppf>15){ctx.beginPath();ctx.moveTo(x+step/2*this.ppf,26);ctx.lineTo(x+step/2*this.ppf,30);ctx.stroke();}}
      ctx.font='10px "Segoe UI","Microsoft YaHei",sans-serif';ctx.fillStyle=t.ruler;
      ctx.fillText('片段',20,this.y()+this.trackHeight/2);
      ctx.save();ctx.beginPath();ctx.rect(this.inset,30,w-this.inset,h);ctx.clip();
      this.clips.forEach((c,i)=>{
        const x=this.x(c.start),width=(c.end-c.start)*this.ppf,y=this.y(),ch=this.trackHeight;
        if(x+width<this.inset-10||x>w+10)return;
        const selected=c.id===this.selected;
        let fill=t.clip;
        if(selected){const g=ctx.createLinearGradient(x,y,x+width,y+ch);g.addColorStop(0,t.selected);g.addColorStop(1,t.highlight);fill=g;}
        this.rect(ctx,x,y,width,ch,8,fill,selected?t.selection:t.border);
        ctx.save();ctx.beginPath();ctx.roundRect(x+1,y+1,Math.max(1,width-2),ch-2,7);ctx.clip();
        const img=this.image(this.options.getImage?.(c));
        if(img&&width>66){ctx.globalAlpha=selected?.08:.045;const iw=(ch-8)*img.naturalWidth/img.naturalHeight;for(let xx=Math.max(x,x+Math.floor((this.inset-x)/iw)*iw);xx<x+width;xx+=iw)ctx.drawImage(img,xx,y+4,iw,ch-8);ctx.globalAlpha=1;}
        const badge=`片段 ${i+1}`;
        ctx.font='12px "Segoe UI","Microsoft YaHei",sans-serif';const badgeWidth=ctx.measureText(badge).width+14;
        this.rect(ctx,x+13,y+10,badgeWidth,23,5,t.inset);
        ctx.fillStyle=t.text;ctx.fillText(badge,x+20,y+21.5);
        const duration=`${Number(((c.end-c.start)/C.FPS).toFixed(2))}s`,dx=x+badgeWidth+24;
        ctx.font='12px Consolas,monospace';ctx.fillText(duration,dx,y+21.5);
        const descriptionX=dx+ctx.measureText(duration).width+13;
        ctx.font='12px "Segoe UI","Microsoft YaHei",sans-serif';ctx.fillStyle=t.muted;
        this.label(ctx,c.name,descriptionX,y+21.5,width-(descriptionX-x)-12);
        const activity=this.options.getActivity?.(c)||{status:'idle',progress:0};
        const running=activity.status==='running',done=activity.status==='completed';
        ctx.font='10px "Segoe UI","Microsoft YaHei",sans-serif';ctx.fillStyle=done?t.success:running?t.progress:t.ruler;
        ctx.beginPath();ctx.arc(x+16,y+ch-19,2.5,0,Math.PI*2);ctx.fill();
        ctx.fillStyle=t.muted;
        const seconds=Number((activity.elapsedSeconds||0).toFixed(1));
        const text=running?`模拟生成 ${Math.round((activity.progress||0)*100)}% · 已用 ${seconds}s`:done?`已完成 · 生成耗时 ${seconds}s${activity.example?' · 示例':' · 模拟'}`:'待生成';
        this.label(ctx,text,x+24,y+ch-19,width-35);
        if(running){const span=Math.max(0,width-18);this.rect(ctx,x+9,y+ch-7,span,4,2,t.progressTrack);this.rect(ctx,x+9,y+ch-7,span*C.clamp(activity.progress||0,0,1),4,2,t.progress);}
        if(this.showWave&&ch>=70){ctx.strokeStyle=t.wave;ctx.globalAlpha=.18;ctx.beginPath();for(let xx=x+13;xx<x+width-12;xx+=3){const a=2+3*Math.abs(Math.sin(xx*.053+i)*Math.cos(xx*.081));ctx.moveTo(xx,y+ch-36-a);ctx.lineTo(xx,y+ch-36+a);}ctx.stroke();ctx.globalAlpha=1;}
        ctx.restore();
      });
      // Only selected clips expose trim handles; hovering another clip adds no white bars.
      // Keep drawing these last so an earlier selected clip can expose its concealed tail.
      for(const c of this.clips.filter(c=>c.id===this.selected)){
        const x=this.x(c.start),end=this.x(c.end),y=this.y(),ch=this.trackHeight;
        for(const hx of [x+2,end-6])this.rect(ctx,hx,y+12,4,ch-24,2,t.text);
      }
      ctx.restore();
    }
    // Small visual gap only; overlap remains passive and hit testing is unchanged.
    get overlapLeaderGap() { return 8; }
    overlapCallouts(ctx) {
      const left=this.inset+4,right=this.width-5,bottom=this.y()+this.trackHeight+3;
      const items=C.overlaps(this.clips).map(o=>{
        const x=this.x(o.start),width=o.frames*this.ppf;
        const focused=[this.selected,this.hover,this.drag?.id].some(id=>id===o.a||id===o.b);
        const text=`${Number((o.frames/C.FPS).toFixed(2))}s`;
        return {...o,x,width,focused,text};
      }).filter(o=>o.x+o.width>left&&o.x<right&&(o.focused||o.width>20));
      ctx.font='11px Consolas,monospace';
      const placed=[];
      // Prioritise the active pair when zoomed so far out labels cannot all fit.
      items.sort((a,b)=>Number(b.focused)-Number(a.focused)||a.start-b.start);
      for(const o of items){
        const width=ctx.measureText(o.text).width+18;if(right-left<width)continue;
        const anchor=C.clamp(o.x+o.width/2,left,right),preferred=C.clamp(anchor-width/2,left,right-width);
        const candidates=[preferred,left,right-width,...placed.flatMap(p=>[p.x-width-8,p.x+p.width+8])];
        const fit=candidates.filter(x=>x>=left&&x+width<=right&&placed.every(p=>x+width+8<=p.x||x>=p.x+p.width+8)).sort((a,b)=>Math.abs(a-preferred)-Math.abs(b-preferred))[0];
        if(fit===undefined)continue;
        placed.push({...o,anchor,x:fit,width,y:bottom+this.overlapLeaderGap,height:23,bottom});
      }
      return placed;
    }
    drawOverlay() {
      const ctx=this.ox,t=this.theme,w=this.width,h=this.height;ctx.clearRect(0,0,w,h);
      ctx.save();ctx.beginPath();ctx.rect(this.inset,30,w-this.inset,h);ctx.clip();
      for(const o of C.overlaps(this.clips)){
        const x=this.x(o.start),width=o.frames*this.ppf;
        if(x+width<this.inset||x>w)continue;
        const focused=[this.selected,this.hover,this.drag?.id].some(id=>id===o.a||id===o.b);
        const top=this.y()-3,bottom=this.y()+this.trackHeight+3;
        ctx.globalAlpha=focused?.10:.05;this.rect(ctx,x,top,width,bottom-top,8,t.overlap);
        ctx.globalAlpha=focused?.85:.40;this.rect(ctx,x,top,width,bottom-top,8,null,t.overlap);ctx.globalAlpha=1;
      }
      // Duration labels ALWAYS sit below the frame, connected by a visible leader.
      // The label lane is reserved by trackHeight, never clamped into the overlap.
      for(const label of this.overlapCallouts(ctx)){
        const center=label.x+label.width/2;
        ctx.strokeStyle=t.overlap;ctx.globalAlpha=label.focused?.9:.55;ctx.lineWidth=1.2;
        ctx.beginPath();ctx.moveTo(label.anchor,label.bottom);ctx.lineTo(label.anchor,label.bottom+(label.y-label.bottom)/2);ctx.lineTo(center,label.y);ctx.stroke();
        this.rect(ctx,label.x,label.y,label.width,label.height,11,t.inset,t.overlap);
        ctx.globalAlpha=1;ctx.fillStyle=label.focused?t.overlap:t.muted;ctx.textBaseline='middle';
        ctx.fillText(label.text,label.x+9,label.y+label.height/2);
      }
      if(this.snapFrame!==null){const x=this.x(this.snapFrame);ctx.setLineDash([3,4]);ctx.strokeStyle=t.snap;ctx.beginPath();ctx.moveTo(x,30);ctx.lineTo(x,h);ctx.stroke();ctx.setLineDash([]);}
      ctx.restore();
      const x=this.x(this.frame);
      if(x>=this.inset&&x<=w){ctx.strokeStyle=t.playhead;ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(x+.5,27);ctx.lineTo(x+.5,h-3);ctx.stroke();this.rect(ctx,x-5,24,10,3,1.5,t.playhead);ctx.font='10px Consolas,monospace';const label=C.timecode(this.frame).slice(3);const tw=ctx.measureText(label).width+12;const bx=C.clamp(x-tw/2,this.inset,w-tw-2);this.rect(ctx,bx,2,tw,18,4,t.bg,t.playhead);ctx.fillStyle=t.playhead;ctx.textBaseline='middle';ctx.fillText(label,bx+6,11);}
    }
    paint(now) {
      this.raf=0;
      if(this.playing){const next=this.playFrame+Math.floor((now-this.playStart)*C.FPS/1000);this.frame=Math.min(this.total,next);this.options.onFrame?.(this.frame);if(this.frame>=this.total){this.playing=false;this.options.onPlay?.(false);}else if(this.x(this.frame)>this.width-25){this.scroll+=this.width*.45;this.clampScroll();this.dirty=true;}}
      if(this.dirty){this.drawContent();this.dirty=false;}this.drawOverlay();
      if(this.playing)this.invalidate(false);
    }
    destroy() { this.abort.abort();this.resizeObserver.disconnect();cancelAnimationFrame(this.raf);this.images.clear(); }
  }
  window.TDTimeline=Timeline;
})();
