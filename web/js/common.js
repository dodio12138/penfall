'use strict';
// Shared helpers for the classic (non-module) scripts. Loaded first; everything here is global.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const MAX_LOG_LINES = 150;

/** File-system safe name; keeps CJK, strips path separators and control characters. */
function safeFilename(name, fallback = '无题') {
  return (String(name || '').trim() || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
}

/** Download text through a temporary object URL (no server round trip). */
function downloadText(text, filename, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Render a line-number gutter for a textarea and keep it scrolled in sync. */
function renderLineNumbers(gutter, editor) {
  let lines = 1;
  for (let index = editor.value.indexOf('\n'); index !== -1; index = editor.value.indexOf('\n', index + 1)) lines++;
  if (gutter.dataset.lines !== String(lines)) {
    gutter.dataset.lines = String(lines);
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  }
  gutter.scrollTop = editor.scrollTop;
}

/** Scroll a textarea so that the given 1-based line is near the top, using the real CSS line height. */
function scrollToLine(editor, line, gutter) {
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 26;
  editor.scrollTop = Math.max(0, (line - 4) * lineHeight);
  if (gutter) gutter.scrollTop = editor.scrollTop;
}

function log(message) {
  const panel = $('#log');
  const row = document.createElement('div');
  row.className = 'log-entry';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  row.append(time, document.createTextNode(message));
  panel.append(row);
  while (panel.childElementCount > MAX_LOG_LINES) panel.firstElementChild.remove();
  panel.scrollTop = panel.scrollHeight;
}
