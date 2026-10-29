/**
 * Lightweight H3 prompt completions for the 预演台 textarea.
 *
 * Mirrors Terry H3 Editor's @ media tokens, slash command categories and
 * Chinese camera move phrases without importing its graph-node-only UI.
 * Works when TerryXu-nodes is not installed; never changes the sampler prompt
 * serialization or mutates the workflow until a user submits the draft.
 * Supports @/＠, /／ and \/＼, including IME compositionend.
 */
const CAMERAS = [
  ["推进","Push In","The camera pushes in "],
  ["拉远","Pull Out","The camera pulls out "],
  ["左摇","Pan Left","The camera pans left "],
  ["右摇","Pan Right","The camera pans right "],
  ["左移","Truck Left","The camera trucks left "],
  ["右移","Truck Right","The camera trucks right "],
  ["上摇","Tilt Up","The camera tilts up "],
  ["下摇","Tilt Down","The camera tilts down "],
  ["升镜","Pedestal Up","The camera moves upward "],
  ["降镜","Pedestal Down","The camera moves downward "],
  ["环绕","Arc Shot","The camera moves in an arc around the subject "],
  ["跟拍","Tracking Shot","The camera follows the moving subject in a tracking shot "],
  ["固定镜头","Static Shot","The camera holds a static shot "],
  ["变焦推近","Zoom In","The camera zooms in "],
  ["变焦拉远","Zoom Out","The camera zooms out "],
  ["第一人称视角","POV","POV, "],
  ["顺时针旋转","Roll Clockwise","The camera rolls clockwise "],
  ["逆时针旋转","Roll Counterclockwise","The camera rolls counterclockwise "],
  ["轻微晃动","Shake Slightly","The camera shakes slightly "],
  ["强烈晃动","Shake Strongly","The camera shakes strongly "],
];
const SECTIONS = [
  ["结构","subject_definitions:","主体与参考定义"],
  ["结构","summary:","任务类型与主要内容"],
  ["结构","retention_analysis:","引用素材如何被保留与参考"],
  ["结构","detailed_description:","逐镜头详细描述"],
  ["结构","integrated_multimodal_description:","整合描述"],
  ["结构","overall_soundscape:","环境、动作、音效"],
  ["结构","non_diegetic_music: N/A","非剧情音乐"],
  ["镜头","[Shot 1]","镜头段落标签"],
  ["镜头","[00:00]","时间标签"],
  ["镜头","(S1)","说话人"],
  ["对白","<d>[Chinese] </d>","中文对白块"],
  ["对白","<d>[English] </d>","英文对白块"],
  ["对白","<scenetrans>","声音跨镜头连续"],
  ["对白","<cutoff>","截断"],
  ["保留关系","fully_preserved","完整保留"],
  ["保留关系","partially_preserved","部分保留"],
  ["保留关系","attribute_transfer","属性转移"],
  ["保留关系","weak_reference","弱参考"],
  ["保留关系","fully_copy","完整复制"],
  ["保留关系","partially_copy","部分复制"],
  ["保留关系","reference","参考"],
  ["任务","[reference generation]","参考生成"],
  ["任务","[keyframe completion]","关键帧补全"],
  ["任务","[video editing]","视频编辑"],
  ["任务","[video continuation]","视频续写"],
  ["任务","[audio reuse]","音频复用"],
  ["任务","[audio reference]","音频参考"],
];

export function h3PromptCommands(text = "") {
  const next = (pattern, fallback = 0) => {
    let max = fallback;
    for (const m of String(text).matchAll(pattern)) max = Math.max(max, Number(m[1]) || 0);
    return max + 1;
  };
  const shot = next(/\[Shot\s+(\d+)\]/gi), speaker = next(/\(S(\d+)\)/gi);
  return [
    ...SECTIONS.map(([category, value, detail]) => ({
      category, label: value === "[Shot 1]" ? `[Shot ${shot}]` :
        value === "(S1)" ? `(S${speaker})` : value,
      detail, value: value === "[Shot 1]" ? `[Shot ${shot}]` :
        value === "(S1)" ? `(S${speaker})` : value,
    })),
    ...CAMERAS.map(([zh,en,value]) => ({category:"运镜",label:`${zh} · ${en}`,
      detail:zh,value})),
  ];
}

/** Return the actual replacement span before the caret; preserve preceding text. */
export function h3Trigger(text, caret) {
  const before = String(text || "").slice(0, Number(caret) || 0);
  const lastLine = before.slice(before.lastIndexOf("\n") + 1);
  const match = lastLine.match(/([@＠/／\\＼])([^@＠/／\\＼\n]*)$/);
  if (!match) return null;
  // Do not hijack URL paths, email addresses, or literal slash-separated words.
  const index = before.length - match[0].length;
  const prev = index ? before[index - 1] : "";
  if (prev && !/[\s([{"'，：、]/u.test(prev)) return null;
  const trigger = match[1], query = match[2].trim().toLowerCase();
  return {start: index, end: before.length, type: "＠@".includes(trigger) ? "asset" : "command",
    query};
}

let mounted = null;
let stylesReady = false;
function ensureStyles() {
  if (stylesReady || document.getElementById("td-preview-h3-menu-style")) {
    stylesReady = true; return;
  }
  const style = document.createElement("style");
  style.id = "td-preview-h3-menu-style";
  style.textContent = `
.tdp-h3-menu{position:fixed;z-index:2147483000;width:min(370px,calc(100vw - 24px));max-height:min(430px,65vh);
 overflow:auto;overscroll-behavior:contain;background:#242830;border:1px solid #59606e;border-radius:9px;
 box-shadow:0 18px 48px #000c;color:#dce2ec;padding:5px;font:12px system-ui}
.tdp-h3-menu-head{padding:8px 10px;color:#aebbd0;font-weight:650;border-bottom:1px solid #414752;margin-bottom:5px}
.tdp-h3-menu-head small{font-weight:400;display:block;color:#8993a4;margin-top:3px}
.tdp-h3-item{display:flex;align-items:center;gap:9px;text-align:left;width:100%;border:0;
 background:transparent;color:#e4e9f1;border-radius:6px;padding:7px;cursor:pointer;min-height:43px}
.tdp-h3-item:hover,.tdp-h3-item.active{background:#364b68}
.tdp-h3-thumb{width:46px;height:35px;object-fit:cover;background:#16191e;border-radius:4px;flex:none}
.tdp-h3-plain-thumb{display:grid;place-items:center;color:#9faebf;font-size:16px}
.tdp-h3-iteminfo{min-width:0;flex:1}.tdp-h3-iteminfo b{font-size:12px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tdp-h3-iteminfo small{display:block;color:#8e9bad;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
.tdp-h3-group{padding:10px 8px 4px;color:#739ed0;font-size:10px;font-weight:700}
.tdp-h3-empty{padding:20px 10px;color:#8993a5;text-align:center}`;
  document.head.append(style);
  stylesReady = true;
}
function closeCurrent() {
  if (!mounted) return;
  const current = mounted; mounted = null;
  current.menu?.remove();
  current.dispose?.();
}
export function closePreviewPromptMenu() { closeCurrent(); }

export function attachPreviewPromptMenus(textarea, {getAssets, onChange} = {}) {
  if (!textarea) return () => {};
  closeCurrent();
  ensureStyles();
  let composing = false, menu = null, trigger = null, choices = [], active = 0;
  let disposed = false;
  function close() {
    menu?.remove(); menu = null; trigger = null; choices = [];
  }
  function assetChoices() {
    return (getAssets?.() || []).filter(a => a?.path).map((a, index) => ({
      type:"asset", label:`图片 ${a.index || index + 1}`, detail:a.name || a.path,
      value:`<Picture ${a.index || index + 1}>`, path:a.path,
    }));
  }
  function options(hit) {
    const items = hit.type === "asset" ? assetChoices() :
      h3PromptCommands(textarea.value).map(x => ({...x,type:"command"}));
    return items.filter(x => !hit.query ||
      `${x.label} ${x.detail} ${x.value}`.toLowerCase().includes(hit.query));
  }
  function insert(option) {
    if (!trigger || disposed) return;
    const {start,end} = trigger;
    // Replace only the trigger and search term, not neighboring prompt text.
    textarea.setRangeText(option.value, start, end, "end");
    onChange?.(textarea.value);
    close();
    textarea.focus({preventScroll:true});
  }
  function draw() {
    if (!menu || !trigger) return;
    const items = options(trigger);
    choices = items.slice(0, 80);
    active = Math.max(0, Math.min(active, choices.length - 1));
    menu.replaceChildren();
    const head = document.createElement("div");
    head.className = "tdp-h3-menu-head";
    head.textContent = trigger.type === "asset" ? "引用参考资产" : "H3 语法与运镜";
    const hint = document.createElement("small");
    hint.textContent = "输入关键词筛选 · ↑↓ 选择 · Enter 插入 · Esc 关闭";
    head.append(hint); menu.append(head);
    if (!choices.length) {
      const empty = document.createElement("div"); empty.className="tdp-h3-empty";
      empty.textContent = trigger.type === "asset" ? "当前任务没有图片参考资产" : "没有匹配的 H3 指令";
      menu.append(empty); return;
    }
    let section = "";
    choices.forEach((item,i) => {
      if (trigger.type === "command" && item.category !== section) {
        section = item.category;
        const group = document.createElement("div");group.className="tdp-h3-group";
        group.textContent=section;menu.append(group);
      }
      const row=document.createElement("button");row.type="button";
      row.className="tdp-h3-item"+(i===active?" active":"");
      if (item.path) {
        const img=document.createElement("img");img.className="tdp-h3-thumb";
        img.src="/view?filename="+encodeURIComponent(item.path)+"&type=input";
        img.alt="";row.append(img);
      }
      const info=document.createElement("span");info.className="tdp-h3-iteminfo";
      const name=document.createElement("b");name.textContent=item.label;info.append(name);
      const sub=document.createElement("small");sub.textContent=item.detail||item.value;info.append(sub);
      row.append(info);
      row.addEventListener("pointerdown",event=>{
        event.preventDefault();event.stopPropagation();insert(item);
      });
      row.addEventListener("pointermove",()=>{active=i;menu?.querySelectorAll(".tdp-h3-item")
        .forEach((node,j)=>node.classList.toggle("active",i===j));});
      menu.append(row);
    });
  }
  function locate() {
    if (!menu) return;
    const rect = textarea.getBoundingClientRect();
    // Textarea has no DOM Range. Position near its typing area, inside the
    // visible viewport (not behind the bottom edge of the floating dialog).
    const width = Math.min(370,window.innerWidth-24);
    const expectedHeight = Math.min(430,menu.offsetHeight||330);
    const bottom = Math.min(window.innerHeight-12,rect.bottom);
    const top = bottom + expectedHeight + 8 < window.innerHeight
      ? bottom + 6 : Math.max(8,bottom-expectedHeight-8);
    menu.style.left=Math.round(Math.min(window.innerWidth-width-8,rect.left+16))+"px";
    menu.style.top=Math.round(top)+"px";
  }
  function update() {
    if (disposed || composing || !textarea.isConnected) {close();return;}
    const hit = h3Trigger(textarea.value,textarea.selectionStart);
    if (!hit || textarea.selectionStart !== textarea.selectionEnd) {close();return;}
    trigger=hit;active=0;
    if (!menu) {
      menu=document.createElement("div");menu.className="tdp-h3-menu";
      document.body.append(menu);
    }
    draw();locate();
  }
  function keydown(event) {
    if (event.isComposing || composing || !menu) return;
    if (event.key === "Escape") {event.preventDefault();event.stopPropagation();close();return;}
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();event.stopPropagation();
      active=(active+(event.key==="ArrowDown"?1:-1)+choices.length)%Math.max(choices.length,1);
      draw();locate();return;
    }
    if ((event.key==="Enter" || event.key==="Tab") && choices[active]) {
      event.preventDefault();event.stopPropagation();insert(choices[active]);
    }
  }
  function outside(event) {
    if (!textarea.contains(event.target) && !menu?.contains(event.target)) close();
  }
  const onInput=()=>{onChange?.(textarea.value);update();};
  const onCompositionEnd=()=>{composing=false;queueMicrotask(update);};
  const onCompositionStart=()=>{composing=true;close();};
  const onKeyUp=event=>{if (!["ArrowDown","ArrowUp","Enter","Tab","Escape"].includes(event.key))update();};
  textarea.addEventListener("keydown",keydown);
  textarea.addEventListener("keydown",event=>event.stopPropagation());
  textarea.addEventListener("keyup",onKeyUp);
  textarea.addEventListener("input",onInput);
  textarea.addEventListener("compositionstart",onCompositionStart);
  textarea.addEventListener("compositionend",onCompositionEnd);
  document.addEventListener("pointerdown",outside,true);
  function dispose() {
    if(disposed)return;disposed=true;close();
    textarea.removeEventListener("keydown",keydown);
    textarea.removeEventListener("keyup",onKeyUp);
    textarea.removeEventListener("input",onInput);
    textarea.removeEventListener("compositionstart",onCompositionStart);
    textarea.removeEventListener("compositionend",onCompositionEnd);
    document.removeEventListener("pointerdown",outside,true);
  }
  mounted={dispose,get menu(){return menu}};
  return dispose;
}
