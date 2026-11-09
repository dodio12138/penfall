'use strict';
// 运笔: pressure / speed envelopes, corners, endings, and how they reach the G-code.
const test = require('node:test');
const assert = require('node:assert/strict');
const Brush = require('../web/js/brush.js');
const { generate, parse, layoutText, textStrokes } = require('../web/js/path-engine.js');
const options = { width: 210, height: 297, margin: 20, size: 8, gap: 1, lineGap: 3, feed: 1500, penUp: 5, penDown: 0 };
const pens = Object.fromEntries(Object.entries(Brush.PENS).map(([id, pen]) => [id, Brush.normalize(pen)]));

test('a straight stroke: 顿笔 entry, steady faster body, slow ends', () => {
  const { points, p, f } = Brush.shapeStroke([[0, 0], [40, 0]], 8, { ...pens.felt, hook: 0 });
  assert.equal(points.length, p.length); assert.equal(p.length, f.length);
  assert.deepEqual(points[0], [0, 0]); assert.deepEqual(points.at(-1), [40, 0]);
  assert(Math.max(...p.slice(0, 5)) > Brush.BODY + .1, 'entry presses harder than the body');
  assert(f[0] < .7 && f.at(-1) < .7 && Math.max(...f) > .9, 'slow at both ends, near full speed in between');
  assert(points.length < 25, 'long straight runs stay coarse');
});
test('sharp corners slow down and press; diagonal endings taper out, straight ones press', () => {
  const brush = { ...pens.brush, hook: 0 };
  const corner = Brush.shapeStroke([[0, 0], [20, 0], [20, 20]], 8, brush);
  const at = corner.points.findIndex(([x, y]) => x === 20 && y === 0);
  assert(at > 0 && corner.f[at] < .7 && corner.p[at] > .7);
  const pie = Brush.shapeStroke([[20, 0], [0, 20]], 8, brush), heng = Brush.shapeStroke([[0, 0], [30, 0]], 8, brush);
  assert(pie.p.at(-1) < .2, '撇 tapers');
  assert(heng.p.at(-1) > .3 && Math.max(...heng.p.slice(-4)) > .7, '横 ends with a press');
});
test('pressure strength 0 keeps the body pressure; hooks add entry / exit points; dots press', () => {
  const flat = Brush.shapeStroke([[0, 0], [30, 0], [30, 30]], 8, { ...pens.felt, pressure: 0, hook: 0 });
  assert(flat.p.every((value) => value === Brush.BODY));
  const plain = Brush.shapeStroke([[0, 0], [30, 0]], 8, { ...pens.felt, hook: 0 }), hooked = Brush.shapeStroke([[0, 0], [30, 0]], 8, pens.felt);
  assert.equal(hooked.points.length, plain.points.length + 2);
  const dot = Brush.shapeStroke([[5, 5]], 8, pens.felt);
  assert.equal(dot.points.length, 1);
  assert(dot.p[0] > .85 && dot.f[0] < .6, 'a dot is pressed and written slowly');
  assert(Brush.width(pens.brush, 1) > Brush.width(pens.brush, .5) * 1.5 && Brush.width(pens.gel, 1) < 1.2);
});
test('Z pen: pressure becomes depth below pen-down and speed the feed; servo gets speed only', () => {
  const brush = Brush.PENS.felt;
  const code = generate('HI 7', { ...options, brush });
  const result = parse(code);
  assert.deepEqual(result.errors, []);
  assert(result.bounds.minZ < 0 && result.bounds.minZ >= -brush.depth - 1e-9);
  const feeds = new Set([...code.matchAll(/F(\d+)/g)].map((match) => Number(match[1])));
  assert(feeds.size > 5 && Math.max(...feeds) <= options.feed);
  assert.equal(generate('HI 7', { ...options, brush: null }), generate('HI 7', options));
  const servo = generate('HI 7', { ...options, brush, penLift: { mode: 'servo-m5', down: 30 } });
  assert(!/Z-/.test(servo) && /speed only/.test(servo));
  assert.deepEqual(parse(servo).errors, []);
});
test('brush strokes follow layout pages / pens and leave decorations unshaped', () => {
  const format = { runs: [{ from: 0, to: 2, underline: true, pen: 2 }], paras: [] };
  const strokes = textStrokes(layoutText('AB', { ...options, format }), Brush.PENS.fountain);
  const underline = strokes.at(-1);
  assert(!underline.p && underline.points.length === 2 && underline.pen === 2);
  assert(strokes.slice(0, -1).every((stroke) => stroke.p && stroke.f && stroke.pen === 2));
});

test('Z direction comes from pen-up vs pen-down: pressing always continues away from the pen-up height', () => {
  const brush = Brush.PENS.felt;
  // +Z towards the paper: pen up at Z0, contact at Z5 → pressing goes to Z > 5.
  const down = generate('HI', { ...options, penUp: 0, penDown: 5, brush });
  const result = parse(down, 5, { mode: 'z', up: 0, down: 5 });
  assert.deepEqual(result.errors, []);
  assert(result.bounds.maxZ > 5 && result.bounds.maxZ <= 5 + brush.depth + 1e-9 && result.bounds.minZ >= 0);
  assert(result.segments.some((segment) => segment.drawing));
  assert(result.segments.filter((segment) => segment.drawing).every((segment) => segment.to.z >= 5 - 1e-6), 'writing stays at or beyond contact');
  // Same text, +Z away from the paper: mirror image of the Z values around the contact height.
  const up = parse(generate('HI', { ...options, penUp: 5, penDown: 0, brush }), 0, { mode: 'z', up: 5, down: 0 });
  assert.equal(up.segments.filter((segment) => segment.drawing).length, result.segments.filter((segment) => segment.drawing).length);
  assert(Math.abs((5 - result.bounds.maxZ) - up.bounds.minZ) < 1e-9);
  assert.throws(() => generate('HI', { ...options, penUp: 1, penDown: 1.1 }), /至少相差/);
});
