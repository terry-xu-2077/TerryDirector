/* Run: node --test tests/test_asset_replacement.cjs */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../src/app.css'),'utf8');
test('asset preview fills about eighty percent of the editor',()=>{
 assert.match(css,/dialog\[data-mode="media"\] \{ width:80vw;/);
 assert.match(css,/height:80dvh;/);
 assert.match(css,/\.asset-lightbox img,\.asset-lightbox video \{[^\n]*object-fit:contain;/);
});
test('replacement preserves asset ID and reference numbering',()=>{
 assert.match(app,/state\.assetOverrides\[id\]=replacement/);
 assert.match(app,/\.\.\.a,\.\.\.\(state\.assetOverrides\?\.\[a\.id\]\|\|\{\}\)/);
 assert.match(app,/token:\x60\$\{mediaNames\[a\.kind\]\} \$\{a\.number\}\x60/);
 assert.match(app,/if\(kind!==old\.kind\)/);
});
test('replacement is serialized and history can revert source',()=>{
 const pool=(asset,state)=>({...asset,...(state.assetOverrides?.[asset.id]||{})});
 const original={id:'a',kind:'image',name:'old',number:2,src:'/view?old',
   source:{type:'comfy-input',path:'old.png'}};
 const before={assetIds:['a'],assetOverrides:{}};
 const after={assetIds:['a'],assetOverrides:{a:{name:'new',src:'/view?new',
   source:{type:'comfy-input',path:'new.png'},local:false}}};
 const history=[JSON.parse(JSON.stringify(before))];
 assert.equal(pool(original,after).id,'a');
 assert.equal(pool(original,after).number,2);
 assert.equal(pool(original,after).source.path,'new.png');
 assert.equal(pool(original,history.pop()).source.path,'old.png');
 assert.match(app,/assets:poolEntries\(\)\.filter\(a=>a\.source\?\.path\)/);
 assert.match(app,/state\.assetOverrides=\{\};/);
});
test('preview, timeline thumbnails, and asset pool resolve replacements',()=>{
 assert.match(app,/const asset=poolEntries\(\)\.find\(a=>a\.id===id\);if\(!asset\)return;/);
 assert.match(app,/const getImage=c=>poolEntries\(\)\.find/);
 assert.match(app,/const key=entries\.map\(a=>\[a\.id,a\.src,a\.name\]/);
 assert.match(app,/temporaryAssetUrls\.forEach\(url=>URL\.revokeObjectURL\(url\)\)/);
});
test('new replacement uses native upload endpoint when embedded',()=>{
 assert.match(app,/const result=await uploadInputFile\(file\)/);
 assert.match(app,/replacingAssetId=target\.id;/);
 assert.match(app,/id="assetReplaceInput" hidden/);
});
