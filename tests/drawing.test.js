'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Drawing = require('../web/js/drawing.js');
const dxf = (entities, units = 4) => ['0','SECTION','2','HEADER','9','$INSUNITS','70',String(units),'0','ENDSEC','0','SECTION','2','TABLES','0','LAYER','2','RED','62','1','0','ENDSEC','0','SECTION','2','ENTITIES',...entities,'0','ENDSEC','0','EOF'].join('\n');

test('DXF lines, circles and layer colours become mm paths with y flipped to top-down', () => {
  const drawing = Drawing.parseDxf(dxf(['0','LINE','8','RED','10','0','20','0','11','100','21','50','0','CIRCLE','8','0','62','5','10','50','20','25','40','10']));
  assert.equal(drawing.width, 100); assert.equal(drawing.height, 50);
  const line = drawing.paths[0];
  assert.equal(line.color, '#ff0000');
  assert.deepEqual(line.points, [[0, 50], [100, 0]]); // (0,0) is the bottom-left in CAD → bottom on paper
  assert.equal(drawing.paths[1].color, '#0000ff');
  const xs = drawing.paths[1].points.map((p) => p[0]);
  assert(Math.abs(Math.min(...xs) - 40) < .05 && Math.abs(Math.max(...xs) - 60) < .05);
});

test('DXF inch units, closed LWPOLYLINE with bulge arcs', () => {
  const drawing = Drawing.parseDxf(dxf(['0','LWPOLYLINE','8','0','70','1','10','0','20','0','42','1','10','1','20','0'], 1));
  // Two half circles (bulge 1) of diameter 1 inch = 25.4 mm.
  assert(Math.abs(drawing.width - 25.4) < .05);
  const [first, last] = [drawing.paths[0].points[0], drawing.paths[0].points.at(-1)];
  assert(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6);
});

test('rejects binary / empty DXF', () => {
  assert.throws(() => Drawing.parseDxf('AutoCAD Binary DXF'), /ASCII DXF/);
  assert.throws(() => Drawing.parseDxf(dxf([])), /没有可绘制/);
});

test('simplify keeps shape, nearest pen maps colours, placement scales into the page', () => {
  const line = Array.from({ length: 101 }, (_, i) => [i, 0]);
  assert.deepEqual(Drawing.simplify(line, .01), [[0, 0], [100, 0]]);
  const square = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  assert.deepEqual(Drawing.simplify(square, .01), [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]); // closed shapes survive
  const pens = [{ color: '#1f2328' }, { color: '#d0342c' }, { color: '#2563eb' }];
  assert.equal(Drawing.nearestPen('#ff0000', pens), 1);
  assert.equal(Drawing.nearestPen('rgb(0, 0, 200)', pens), 2);
  assert.equal(Drawing.nearestPen('#ffffff', pens), 0);
  const drawing = { width: 400, height: 100, paths: [{ color: '#ff0000', points: [[0, 0], [400, 100]] }] };
  const placement = Drawing.defaultPlacement(drawing, { width: 210, height: 297, margin: 20 });
  assert.deepEqual(placement, { page: 1, x: 20, y: 20, width: 170 });
  assert.deepEqual(Drawing.placePaths(drawing, placement, pens)[0], { page: 1, pen: 2, color: '#ff0000', points: [[20, 20], [190, 62.5]] });
});
