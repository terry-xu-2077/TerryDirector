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
const repeated=parsePreviewBatches("## 批次03｜重复引用\n[全局参考]\n- a.jpg：正面\n- a.jpg：侧面\n[分镜脚本]\n镜头");
assert.equal(repeated.batches[0].references.length,2);
assert.equal(parsePreviewBatches("没有批次标题").batches.length,0);
assert.match(parsePreviewBatches("没有批次标题").error,/未识别到批次标题/);

const plainText = [
  "批次01｜场景一·菌伞峡道／赛车穿越机（建议15秒）",
  "[导演说明] 第一镜以赛车式穿越机的自由飞行把观众拉进这颗星球。",
  "",
  "[全局参考]",
  "00_特瑞_Terry.jpg：特瑞面容、沙棕旧披覆外层及深灰工装",
  "蚂蚱载具.jpg：866单座、四轮长机械腿、翼膜及旧涂装",
  "荒星地貌.jpg：蓝灰岩、粉紫矿尘与荒原光色",
  "待生成资产｜干燥菌伞峡道母图 生图提示词：请生成一张2.39:1横幅电影空间母图。",
  "",
  "[连续性状态] 866在干燥旧路行驶、四轮完好。",
  "[视觉基调] 空气流动／衣料物理：碎发自然向车后偏移。",
  "[色彩光影] 岩壁阴影蓝灰。",
  "[分镜脚本]",
  "镜头01｜[0–9s] 景别 / 焦段：18mm｜后方中景。",
  "镜头02｜[9–15s] 景别 / 焦段：25mm｜驾驶POV。",
  "",
  "批次02｜场景一·旷野、橙灯与人物反应（建议15秒）",
  "[导演说明] 从高速峡谷突然切到完全固定的远景。",
  "[全局参考]",
  "00_特瑞_Terry.jpg：人物外观",
  "蚂蚱载具.jpg：载具外观",
  "荒星地貌.jpg：环境光色",
  "开场遗迹.jpg：旧ORC工业遗迹",
  "地下虫群-4种变体.jpg：最新版虫群形态",
  "待生成资产｜干燥菌伞峡道母图 生图提示词：这是一段很长的生图提示词。",
  "[连续性状态] 866已经冲出峡谷。",
  "[视觉基调] 驾驶位并未密封。",
  "[色彩光影] 旷野天光高而软。",
  "[分镜脚本]",
  "镜头01｜[0–8s] 固定极大远景。",
  "镜头02｜[8–11s] 仪表特写。",
  "镜头03｜[11–15s] 人物近景。",
].join("\n");
const plain = parsePreviewBatches(plainText);
assert.equal(plain.batches.length,2);
assert.equal(plain.batches[0].name,"批次01｜场景一·菌伞峡道／赛车穿越机");
assert.equal(plain.batches[0].duration_seconds,15);
assert.match(plain.batches[0].body,/\[导演说明\]/);
assert.match(plain.batches[0].body,/\[连续性状态\]/);
assert.match(plain.batches[0].body,/镜头02｜\[9–15s\]/);
assert.deepEqual(plain.batches[0].references.map(x=>x.name),[
  "00_特瑞_Terry.jpg","蚂蚱载具.jpg","荒星地貌.jpg"
]);
assert.deepEqual(plain.batches[0].generatedAssets,["干燥菌伞峡道母图"]);
assert.deepEqual(plain.batches[1].references.map(x=>x.name),[
  "00_特瑞_Terry.jpg","蚂蚱载具.jpg","荒星地貌.jpg","开场遗迹.jpg","地下虫群-4种变体.jpg"
]);
assert.deepEqual(plain.batches[1].generatedAssets,["干燥菌伞峡道母图"]);
assert.equal(parsePreviewBatches("## **批次03｜测试标题（建议12秒）**\n[分镜脚本]\n镜头").batches[0].duration_seconds,12);

// Image, audio and video references are typed independently for H3 media slots.
const media = parsePreviewBatches([
  "批次04｜多媒体引用（建议15秒）",
  "[全局参考]",
  "角色.jpg：人物外观",
  "环境.webp：环境",
  "对白.wav：角色对白",
  "环境声.mp3：风声",
  "运动参考.mp4：动作节奏",
  "镜头参考.mov：运镜参考",
  "[分镜脚本]",
  "镜头01｜测试",
].join("\n"));
assert.deepEqual(media.batches[0].references.map(x=>[x.name,x.kind]),[
  ["角色.jpg","image"],["环境.webp","image"],["对白.wav","audio"],
  ["环境声.mp3","audio"],["运动参考.mp4","video"],["镜头参考.mov","video"]
]);
console.log("Preview Stage Markdown + plain-text + H3 media batch parser: PASS");
