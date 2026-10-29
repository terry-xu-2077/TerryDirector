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
  insertH3RichTextAtSelection, bindH3TagInteractions, installH3RichTextStyles,
} from "./td_h3_rich_text.js";
import {
  attachH3Menus, detachH3Menus, openH3AssetMenuForChip, installH3MenuStyles,
} from "./td_h3_shared_menus.js";

let active = null;
function referenceList(draft) {
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
export function attachPreviewRichEditor(editor,{draft,onChange,mode="visual"}={}) {
  if (!editor || !draft) return ()=>{};
  closePreviewRichEditor();
  installH3RichTextStyles();
  installH3MenuStyles();
  let disposed=false;
  const liveAssets=()=>referenceList(draft);
  const media=(kind,index)=>liveAssets().find(x => x.kind===kind && x.index===Number(index)) || null;
  const options={resolveMedia:media,onChange:sync};
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
    else renderH3RichText(editor,value,options);
  }
  render(draft.prompt,mode);
  editor.dataset.mode=mode;
  editor.contentEditable="true";
  editor.spellcheck=false;
  const menu=attachH3Menus({node:virtualNode,editor,mode:"prompt",onChange:sync});
  bindH3TagInteractions(editor,{node:virtualNode,getSourceText:()=>draft.prompt||"",onChange:sync});
  const onInput=()=>sync();
  const onChangeEvent=()=>sync();
  const onPaste=event=>{
    event.preventDefault();event.stopPropagation();
    const raw=event.clipboardData?.getData("text/plain")||"";
    if(!raw)return;
    const inserted=insertH3RichTextAtSelection(editor,raw,
      mode==="raw" ? {onChange:sync} : options);
    if(!inserted) {
      // Avoid HTML paste and keep plain text if selection is outside editor.
      editor.focus({preventScroll:true});
      document.execCommand?.("insertText",false,raw);
    }
    sync();
  };
  const onMediaClick=event=>{
    const chip=event.target?.closest?.(".terry-h3-media-chip");
    if(!chip || !editor.contains(chip))return;
    event.preventDefault();event.stopPropagation();
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
