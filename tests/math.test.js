'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MathLayout = require('../web/js/math.js');
const Glyphs = require('../web/js/glyphs.js');
const { layoutText, generate, parse } = require('../web/js/path-engine.js');
const kai = Glyphs.indexLibrary(Glyphs.normalizeLibrary(require('../web/glyphs/skeleton-kai.json')));
const glyphFor = (char) => { const v = kai.chars.get(char)?.[0]; return v ? { unitsPerEm: kai.unitsPerEm, advance: v.advance, strokes: v.strokes } : null; };
const box = (source, size = 10) => MathLayout.layout(source, size, glyphFor);

test('parser builds fractions, roots, scripts, limits and fences; reports errors', () => {
  assert.equal(MathLayout.parse('\\frac{a}{b}').items[0].type, 'frac');
  assert.equal(MathLayout.parse('\\sqrt[3]{x}').items[0].index.items[0].char, '3');
  const scripts = MathLayout.parse('x_i^2').items[0];
  assert.deepEqual([scripts.type, scripts.sub.char, scripts.sup.char], ['scripts', 'i', '2']);
  assert.equal(MathLayout.parse('\\left( x \\right)').items[0].type, 'fence');
  assert.throws(() => MathLayout.parse('\\frac{1}{'), /缺少/);
  assert.throws(() => MathLayout.parse('\\unknowncmd'), /不支持的命令/);
  assert.throws(() => MathLayout.parse('x^2^3'), /重复的上标/);
});

test('layout geometry: fraction stacks around the axis, scripts are smaller and raised, no missing glyphs', () => {
  const frac = box('\\frac{a+b}{c}'), plain = box('a+b');
  assert(frac.height > plain.height && frac.depth > plain.depth + 3); // numerator above, denominator below the baseline
  const sup = box('x^2');
  assert(sup.height > box('x').height);
  for (const source of ['\\sum_{i=1}^{n} i^2', '\\int_0^1 x\\,dx', '\\lim_{x\\to 0}\\frac{\\sin x}{x}', '\\alpha+\\beta\\ge\\pi', '\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}']) {
    const result = box(source);
    assert.equal(result.error, null, source);
    assert.deepEqual(result.missing, [], source);
    assert(result.strokes.length > 0 && result.strokes.every((s) => s.every(([x, y]) => x >= -1 && y >= -1 && x <= result.width + 1 && y <= result.height + result.depth + 1)), source);
  }
  const broken = box('\\frac{1}{');
  assert.match(broken.error, /缺少/);
  assert(broken.placeholder.length > 0);
});

test('formulas inside text: one atomic box, carets, generation writes their strokes', () => {
  const options = { width: 210, height: 297, margin: 20, size: 6, gap: 1, lineGap: 3, feed: 1200, penUp: 5, penDown: 0, math: (source, size) => MathLayout.layout(source, size, glyphFor) };
  const text = 'A\\(\\frac{1}{2}\\)B';
  const layout = layoutText(text, options);
  const formula = layout.placements.find((item) => item.kind === 'formula');
  assert.deepEqual([formula.index, formula.end], [1, 16]);
  const b = layout.placements.find((item) => item.char === 'B');
  assert(Math.abs(b.x - (formula.x + formula.width + 1)) < 1e-9);
  assert.equal(layout.carets[5].x, layout.carets[1].x); // inside the formula → caret at its start
  assert.equal(layout.carets.length, Array.from(text).length + 1);
  const code = generate(text, options);
  assert.deepEqual(parse(code).errors, []);
  assert(code.split('\n').length > generate('AB', options).split('\n').length + 10);
});

test('formatting runs and paragraphs: size, pen, centre / right alignment, first-line indent', () => {
  const options = { width: 210, height: 297, margin: 20, size: 5, gap: 1, lineGap: 3 };
  const format = { runs: [{ from: 0, to: 2, size: 10, pen: 2 }], paras: [{ at: 0, align: 'center' }, { at: 3, indent: 10 }, { at: 6, align: 'right' }] };
  const layout = layoutText('AB\nCD\nEF', { ...options, format });
  const [a, b, c, , , f] = layout.placements;
  assert.deepEqual([a.size, a.pen, c.size, c.pen], [10, 2, 5, 0]);
  assert(Math.abs((a.x - 20) - (190 - (b.x + b.width))) < 1e-9); // centred row
  assert.equal(c.x, 30);                                          // first-line indent
  assert(Math.abs(f.x + f.width - 190) < 1e-9);                   // right aligned
  assert.equal(c.y - a.y, 10 + 3);                                 // row height follows the larger size
  const plain = layoutText('AB\nCD', options), same = layoutText('AB\nCD', { ...options, format: { runs: [], paras: [] } });
  assert.deepEqual(same.placements, plain.placements);
});
