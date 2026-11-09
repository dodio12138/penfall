'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Links = require('../web/js/links.js');

test('paths follow the server rules', () => {
  for (const ok of ['a.txt', '信件/给妈妈.wtl', 'a b/c (2).gcode']) assert(Links.validPath(ok), ok);
  for (const bad of ['', '/a.txt', '../a.txt', 'a/../b.txt', '.x.txt', 'a\\b.txt', 'a.py', 'a/b/c/d/e/f/g/h/i.txt']) assert(!Links.validPath(bad), bad);
  assert.equal(Links.stem('a/b.c.wtl'), 'b.c');
  assert.equal(Links.uniqueStem(new Set(['x.wtl', 'x (2).txt']), '', 'x', ['.wtl', '.txt']), 'x (3)');
});

test('tree nests a draft\'s text and program under its link, folders first', () => {
  const tree = Links.buildTree([
    { path: '信件', type: 'dir' }, { path: '信件/给妈妈.wtl', type: 'file' }, { path: '信件/给妈妈.txt', type: 'file' }, { path: '信件/给妈妈.gcode', type: 'file' },
    { path: '信件/附言.txt', type: 'file' }, { path: 'workspace.wtw', type: 'file' }, { path: '导入.nc', type: 'file' },
  ]);
  assert.deepEqual(tree.children.map((node) => [node.type, node.name]), [['dir', '信件'], ['file', '导入.nc'], ['file', 'workspace.wtw']]);
  const draft = tree.children[0].children.find((node) => node.type === 'link');
  assert.deepEqual([draft.name, draft.text, draft.gcode], ['给妈妈', '信件/给妈妈.txt', '信件/给妈妈.gcode']);
  assert.deepEqual(tree.children[0].children.map((node) => node.name), ['附言.txt', '给妈妈']);
  const existing = new Set(['信件/给妈妈.wtl']);
  assert.deepEqual(Links.documentFor('信件/给妈妈.gcode', existing), { kind: 'link', key: '信件/给妈妈.wtl', view: 'gcode' });
  assert.deepEqual(Links.documentFor('信件/附言.txt', existing), { kind: 'text', key: '信件/附言.txt', view: 'editor' });
  assert.equal(Links.documentFor('workspace.wtw', existing), null);
});

test('梳串: sync analysis distinguishes regenerate, stale and external program edits', () => {
  const link = Links.normalizeLink({ settings: { 'font-size': '5' } }, '稿.wtl');
  assert.equal(Links.analyzeSync(link, 'HI', '').state, 'empty');
  assert.equal(Links.analyzeSync(link, 'HI', 'G0 X1').state, 'new');
  Links.markSynced(link, 'HI', 'G0 X1', 'generated');
  assert.equal(Links.analyzeSync(link, 'HI', 'G0 X1').state, 'synced');
  assert.equal(Links.analyzeSync(link, 'HELLO', 'G0 X1').state, 'regenerate');
  link.settings['font-size'] = '6';
  assert.equal(Links.analyzeSync(link, 'HI', 'G0 X1').state, 'regenerate');
  link.settings['font-size'] = '5';
  assert.deepEqual(Links.analyzeSync(link, 'HI', 'G0 X2'), { state: 'external', source: 'manual' });
  Links.markSynced(link, 'HI', 'G0 X2', 'manual');
  assert.equal(Links.analyzeSync(link, 'HELLO', 'G0 X2').state, 'stale');
});

test('link and manifest normalization', () => {
  const link = Links.normalizeLink({ text: '../evil.txt', gcode: 'x.py', view: 'nope', motion: { feed: '900', bad: 3 } }, 'a/稿.wtl');
  assert.deepEqual([link.text, link.gcode, link.view, link.motion], ['稿.txt', '稿.gcode', 'editor', { feed: '900' }]);
  assert.throws(() => Links.normalizeLink({ format: 'other' }), /稿件链接/);
  assert.equal(Links.normalizeManifest({ machine: { penWidth: 0.8 } }).machine.penWidth, 0.8);
  assert.equal(Links.normalizeManifest({ machine: { penWidth: 99 } }).machine.penWidth, 0.5);
  assert.throws(() => Links.normalizeArchive({ format: 'x' }), /工作区备份/);
  assert.deepEqual(Links.normalizeArchive({ format: Links.ARCHIVE_FORMAT, version: 1, files: [{ path: 'a.txt', content: 'x' }, { path: '../b.txt', content: 'y' }] }).files.map((f) => f.path), ['a.txt']);
});

test('formatting follows the text through edits', () => {
  const format = Links.normalizeFormat({ runs: [{ from: 2, to: 4, size: 8 }, { from: 0, to: 1, size: 0 }], paras: [{ at: 0, align: 'center' }, { at: 5, indent: 7 }, { at: 3 }] });
  assert.deepEqual(format, { runs: [{ from: 2, to: 4, size: 8 }], paras: [{ at: 0, align: 'center' }, { at: 5, indent: 7 }] });
  const before = 'ABCD\nEFG';
  // Typing at the end of a run continues it (word-processor behaviour); text before shifts everything.
  assert.deepEqual(Links.shiftFormat(format, before, 'ABCDx\nEFG').runs, [{ from: 2, to: 5, size: 8 }]);
  assert.deepEqual(Links.shiftFormat(format, before, '12ABCD\nEFG'), { runs: [{ from: 4, to: 6, size: 8 }], paras: [{ at: 0, align: 'center' }, { at: 7, indent: 7 }] });
  // Deleting the formatted text removes the run; merging paragraphs drops the second paragraph's attributes.
  assert.deepEqual(Links.shiftFormat(format, before, 'AB\nEFG').runs, []);
  assert.deepEqual(Links.shiftFormat(format, before, 'ABCDEFG').paras, [{ at: 0, align: 'center' }]);
  const link = Links.normalizeLink({ style: format }, 'a.wtl');
  Links.markSynced(link, before, 'G0', 'generated');
  link.style = Links.shiftFormat(link.style, before, 'ABCDx\nEFG');
  assert.equal(Links.analyzeSync(link, before, 'G0').state, 'regenerate'); // formatting is a generator input
});
