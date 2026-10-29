// Run: node tests/test_preview_video_playback.mjs
// Saved MP4 must have real controls, an explicit play action, and stable media identity.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const code=await readFile(new URL("../web/td_selflift_task_manager.js",import.meta.url),"utf8");
const section=(from,to)=>{
  const a=code.indexOf(from),b=code.indexOf(to,a);
  assert.ok(a>=0&&b>a,from);
  return code.slice(a,b);
};
assert.doesNotThrow(()=>new Function(
  code.replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];/gm,"")));

const playback=section("function bindPreviewPlaybackErrors() {","function render() {");
const html=section("function details(task) {","function bindPreviewPlaybackErrors() {");
assert.ok(playback.includes("await player.play()"));
assert.ok(playback.includes("player.pause()"));
assert.ok(playback.includes("showPreviewPlaybackError("));
assert.ok(html.includes("data-saved-video data-media-key"));
assert.ok(html.includes("controls loop playsinline preload"));
assert.ok(html.includes('data-action="toggle-preview-playback"'));

// This test directly exercises the actual playback helper without a browser.
let plays=0,pauses=0,lastLabel=null;
const video={
  paused:true,error:null,
  async play(){plays++;this.paused=false;},
  pause(){pauses++;this.paused=true;},
};
const host={querySelector(){return lastLabel;},appendChild(node){lastLabel=node;}};
const state={root:{querySelector(selector){
  if(selector==="[data-live-preview-host] video")return video;
  if(selector==="[data-live-preview-host]")return host;
  return null;
}}};
const document={createElement(){return {
  className:"",textContent:"",setAttribute(){},
};}};
const helpers=new Function("state","document",playback+
  ";return {togglePreviewPlayback,bindPreviewPlaybackErrors};")(state,document);
await helpers.togglePreviewPlayback();
assert.equal(plays,1);
assert.equal(video.paused,false);
await helpers.togglePreviewPlayback();
assert.equal(pauses,1);
assert.equal(video.paused,true);
video.play=async()=>{throw Error("MediaError: unsupported codec");};
await assert.rejects(()=>helpers.togglePreviewPlayback(),/MediaError/);
assert.match(lastLabel.textContent,/MediaError/);

const render=section("function render() {","function showDeleteConfirmation() {");
assert.ok(render.includes("replacement.replaceWith(oldPlayer)"));
assert.ok(render.includes("const oldPlaying="));
assert.ok(render.includes("oldPlayer.currentTime=oldTime"));
const finish=section('for(const event of ["execution_success"','app.registerExtension({');
const deleteBeforeRefresh=finish.indexOf("state.jobs.delete(promptId)")<
  finish.indexOf("await refresh()",finish.indexOf("await persistPreview(job)"));
assert.ok(deleteBeforeRefresh,"Final refresh must use saved MP4, never a revoked live Blob URL");
assert.ok(finish.includes("releasePreviewBlobUrls(job)"));
console.log("Preview Stage saved video playback and stable refresh: PASS");
