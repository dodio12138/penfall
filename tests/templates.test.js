'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Templates = require('../web/js/templates.js');
const { layoutText, backgroundPaths } = require('../web/js/path-engine.js');

test('built-in templates are valid and their grids fit an A4 writing area', () => {
  for (const template of Templates.BUILTIN) {
    const clean = Templates.normalizeTemplate(template);
    assert.equal(clean.name, template.name);
    const s = { margin: 20, 'font-size': 5, ...template.settings };
    const options = { width: s.paper === 'a5' ? 148 : 210, height: s.paper === 'a5' ? 210 : 297, margin: +s.margin, size: +s['font-size'], gap: 1, lineGap: 3 };
    if (s['bg-kind'] && s['bg-kind'] !== 'none') assert(backgroundPaths({ kind: s['bg-kind'], cell: +s['bg-cell'], gap: +(s['bg-gap'] || 0) }, options, 1).length > 0, template.name);
    if (['grid', 'tianzige', 'mizige', 'composition'].includes(s['bg-kind'])) assert(+s['font-size'] < +s['bg-cell'], `${template.name}: text must fit the cell`);
  }
});

test('normalization keeps only layout keys and rejects other formats', () => {
  const clean = Templates.normalizeTemplate({ format: Templates.FORMAT, version: 1, name: ' 我的 ', settings: { 'bg-kind': 'grid', feed: '9999', 'font-size': 7 }, text: 'X' });
  assert.deepEqual(clean.settings, { 'bg-kind': 'grid' });
  assert.equal(clean.name, '我的');
  assert.throws(() => Templates.normalizeTemplate({ format: 'x' }), /模板文件/);
  const own = Templates.fromDraft('信', { paper: 'a4', 'bg-kind': 'lines', 'bg-cell': '9', feed: '100' }, '你好');
  assert.deepEqual(Object.keys(own.settings).sort(), ['bg-cell', 'bg-kind', 'paper']);
  assert.equal(JSON.parse(Templates.serialize(own)).text, '你好');
});
