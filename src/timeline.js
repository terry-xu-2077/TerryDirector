/* Independent, two-layer Canvas timeline. No rendering framework in the drag loop.
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
      this.snapEnabled = true; this.hand = false; this.showWave = false;
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
      const names = {bg:'timeline-bg',grid:'timeline-grid',ruler:'timeline-ruler',playhead:'timeline-playhead',selection:'timeline-selection',snap:'timeline-snap',overlap:'timeline-overlap',clip:'timeline-clip',selected:'timeline-clip-selected',edge:'timeline-clip-edge',highlight:'timeline-clip-highlight',wave:'timeline-waveform',text:'text-main',muted:'text-secondary',inset:'bg-inset',border:'border',effect:'effect'};
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
    get trackHeight() { return Math.max(38,Math.min(65,(this.height-this.ruler-38)/2-6)); }
    y(lane) { return this.ruler+10+lane*(this.trackHeight+12); }
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
    hitTest(p) {
      // There is intentionally no overlap branch here: only actual clip geometry.
      return [...this.clips].reverse().find(c=>p.y>=this.y(c.lane)&&p.y<=this.y(c.lane)+this.trackHeight&&p.x>=Math.max(this.inset,this.x(c.start)-5)&&p.x<=this.x(c.end)+5);
    }
    down(e) {
      if(e.button!==0&&e.button!==1)return;
      e.preventDefault();this.overlay.focus({preventScroll:true});this.stop();
      const p=this.point(e); if(p.x<this.inset)return;
      this.overlay.setPointerCapture(e.pointerId);
      if(e.button===1||this.hand){this.drag={mode:'pan',origin:p,scroll:this.scroll,pointer:e.pointerId};this.overlay.style.cursor='grabbing';return;}
      const c=this.hitTest(p);
      if(p.y<this.ruler||(!c&&Math.abs(this.x(this.frame)-p.x)<7)||!c){this.drag={mode:'seek',pointer:e.pointerId};this.setFrame(this.frameAt(p.x));return;}
      const mode=Math.abs(p.x-this.x(c.start))<9?'left':Math.abs(p.x-this.x(c.end))<9?'right':'move';
      this.selected=c.id;this.options.onSelect?.(c.id);
      this.drag={mode,id:c.id,origin:p,original:C.copy(this.clips),start:c.start,end:c.end,pointer:e.pointerId,last:p};
      this.overlay.style.cursor=mode==='move'?'grabbing':'ew-resize';this.invalidate();
    }
    move(e) {
      const p=this.point(e);
      if(!this.drag){const c=this.hitTest(p);this.hover=c?.id||null;this.overlay.style.cursor=this.hand?'grab':c?(Math.min(Math.abs(p.x-this.x(c.start)),Math.abs(p.x-this.x(c.end)))<9?'ew-resize':'grab'):'default';this.invalidate();return;}
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
      if(this.snapEnabled&&!alt){const targets=[0,this.frame,...d.original.filter(c=>c.id!==d.id).flatMap(c=>[c.start,c.end])];const offsets=d.mode==='move'?[0,d.end-d.start]:[0];const result=C.snap(value,offsets,targets,7/this.ppf);value=result.value;this.snapFrame=result.target;}
      this.clips=C.editClip(d.original,d.id,d.mode,value);
      const edited=this.clips.find(c=>c.id===d.id),actual=d.mode==='right'?edited.end:edited.start;
      if(Math.abs(actual-value)>.5)this.snapFrame=null;
      this.options.onPreview?.(this.clips);this.invalidate();
    }
    up(e) {
      if(!this.drag)return;
      const d=this.drag;this.drag=null;this.snapFrame=null;
      if(this.overlay.hasPointerCapture(e.pointerId))this.overlay.releasePointerCapture(e.pointerId);
      this.overlay.style.cursor=this.hand?'grab':'default';
      if(d.original)this.options.onCommit?.(this.clips,d.original);
      this.clampScroll();this.invalidate();
    }
    cancel() {
      if(!this.drag)return;const d=this.drag;this.drag=null;this.snapFrame=null;
      if(d.original){this.clips=d.original;this.options.onPreview?.(this.clips);}
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
      for(let lane=0;lane<2;lane++){const y=this.y(lane);ctx.font='11px Consolas, monospace';ctx.fillStyle=t.ruler;ctx.fillText(lane?'B':'A',27,y+this.trackHeight/2);ctx.strokeStyle=t.grid;ctx.beginPath();ctx.moveTo(this.inset,y+this.trackHeight+6);ctx.lineTo(w,y+this.trackHeight+6);ctx.stroke();}
      ctx.save();ctx.beginPath();ctx.rect(this.inset,30,w-this.inset,h);ctx.clip();
      this.clips.forEach((c,i)=>{
        const x=this.x(c.start),width=(c.end-c.start)*this.ppf,y=this.y(c.lane),ch=this.trackHeight;
        if(x+width<this.inset-10||x>w+10)return;
        const selected=c.id===this.selected;
        let fill=t.clip;
        if(selected){const g=ctx.createLinearGradient(x,y,x+width,y+ch);g.addColorStop(0,t.selected);g.addColorStop(1,t.highlight);fill=g;}
        this.rect(ctx,x,y,width,ch,7,fill,selected?t.selection:t.border);
        ctx.save();ctx.beginPath();ctx.roundRect(x+1,y+1,Math.max(1,width-2),ch-2,6);ctx.clip();
        const img=this.image(this.options.getImage?.(c));
        if(img&&width>66){ctx.globalAlpha=selected?.13:.11;const iw=(ch-8)*img.naturalWidth/img.naturalHeight;for(let xx=Math.max(x,x+Math.floor((this.inset-x)/iw)*iw);xx<x+width;xx+=iw)ctx.drawImage(img,xx,y+4,iw,ch-8);ctx.globalAlpha=1;}
        ctx.fillStyle=selected?t.selection:t.edge;ctx.fillRect(x+7,y+10,2,ch-20);
        this.rect(ctx,x+15,y+10,43,20,4,selected?t.selected:t.inset);
        ctx.font='11px "Segoe UI",sans-serif';ctx.fillStyle=t.text;ctx.fillText(`片段 ${i+1}`,x+21,y+19);
        ctx.font='12px "Segoe UI","Microsoft YaHei",sans-serif';this.label(ctx,c.name,x+66,y+19,width-76);
        ctx.font='10px "Segoe UI",sans-serif';ctx.fillStyle=t.muted;
        this.label(ctx,`${((c.end-c.start)/C.FPS).toFixed(1)}s  ·  ${c.status==='running'?'模拟生成中':c.versions.length?`v${String(c.version+1).padStart(2,'0')}  演示版本`:'待生成'}`,x+17,y+ch-11,width-30);
        if(this.showWave){ctx.strokeStyle=t.wave;ctx.globalAlpha=.25;ctx.beginPath();for(let xx=x+width*.52;xx<x+width-12;xx+=3){const a=3+5*Math.abs(Math.sin(xx*.053+i)*Math.cos(xx*.081));ctx.moveTo(xx,y+ch-14-a);ctx.lineTo(xx,y+ch-14+a);}ctx.stroke();ctx.globalAlpha=1;}
        ctx.restore();
        if(selected||this.hover===c.id){for(const hx of [x+2,x+width-6])this.rect(ctx,hx,y+13,4,ch-26,2,t.text);}
      });
      ctx.restore();
    }
    drawOverlay() {
      const ctx=this.ox,t=this.theme,w=this.width,h=this.height;ctx.clearRect(0,0,w,h);
      ctx.save();ctx.beginPath();ctx.rect(this.inset,30,w-this.inset,h);ctx.clip();
      for(const o of C.overlaps(this.clips)){
        const x=this.x(o.start),width=o.frames*this.ppf;
        if(x+width<this.inset||x>w)continue;
        const focused=[this.selected,this.hover,this.drag?.id].some(id=>id===o.a||id===o.b);
        const top=this.y(0)-3,bottom=this.y(1)+this.trackHeight+3;
        ctx.globalAlpha=focused?.075:.035;this.rect(ctx,x,top,width,bottom-top,7,t.overlap);
        ctx.globalAlpha=focused?.63:.25;this.rect(ctx,x,top,width,bottom-top,7,null,t.overlap);ctx.globalAlpha=1;
        // Passive duration bubble: drawing only, never a DOM button or hit target.
        const text=`${(o.frames/C.FPS).toFixed(o.frames%C.FPS?2:1)}s`;
        ctx.font='10px Consolas, monospace';const tw=ctx.measureText(text).width+15;
        const cx=C.clamp(x+width/2,this.inset+tw/2+2,w-tw/2-3),by=Math.min(h-15,bottom+14);
        if(focused||width>22){ctx.strokeStyle=t.overlap;ctx.globalAlpha=focused?.75:.32;ctx.beginPath();ctx.moveTo(cx,bottom);ctx.lineTo(cx,by-7);ctx.stroke();this.rect(ctx,cx-tw/2,by-8,tw,16,8,t.bg,t.overlap);ctx.globalAlpha=1;ctx.fillStyle=focused?t.overlap:t.ruler;ctx.textBaseline='middle';ctx.fillText(text,cx-tw/2+7,by);}
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
