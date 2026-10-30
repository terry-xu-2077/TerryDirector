// Run: node tests/test_preview_batch_import.mjs
import assert from "node:assert/strict";
import {parsePreviewBatches} from "../web/td_preview_batch_import.js";
const source = [
  "# 第一集提示词","> **规则：** 所有批次遵循统一影像风格。","",
  "## 批次01｜场景一·菌伞峡道（建议15秒）","[导演说明]","保留完整导演说明。","",
  "[全局参考]","- 00_特瑞_Terry.jpg：人物外观","- 蚂蚱载具.jpg：载具外观",
  "- 待生成资产｜干燥菌伞峡道母图","","[连续性状态]","保持车辆连续。","",
  "[分镜脚本]","镜头01｜[0–15s]","贴地飞行。","",
  "## 批次02｜场景二·遗迹揭露","[导演说明]","第二批完整正文。","",
  "[全局参考]","- 开场遗迹.jpg：遗迹环境","","[分镜脚本]","固定远景。",
].join("\n");
const parsed=parsePreviewBatches(source);
assert.equal(parsed.batches.length,2);
assert.match(parsed.preamble,/统一影像风格/);
assert.doesNotMatch(parsed.preamble,/^# 第一集提示词/m);
assert.equal(parsed.batches[0].name,"批次01｜场景一·菌伞峡道");
assert.equal(parsed.batches[0].heading,"批次01｜场景一·菌伞峡道（建议15秒）");
assert.equal(parsed.batches[0].duration_seconds,15);
assert.match(parsed.batches[0].body,/保留完整导演说明/);
assert.match(parsed.batches[0].body,/镜头01｜/);
assert.deepEqual(parsed.batches[0].references.map(x=>x.name),["00_特瑞_Terry.jpg","蚂蚱载具.jpg"]);
assert.deepEqual(parsed.batches[0].generatedAssets,["干燥菌伞峡道母图"]);
assert.deepEqual(parsed.batches[1].references.map(x=>x.name),["开场遗迹.jpg"]);
assert.equal(parsePreviewBatches("没有批次标题").batches.length,0);
assert.match(parsePreviewBatches("没有批次标题").error,/未识别到批次标题/);
console.log("Preview Stage Markdown batch parser: PASS");
