const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "web", "td_loop_output_check.js"), "utf8"
);
const load = import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));

const ready = {
  state: "ready", activeClips: 3, frames: 288,
  seconds: 12, width: 608, height: 352,
};

test("12s native H3 video estimates lossless temp space, not encoded MP4", async () => {
  const { estimateLoopTempSpaceBytes, formatLoopDiskSpace } = await load;
  const bytes = estimateLoopTempSpaceBytes(288, 608, 352);
  assert.equal(bytes, 928389120);
  assert.equal(formatLoopDiskSpace(bytes), "0.9 GB");
  assert.equal(estimateLoopTempSpaceBytes(0, 608, 352), null);
  assert.equal(estimateLoopTempSpaceBytes(288, NaN, 352), null);
  assert.equal(estimateLoopTempSpaceBytes(-2, 608, 352), null);
});

test("disk space warnings distinguish shortage, narrow margin and enough", async () => {
  const { loopDiskHeadroom } = await load;
  const need = 2e9;
  assert.equal(loopDiskHeadroom(need, need - 1), "critical");
  assert.equal(loopDiskHeadroom(need, need + 1), "warning");
  assert.equal(loopDiskHeadroom(need, need + 600e6), "ok");
  assert.equal(loopDiskHeadroom(need, undefined), "unknown");
});

test("ready state is short, user-facing, and contains the real cache drive only", async () => {
  const { createLoopOutputCheckCard } = await load;
  const result = createLoopOutputCheckCard(
    ready, { info: { freeBytes: 100e9, drive: "G:" } }
  );
  assert.equal(result.status, "ok");
  assert.match(result.html, /视频输出检查/);
  assert.match(result.html, /12 秒 · 608×352 · 24 帧\/秒/);
  assert.match(result.html, /3 段/);
  assert.match(result.html, /预计临时空间/);
  assert.match(result.html, /约 0\.9 GB/);
  assert.match(result.html, /临时磁盘剩余/);
  assert.match(result.html, /G: · 100\.0 GB/);
  assert.match(result.html, /保存成功后/);
  assert.doesNotMatch(result.html, /物化|整段画面占用|IMAGE|AUDIO|H\.264/);
});

test("near-full disk gets prominent and actionable plain-language warning", async () => {
  const { createLoopOutputCheckCard } = await load;
  const shortage = createLoopOutputCheckCard(
    ready, {info:{freeBytes:100e6,drive:"D:"}}
  );
  assert.equal(shortage.status, "critical");
  assert.match(shortage.className, /is-space-low/);
  assert.match(shortage.html, /先清理磁盘/);
  const caution = createLoopOutputCheckCard(
    ready, {info:{freeBytes:1e9,drive:"D:"}}
  );
  assert.equal(caution.status, "warning");
  assert.match(caution.className, /is-space-warning/);
  assert.match(caution.html, /多留一些空间/);
});

test("unknown upstream resolution still shows known time and disk free space", async () => {
  const { createLoopOutputCheckCard } = await load;
  const card = createLoopOutputCheckCard(
    {state:"summary",activeClips:3,frames:288},
    {info:{freeBytes:40e9,drive:"C:"}}
  );
  assert.equal(card.status, "unknown");
  assert.match(card.html, /12 秒 · 分辨率待确定/);
  assert.match(card.html, /临时磁盘剩余/);
  assert.match(card.html, /C: · 40\.0 GB/);
  assert.match(card.html, /暂无法估算/);
  assert.doesNotMatch(card.html, /约 0\.9 GB/);
});

test("failed disk query never invents a free-space number", async () => {
  const { createLoopOutputCheckCard } = await load;
  const card = createLoopOutputCheckCard(ready, {failed: true});
  assert.equal(card.status, "unknown");
  assert.match(card.html, /暂无法读取/);
  assert.match(card.html, /约 0\.9 GB/);
  assert.doesNotMatch(card.html, /空间不足/);
});

test("unconnected workflow does not imply videos or disk capacity", async () => {
  const { createLoopOutputCheckCard } = await load;
  const card = createLoopOutputCheckCard({state:"disconnected"}, {});
  assert.equal(card.status, "disconnected");
  assert.match(card.html, /连接循环信息/);
  assert.doesNotMatch(card.html, /288|100 GB/);
});

test("untrusted drive labels cannot insert HTML into the node", async () => {
  const { createLoopOutputCheckCard } = await load;
  const card = createLoopOutputCheckCard(
    ready, { info: {freeBytes:10e9,drive:'<img src=x onerror=alert(1)>'} }
  );
  assert.doesNotMatch(card.html, /<img/);
});
