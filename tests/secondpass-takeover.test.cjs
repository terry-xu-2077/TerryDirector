const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'td_secondpass_takeover.js'), 'utf8'
);
const load = import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

function config({ linked = null, originalDisabled = false } = {}) {
  const names = ['sampler', 'sigmas', 'sigmas_steps', 'sigmas_denoise',
    'aspect_ratio', 'megapixels', 'multiple', 'ref_image_size'];
  const widgets = names.map((name, index) => ({
    name,
    label: name === 'sampler' ? '采样器' : undefined,
    tooltip: name === 'sampler' ? '原本的采样器提示' : undefined,
    disabled: index === 2 && originalDisabled,
    value: index + 10,
    options: { advanced: index < 2 },
  }));
  const node = {
    inputs: [{ name: 'model', link: 42 }, { name: 'second_pass_config', link: linked }],
    widgets,
    updates: 0,
    renders: 0,
    updateComputedDisabled() {
      this.updates++;
      widgets.forEach(widget => widget.computedDisabled = !!widget.disabled);
    },
    setDirtyCanvas() { this.renders++; },
  };
  return node;
}

test('disconnected config leaves ordinary controls and their values untouched', async () => {
  const { updateSecondPassTakeover } = await load;
  const node = config();
  const snapshot = structuredClone(node.widgets);
  assert.equal(updateSecondPassTakeover(node), false);
  assert.deepEqual(node.widgets, snapshot);
  assert.equal(node.updates, 0);
});

test('link ID zero disables precisely four controls with visible takeover labels', async () => {
  const { updateSecondPassTakeover, hasSecondPassConnection } = await load;
  const node = config({ linked: 0 });
  const saved = node.widgets.map(w => w.value);
  assert.equal(hasSecondPassConnection(node), true);
  assert.equal(updateSecondPassTakeover(node), true);
  node.widgets.slice(0, 4).forEach(widget => {
    assert.equal(widget.disabled, true);
    assert.match(widget.label, /二采接管/);
    assert.doesNotMatch(widget.label, /SelfLift/);
    assert.match(widget.tooltip, /二采配置/);
    assert.doesNotMatch(widget.tooltip, /SelfLift/);
    assert.equal(widget.computedDisabled, true);
  });
  node.widgets.slice(4).forEach(w => assert.equal(w.disabled, false));
  assert.deepEqual(node.widgets.map(w => w.value), saved);
  assert.equal(node.widgets[0].tooltip.endsWith('原本的采样器提示'), true);
});

test('disconnect restores original disabled/label/tooltip state exactly', async () => {
  const { updateSecondPassTakeover } = await load;
  const node = config({ linked: 27, originalDisabled: true });
  const originals = node.widgets.map(({ label, tooltip, disabled, value }) =>
    ({ label, tooltip, disabled, value }));
  updateSecondPassTakeover(node);
  assert.equal(node.widgets[2].disabled, true);
  node.inputs[1].link = null;
  assert.equal(updateSecondPassTakeover(node), false);
  assert.deepEqual(node.widgets.map(({ label, tooltip, disabled, value }) =>
    ({ label, tooltip, disabled, value })), originals);
  assert.equal(node.widgets.every(w => !w.__tdSecondPassOriginal), true);
});

test('repeated rendering is idempotent and does not append duplicate labels', async () => {
  const { updateSecondPassTakeover } = await load;
  const node = config({ linked: 1 });
  updateSecondPassTakeover(node);
  const labels = node.widgets.map(w => w.label);
  const runs = node.updates;
  updateSecondPassTakeover(node);
  assert.deepEqual(node.widgets.map(w => w.label), labels);
  assert.equal(node.updates, runs);
});

test('connection event updates only that config instance, including after reload', async () => {
  const { bindSecondPassTakeover } = await load;
  const primary = config();
  const secondary = config();
  let previousCalls = 0;
  primary.onConnectionsChange = function() { previousCalls++; };
  bindSecondPassTakeover(primary);
  bindSecondPassTakeover(primary);
  bindSecondPassTakeover(secondary);
  primary.inputs[1].link = 99;
  primary.onConnectionsChange();
  await Promise.resolve();
  assert.equal(previousCalls, 1);
  assert.equal(primary.widgets[0].disabled, true);
  assert.equal(secondary.widgets[0].disabled, false);
  primary.inputs[1].link = null;
  primary.onConnectionsChange();
  await Promise.resolve();
  assert.equal(primary.widgets[0].disabled, false);
  const restored = config({ linked: 99 });
  bindSecondPassTakeover(restored);
  assert.equal(restored.widgets[0].disabled, true);
});
