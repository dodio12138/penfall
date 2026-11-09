/* Templates (.wtt): page format + ruling + starter text for new drafts. Pure logic, shared with Node tests. */
(function (root) {
  'use strict';
  const FORMAT = 'web-typewriter/template';
  // Layout keys a template may set (same names as the draft's settings).
  const KEYS = ['paper', 'orientation', 'font', 'font-size', 'line-gap', 'letter-gap', 'margin', 'gutter', 'bg-kind', 'bg-cell', 'bg-gap', 'bg-write', 'bg-pen'];
  const BUILTIN = [
    { id: 'blank', name: '空白 A4', description: '无背景，自由排版', settings: { paper: 'a4', 'bg-kind': 'none' } },
    { id: 'letter', name: '横线信纸', description: 'A4，行距 9 mm，每行字落在横线上', settings: { paper: 'a4', 'font-size': '5', 'bg-kind': 'lines', 'bg-cell': '9', margin: '20' }, text: '亲爱的：\n\n    \n\n此致\n敬礼\n' },
    { id: 'memo', name: 'A5 便笺', description: 'A5，行距 8 mm 横线', settings: { paper: 'a5', 'font-size': '4.5', 'bg-kind': 'lines', 'bg-cell': '8', margin: '15' } },
    { id: 'english', name: '英文四线三格', description: '英文书写练习，四线三格，大写字母占上两格', settings: { paper: 'a4', 'font-size': '6', 'bg-kind': 'four-line', 'bg-cell': '13', margin: '20' }, text: 'Hello World\nThe quick brown fox\n' },
    { id: 'grid', name: '方格纸', description: '10 mm 方格，一字一格', settings: { paper: 'a4', 'font-size': '7', 'bg-kind': 'grid', 'bg-cell': '10', margin: '20' } },
    { id: 'tianzige', name: '田字格练字', description: '15 mm 田字格，一字一格居中', settings: { paper: 'a4', 'font-size': '11', 'bg-kind': 'tianzige', 'bg-cell': '15', margin: '22.5' }, text: '永和九年岁在癸丑' },
    { id: 'mizige', name: '米字格练字', description: '18 mm 米字格', settings: { paper: 'a4', 'font-size': '13', 'bg-kind': 'mizige', 'bg-cell': '18', margin: '24' } },
    { id: 'composition', name: '作文稿纸', description: '8 mm 方格，行间留 3 mm，一字一格', settings: { paper: 'a4', 'font-size': '6', 'bg-kind': 'composition', 'bg-cell': '8', 'bg-gap': '3', margin: '20' } },
  ].map((template) => ({ format: FORMAT, version: 1, text: '', ...template, builtin: true }));

  function normalizeTemplate(raw, fallbackName = '模板') {
    if (!raw || raw.format !== FORMAT || raw.version !== 1) throw Error('不是模板文件（format 应为 web-typewriter/template）');
    const settings = {};
    for (const key of KEYS) if (typeof raw.settings?.[key] === 'string' && raw.settings[key].length <= 20) settings[key] = raw.settings[key];
    return {
      format: FORMAT, version: 1,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : fallbackName,
      description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : '',
      settings,
      text: typeof raw.text === 'string' ? raw.text.slice(0, 100000) : '',
    };
  }
  /** Template from a draft's current layout settings (and optionally its text). */
  function fromDraft(name, settings, text = '') {
    return normalizeTemplate({ format: FORMAT, version: 1, name, description: '', settings: Object.fromEntries(KEYS.filter((key) => key in settings).map((key) => [key, String(settings[key])])), text }, name);
  }
  const serialize = (template) => JSON.stringify({ format: FORMAT, version: 1, name: template.name, description: template.description, settings: template.settings, text: template.text }, null, 2) + '\n';

  const api = { FORMAT, KEYS, BUILTIN, normalizeTemplate, fromDraft, serialize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Templates = api;
})(typeof window !== 'undefined' ? window : globalThis);
