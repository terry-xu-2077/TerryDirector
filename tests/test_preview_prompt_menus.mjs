// Run: node tests/test_preview_prompt_menus.mjs
// No browser/ComfyUI/GPU required: verify plain H3 text insertion triggers.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raw = await readFile(new URL("../web/td_preview_prompt_menus.js", import.meta.url), "utf8");
const module = await import("data:text/javascript;base64," + Buffer.from(raw).toString("base64"));
const { h3Trigger, h3PromptCommands } = module;
const at = value => h3Trigger(value, value.length);

assert.deepEqual(at("@"), {start:0,end:1,type:"asset",query:""});
assert.deepEqual(at("＠"), {start:0,end:1,type:"asset",query:""});
assert.deepEqual(at("镜头@"), {start:2,end:3,type:"asset",query:""});
assert.deepEqual(at("画面 @图片"), {start:3,end:6,type:"asset",query:"图片"});
assert.equal(at("user@example.com"), null);
for (const trigger of ["/", "／", "\\", "＼", "镜头\\环绕"]) {
  assert.equal(at(trigger)?.type,"command",trigger);
}
assert.equal(at("https://example.com"), null);
assert.equal(at("audio/video"), null);
assert.equal(at("镜头\\环绕")?.query,"环绕");
const list = h3PromptCommands("[Shot 1]\n[Shot 3]\n(S1)");
assert.equal(list.find(x => x.label === "[Shot 4]")?.value, "[Shot 4]");
assert.equal(list.find(x => x.label === "(S2)")?.value,"(S2)");
assert.equal(list.filter(x => x.category === "运镜").length,20);
assert.equal(list.find(x => x.label.includes("环绕"))?.value,"The camera moves in an arc around the subject ");
assert.ok(list.some(x => x.value.includes("non_diegetic_music")));
console.log("Preview Stage H3 prompt menu contract: PASS");
