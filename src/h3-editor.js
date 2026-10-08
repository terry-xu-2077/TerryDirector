/* Host-independent H3 visual editor. Ported menu/atomic-tag behavior from
 * ComfyUI-TerryXu-nodes; graph inputs replaced by the project-wide asset pool.
 * No framework, model calls, or second prompt source. */
(function () {
  'use strict';
  const S=window.TDH3Syntax, CARET='\u200B';
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
  const clean=s=>String(s||'').replaceAll(CARET,'').replace(/\r\n?/g,'\n');
  // data-raw, not the translated label, is the authoritative token value.
  function serialize(root){
    let out='';
    function walk(parent){
      let previousBlock=false;
      for(const child of parent.childNodes||[]){
        if(child.nodeType===3){out+=clean(child.nodeValue);previousBlock=false;continue;}
        if(child.nodeType!==1)continue;
        if(child.dataset.raw!=null){out+=child.dataset.raw;previousBlock=false;continue;}
        if(child.tagName==='BR'){out+='\n';previousBlock=false;continue;}
        const block=/^(DIV|P|LI)$/.test(child.tagName);
        if(block&&(previousBlock||(out&&!out.endsWith('\n'))))out+='\n';
        const placeholder=block&&child.childNodes.length===1&&child.firstChild.nodeName==='BR';
        if(!placeholder)walk(child);previousBlock=block;
      }
    }
    walk(root);return clean(out);
  }
  function appendText(parent,text){
    text.split('\n').forEach((p,i)=>{if(i)parent.append(document.createElement('br'));if(p)parent.append(document.createTextNode(p));});
  }
  function rangeInside(editor){const s=window.getSelection();return s?.rangeCount&&editor.contains(s.getRangeAt(0).commonAncestorContainer)?s.getRangeAt(0):null;}
  function rawOffset(editor,node,offset){const r=document.createRange();r.selectNodeContents(editor);r.setEnd(node,offset);return serialize(r.cloneContents()).length;}
  function offsets(editor){const r=rangeInside(editor);return r?{start:rawOffset(editor,r.startContainer,r.startOffset),end:rawOffset(editor,r.endContainer,r.endOffset)}:null;}
  function pointAt(root,offset){
    let left=offset;
    function walk(n){
      for(let i=0;i<n.childNodes.length;i++){
        const ch=n.childNodes[i];
        if(ch.nodeType===3){const text=ch.nodeValue||'',len=clean(text).length;if(left<=len){let p=0,real=0;while(p<text.length&&real<left){if(text[p]!==CARET)real++;p++;}while(p<text.length&&text[p]===CARET)p++;return [ch,p];}left-=len;}
        else if(ch.nodeType===1){
          if(ch.dataset.raw!=null){const len=ch.dataset.raw.length;if(left===0)return[n,i];if(left<=len)return[n,i+1];left-=len;}
          else if(ch.tagName==='BR'){if(left===0)return[n,i];left--;}
          else{const hit=walk(ch);if(hit)return hit;}
        }
      }
      return null;
    }
    return walk(root)||[root,root.childNodes.length];
  }
  function selectOffsets(editor,start,end=start){
    const a=pointAt(editor,start),b=pointAt(editor,end),r=document.createRange();r.setStart(...a);r.setEnd(...b);const s=window.getSelection();s.removeAllRanges();s.addRange(r);
  }
  // The source editor's boundary rule: a single Backspace/Delete removes a tag,
  // ignoring only invisible caret markers, not real spaces or line breaks.
  function boundaryTag(n,backward){
    if(!n)return undefined;
    if(n.nodeType===3)return clean(n.nodeValue)?null:undefined;
    if(n.nodeType!==1||n.tagName==='BR')return null;
    if(n.dataset.raw!=null)return n;
    const children=[...n.childNodes];if(backward)children.reverse();
    for(const c of children){const v=boundaryTag(c,backward);if(v!==undefined)return v;}return null;
  }
  function adjacentTag(editor,r,backward){
    let n=r.startContainer;const at=r.startOffset;
    if(n.nodeType===3){if(clean(backward?n.nodeValue.slice(0,at):n.nodeValue.slice(at)))return null;}
    else{const children=[...n.childNodes];for(let i=backward?at-1:at;i>=0&&i<children.length;i+=backward?-1:1){const v=boundaryTag(children[i],backward);if(v!==undefined)return v;}}
    while(n&&n!==editor){let c=backward?n.previousSibling:n.nextSibling;while(c){const v=boundaryTag(c,backward);if(v!==undefined)return v;c=backward?c.previousSibling:c.nextSibling;}n=n.parentNode;if(n!==editor&&/^(DIV|P|LI)$/.test(n?.nodeName||''))return null;}return null;
  }
  class H3Editor{
    constructor({visual,textarea,getAssets,getAssetAvailability,onBeforeChange,onChange,onCommit,onHistory,menuRoot}){
      Object.assign(this,{visual,textarea,getAssets,getAssetAvailability,onBeforeChange,onChange,onCommit,onHistory});
      this.menuRoot=menuRoot||document.body;
      this.value='';this.context=null;this.mode='visual';this.composing=false;this.menu=null;this.bookmark=null;this.timer=0;
      this.abort=new AbortController();const signal=this.abort.signal;
      const on=(target,type,fn,opts={})=>target.addEventListener(type,fn,{signal,...opts});
      on(visual,'beforeinput',e=>{
        if(e.inputType==='historyUndo'||e.inputType==='historyRedo'){e.preventDefault();this.commit();this.onHistory?.(e.inputType==='historyRedo');return;}
        this.onBeforeChange?.();
        if(!this.composing&&e.inputType==='insertParagraph'&&!e.target.closest('.h3-dialogue-body')){e.preventDefault();this.replaceSelection('\n',false);}
      });
      on(visual,'input',e=>{
        this.changed();if(this.composing||e.isComposing)return;
        if(!e.target.closest('.h3-dialogue-body')){this.detectMenu();if(!this.menu&&/[>\]:]/.test(e.data||''))this.normalize();}
      });
      on(visual,'compositionstart',()=>{this.composing=true;clearTimeout(this.timer);this.closeMenu();this.onBeforeChange?.();});
      on(visual,'compositionend',()=>{this.composing=false;this.changed();this.detectMenu();});
      on(visual,'keydown',e=>this.keydown(e));
      on(visual,'copy',e=>this.copy(e,false));on(visual,'cut',e=>this.copy(e,true));
      on(visual,'paste',e=>{e.preventDefault();e.stopPropagation();const text=clean(e.clipboardData?.getData('text/plain'));this.onBeforeChange?.();this.replaceSelection(text,true);});
      on(visual,'pointerdown',e=>this.tagPointer(e));
      on(visual,'blur',()=>{if(!this.composing)this.commit();});
      on(visual,'scroll',()=>{if(this.menu)this.positionMenu();});
      on(textarea,'beforeinput',()=>this.onBeforeChange?.());
      on(textarea,'compositionstart',()=>{this.composing=true;clearTimeout(this.timer);this.onBeforeChange?.();});
      on(textarea,'compositionend',()=>{this.composing=false;this.rawChanged();});
      on(textarea,'input',()=>{this.rawChanged();if(!this.composing)this.detectMenu();});
      on(textarea,'blur',()=>{if(!this.composing)this.commit();});
      on(textarea,'keydown',e=>{if(!e.isComposing&&this.handleMenuKey(e)){e.preventDefault();e.stopPropagation();return;}if(!e.isComposing&&(e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();e.stopPropagation();this.commit();this.onHistory?.(e.key.toLowerCase()==='y'||e.shiftKey);}});
      on(document,'selectionchange',()=>{if(this.mode==='visual'&&rangeInside(visual))this.bookmark=offsets(visual);});
      on(document,'pointerdown',e=>{if(this.menu&&!this.menu.element.contains(e.target))this.closeMenu();},{capture:true});
      on(window,'resize',()=>{if(this.menu)this.positionMenu();});
      on(document,'keydown',e=>{if(this.menu&&this.menu.element.contains(e.target)&&e.key==='Escape'){e.preventDefault();this.closeMenu();visual.focus();}});
    }
    rawChanged(){this.onBeforeChange?.();this.value=clean(this.textarea.value);this.onChange?.(this.value);this.scheduleCommit();}
    changed(){this.onBeforeChange?.();this.value=serialize(this.visual);this.onChange?.(this.value);this.scheduleCommit();}
    scheduleCommit(){clearTimeout(this.timer);if(!this.composing)this.timer=setTimeout(()=>this.commit(),650);}
    commit(){clearTimeout(this.timer);this.onCommit?.();}
    setContext(id,text,mode){
      const switched=id!==this.context,changed=text!==this.value,modeChanged=mode!==this.mode;
      if(switched||changed||modeChanged)this.closeMenu();
      if(this.mode==='visual'&&!switched)this.bookmark=offsets(this.visual)||this.bookmark;
      if(this.mode==='text'&&!switched)this.bookmark={start:this.textarea.selectionStart,end:this.textarea.selectionEnd};
      const focused=this.visual.contains(document.activeElement)||document.activeElement===this.textarea;
      this.context=id;this.mode=mode;this.value=String(text||'');
      if(switched)this.bookmark={start:0,end:0};
      this.visual.hidden=!id||mode!=='visual';this.textarea.hidden=!id||mode!=='text';
      this.visual.contentEditable=String(!!id);this.visual.setAttribute('aria-disabled',String(!id));this.textarea.disabled=!id;
      if(mode==='visual'&&(switched||changed||modeChanged||!this.visual.childNodes.length)){
        this.render(this.value);if(focused&&!switched&&this.bookmark)selectOffsets(this.visual,this.bookmark.start,this.bookmark.end);
      }
      if(mode==='text'&&this.textarea.value!==this.value)this.textarea.value=this.value;
      if(modeChanged&&this.bookmark&&id){if(mode==='visual'){this.visual.focus({preventScroll:true});selectOffsets(this.visual,this.bookmark.start,this.bookmark.end);}else{this.textarea.focus({preventScroll:true});this.textarea.setSelectionRange(this.bookmark.start,this.bookmark.end);}}
      this.refreshAssets();
    }
    createToken(raw){
      const type=S.tokenType(raw);if(type==='plain')return document.createTextNode(raw);
      const chip=el('span','h3-chip h3-'+type);chip.contentEditable='false';chip.dataset.raw=raw;chip.dataset.kind=type;chip.title=raw;
      if(type==='dialogue'){
        const m=raw.match(/^<d>\[([^\]]+)\]([\s\S]*?)<\/d>$/i),language=m?.[1]||'Chinese';
        const select=el('select','h3-language');select.setAttribute('aria-label','对白语言');
        for(const [value,name] of S.languages.some(l=>l[0]===language)?S.languages:[[language,language],...S.languages]){const opt=el('option','',name);opt.value=value;opt.selected=value===language;select.append(opt);}
        const body=el('span','h3-dialogue-body',m?.[2]||'');body.contentEditable='true';body.spellcheck=false;body.setAttribute('role','textbox');body.setAttribute('aria-label','对白内容');body.dataset.placeholder='输入对白…';
        const update=()=>{this.onBeforeChange?.();chip.dataset.raw=`<d>[${select.value}]${clean(body.innerText||body.textContent).replace(/\n/g,' ')}</d>`;this.changed();};
        select.addEventListener('change',update);body.addEventListener('input',update);
        body.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing)e.preventDefault();});
        chip.append(select,body);return chip;
      }
      if(['picture','video','audio'].includes(type)){
        const img=el('img');img.alt='';img.draggable=false;img.hidden=true;const fallback=el('span','h3-media-icon',type==='audio'?'♪':type==='video'?'▶':'▧');chip.append(img,fallback);
      }
      chip.append(el('span','h3-label',S.label(raw)));
      if(['picture','video','audio','shot','speaker','time','camera'].includes(type)){chip.classList.add('h3-interactive');chip.tabIndex=0;chip.setAttribute('role','button');chip.setAttribute('aria-label','更换'+S.label(raw));}
      return chip;
    }
    fragment(raw){
      const frag=document.createDocumentFragment();let last=0;
      for(const m of raw.matchAll(S.pattern())){appendText(frag,raw.slice(last,m.index));frag.append(this.createToken(m[0]),document.createTextNode(CARET));last=m.index+m[0].length;}
      appendText(frag,raw.slice(last));if(raw.endsWith('\n'))frag.append(document.createTextNode(CARET));return frag;
    }
    render(raw){this.visual.replaceChildren(this.fragment(raw));this.refreshAssets();}
    normalize(){const p=offsets(this.visual);this.render(this.value);if(p)selectOffsets(this.visual,p.start,p.end);}
    refreshAssets(){
      const assets=this.getAssets?.()||[];
      for(const chip of this.visual.querySelectorAll('.h3-picture,.h3-video,.h3-audio')){
        const a=assets.find(a=>a.raw.toLowerCase()===chip.dataset.raw.toLowerCase());const image=chip.querySelector('img');
        // Video URLs are not images. Until a real poster exists, show its media icon.
        const src=a?.kind==='picture'?a.preview:(a?.poster||'');
        if(src){if(image.getAttribute('src')!==src)image.src=src;image.hidden=false;}else{image.removeAttribute('src');image.hidden=true;}
        chip.querySelector('.h3-media-icon').hidden=!!src;chip.title=a?`${S.label(a.raw)} · ${a.name}`:`${chip.dataset.raw} · 尚未绑定参考`;chip.classList.toggle('is-unbound',!a);
      }
    }
    replaceSelection(text,parse=true,explicitRange=null){
      this.onBeforeChange?.();this.closeMenu();const body=document.activeElement?.closest?.('.h3-dialogue-body');
      if(this.mode==='text'){
        const f=this.textarea;f.setRangeText(text,f.selectionStart,f.selectionEnd,'end');this.rawChanged();f.focus();return;
      }
      const r=explicitRange||rangeInside(this.visual);
      if(!r){this.visual.focus();const p=this.bookmark||{start:this.value.length,end:this.value.length};selectOffsets(this.visual,p.start,p.end);return this.replaceSelection(text,parse);}
      const insideDialogue=body&&body.contains(r.commonAncestorContainer);
      r.deleteContents();const frag=insideDialogue?document.createDocumentFragment():(parse?this.fragment(text):document.createDocumentFragment());
      if(insideDialogue)frag.append(document.createTextNode(text.replace(/\n/g,' ')));else if(!parse)appendText(frag,text);
      const marker=document.createTextNode(CARET);frag.append(marker);r.insertNode(frag);
      const next=document.createRange();next.setStart(marker,1);next.collapse(true);const s=window.getSelection();s.removeAllRanges();s.addRange(next);
      if(insideDialogue)body.dispatchEvent(new Event('input',{bubbles:true}));else{this.visual.focus({preventScroll:true});this.changed();this.refreshAssets();}
      this.bookmark=offsets(this.visual);
    }
    insert(raw){
      this.onBeforeChange?.();
      if(this.mode==='visual'){this.visual.focus({preventScroll:true});const p=this.bookmark||{start:this.value.length,end:this.value.length};selectOffsets(this.visual,p.start,p.end);}
      this.replaceSelection(raw,true);this.commit();
    }
    copy(event,cut){
      const range=rangeInside(this.visual);if(!range||range.collapsed)return;
      const fragment=range.cloneContents(),body=event.target.closest('.h3-dialogue-body');
      const text=body&&body.contains(range.commonAncestorContainer)?clean(fragment.textContent):serialize(fragment);
      if(!event.clipboardData)return;event.preventDefault();event.stopPropagation();event.clipboardData.setData('text/plain',text);
      if(cut){this.onBeforeChange?.();range.deleteContents();range.collapse(true);const s=window.getSelection();s.removeAllRanges();s.addRange(range);if(body)body.dispatchEvent(new Event('input',{bubbles:true}));else this.changed();this.commit();}
    }
    keydown(e){
      if(e.isComposing||this.composing||e.keyCode===229)return;
      if(this.handleMenuKey(e)){e.preventDefault();e.stopPropagation();return;}
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'&&!e.target.closest('select,.h3-dialogue-body')){e.preventDefault();const r=document.createRange();r.selectNodeContents(this.visual);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(r);return;}
      if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();e.stopPropagation();this.commit();this.closeMenu();this.onHistory?.(e.key.toLowerCase()==='y'||e.shiftKey);return;}
      const chip=e.target.closest('.h3-chip');
      if(chip&&['Enter',' '].includes(e.key)&&!e.target.closest('select,.h3-dialogue-body')){e.preventDefault();this.openChip(chip);return;}
      if(e.target.closest('select,.h3-dialogue-body'))return;
      if(['Backspace','Delete'].includes(e.key)&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const r=rangeInside(this.visual);const tag=r?.collapsed?adjacentTag(this.visual,r,e.key==='Backspace'):null;if(tag){e.preventDefault();e.stopPropagation();this.onBeforeChange?.();const marker=document.createTextNode(CARET);tag.replaceWith(marker);const next=document.createRange();next.setStart(marker,1);next.collapse(true);const s=window.getSelection();s.removeAllRanges();s.addRange(next);this.changed();this.commit();}}
    }
    rawCaretRect(){
      const field=this.textarea,rect=field.getBoundingClientRect(),style=getComputedStyle(field),mirror=el('div');
      for(const name of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','paddingTop','paddingLeft','paddingRight','paddingBottom','borderWidth','boxSizing','tabSize'])mirror.style[name]=style[name];
      Object.assign(mirror.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',visibility:'hidden',whiteSpace:'pre-wrap',overflowWrap:'break-word',overflow:'hidden'});
      mirror.append(document.createTextNode(field.value.slice(0,field.selectionStart)));const marker=el('span','',field.value.slice(field.selectionStart)||'​');mirror.append(marker);document.body.append(mirror);mirror.scrollTop=field.scrollTop;mirror.scrollLeft=field.scrollLeft;
      const r=marker.getBoundingClientRect();const lineHeight=parseFloat(style.lineHeight)||22;
      const result={left:Math.max(rect.left,Math.min(r.left,rect.right-15)),top:Math.max(rect.top,Math.min(r.top,rect.bottom-lineHeight)),bottom:Math.max(rect.top+lineHeight,Math.min(r.top+lineHeight,rect.bottom)),height:lineHeight};mirror.remove();return result;
    }
    trigger(){
      if(this.mode==='text'){
        const f=this.textarea;if(f.selectionStart!==f.selectionEnd)return null;
        const before=f.value.slice(0,f.selectionStart),m=before.match(/([@/])([^@/\n]*)$/);if(!m)return null;
        const prev=before[before.length-m[0].length-1];if(prev&&/[a-z0-9:]/i.test(prev))return null;
        const rect=this.rawCaretRect();return {trigger:m[1],query:clean(m[2]).trim().toLowerCase(),rawRange:[f.selectionStart-m[0].length,f.selectionEnd],anchor:{getBoundingClientRect:()=>rect}};
      }
      const r=rangeInside(this.visual);if(!r?.collapsed||r.startContainer.nodeType!==3)return null;
      if(r.startContainer.parentElement?.closest('.h3-chip'))return null;
      const before=r.startContainer.nodeValue.slice(0,r.startOffset),m=before.match(/([@/])([^@/\n]*)$/);if(!m)return null;
      // Don't open syntax menus inside URL paths or email addresses.
      const prev=before[before.length-m[0].length-1];if(prev&&/[a-z0-9:]/i.test(prev))return null;
      const range=r.cloneRange();range.setStart(r.startContainer,r.startOffset-m[0].length);
      return {trigger:m[1],query:clean(m[2]).trim().toLowerCase(),range,anchor:r.cloneRange()};
    }
    detectMenu(){
      if(this.composing)return;const hit=this.trigger();
      if(!hit){if(this.menu?.trigger)this.closeMenu();return;}
      this.openMenu({type:hit.trigger==='@'?'asset':'command',category:null,active:0,...hit});
    }
    closeMenu(){if(this.menu){this.menu.element.remove();this.menu=null;this.visual.setAttribute('aria-expanded','false');this.visual.removeAttribute('aria-activedescendant');}}
    openMenu(state){this.closeMenu();state.element=el('div','h3-menu');state.element.id='td-h3-menu';state.element.setAttribute('role','listbox');this.menu=state;this.menuRoot.append(state.element);this.visual.setAttribute('aria-controls',state.element.id);this.visual.setAttribute('aria-expanded','true');this.renderMenu();}
    menuOptions(m){
      if(m.type==='asset')return (this.getAssets?.()||[])
        .filter(a=>!m.query||`${a.name} ${a.raw} ${a.kind} ${S.label(a.raw)}`.toLowerCase().includes(m.query))
        .map(a=>{
          const rawAvailability=this.getAssetAvailability?.(a,{
            value:this.value,
            replacingRaw:m.chip?.dataset.raw||null
          });
          const availability=rawAvailability===false
            ? {allowed:false,reason:''}
            : rawAvailability===true||rawAvailability==null
              ? {allowed:true,reason:''}
              : {allowed:rawAvailability.allowed!==false,reason:String(rawAvailability.reason||'')};
          return {asset:a,disabled:!availability.allowed,reason:availability.reason};
        });
      if(m.type==='camera')return S.cameras.map(([zh,en,detail,raw])=>({command:{label:zh+' · '+en,detail,raw,category:'camera'}}));
      if(m.type==='number'){
        const re=m.kind==='speaker'?/\(S(\d+)\)/gi:/\[Shot\s+(\d+)\]/gi;let max=6;for(const x of this.value.matchAll(re))max=Math.max(max,+x[1]+1);
        max=Math.min(max,100);const current=+m.chip.dataset.raw.match(/\d+/)?.[0]||1;
        return [...new Set([...Array.from({length:max},(_,i)=>i+1),current])].map(n=>({command:{label:m.kind==='speaker'?'S'+n:String(n),raw:m.kind==='speaker'?`(S${n})`:`[Shot ${n}]`,detail:''}}));
      }
      const commands=S.commands(this.value);const cat=id=>[...S.categories,S.cameraCategory].find(c=>c.id===id)?.label||id;
      if(m.query)return commands.filter(c=>`${c.label} ${c.zh||''} ${c.detail} ${c.raw} ${cat(c.category)}`.toLowerCase().includes(m.query)).map(command=>({command}));
      if(!m.category)return S.categories.map(category=>({category,count:commands.filter(c=>c.category===category.id||(category.id==='shot'&&c.category==='camera')).length}));
      const list=commands.filter(c=>c.category===m.category).map(command=>({command}));
      if(m.category==='shot')list.push({category:S.cameraCategory,count:S.cameras.length});return list;
    }
    renderMenu(){
      const m=this.menu;if(!m)return;const menu=m.element;menu.replaceChildren();
      menu.className='h3-menu '+(m.type==='asset'?'h3-asset-menu':m.type==='number'?'h3-number-menu':'h3-command-menu');
      const header=el('div','h3-menu-header');
      if(m.category&&!m.query){const back=el('button','h3-back','‹ 返回');back.type='button';back.addEventListener('pointerdown',e=>{e.preventDefault();this.back();});header.append(back);}
      const title=m.type==='asset'?'引用参考':m.type==='camera'?'切换镜头运动':m.type==='number'?(m.kind==='speaker'?'切换说话人序号':'切换镜头序号'):m.query?'搜索 H3 语法':m.category?([...S.categories,S.cameraCategory].find(c=>c.id===m.category)?.label):'H3 语法';
      header.append(el('strong','',title));menu.append(header);
      m.options=this.menuOptions(m);m.active=Math.min(m.active||0,Math.max(0,m.options.length-1));
      if(m.options[m.active]?.disabled){
        const first=m.options.findIndex(option=>!option.disabled);
        if(first>=0)m.active=first;
      }
      const list=el('div','h3-menu-list');menu.append(list);
      m.options.forEach((option,index)=>{
        const b=el('button','h3-menu-item');b.type='button';b.id='h3-option-'+index;b.setAttribute('role','option');b.tabIndex=-1;
        if(option.category){b.classList.add('is-category');b.append(el('span','h3-category-icon',option.category.icon));const copy=el('span','h3-menu-copy');copy.append(el('b','',option.category.label),el('small','',option.category.detail));b.append(copy,el('span','h3-count',option.count+' ›'));}
        else if(option.asset){const a=option.asset,thumb=el('span','h3-menu-thumb',a.kind==='audio'?'♪':a.kind==='video'?'▶':'▧');if(a.kind==='picture'&&a.preview){const img=el('img');img.src=a.preview;img.alt='';thumb.replaceChildren(img);}const copy=el('span','h3-menu-copy');copy.append(el('b','',a.name),el('small','',option.disabled?(S.label(a.raw)+' · 已达上限'):S.label(a.raw)));b.append(thumb,copy);if(option.disabled){b.disabled=true;b.classList.add('is-disabled');b.title=option.reason||'当前片段的参考资产额度已满';}}
        else{const c=option.command,copy=el('span','h3-menu-copy');copy.append(el('b','',c.label));if(c.detail)copy.append(el('small','',c.detail));b.title=c.raw;b.append(copy);}
        b.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();if(option.disabled)return;m.active=index;this.choose(option);});
        b.addEventListener('pointermove',()=>{m.active=index;this.highlight();});list.append(b);
      });
      if(!m.options.length)list.append(el('p','h3-menu-empty',m.type==='asset'?((this.getAssets?.()||[]).length?'没有匹配的参考资产。':'项目资产池暂无图片、视频或音频。'):'没有匹配的 H3 命令。'));
      menu.append(el('div','h3-menu-footer',m.type==='asset'?'继续输入筛选 · ↑↓ 选择 · Enter 插入 · Esc 关闭':'↑↓ 选择 · → / Enter 确认 · ← 返回 · Esc 关闭'));
      this.highlight();this.positionMenu();
    }
    highlight(){const m=this.menu;if(!m)return;m.element.querySelectorAll('.h3-menu-item').forEach((b,i)=>{const active=i===m.active&&!b.disabled;b.classList.toggle('is-active',active);b.setAttribute('aria-selected',String(active));});this.visual.setAttribute('aria-activedescendant','h3-option-'+m.active);}
    positionMenu(){
      const m=this.menu;if(!m)return;const menu=m.element;
      const r=m.chip?.getBoundingClientRect()||m.anchor?.getBoundingClientRect()||this.visual.getBoundingClientRect();
      const rect=r.height?r:this.visual.getBoundingClientRect(),w=Math.min(m.type==='asset'?320:m.type==='time'?285:380,innerWidth-24);
      menu.style.width=w+'px';menu.style.maxHeight='min(410px,calc(100dvh - 24px))';
      const below=innerHeight-rect.bottom-14,above=rect.top-14,wanted=Math.min(410,menu.scrollHeight||320);
      const up=below<wanted&&above>below;const avail=Math.max(110,up?above:below);
      menu.style.maxHeight=Math.min(410,avail,innerHeight-24)+'px';
      const height=menu.getBoundingClientRect().height;
      menu.style.left=Math.max(12,Math.min(rect.left,innerWidth-w-12))+'px';
      menu.style.top=Math.max(12,Math.min(up?rect.top-height-6:rect.bottom+6,innerHeight-height-12))+'px';
    }
    back(){const m=this.menu;if(!m)return;m.category=m.category==='camera'?'shot':null;m.active=0;this.renderMenu();}
    choose(option){
      const m=this.menu;if(!m||!option||option.disabled)return;
      if(option.category){m.category=option.category.id;m.active=0;this.renderMenu();return;}
      const command=option.command,raw=option.asset?.raw||command?.raw||'';this.onBeforeChange?.();
      if(m.chip){
        const replacement=this.createToken(raw.trimEnd());const marker=document.createTextNode(CARET);m.chip.replaceWith(replacement,marker);this.closeMenu();this.visual.focus({preventScroll:true});const r=document.createRange();r.setStart(marker,1);r.collapse(true);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);this.changed();this.refreshAssets();
      }else{
        const r=m.range,insert=raw+(command?.defaultBody!=null?'\n'+command.defaultBody:'');
        if(m.rawRange){const f=this.textarea;f.focus({preventScroll:true});f.setSelectionRange(...m.rawRange);this.replaceSelection(insert,false);}
        else this.replaceSelection(insert,true,r);
        if(!m.rawRange&&command?.kind==='dialogue'){const rNow=rangeInside(this.visual),marker=rNow?.startContainer;let chip=marker?.previousSibling;while(chip?.nodeType===3)chip=chip.previousSibling;const body=chip?.querySelector?.('.h3-dialogue-body');if(body){body.focus({preventScroll:true});const d=document.createRange();d.selectNodeContents(body);d.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(d);}}
      }
      this.commit();
    }
    handleMenuKey(e){
      const m=this.menu;if(!m||m.type==='time')return false;
      if(e.key==='Escape'){this.closeMenu();return true;}
      if(e.key==='ArrowLeft'&&m.category&&!m.query){this.back();return true;}
      if(['ArrowDown','ArrowUp'].includes(e.key)){
        if(m.options.length){
          const dir=e.key==='ArrowDown'?1:-1;
          let next=m.active;
          for(let step=0;step<m.options.length;step++){
            next=(next+dir+m.options.length)%m.options.length;
            if(!m.options[next]?.disabled){m.active=next;break;}
          }
        }
        this.highlight();m.element.querySelector('.is-active')?.scrollIntoView({block:'nearest'});return true;
      }
      if(['Enter','Tab','ArrowRight'].includes(e.key)){if(m.options.length&&!m.options[m.active]?.disabled)this.choose(m.options[m.active]);return true;}
      return false;
    }
    tagPointer(e){
      const chip=e.target.closest('.h3-chip');if(!chip||e.target.closest('select,.h3-dialogue-body'))return;
      if(!chip.classList.contains('h3-interactive'))return;e.preventDefault();e.stopPropagation();this.openChip(chip);
    }
    openChip(chip){
      const kind=chip.dataset.kind;if(['picture','video','audio'].includes(kind))this.openMenu({type:'asset',query:'',chip,active:0});
      else if(kind==='camera')this.openMenu({type:'camera',chip,active:0});
      else if(kind==='shot'||kind==='speaker')this.openMenu({type:'number',kind,chip,active:0});
      else if(kind==='time')this.openTime(chip);
    }
    openTime(chip){
      this.closeMenu();const menu=el('div','h3-menu h3-time-menu');this.menu={element:menu,type:'time',chip};this.menuRoot.append(menu);
      menu.append(el('div','h3-menu-header','编辑时间戳'));const row=el('div','h3-time-row'),m=chip.dataset.raw.match(/\[(\d{2}):(\d{2})\]/);
      const fields=['分钟','秒'].map((name,i)=>{const label=el('label','',name),input=el('input');input.type='number';input.min=0;input.max=i?59:99;input.step=1;input.value=+m[i+1];input.setAttribute('aria-label',name);label.append(input);row.append(label);return input;});
      const apply=()=>{this.onBeforeChange?.();const [a,b]=fields.map((f,i)=>String(Math.max(0,Math.min(i?59:99,Math.floor(+f.value)||0))).padStart(2,'0'));chip.dataset.raw=`[${a}:${b}]`;chip.querySelector('.h3-label').textContent=S.label(chip.dataset.raw);this.changed();this.commit();this.closeMenu();this.visual.focus();};
      const btn=el('button','h3-apply','确定');btn.type='button';btn.onclick=apply;row.append(btn);menu.append(row);this.positionMenu();fields[0].focus();fields[0].select();
      menu.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();apply();}if(e.key==='Escape'){e.preventDefault();this.closeMenu();this.visual.focus();}});
    }
    destroy(){this.closeMenu();clearTimeout(this.timer);this.abort.abort();}
  }
  window.TDH3Editor=H3Editor;window.TDH3Editor.serialize=serialize;
})();
