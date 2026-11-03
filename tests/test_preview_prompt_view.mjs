import assert from "node:assert/strict";
import { tokenizePreviewPrompt, renderPreviewPrompt } from "../web/td_preview_prompt_view.js";

const source = '[导演说明]\r\n保留原文。\r\n\r\n[全局参考]\r\n<Picture ORC遗迹>：巨型承台。\r\n<Audio 风声> <Video 运输舰> <Prompt 开场>\r\n[分镜脚本]\r\n镜头03｜[10–15s]  \r\n画面描述：六只虫群。';
const tokens = tokenizePreviewPrompt(source);
assert.equal(tokens.map(token => token.raw).join(""), source);
assert.equal(tokens.filter(token => token.kind === "section").length, 3);
assert.equal(tokens.filter(token => token.kind === "shot").length, 1);
assert.deepEqual(tokens.filter(token => token.kind === "reference").map(token => token.name),
  ["ORC遗迹", "风声", "运输舰", "开场"]);
for (const dash of ["-", "–", "—", "−"]) {
  assert.equal(tokenizePreviewPrompt(`镜头01 | [0.5${dash}5s]`)[0].kind, "shot");
}
const html = renderPreviewPrompt(source);
assert.ok(html.includes("图片 · ORC遗迹"));
assert.ok(html.includes('tdm-prompt-shot'));
assert.ok(!html.includes("<Picture"));
assert.ok(renderPreviewPrompt('<script>alert("x")</script> & <Picture A"B>').includes("&lt;script&gt;"));
assert.ok(!renderPreviewPrompt('<Picture A" onclick="evil>').includes(' onclick="evil'));
assert.equal(tokenizePreviewPrompt("正文中的[普通括号]和 <unknown 标签>")[0].kind, "text");
assert.equal(renderPreviewPrompt(null), "");
const editableHtml=renderPreviewPrompt(source,{editable:true});
assert.ok(editableHtml.includes('data-raw="[导演说明]"'));
assert.ok(editableHtml.includes('contenteditable="false"'));
assert.ok(editableHtml.includes('data-raw="&lt;Picture ORC遗迹&gt;"'));
console.log("Preview screenplay visual tags: PASS");
