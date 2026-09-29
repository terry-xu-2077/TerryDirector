/* Resolution math follows ComfyUI's ResolutionSelector (nodes_resolution.py).
 * 1 MP = 1024 * 1024 here, not 1,000,000; round each side to the nearest multiple.
 * No model/runtime dependency. Only the three input settings are stored per clip. */
(function (global) {
  'use strict';
  const ASPECTS = Object.freeze([
    { value:'1:1', label:'1:1 · 方形', width:1, height:1 },
    { value:'2:3', label:'2:3 · 竖幅', width:2, height:3 },
    { value:'3:2', label:'3:2 · 横幅', width:3, height:2 },
    { value:'3:4', label:'3:4 · 竖屏', width:3, height:4 },
    { value:'4:3', label:'4:3 · 标准', width:4, height:3 },
    { value:'9:16', label:'9:16 · 竖屏宽幅', width:9, height:16 },
    { value:'16:9', label:'16:9 · 宽屏', width:16, height:9 },
    { value:'21:9', label:'21:9 · 超宽屏', width:21, height:9 }
  ].map(Object.freeze));
  const DEFAULT = Object.freeze({ aspect_ratio:'16:9', megapixels:1.2, multiple:32 });
  // Python round() uses ties-to-even; Math.round() would disagree at exactly .5.
  function roundEven(value) {
    const floor = Math.floor(value), fraction = value - floor;
    return fraction === 0.5 ? floor + floor % 2 : Math.round(value);
  }
  function calculate(settings) {
    const aspect = ASPECTS.find(a => a.value === settings?.aspect_ratio);
    const megapixels = settings?.megapixels, multiple = settings?.multiple;
    if (!aspect) throw new RangeError('请选择画面比例。');
    if (!Number.isFinite(megapixels) || megapixels < 0.1 || megapixels > 16)
      throw new RangeError('像素量范围为 0.1–16 MP。');
    if (!Number.isInteger(multiple) || multiple < 8 || multiple > 128 || multiple % 4 !== 0)
      throw new RangeError('尺寸倍数范围为 8–128，步长为 4。');
    const scale = Math.sqrt(megapixels * 1024 * 1024 / (aspect.width * aspect.height));
    return {
      width: roundEven(aspect.width * scale / multiple) * multiple,
      height: roundEven(aspect.height * scale / multiple) * multiple
    };
  }
  const api = { ASPECTS, DEFAULT, calculate };
  if (typeof module !== 'undefined') module.exports = api;
  global.TDResolution = api;
})(typeof window !== 'undefined' ? window : globalThis);
