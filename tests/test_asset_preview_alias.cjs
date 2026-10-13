/* Run: node --test tests/test_asset_preview_alias.cjs */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'src/app.js'),'utf8');
const h3=fs.readFileSync(path.join(root,'src/h3-editor.js'),'utf8');
const css=fs.readFileSync(path.join(root,'src/app.css'),'utf8');
const web=fs.readFileSync(path.join(root,'web/terry_director.js'),'utf8');
function snippet(source,from,to){
 const a=source.indexOf(from),b=source.indexOf(to,a+from.length);
 assert.ok(a>=0&&b>a,'Missing production code from '+from);
 return source.slice(a,b);
}
function aliases(){
 return new Function(snippet(app,'  const cleanAssetAlias=', '  const transitionLabels=')
   +'return {cleanAssetAlias,assetDisplayName};')();
}
function h3Class(){
 const sandbox={window:{TDH3Syntax:{label:raw=>raw==='<Picture 3>'?'图片 3':raw}},document:{}};
 vm.runInNewContext(h3,sandbox,{filename:'h3-editor.js'});
 return sandbox.window.TDH3Editor;
}
test('displayName is independent of the source filename and raw H3 token',()=>{
 const {cleanAssetAlias,assetDisplayName}=aliases();
 const asset={id:'a',kind:'image',number:3,name:'snow.png',source:{type:'comfy-input',path:'snow.png'}};
 assert.equal(assetDisplayName(asset),'snow.png');
 assert.equal(assetDisplayName({...asset,displayName:'雪地战壕'}),'雪地战壕');
 assert.equal(cleanAssetAlias('  雪地\n战壕  '),'雪地 战壕');
 assert.equal(asset.source.path,'snow.png');
 assert.equal(asset.number,3);
});
test('H3 visual chips show alias and retain canonical serialized references',()=>{
 const H3=h3Class();
 const image={hidden:true,attrs:{},getAttribute(name){return this.attrs[name]??null;},
   removeAttribute(name){delete this.attrs[name];},set src(value){this.attrs.src=value;},get src(){return this.attrs.src;}};
 const label={textContent:'图片 3'},icon={hidden:false};
 const chip={dataset:{raw:'<Picture 3>'},title:'',classList:{toggle(){}},
   setAttribute(){},querySelector(name){return name==='img'?image:name==='.h3-label'?label:icon;}};
 const editor={getAssets:()=>[{kind:'picture',raw:'<Picture 3>',
   name:'雪地战壕',fileName:'snow.png',displayName:'雪地战壕',preview:'snow.png'}],
   visual:{querySelectorAll:()=>[chip]}};
 H3.prototype.refreshAssets.call(editor);
 assert.equal(label.textContent,'雪地战壕');
 assert.equal(chip.dataset.raw,'<Picture 3>');
 assert.match(chip.title,/snow\.png/);
 assert.equal(H3.serialize({childNodes:[
   {nodeType:3,nodeValue:'subject '},{nodeType:1,dataset:{raw:chip.dataset.raw}}
 ]}),'subject <Picture 3>');
 const result=H3.prototype.menuOptions.call({
   ...editor,getAssetAvailability:()=>({allowed:true}),value:''
 },{type:'asset',query:'雪地'});
 assert.equal(result.length,1);
 const byFilename=H3.prototype.menuOptions.call({...editor,value:''},{type:'asset',query:'snow.png'});
 assert.equal(byFilename.length,1);
 editor.getAssets=()=>[{kind:'picture',raw:'<Picture 3>',name:'snow.png',
   fileName:'snow.png',displayName:'',preview:'snow.png'}];
 H3.prototype.refreshAssets.call(editor);
 assert.equal(label.textContent,'图片 3');
});
test('rename action alters only overlay, preserving asset identity and undo',()=>{
 const state={assetOverrides:{},assetIds:['a']};
 const asset={id:'a',name:'snow.png',kind:'image',number:3,
   source:{type:'comfy-input',path:'folder/snow.png'}};
 const savepoints=[],changes=[];
 const {cleanAssetAlias,assetDisplayName}=aliases();
 const markup=snippet(app,'  function renameAsset(', '  async function replaceAssetFile(');
 const get=new Function('state','asset','cleanAssetAlias','assetDisplayName','savepoints','changes',`
  let hostReadonly=false,assetGridKey='';
  const poolEntries=()=>[{...asset,...(state.assetOverrides[asset.id]||{})}];
  const mutate=change=>{savepoints.push(JSON.parse(JSON.stringify(state.assetOverrides)));change();};
  function renderReferences(){}
  const dialog={dataset:{mode:'media',assetId:asset.id}},title={textContent:''};
  const $=selector=>selector==='#dialog'?dialog:title;
  const promptEditor={refreshAssets(){changes.push('clip')}};
  const globalPromptEditor={refreshAssets(){changes.push('global')}};
  const toast=()=>{};
  ${markup}
  return {renameAsset,read:()=>poolEntries()[0]};
 `)(state,asset,cleanAssetAlias,assetDisplayName,savepoints,changes);
 get.renameAsset('a','雪地战壕');
 assert.equal(get.read().displayName,'雪地战壕');
 assert.equal(get.read().name,'snow.png');
 assert.equal(get.read().source.path,'folder/snow.png');
 assert.equal(get.read().id,'a');assert.equal(get.read().number,3);
 assert.deepEqual(changes,['clip','global']);
 const saved=savepoints.pop();
 state.assetOverrides=saved;
 assert.equal(assetDisplayName(get.read()),'snow.png');
 get.renameAsset('a','雪地战壕');
 get.renameAsset('a','');
 assert.equal(assetDisplayName(get.read()),'snow.png');
});
test('aliases survive payload export and are recognized by frontend and backend normalizers',()=>{
 assert.match(app,/displayName:cleanAssetAlias\(raw\.displayName\)/);
 assert.match(app,/\?\{displayName:cleanAssetAlias\(a\.displayName\)\}:\{\}/);
 assert.match(web,/displayName: String\(asset\.displayName\)\.trim\(\)\.slice\(0, 80\)/);
 const py=fs.readFileSync(path.join(root,'director_core.py'),'utf8');
 assert.match(py,/asset\["displayName"\] = alias/);
 assert.ok(app.includes('state.assetOverrides[id]={...(state.assetOverrides[id]||{}),...replacement};'));
 const fields=snippet(app,'  function documentPayload(){','  function destroyGlobalPromptEditor(){');
 const {cleanAssetAlias}=aliases();
 const state={selected:null,clips:[],assetOverrides:{},globalPrompt:'Image <Picture 3>',assetIds:['a']};
 const source={id:'a',name:'snow.png',displayName:'雪地战壕',
   number:3,kind:'image',source:{type:'comfy-input',path:'snow.png'}};
 const payload=new Function('state','poolEntries','cleanAssetAlias','C',`
   function finishPromptEdit(){}function syncAllReferences(){}
   ${fields}
   return documentPayload();
 `)(state,()=>[source],cleanAssetAlias,{FPS:24});
 assert.equal(payload.assets[0].displayName,'雪地战壕');
 assert.equal(payload.assets[0].name,'snow.png');
 assert.equal(payload.assets[0].number,3);
 assert.equal(payload.globalPrompt,'Image <Picture 3>');
});
test('image fit and audio/video player layout remain separate',()=>{
 assert.match(css,/dialog\[data-mode="media"\] \{ width:80vw;/);
 assert.match(css,/\.asset-lightbox\.is-image img \{[^\n]*object-fit:contain;/);
 assert.match(css,/\.asset-lightbox video \{[^\n]*object-fit:contain;/);
 assert.match(css,/\.asset-lightbox audio \{[^\n]*width:min\(720px/);
 assert.ok(app.includes("else{media.controls=true;media.preload='metadata';media.playsInline=true;"));
});
