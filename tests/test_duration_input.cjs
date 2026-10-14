/* Run: node --test tests/test_duration_input.cjs
 * Exercise the real editor functions and input listeners with a small DOM fake,
 * specifically guarding against fractional typing being overwritten on input. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const C=require('../src/core.js');
const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
const section=(begin,end)=>{
  const first=source.indexOf(begin),last=source.indexOf(end,first+begin.length);
  assert.ok(first!==-1&&last>first,'duration production section not found');
  return source.slice(first,last);
};
const renderFn=section('  function renderClipDuration(', '  function renderClipSeed(');
const editFns=section('  function beginDurationEdit()', '  function poolEntries()');
const wiring=section("  const durationRange=$('#clipDurationRange')", "  const clipSeedInput=$('#clipSeedInput')");
class FakeInput{
  constructor(){
    this.listeners={};this._value='';this.disabled=false;this.max='15';
    this.title='';this.control={title:''};
  }
  set value(v){this._value=String(v);}
  get value(){return this._value;}
  get valueAsNumber(){
    if(!this._value||this._value.endsWith('.'))return NaN;
    const number=Number(this._value);
    return Number.isFinite(number)?number:NaN;
  }
  get validity(){
    const number=this.valueAsNumber;
    const badInput=this._value.endsWith('.')||(!Number.isFinite(number)&&!!this._value);
    // 10.25s is intentionally not aligned to 0.1s spinner steps.
    const stepMismatch=Number.isFinite(number)&&Math.abs((number-1)*10-Math.round((number-1)*10))>1e-7;
    return {badInput,stepMismatch,valid:!badInput&&!stepMismatch};
  }
  closest(){return this.control;}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  dispatch(type,props={}){
    for(const listener of this.listeners[type]||[])listener({target:this,key:'',preventDefault(){},...props});
  }
  blur(){this.dispatch('blur');}
}
function demo(){
  const number=new FakeInput(),range=new FakeInput();
  const dom={activeElement:null},inputs={'#clipDurationNumber':number,'#clipDurationRange':range};
  const create=new Function('C','inputs','document',`
    let state={selected:'a',clips:[{id:'a',start:0,end:240}]};
    let durationEditBefore=null,hostReadonly=false;
    const $=selector=>inputs[selector];
    const history={pushCount:0,push(before,after){this.pushCount++;return JSON.stringify(before)!==JSON.stringify(after);}};
    const timeline={chainEnabled:true,setClips(){},select(){},fit(){}};
    function current(){return state.clips.find(clip=>clip.id===state.selected);}
    function finishPromptEdit(){}
    function markEdited(){}
    function updateHistory(){}
    function renderTiming(clips=state.clips){renderClipDuration(clips);}
    function renderAll(){renderClipDuration();}
    function requestAnimationFrame(fn){fn();}
    ${renderFn}
    ${editFns}
    ${wiring}
    return {state,history,timeline,renderClipDuration,getBefore:()=>durationEditBefore};
  `);
  return {number,range,dom,...create(C,inputs,dom)};
}
test('native spinner increments seconds without renderer resetting the focused input',()=>{
  const x=demo();x.renderClipDuration();
  assert.equal(x.number.value,'10');
  x.dom.activeElement=x.number;x.number.dispatch('focus');
  x.number.value='10.1';x.number.dispatch('input');
  assert.equal(x.number.value,'10.1');
  assert.equal(x.state.clips[0].end,242);
  // Spin-button "change" does not end an active edit prematurely.
  x.number.dispatch('change');
  assert.equal(x.number.value,'10.1');
  assert.ok(x.getBefore());
  x.number.value='10.2';x.number.dispatch('input');
  assert.equal(x.state.clips[0].end,245);
  x.dom.activeElement=null;x.number.blur();
  assert.equal(x.state.clips[0].end,245);
  assert.equal(x.number.value,'10.21');
  assert.equal(x.history.pushCount,1);
});
test('arbitrary decimals and incomplete typing are not blocked by stepMismatch',()=>{
  const x=demo();x.renderClipDuration();
  x.dom.activeElement=x.number;x.number.dispatch('focus');
  x.number.value='10.';x.number.dispatch('input');
  assert.equal(x.number.value,'10.');
  assert.equal(x.state.clips[0].end,240);
  x.number.value='10.25';
  assert.equal(x.number.validity.valid,false);
  assert.equal(x.number.validity.badInput,false);
  x.number.dispatch('input');
  assert.equal(x.number.value,'10.25');
  assert.equal(x.state.clips[0].end,246);
  x.dom.activeElement=null;x.number.blur();
  assert.equal(x.number.value,'10.25');
});
test('empty and out-of-range inputs revert without changing frames',()=>{
  const x=demo();x.renderClipDuration();
  x.dom.activeElement=x.number;x.number.dispatch('focus');
  x.number.value='';x.number.dispatch('input');
  assert.equal(x.state.clips[0].end,240);
  x.number.value='0.5';x.number.dispatch('input');
  assert.equal(x.state.clips[0].end,240);
  x.dom.activeElement=null;x.number.blur();
  assert.equal(x.number.value,'10');
});
test('duration number has a visible spinner step and decimal entry mode',()=>{
  assert.match(source,/id="clipDurationNumber" type="number" min="1" step="0\.1" inputmode="decimal"/);
  assert.doesNotMatch(wiring,/durationNumber\.addEventListener\('change',finishDurationEdit\)/);
});
