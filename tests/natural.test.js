'use strict';
// 拟真笔迹, formatting decorations / lists / scripts, servo pen lift, machine presets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generate, parse, layoutText, textStrokes } = require('../web/js/path-engine.js');
const Links = require('../web/js/links.js');
const Machines = require('../web/js/machines.js');
const options = { width: 210, height: 297, margin: 20, size: 5, gap: 1, lineGap: 3, feed: 1200, penUp: 5, penDown: 0 };
const natural = { size: .1, baseline: .1, spacing: .2, slant: 6, slantVar: 4, join: .5, seed: 7 };

test('拟真 is reproducible per seed, differs between seeds, and off changes nothing', () => {
  const text = 'HELLO WORLD 123';
  assert.deepEqual(layoutText(text, { ...options, natural }), layoutText(text, { ...options, natural }));
  assert.equal(generate(text, { ...options, natural }), generate(text, { ...options, natural }));
  assert.notEqual(generate(text, { ...options, natural }), generate(text, { ...options, natural: { ...natural, seed: 8 } }));
  assert.equal(generate(text, { ...options, natural: null }), generate(text, options));
  const zero = { size: 0, baseline: 0, spacing: 0, slant: 0, slantVar: 0, join: 0, seed: 3 };
  assert.deepEqual(textStrokes(layoutText(text, { ...options, natural: zero })), textStrokes(layoutText(text, options)));
});
test('拟真 output stays a valid program inside the paper', () => {
  const result = parse(generate('HELLO WORLD\n'.repeat(10), { ...options, natural }));
  assert.deepEqual(result.errors, []);
  assert(result.bounds.minX >= 0 && result.bounds.maxX <= 210 && result.bounds.maxY <= 297);
});
test('连笔 joins only neighbouring Latin letters / digits, never punctuation', () => {
  const always = { ...natural, join: 1 };
  const layout = layoutText('AB. CD', { ...options, natural: always });
  const joined = layout.placements.filter((item) => item.joinPrevious).map((item) => item.char);
  assert(joined.every((char) => /[A-Z0-9]/.test(char)));
  assert(!joined.includes('.') && !joined.includes('C'), 'no join after a space or into punctuation');
  assert(textStrokes(layout).length <= textStrokes(layoutText('AB. CD', options)).length);
});
test('underline, strike-through, superscript, lists and line spacing', () => {
  const text = 'AB CD\nONE\nTWO\nX2';
  const format = { runs: [{ from: 0, to: 2, underline: true }, { from: 3, to: 5, strike: true }, { from: 15, to: 16, script: 'sup' }], paras: [{ at: 6, list: 'number' }, { at: 10, list: 'number', spacing: 2 }, { at: 14, list: 'bullet' }] };
  const plain = layoutText(text, options), rich = layoutText(text, { ...options, format });
  assert.deepEqual(rich.decorations.map((item) => item.kind), ['underline', 'strike', 'bullet']);
  assert.deepEqual(rich.placements.filter((item) => item.kind === 'marker').map((item) => item.char).join(''), '1.2.');
  const at = (layout, index) => layout.placements.find((item) => item.index === index);
  assert(at(rich, 6).x > at(plain, 6).x, 'list text hangs after its marker');
  assert(at(rich, 15).size < at(plain, 15).size && at(rich, 15).y < at(rich, 14).y + 1, 'superscript is smaller and raised');
  // Double spacing on the "TWO" paragraph pushes the following paragraph down.
  assert(at(rich, 14).y - at(rich, 10).y > at(plain, 14).y - at(plain, 10).y);
  assert.deepEqual(parse(generate(text, { ...options, format })).errors, []);
});
test('format model keeps the new run / paragraph attributes and drops invalid ones', () => {
  const style = Links.normalizeFormat({ runs: [{ from: 0, to: 2, underline: true, script: 'sup' }, { from: 2, to: 3, script: 'big' }], paras: [{ at: 0, list: 'number', spacing: 1.5 }, { at: 4, list: 'star' }] });
  assert.deepEqual(style.runs, [{ from: 0, to: 2, underline: true, script: 'sup' }]);
  assert.deepEqual(style.paras, [{ at: 0, spacing: 1.5, list: 'number' }]);
  const toggled = Links.applyRun(style, 0, 2, { underline: null, script: null });
  assert.deepEqual(toggled.runs, []);
  assert.deepEqual(Links.applyParagraph(style, [0], { list: null, spacing: 1 }).paras, []);
});
test('servo pen lift writes M3 S / M5 with dwells and parses as drawing', () => {
  const code = generate('HI', { ...options, penLift: { mode: 'servo-m5', down: 30, dwell: .2 } });
  assert(!/Z/.test(code.split('\n').filter((line) => !line.startsWith(';')).join('\n')));
  assert.match(code, /^M3 S30$/m);
  assert.match(code, /^M5$/m);
  const result = parse(code);
  assert.deepEqual(result.errors, []);
  assert(result.segments.some((segment) => segment.drawing) && result.dwell > 0);
  const two = generate('HI', { ...options, penLift: { mode: 'servo-s', down: 20, up: 90 } });
  const profiled = parse(two, 0, { mode: 'servo-s', down: 20, up: 90 });
  assert(profiled.segments.filter((segment) => segment.drawing).every((segment) => !segment.rapid));
  assert.throws(() => generate('HI', { ...options, penLift: { mode: 'servo-s', down: 20, up: 20 } }), /舵机/);
  assert.throws(() => generate('HI', { ...options, penLift: { mode: 'laser' } }), /抬笔方式/);
  assert(parse('G4 P1 X1').errors.length && parse('G1 X1 P2').errors.length);
});
test('machine presets: built-ins, user presets in workspace.wtw, invalid entries dropped', () => {
  const manifest = Links.normalizeManifest({ machine: { preset: '我的', motion: { 'pen-mode': 'servo-m5', bogus: '1' }, limits: { 'machine-x': '300' }, presets: [{ name: '我的', motion: { feed: '1500' } }, { name: '' }, { name: Machines.BUILTIN[0].name }] } });
  assert.deepEqual(manifest.machine.motion, { 'pen-mode': 'servo-m5' });
  assert.deepEqual(manifest.machine.presets.map((preset) => preset.name), ['我的']);
  assert.equal(Machines.allPresets(manifest.machine).length, Machines.BUILTIN.length + 1);
  assert.deepEqual(Links.normalizeManifest({}).machine.presets, []);
});
