/* Machine presets (机型): pen lift, speed, pen zero and travel of a writing machine, applied to a workspace.
 * Built-ins are generic GRBL starting points, not claims about any brand. Pure logic, shared with Node tests. */
(function (root) {
  'use strict';
  // Draft motion fields a preset sets (same ids as the 笔与零点 fields), and workspace machine fields.
  const MOTION_KEYS = ['feed', 'pen-mode', 'pen-up', 'pen-down', 'servo-down', 'servo-up', 'pen-delay', 'origin-corner', 'origin-x', 'origin-y', 'x-dir', 'y-dir'];
  const LIMIT_KEYS = ['machine-x', 'machine-y', 'machine-z-min', 'machine-z-max', 'travel-x-min', 'travel-x-max', 'travel-y-min', 'travel-y-max', 'travel-z-min', 'travel-z-max', 'baud'];
  const ORIGIN = { 'origin-corner': 'bottom-left', 'origin-x': '0', 'origin-y': '0', 'x-dir': '1', 'y-dir': '1' };
  const PAPER = { 'machine-x': '210', 'machine-y': '297', 'machine-z-min': '0', 'machine-z-max': '10', baud: '115200' };
  const BUILTIN = [
    { id: 'grbl-z', name: '通用 GRBL · Z 轴抬笔', description: '笔装在 Z 轴上：Z 5 mm 抬笔，Z 0 落笔。', motion: { feed: '1200', 'pen-mode': 'z', 'pen-up': '5', 'pen-down': '0', ...ORIGIN }, limits: PAPER },
    { id: 'grbl-servo-m5', name: 'GRBL 舵机 · M3 S 落笔 / M5 抬笔', description: '舵机接在主轴 PWM 上（常见的 GRBL 舵机固件）。落笔 M3 S30，抬笔 M5，每次等待 0.15 秒。', motion: { feed: '2000', 'pen-mode': 'servo-m5', 'servo-down': '30', 'pen-delay': '0.15', ...ORIGIN }, limits: PAPER },
    { id: 'grbl-servo-s', name: 'GRBL 舵机 · M3 两个 S 值', description: '用两个 S 值控制舵机角度：落笔 M3 S30，抬笔 M3 S90，每次等待 0.2 秒。', motion: { feed: '2000', 'pen-mode': 'servo-s', 'servo-down': '30', 'servo-up': '90', 'pen-delay': '0.2', ...ORIGIN }, limits: PAPER },
  ].map((preset) => ({ ...preset, builtin: true }));

  const pick = (value, keys) => Object.fromEntries(keys.filter((key) => typeof value?.[key] === 'string' && value[key].length <= 20).map((key) => [key, value[key]]));
  /** A user preset stored in workspace.wtw: { name, motion, limits } with string values (validated again when applied). */
  function normalizePreset(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
    return { name: raw.name.trim().slice(0, 40), motion: pick(raw.motion, MOTION_KEYS), limits: pick(raw.limits, LIMIT_KEYS) };
  }
  /** Machine fields of workspace.wtw besides pens: applied preset name, defaults for new drafts, limits, user presets. */
  function normalizeMachine(machine) {
    const presets = [];
    for (const item of Array.isArray(machine?.presets) ? machine.presets.slice(0, 50) : []) {
      const preset = normalizePreset(item);
      if (preset && !presets.some((other) => other.name === preset.name) && !BUILTIN.some((other) => other.name === preset.name)) presets.push(preset);
    }
    return {
      preset: typeof machine?.preset === 'string' ? machine.preset.slice(0, 40) : '',
      motion: pick(machine?.motion, MOTION_KEYS),
      limits: pick(machine?.limits, LIMIT_KEYS),
      presets,
    };
  }
  /** Built-ins first, then this workspace's presets. */
  function allPresets(machine) {
    return [...BUILTIN, ...(machine?.presets || []).map((preset) => ({ ...preset, id: `user:${preset.name}`, builtin: false }))];
  }

  const api = { MOTION_KEYS, LIMIT_KEYS, BUILTIN, normalizePreset, normalizeMachine, allPresets };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Machines = api;
})(typeof window !== 'undefined' ? window : globalThis);
