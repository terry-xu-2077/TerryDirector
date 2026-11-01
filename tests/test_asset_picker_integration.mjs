// Run: node tests/test_asset_picker_integration.mjs
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const pickerStart=source.indexOf("function openPreviewAssetPicker(");
const pickerEnd=source.indexOf("function chooseAsset(data)",pickerStart);
let pickerOptions;
const pickerState={createDraft:{assets:[{kind:"image"}]},inputFiles:[]};
let chosen;
const openPicker=new Function("state","openAssetPicker","api","chooseAsset",
  source.slice(pickerStart,pickerEnd)+";return openPreviewAssetPicker;")(
    pickerState,options=>{pickerOptions=options;return {close(){}};},{fetchApi(){}},file=>{chosen=file;});
openPicker(0);
assert.equal(pickerOptions.kind,"image");
pickerOptions.onSelect({path:"TerryDirector/imported/output.png",kind:"image"});
assert.equal(chosen.path,"TerryDirector/imported/output.png");
assert.equal(pickerState.inputFiles[0].path,chosen.path);
// An obsolete request cannot bind an asset into a replacement task.
pickerState.createDraft={assets:[{kind:"image"}]};chosen=null;
pickerOptions.onSelect({path:"stale.png",kind:"image"});
assert.equal(chosen,null);

const chooseStart=source.indexOf("function chooseAsset(data) {");
const chooseEnd=source.indexOf("async function importWorkflow()",chooseStart);
const chooseState={assetPicker:{index:0,batchReferenceIndex:1,kind:"video"},
  batchImport:{activeIndex:0,selectedRefIndex:0,batches:[{references:[
    {kind:"image",path:"old.jpg"},{kind:"video",path:"old.mp4"}
  ]}]},inputFiles:[{kind:"video",path:"new.mp4"}]};
let chooseRenders=0;
const choose=new Function("state","mediaKindLabel","render",
  source.slice(chooseStart,chooseEnd)+";return chooseAsset;")(
    chooseState,kind=>kind,()=>chooseRenders++);
choose({path:"new.mp4"});
assert.equal(chooseState.batchImport.batches[0].references[1].path,"new.mp4");
assert.equal(chooseState.batchImport.selectedRefIndex,1);
assert.equal(chooseState.assetPicker,null);
assert.equal(chooseRenders,1);
// Public component is also used for batch references.
const batch={activeIndex:0,selectedRefIndex:0,batches:[{references:[{kind:"audio",path:""}]}]};
pickerState.batchImport=batch;
openPicker(0,true);
assert.equal(pickerOptions.kind,"audio");
assert.equal(pickerState.assetPicker.batchReferenceIndex,0);
pickerOptions.onClose();
assert.equal(pickerState.assetPicker,null);
// A late selection after close must be ignored.
chosen=null;pickerOptions.onSelect({path:"late.wav",kind:"audio"});
assert.equal(chosen,null);
console.log("Shared asset picker preview integration: single/batch callbacks and stale selection protection PASS");
