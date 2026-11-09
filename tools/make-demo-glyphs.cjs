'use strict';
// Builds web/glyphs/demo-variants.json: programmatic variants of the built-in Latin set.
// Only for trying out variant selection — NOT real handwriting.
const fs = require('node:fs');
const path = require('node:path');
const Glyphs = require('../web/js/glyphs.js');
const round = (value) => Math.round(value * 10) / 10;
const base = Glyphs.builtinLibrary();
const transforms = {
  slant: { advance: 860, map: ([x, y]) => [x + (1000 - y) * .16, y] },
  narrow: { advance: 560, map: ([x, y]) => [x * .8, y] },
  wave: { advance: 700, map: ([x, y]) => [x + Math.sin(y / 120) * 22, y + Math.sin(x / 90) * 18] },
};
// Smooth the wave by inserting midpoints so the distortion follows the stroke.
const densify = (stroke) => stroke.flatMap((point, i) => i ? [[(stroke[i - 1][0] + point[0]) / 2, (stroke[i - 1][1] + point[1]) / 2], point] : [point]);
const glyphs = base.glyphs.filter((glyph) => !/[a-z]/.test(glyph.char)).map((glyph) => ({
  char: glyph.char,
  variants: [
    { id: 'plain', advance: 700, strokes: glyph.variants[0].strokes, tags: ['原样'] },
    ...Object.entries(transforms).map(([id, t]) => ({ id, advance: t.advance, tags: ['程序生成'], strokes: glyph.variants[0].strokes.map((stroke) => (id === 'wave' ? densify(stroke) : stroke).map((point) => t.map(point).map(round))) })),
  ],
}));
const library = Glyphs.normalizeLibrary({ format: Glyphs.FORMAT, version: 1, id: 'demo-variants', name: '演示变体（程序生成，非手写）', author: 'Penfall', license: '随本项目提供', description: '由内置单线英文程序变形得到的 4 种写法，仅用于演示选字与变体切换，不代表真实手写。', unitsPerEm: 1000, glyphs });
const out = path.join(__dirname, '../web/glyphs');
fs.writeFileSync(path.join(out, 'demo-variants.json'), JSON.stringify(library));
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ libraries: [{ id: library.id, name: library.name, file: 'demo-variants.json', chars: library.glyphs.length, description: library.description }] }, null, 2) + '\n');
console.log(`demo-variants: ${library.glyphs.length} chars`);
