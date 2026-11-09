'use strict';
// Editor helpers independent of storage: find / replace, keyboard shortcuts, resizable panels.
(() => {
  // Find/replace uses the actual active textarea and its selection, never a mock editor.
  let matches = [], matchIndex = -1;
  let currentView = 'editor';
  window.addEventListener('workspace-view', (event) => {
    currentView = event.detail;
    if (!['editor', 'gcode'].includes(currentView)) $('#find-bar').hidden = true;
    else if (!$('#find-bar').hidden) collectMatches();
  });
  const findEditor = () => currentView === 'gcode' ? codeEditor : content;
  const locked = () => !window.Workspace?.activeId || window.Workspace.blocked || hardwareJob || controllerBusy();
  function collectMatches() {
    const editor = findEditor(), query = $('#find-query').value;
    const caseSensitive = $('#find-case').checked;
    matches = [];
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matches = [...editor.value.matchAll(new RegExp(escaped, caseSensitive ? 'g' : 'gi'))].map(match => match.index);
    }
    matchIndex = matches.findIndex(start => start >= editor.selectionStart);
    if (matchIndex < 0 && matches.length) matchIndex = 0;
    $('#find-result').textContent = `${matches.length} 处`;
    return editor;
  }
  function selectMatch(direction = 0) {
    const editor = findEditor();
    if (!matches.length) { $('#find-result').textContent = '0 处'; return; }
    matchIndex = (Math.max(0, matchIndex) + direction + matches.length) % matches.length;
    const start = matches[matchIndex];
    editor.setSelectionRange(start, start + $('#find-query').value.length);
    scrollToLine(editor, editor.value.slice(0,start).split('\n').length, editor === content ? $('#line-numbers') : $('#gcode-lines'));
    $('#find-result').textContent = `${matchIndex + 1} / ${matches.length}`; updateCursor();
  }
  function openFind() {
    if (!window.Workspace?.activeId) return;
    if (!['editor','gcode'].includes(currentView)) selectView('editor');
    $('#find-bar').hidden = false; collectMatches(); $('#find-query').focus(); $('#find-query').select();
  }
  $('#find-query').addEventListener('input', () => { collectMatches(); selectMatch(); });
  $('#find-case').addEventListener('change', () => { collectMatches(); selectMatch(); });
  $('#find-next').addEventListener('click', () => selectMatch(1));
  $('#find-prev').addEventListener('click', () => selectMatch(-1));
  $('#find-close').addEventListener('click', () => { $('#find-bar').hidden = true; findEditor().focus(); });
  $('#replace-one').addEventListener('click', () => {
    if (locked()) return;
    const editor = findEditor();
    if (!matches.length) return;
    selectMatch(); editor.setRangeText($('#replace-query').value, editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input', { bubbles:true })); collectMatches(); selectMatch();
  });
  $('#replace-all').addEventListener('click', () => {
    if (locked()) return;
    const editor = collectMatches();
    if (!matches.length) return;
    const replacement = $('#replace-query').value, length = $('#find-query').value.length;
    for (const start of [...matches].reverse()) editor.setRangeText(replacement, start, start + length, 'end');
    editor.dispatchEvent(new Event('input', { bubbles:true })); collectMatches();
  });
  [content,codeEditor].forEach(editor => editor.addEventListener('input', () => { if (!$('#find-bar').hidden) collectMatches(); }));
  document.addEventListener('keydown', event => {
    if (event.target.closest('dialog')) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); window.Workspace?.save(); }
    if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); }
    if (event.key === 'F3') { event.preventDefault(); if ($('#find-bar').hidden) openFind(); else selectMatch(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape' && !$('#find-bar').hidden) { event.preventDefault(); $('#find-close').click(); }
    if (event.key === 'Enter' && event.target === $('#find-query')) { event.preventDefault(); selectMatch(event.shiftKey ? -1 : 1); }
  });

  // Real resizing, with keyboard access and persistent dimensions.
  function resizer(id, property, min, max, horizontal) {
    const handle = $(`#${id}`);
    const clamp = value => Math.max(min, Math.min(max, value));
    const set = value => { const n = clamp(value); document.documentElement.style.setProperty(property, `${n}px`); handle.setAttribute('aria-valuenow', String(n)); try { localStorage.setItem(property,String(n)); } catch { /* Optional UI preference. */ } };
    handle.setAttribute('aria-valuemin',String(min)); handle.setAttribute('aria-valuemax',String(max));
    handle.setAttribute('aria-valuenow',String(horizontal ? $('#sidebar').getBoundingClientRect().width || 263 : $('#log').getBoundingClientRect().height || 110));
    try { const saved = localStorage.getItem(property); if (saved !== null && Number.isFinite(+saved)) set(+saved); } catch { /* Default CSS size. */ }
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const start = horizontal ? event.clientX : event.clientY;
      const size = horizontal ? $('#sidebar').getBoundingClientRect().width : $('#log').getBoundingClientRect().height;
      handle.setPointerCapture(event.pointerId);
      const move = pointer => set(size + (horizontal ? pointer.clientX - start : start - pointer.clientY));
      const end = () => { handle.removeEventListener('pointermove',move); handle.removeEventListener('pointerup',end); handle.removeEventListener('pointercancel',end); };
      handle.addEventListener('pointermove',move); handle.addEventListener('pointerup',end); handle.addEventListener('pointercancel',end);
      event.preventDefault();
    });
    handle.addEventListener('keydown', event => {
      const step = horizontal ? ({ArrowLeft:-10,ArrowRight:10})[event.key] : ({ArrowUp:10,ArrowDown:-10})[event.key];
      if (step) { event.preventDefault(); const size = horizontal ? $('#sidebar').getBoundingClientRect().width : $('#log').getBoundingClientRect().height; set(size+step); }
    });
  }
  resizer('sidebar-resizer','--sidebar-width',210,480,true);
  resizer('log-resizer','--log-height',50,350,false);
})();
