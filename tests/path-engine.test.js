'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { generate, parse, layoutText } = require('../web/js/path-engine.js');
const options = { width:210,height:297,margin:20,size:5,gap:1,lineGap:3,feed:1200,penUp:5,penDown:0 };
test('single-line text generates finite, bounded XY paths and raised final pen', () => {
  const result=parse(generate('Hello 123!',options));
  assert.deepEqual(result.errors,[]);
  assert(result.segments.some(s=>s.drawing));
  assert(result.bounds.minX>=0 && result.bounds.maxX<=210);
  assert(result.bounds.minY>=0 && result.bounds.maxY<=297);
  assert.equal(result.segments.at(-1).to.z,5);
});
test('unsupported Chinese is rejected instead of rendered as fake strokes', () => assert.throws(()=>generate('你好',options),/字库暂不支持/));
test('overflow and invalid pen profiles rejected', () => {
  assert.throws(()=>generate('A'.repeat(200000),options),/页上限/);
  assert.throws(()=>generate('A',{...options,penUp:0}),/参数无效/);
});
test('square includes travel, writing, source lines and Z bounds', () => {
  const result=parse(fs.readFileSync(require('node:path').join(__dirname,'../web/demo.gcode'),'utf8'));
  assert.deepEqual(result.errors,[]);
  assert.equal(result.bounds.maxX,40);
  assert.equal(result.bounds.maxZ,5);
  assert.equal(result.segments.filter(s=>s.drawing&&s.from.z===0&&s.to.z===0).length,4);
  assert(result.segments.every(s=>s.line>0));
});
test('relative and inch coordinates supported', () => {
  const result=parse('G20\nG91\nG1 X1 Y1 F10\nX1');
  assert.deepEqual(result.errors,[]);
  assert.equal(result.segments.at(-1).to.x,50.8);
  assert.equal(result.segments.at(-1).to.y,25.4);
});
test('IJ arcs interpolated and bad radii blocked', () => {
  const result=parse('G21\nG90\nG0 X10 Y0\nG3 X0 Y10 I-10 J0 F100');
  assert.deepEqual(result.errors,[]);
  assert(result.segments.length>10);
  assert.deepEqual(result.segments.at(-1).to,{x:0,y:10,z:0});
  assert(parse('G0 X10\nG3 X0 Y20 I-10 J0').errors.length);
});
test('unknown commands, coordinate transforms and invalid feeds block execution', () => {
  for(const code of ['G28','G92 X0','G2 X10 R5','M280 P0 S90','G1 F0 X1','G1 X1 X2','G1 X1 garbage','%']) assert(parse(code).errors.length,code);
});

test('pen origin and axis directions shift / flip generated coordinates', () => {
  const base=parse(generate('HI',options));
  // Pen zero 10 mm right of / 8 mm below the paper top-left corner, +Y pointing down the page.
  const shifted=parse(generate('HI',{...options,origin:{x:10,y:297-8,dirX:1,dirY:-1}}));
  assert.deepEqual(shifted.errors,[]);
  const firstDraw=result=>result.segments.find(s=>s.drawing).from;
  const a=firstDraw(base),b=firstDraw(shifted);
  assert.ok(Math.abs(b.x-(a.x-10))<1e-6);
  assert.ok(Math.abs(b.y-(-(a.y-(297-8))))<1e-6);
  assert(shifted.bounds.minY>=0 && shifted.bounds.minX>=-10);
  assert.throws(()=>generate('A',{...options,origin:{x:0,y:0,dirX:2,dirY:1}}),/笔起点/);
});

test('binding gutter mirrors on odd / even pages; zero gutter changes nothing', () => {
  const text='HELLO WORLD\n'.repeat(80);
  const plain=layoutText(text,options), bound=layoutText(text,{...options,gutter:10});
  const first=(result,page)=>result.placements.find(item=>item.page===page).x;
  assert.equal(first(bound,1),first(plain,1)+10);
  assert.equal(first(bound,2),first(plain,2));
  assert.deepEqual(layoutText(text,{...options,gutter:0}),plain);
});
test('long text flows onto further pages; each page is generated separately', () => {
  const text='HELLO WORLD\n'.repeat(80);
  const layout=layoutText(text,options);
  assert(layout.pages>=2);
  assert.equal(layout.placements.at(-1).page,layout.pages);
  const first=parse(generate(text,{...options,page:1})), second=parse(generate(text,{...options,page:2}));
  assert.deepEqual(second.errors,[]);
  assert.match(generate(text,{...options,page:2}),/; Page 2 of /);
  // Page 2 restarts at the top margin, so both pages occupy the same area of their sheet.
  assert.equal(first.bounds.maxY,second.bounds.maxY);
  assert.throws(()=>generate(text,{...options,page:layout.pages+1}),/页码无效/);
});
