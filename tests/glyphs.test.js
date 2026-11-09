'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Glyphs = require('../web/js/glyphs.js');
const { generate, parse, layoutText } = require('../web/js/path-engine.js');

const hand = {
  format: Glyphs.FORMAT, version: 1, id: 'test-hand', name: '测试手写', unitsPerEm: 1000,
  glyphs: [
    { char: '永', variants: [
      { id: 'a', advance: 1000, strokes: [[[100, 100], [100, 900, .5, 20]]] },
      { id: 'b', advance: 1000, strokes: [[[200, 100], [800, 900]]] },
      { id: 'c', advance: 1000, strokes: [[[500, 500]]] },
    ] },
    { char: 'A', variants: [{ id: 'hand', advance: 600, strokes: [[[0, 1000], [300, 0], [600, 1000]]] }] },
  ],
};
const options = { width: 210, height: 297, margin: 20, size: 10, gap: 1, lineGap: 3, feed: 1200, penUp: 5, penDown: 0 };
const registry = (...libs) => new Map([[Glyphs.BUILTIN_ID, Glyphs.builtinLibrary()], ...libs.map((lib) => [lib.id, lib])]);
const indexed = Glyphs.indexLibrary(Glyphs.normalizeLibrary(hand));
const pick = (selection, text) => {
  const resolve = Glyphs.createResolver(Glyphs.normalizeSelection(selection), registry(indexed));
  return Array.from(text).map((char, i) => resolve(i, char)?.variant ?? null);
};

test('library validation rejects malformed files with readable errors', () => {
  assert.throws(() => Glyphs.normalizeLibrary({ ...hand, format: 'x' }), /v1 字形库/);
  assert.throws(() => Glyphs.normalizeLibrary({ ...hand, id: 'Bad ID' }), /id 无效/);
  assert.throws(() => Glyphs.normalizeLibrary({ ...hand, glyphs: [hand.glyphs[0], hand.glyphs[0]] }), /重复/);
  assert.throws(() => Glyphs.normalizeLibrary({ ...hand, glyphs: [{ char: '永永', variants: hand.glyphs[0].variants }] }), /一个字符/);
  assert.throws(() => Glyphs.normalizeLibrary({ ...hand, glyphs: [{ char: '永', variants: [{ id: 'a', strokes: [[[0, Infinity]]] }] }] }), /无效坐标/);
  const clean = Glyphs.normalizeLibrary(hand);
  assert.deepEqual(clean.glyphs[0].variants[0].strokes[0][1], [100, 900, .5, 20]); // pressure / time preserved
});

test('strategies: first, cycle and reproducible random', () => {
  const base = { libraries: ['test-hand'] };
  assert.deepEqual(pick({ ...base, strategy: 'first' }, '永永永永'), ['a', 'a', 'a', 'a']);
  assert.deepEqual(pick({ ...base, strategy: 'cycle' }, '永永永永'), ['a', 'b', 'c', 'a']);
  const random = pick({ ...base, strategy: 'random', seed: 7 }, '永'.repeat(30));
  assert.deepEqual(random, pick({ ...base, strategy: 'random', seed: 7 }, '永'.repeat(30)));
  assert.notDeepEqual(random, pick({ ...base, strategy: 'random', seed: 8 }, '永'.repeat(30)));
  assert(new Set(random).size > 1);
});

test('pin beats per-character default beats strategy; library priority decides the source', () => {
  const selection = { libraries: ['test-hand', Glyphs.BUILTIN_ID], strategy: 'cycle', prefer: { '永': { library: 'test-hand', variant: 'c' } }, pins: [{ at: 1, char: '永', library: 'test-hand', variant: 'b' }] };
  assert.deepEqual(pick(selection, '永永永'), ['c', 'b', 'c']);
  // A pin whose character no longer matches is ignored rather than applied to another character.
  assert.deepEqual(pick({ ...selection, pins: [{ at: 0, char: '永', library: 'test-hand', variant: 'b' }] }, 'A永'), ['hand', 'c']);
  // Priority: test-hand has its own A; with builtin first, the builtin A wins.
  assert.deepEqual(pick({ libraries: [Glyphs.BUILTIN_ID, 'test-hand'] }, 'A'), ['v1']);
  // Disabled libraries are never used, even when referenced.
  assert.deepEqual(pick({ libraries: [Glyphs.BUILTIN_ID], prefer: { '永': { library: 'test-hand', variant: 'a' } } }, '永'), [null]);
});

test('pins follow their characters across edits and drop when the character is edited', () => {
  const pins = [{ at: 2, char: '永', library: 'test-hand', variant: 'b' }, { at: 5, char: 'A', library: 'test-hand', variant: 'hand' }];
  assert.deepEqual(Glyphs.shiftPins(pins, 'xx永xxA', '前缀xx永xxA').map((p) => p.at), [4, 7]);
  assert.deepEqual(Glyphs.shiftPins(pins, 'xx永xxA', 'xx永xA').map((p) => p.at), [2, 4]);
  assert.deepEqual(Glyphs.shiftPins(pins, 'xx永xxA', 'xx水xxA').map((p) => p.char), ['A']);
  assert.deepEqual(Glyphs.shiftPins(pins, 'xx永xxA', 'xx永xxA'), pins);
});

test('selection normalization never throws and drops invalid parts', () => {
  assert.deepEqual(Glyphs.normalizeSelection(undefined), { libraries: [Glyphs.BUILTIN_ID], strategy: 'first', seed: 1, prefer: {}, pins: [] });
  const clean = Glyphs.normalizeSelection({ libraries: ['ok', 'BAD', 'ok'], strategy: 'zzz', seed: -1, prefer: { '永': { library: 'ok', variant: 'a' }, xx: {} }, pins: [{ at: 1, char: '永', library: 'ok', variant: 'a' }, { at: 1, char: '永', library: 'ok', variant: 'b' }, { at: -1 }] });
  assert.deepEqual(clean.libraries, ['ok']);
  assert.equal(clean.strategy, 'first');
  assert.deepEqual(Object.keys(clean.prefer), ['永']);
  assert.equal(clean.pins.length, 1);
});

test('generator writes imported CJK strokes, scaled to the font size, and blocks missing glyphs', () => {
  const selection = Glyphs.normalizeSelection({ libraries: ['test-hand'], strategy: 'cycle' });
  const resolve = () => Glyphs.createResolver(selection, registry(indexed));
  const code = generate('永永', { ...options, resolve: resolve() });
  const result = parse(code);
  assert.deepEqual(result.errors, []);
  assert.match(code, /G0 X21 Y276\n/); // variant a: (100, 100) em → +1 mm at size 10
  assert.match(code, /G0 X33 Y276\n/); // second 永 uses variant b at x = 20 + 10 + 1 gap + 2
  assert.throws(() => generate('永水', { ...options, resolve: resolve() }), /字库暂不支持：水/);
  const layout = layoutText('永 水', options, resolve(), () => 7);
  assert.deepEqual(layout.missing, ['水']);
  assert.equal(layout.placements[1].x, 20 + 10 + 1 + 7 + 1);
});
