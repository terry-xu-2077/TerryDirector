/**
 * 预演台 integration of the complete TerryXu H3 rich text + shared menu system.
 *
 * The shared renderer/menus are vendored from TerryXu-nodes, while this
 * adapter supplies a virtual H3 node with the task's live reference images.
 * It NEVER writes HTML to the sampler: serializeH3RichText() is the single
 * source of the STRING sent to the configured prompt widget.
 */
import {
  renderH3RichText, renderH3RawText, serializeH3RichText,
  insertH3RichTextAtSelection, bindH3TagInteractions, installH3RichTextStyles, createH3TokenNode,
} from "./td_h3_rich_text.js";
import {
  attachH3Menus, detachH3Menus, openH3AssetMenuForChip, installH3MenuStyles,
} from "./td_h3_shared_menus.js";
import { renderPreviewPrompt } from "./td_preview_prompt_view.js";

let active = null;
function referenceList(draft) {
  if(Array.isArray(draft?.references)){
    const counts={image:0,audio:0,video:0};
    return draft.references.map(ref=>{
      const kind=ref.kind||"image",index=++counts[kind];
      const type=kind==="audio"?"Audio":kind==="video"?"Video":"Picture";
      return {key:kind+":"+index,kind:kind==="image"?"picture":kind,index,name:ref.name,
        tag:`<${type} ${index}>`,label:ref.name,source:ref.path||"",
        preview:ref.path?"/view?filename="+encodeURIComponent(ref.path)+"&type=input":""};
    });
  }
  return (draft?.assets || []).filter(asset => asset != null).map((asset,i) => {
    const index=i+1, source=String(asset.value || "");
    return {
      key: String(asset.node_id) + ":0", kind:"picture", index,
      tag:`<Picture ${index}>`, label:`Picture ${index}`,
      source:source.split(/[\\/]/).pop() || `Picture ${index}`,
      preview:source ? "/view?filename="+encodeURIComponent(source)+"&type=input" : "",
    };
  });
}
export function closePreviewRichEditor() {
  if (!active) return;
  const item=active; active=null;
  item.dispose();
}
export function decoratePreviewBatchTokens(editor,options={}) {
  // H3 tokens (including dialogue) are already complete chips. Only decorate
  // remaining text, so both grammars coexist without changing their raw strings.
  for(const child of [...editor.childNodes]){
    if(child.nodeType!==Node.TEXT_NODE)continue;
    const template=document.createElement("template");
    template.innerHTML=renderPreviewPrompt(child.nodeValue,{editable:true});
    if(!template.content.querySelector(".tdm-prompt-tag"))continue;
    for(const tag of template.content.querySelectorAll(".tdm-prompt-reference")){
      const raw=tag.dataset.raw,match=raw.match(/^<\s*(Picture|Audio|Video)\s+([^>]+?)\s*>$/i);
      if(!match)continue;
      const type=match[1].toLowerCase(),info=options.resolveNamedMedia?.(type,match[2].trim());
      if(!info?.source)continue;
      const chip=createH3TokenNode(`<${match[1]} ${info.index}>`,{...options,resolveMedia:()=>info});
      chip.dataset.raw=raw;chip.dataset.namedReference="true";
      chip.lastElementChild.textContent=tag.textContent;
      chip.title=info.source;
      tag.replaceWith(chip);
    }
    child.replaceWith(template.content);
  }
}
export function attachPreviewRichEditor(editor,{draft,onChange,onReferenceClick,mode="visual"}={}) {
  if (!editor || !draft) return ()=>{};
  closePreviewRichEditor();
  installH3RichTextStyles();
  installH3MenuStyles();
  let disposed=false;
  const liveAssets=()=>referenceList(draft);
  const media=(kind,index)=>liveAssets().find(x => x.kind===kind && x.index===Number(index)) || null;
  const options={resolveMedia:media,onChange:sync,
    resolveNamedMedia:(kind,name)=>liveAssets().find(info=>info.kind===kind&&info.name===name)};
  const promptWidget={name:"prompt",get value(){return draft.prompt || "";}};
  const virtualNode={
    widgets:[promptWidget],properties:draft.h3Properties ||= {},
    __terryH3MediaOptions:liveAssets,
    graph:null,
  };
  function sync() {
    if(disposed)return;
    const raw=serializeH3RichText(editor);
    draft.prompt=raw;
    onChange?.(raw);
  }
  function render(value,view) {
    if(view==="raw") renderH3RawText(editor,value);
    else {
      renderH3RichText(editor,value,options);
      decoratePreviewBatchTokens(editor,options);
    }
  }
  render(draft.prompt,mode);
  editor.dataset.mode=mode;
  editor.contentEditable="true";
  editor.spellcheck=false;
  attachH3Menus({node:virtualNode,editor,mode:"prompt",onChange:sync});
  bindH3TagInteractions(editor,{node:virtualNode,getSourceText:()=>draft.prompt||"",onChange:sync});
  const onInput=()=>sync();
  const onChangeEvent=()=>sync();
  const onPaste=event=>{
    event.preventDefault();event.stopPropagation();
    const raw=event.clipboardData?.getData("text/plain")||"";
    if(!raw)return;
    if(mode==="raw") {
      // Raw view must remain raw: never turn pasted H3 tags into chips.
      if(!document.execCommand?.("insertText",false,raw)) {
        const selection=window.getSelection?.();
        const range=selection?.rangeCount ? selection.getRangeAt(0) : null;
        if(range && editor.contains(range.commonAncestorContainer)) {
          range.deleteContents();
          const fragment=document.createDocumentFragment();
          raw.split("\n").forEach((line,i)=>{
            if(i)fragment.append(document.createElement("br"));
            fragment.append(document.createTextNode(line));
          });
          const marker=document.createTextNode("\u200b");
          fragment.append(marker);
          range.insertNode(fragment);
          range.setStartAfter(marker);range.collapse(true);
          selection.removeAllRanges();selection.addRange(range);
        }
      }
    } else if(!insertH3RichTextAtSelection(editor,raw,options)) {
      editor.focus({preventScroll:true});
      document.execCommand?.("insertText",false,raw);
    }
    if(mode!=="raw")decoratePreviewBatchTokens(editor,options);
    sync();
  };
  const onMediaClick=event=>{
    const chip=event.target?.closest?.(".terry-h3-media-chip");
    if(!chip || !editor.contains(chip))return;
    event.preventDefault();event.stopPropagation();
    if(chip.dataset.namedReference){
      const match=chip.dataset.raw.match(/^<\s*(Picture|Audio|Video)\s+([^>]+?)\s*>$/i);
      if(match)onReferenceClick?.(match[1].toLowerCase(),match[2].trim());
      return;
    }
    openH3AssetMenuForChip(editor,chip);
  };
  const onKey=event=>event.stopPropagation();
  const onPointer=event=>event.stopPropagation();
  editor.addEventListener("input",onInput);
  editor.addEventListener("terrychange",onChangeEvent);
  editor.addEventListener("paste",onPaste);
  editor.addEventListener("pointerdown",onMediaClick);
  editor.addEventListener("keydown",onKey);
  editor.addEventListener("pointerdown",onPointer);
  function dispose() {
    if(disposed)return;
    sync();
    disposed=true;
    detachH3Menus(editor);
    editor.removeEventListener("input",onInput);
    editor.removeEventListener("terrychange",onChangeEvent);
    editor.removeEventListener("paste",onPaste);
    editor.removeEventListener("pointerdown",onMediaClick);
    editor.removeEventListener("keydown",onKey);
    editor.removeEventListener("pointerdown",onPointer);
  }
  active={editor,dispose};
  return dispose;
}
