'use strict';
// Word-like editing directly on the paper. The real editor stays the #content textarea (typing, IME, undo,
// clipboard, find/replace); on the 纸张 view it is moved onto the sheet, kept at the caret (so the IME window
// appears there) and the caret / selection are drawn from the layout's caret positions.
(() => {
  const sheet = $('#paper-sheet'), canvas = $('#preview'), overlay = $('#preview-overlay'), caret = $('#paper-caret');
  const home = $('#editor-view');
  let view = 'editor', preferredX = null, dragging = false;
  const paperMode = () => view === 'preview' && content.parentElement === sheet;
  // The textarea counts UTF-16 units, the layout counts code points: convert (identity without surrogates).
  const wide = () => /[\uD800-\uDFFF]/.test(content.value);
  const toCp = (offset) => wide() ? Array.from(content.value.slice(0, offset)).length : offset;
  const toU16 = (index) => wide() ? Array.from(content.value).slice(0, index).join('').length : index;
  const scale = () => previewScale || 1;

  // ---------- moving the editor between the text view and the paper ----------
  function relocate() {
    const doc = window.Workspace?.activeId;
    const toPaper = view === 'preview' && Boolean(doc);
    const { selectionStart, selectionEnd, selectionDirection } = content;
    if (toPaper && content.parentElement !== sheet) sheet.append(content);
    if (!toPaper && content.parentElement !== home) home.append(content);
    content.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    caret.hidden = !toPaper;
    if (!toPaper) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  }
  window.addEventListener('workspace-view', (event) => {
    view = event.detail;
    relocate();
    $('.main-area').dataset.view = view;
    if (view === 'preview') requestAnimationFrame(() => update());
  });

  // ---------- caret, selection, hit testing ----------
  const active = () => toCp(content.selectionDirection === 'backward' ? content.selectionStart : content.selectionEnd);
  const caretAt = (index) => layout.carets?.[Math.max(0, Math.min(index, layout.carets.length - 1))];
  const rowKey = (c) => `${c.page}:${c.y.toFixed(3)}`;
  function hitIndex(mx, my) {
    const page = currentPage();
    let best = 0, bestScore = Infinity;
    (layout.carets || []).forEach((c, index) => {
      if (c.page !== page) return;
      const dy = my < c.y ? c.y - my : my > c.y + c.height ? my - c.y - c.height : 0;
      const score = dy * 1000 + Math.abs(mx - c.x);
      if (score < bestScore) { bestScore = score; best = index; }
    });
    return best;
  }
  function rowsOf() {
    const rows = new Map();
    (layout.carets || []).forEach((c, index) => { const key = rowKey(c); if (!rows.has(key)) rows.set(key, { page: c.page, y: c.y, indices: [] }); rows.get(key).indices.push(index); });
    return [...rows.values()].sort((a, b) => a.page - b.page || a.y - b.y);
  }
  function verticalTarget(index, direction) {
    const current = caretAt(index), rows = rowsOf();
    const at = rows.findIndex((row) => row.page === current.page && Math.abs(row.y - current.y) < 1e-6);
    const target = rows[at + direction];
    if (!target) return direction < 0 ? 0 : layout.carets.length - 1;
    const x = preferredX ?? current.x;
    return target.indices.reduce((best, i) => Math.abs(caretAt(i).x - x) < Math.abs(caretAt(best).x - x) ? i : best, target.indices[0]);
  }
  function rowEdge(index, end) {
    const current = caretAt(index);
    const row = rowsOf().find((item) => item.page === current.page && Math.abs(item.y - current.y) < 1e-6);
    return row ? (end ? Math.max(...row.indices) : Math.min(...row.indices)) : index;
  }
  function select(targetCp, extend) {
    const target = toU16(targetCp);
    const anchor = content.selectionDirection === 'backward' ? content.selectionEnd : content.selectionStart;
    if (!extend) content.setSelectionRange(target, target);
    else if (target < anchor) content.setSelectionRange(target, anchor, 'backward');
    else content.setSelectionRange(anchor, target, 'forward');
    update({ follow: true });
  }
  /** Redraw caret / selection; with follow, flip to the caret's page (typing onto the next sheet). */
  function update({ follow = false } = {}) {
    if (!paperMode() || !layout.carets) return;
    const k = scale(), c = caretAt(active());
    if (follow && c && c.page !== currentPage()) { setPage(c.page); return; }
    overlay.width = canvas.width; overlay.height = canvas.height;
    overlay.style.width = canvas.style.width; overlay.style.height = canvas.style.height;
    const ctx = overlay.getContext('2d');
    ctx.setTransform(canvas.width / layout.width, 0, 0, canvas.height / layout.height, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
    const [start, end] = [toCp(content.selectionStart), toCp(content.selectionEnd)];
    if (end > start) {
      ctx.fillStyle = '#459bf233';
      for (let i = start; i < end; i++) {
        const a = caretAt(i), b = caretAt(i + 1);
        if (a.page !== currentPage()) continue;
        const sameRow = b && b.page === a.page && Math.abs(b.y - a.y) < 1e-6 && b.x > a.x;
        ctx.fillRect(a.x, a.y, sameRow ? b.x - a.x : Math.max(.8, layout.size * .4), a.height);
      }
    }
    const visible = c && c.page === currentPage();
    caret.hidden = !visible;
    if (visible) Object.assign(caret.style, { left: `${c.x * k - 1}px`, top: `${c.y * k}px`, height: `${Math.max(8, c.height * k)}px` });
    // Keep the (invisible) input at the caret: the IME candidate window follows it.
    if (c) Object.assign(content.style, { left: `${c.x * k}px`, top: `${(c.y + c.height * .8) * k}px` });
    if (visible && follow) caret.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    syncFormatBar();
  }
  window.afterPreviewRender = () => update();

  const local = (event) => { const rect = canvas.getBoundingClientRect(); return [(event.clientX - rect.left) / rect.width * layout.width, (event.clientY - rect.top) / rect.height * layout.height]; };
  const formulaAt = ([x, y]) => (layout.placements || []).find((item) => item.kind === 'formula' && item.page === currentPage() && x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height);
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !window.Workspace?.activeId || content.disabled) return;
    event.preventDefault();
    const point = local(event);
    const formula = formulaAt(point);
    if (formula && !event.shiftKey) { content.focus({ preventScroll: true }); content.setSelectionRange(toU16(formula.index), toU16(formula.index)); openFormula(formula); return; }
    preferredX = null;
    content.focus({ preventScroll: true });
    select(hitIndex(...point), event.shiftKey);
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => { if (dragging) select(hitIndex(...local(event)), true); });
  canvas.addEventListener('pointerup', () => { dragging = false; content.focus({ preventScroll: true }); });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  content.addEventListener('keydown', (event) => {
    if (!paperMode() || event.isComposing) return;
    const index = active();
    const moves = {
      ArrowUp: () => verticalTarget(index, -1), ArrowDown: () => verticalTarget(index, 1),
      Home: () => (event.ctrlKey || event.metaKey ? 0 : rowEdge(index, false)), End: () => (event.ctrlKey || event.metaKey ? layout.carets.length - 1 : rowEdge(index, true)),
      PageUp: () => { const first = layout.carets.findIndex((c) => c.page === Math.max(1, caretAt(index).page - 1)); return first < 0 ? 0 : first; },
      PageDown: () => { const first = layout.carets.findIndex((c) => c.page === caretAt(index).page + 1); return first < 0 ? layout.carets.length - 1 : first; },
    };
    if (!moves[event.key]) { if (!['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) preferredX = null; return; }
    event.preventDefault();
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) preferredX ??= caretAt(index).x; else preferredX = null;
    select(moves[event.key](), event.shiftKey);
  });
  for (const type of ['keyup', 'input', 'select', 'focus', 'blur']) content.addEventListener(type, () => update({ follow: type !== 'blur' && type !== 'focus' }));
  document.addEventListener('selectionchange', () => { if (document.activeElement === content) update(); });

  // ---------- formatting toolbar ----------
  const selectionRange = () => {
    const [start, end] = [toCp(content.selectionStart), toCp(content.selectionEnd)];
    if (end > start) return [start, end];
    // Nothing selected: the caret's whole paragraph.
    const chars = Array.from(content.value);
    let from = start, to = start;
    while (from > 0 && chars[from - 1] !== '\n') from--;
    while (to < chars.length && chars[to] !== '\n') to++;
    return [from, to];
  };
  function styleChanged() {
    layout = makeLayout(); renderPreview(); resetSimulation(); markStale(); scheduleRegenerate(); updateTask();
    window.Workspace?.capture();
    // Like a word processor: after a toolbar action, keep typing in the document.
    if (['editor', 'preview'].includes(view) && !content.disabled) content.focus({ preventScroll: true });
    update();
  }
  const locked = () => !window.Workspace?.activeId || window.Workspace.blocked || hardwareJob || controllerBusy() || content.disabled;
  function setRun(attrs) {
    if (locked()) return;
    const [from, to] = selectionRange();
    if (to <= from) return;
    textStyle = Links.applyRun(textStyle, from, to, attrs);
    styleChanged();
  }
  function setParagraph(attrs) {
    if (locked()) return;
    textStyle = Links.applyParagraph(textStyle, Links.paragraphStarts(content.value, toCp(content.selectionStart), toCp(content.selectionEnd)), attrs);
    styleChanged();
  }
  const base = () => Number(config()['font-size']);
  const HEADINGS = { h1: [1.6, 'center'], h2: [1.3, null], h3: [1.15, null] };
  $('#run-size').addEventListener('change', (event) => setRun({ size: event.target.value ? Number(event.target.value) : null }));
  $('#run-pen').addEventListener('change', (event) => setRun({ pen: event.target.value ? Number(event.target.value) : null }));
  $('#para-style').addEventListener('change', (event) => {
    if (locked()) return;
    const starts = Links.paragraphStarts(content.value, toCp(content.selectionStart), toCp(content.selectionEnd));
    const chars = Array.from(content.value);
    const heading = HEADINGS[event.target.value];
    for (const start of starts) {
      let end = start;
      while (end < chars.length && chars[end] !== '\n') end++;
      if (end > start) textStyle = Links.applyRun(textStyle, start, end, { size: heading ? Math.round(base() * heading[0] * 10) / 10 : null });
    }
    textStyle = Links.applyParagraph(textStyle, starts, { align: heading?.[1] || null });
    styleChanged();
  });
  for (const align of ['left', 'center', 'right']) $(`#align-${align}`).addEventListener('click', () => setParagraph({ align }));
  $('#indent-first').addEventListener('click', () => setParagraph({ indent: $('#indent-first').getAttribute('aria-pressed') === 'true' ? null : Math.round(base() * 2 * 10) / 10 }));
  $('#clear-format').addEventListener('click', () => {
    if (locked()) return;
    const [from, to] = selectionRange();
    textStyle = Links.applyRun(textStyle, from, to, Object.fromEntries(Links.RUN_KEYS.map((key) => [key, null])));
    textStyle = Links.applyParagraph(textStyle, Links.paragraphStarts(content.value, from, to), Object.fromEntries(Links.PARA_KEYS.map((key) => [key, null])));
    styleChanged();
  });
  // Character effects toggle like a word processor: on unless the caret / selection start already has it.
  const runAt = (index) => textStyle.runs.find((item) => item.from <= index && index < item.to) || textStyle.runs.find((item) => item.to === index) || {};
  const pressed = (id) => $(`#${id}`).getAttribute('aria-pressed') === 'true';
  const toggleRun = (key, value, id) => setRun({ [key]: pressed(id) ? null : value });
  $('#run-underline').addEventListener('click', () => toggleRun('underline', true, 'run-underline'));
  $('#run-strike').addEventListener('click', () => toggleRun('strike', true, 'run-strike'));
  $('#run-sup').addEventListener('click', () => toggleRun('script', 'sup', 'run-sup'));
  $('#run-sub').addEventListener('click', () => toggleRun('script', 'sub', 'run-sub'));
  $('#list-bullet').addEventListener('click', () => setParagraph({ list: pressed('list-bullet') ? null : 'bullet' }));
  $('#list-number').addEventListener('click', () => setParagraph({ list: pressed('list-number') ? null : 'number' }));
  $('#para-spacing').addEventListener('change', (event) => setParagraph({ spacing: event.target.value ? Number(event.target.value) : null }));
  content.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || $('.main-area').classList.contains('no-format')) return;
    const key = event.key.toLowerCase();
    const action = key === 'u' && !event.shiftKey ? 'run-underline' : key === 'x' && event.shiftKey ? 'run-strike' : key === '.' ? 'run-sup' : key === ',' ? 'run-sub' : '';
    if (!action) return;
    event.preventDefault();
    $(`#${action}`).click();
  });

  // ---------- 格式刷: copy the formatting at the caret, apply it to the next selection ----------
  let painter = null;
  function setPainter(next) {
    painter = next;
    $('#format-painter').setAttribute('aria-pressed', String(Boolean(painter)));
    sheet.classList.toggle('painting', Boolean(painter));
  }
  $('#format-painter').addEventListener('click', () => {
    if (painter || locked()) { setPainter(null); return; }
    const index = toCp(content.selectionStart);
    const run = runAt(index), para = textStyle.paras.find((item) => item.at === Links.paragraphStarts(content.value, index, index)[0]) || {};
    setPainter({ run: Object.fromEntries(Links.RUN_KEYS.map((key) => [key, run[key] ?? null])), para: Object.fromEntries(Links.PARA_KEYS.map((key) => [key, para[key] ?? null])) });
    log('格式刷：选中要套用格式的文字（Esc 取消）。');
    if (!content.disabled) content.focus({ preventScroll: true });
  });
  function paint() {
    if (!painter || locked()) return;
    const [from, to] = [toCp(content.selectionStart), toCp(content.selectionEnd)];
    if (to <= from) return;
    const { run, para } = painter;
    setPainter(null);
    textStyle = Links.applyRun(textStyle, from, to, run);
    textStyle = Links.applyParagraph(textStyle, Links.paragraphStarts(content.value, from, to), para);
    styleChanged();
  }
  canvas.addEventListener('pointerup', () => setTimeout(paint));
  content.addEventListener('mouseup', () => setTimeout(paint));
  content.addEventListener('keyup', (event) => { if (event.shiftKey) paint(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && painter) setPainter(null); });
  /** Toolbar shows the formatting at the caret. */
  function syncFormatBar() {
    const index = toCp(content.selectionStart);
    const run = textStyle.runs.find((item) => item.from <= index && index < item.to) || textStyle.runs.find((item) => item.to === index);
    const para = textStyle.paras.find((item) => item.at === Links.paragraphStarts(content.value, index, index)[0]) || {};
    const setSelect = (id, value) => { const field = $(`#${id}`); if (field.value !== value && [...field.options].some((o) => o.value === value)) { field.value = value; field.dispatchEvent(new Event('input')); } };
    setSelect('run-size', run?.size ? String(run.size) : '');
    setSelect('run-pen', run?.pen ? String(run.pen) : '');
    const ratio = run?.size ? run.size / base() : 1;
    setSelect('para-style', Object.entries(HEADINGS).find(([, [k]]) => Math.abs(k - ratio) < .06)?.[0] || 'body');
    for (const align of ['left', 'center', 'right']) $(`#align-${align}`).setAttribute('aria-pressed', String((para.align || 'left') === align));
    $('#indent-first').setAttribute('aria-pressed', String(Boolean(para.indent)));
    $('#run-underline').setAttribute('aria-pressed', String(Boolean(run?.underline)));
    $('#run-strike').setAttribute('aria-pressed', String(Boolean(run?.strike)));
    $('#run-sup').setAttribute('aria-pressed', String(run?.script === 'sup'));
    $('#run-sub').setAttribute('aria-pressed', String(run?.script === 'sub'));
    $('#list-bullet').setAttribute('aria-pressed', String(para.list === 'bullet'));
    $('#list-number').setAttribute('aria-pressed', String(para.list === 'number'));
    setSelect('para-spacing', para.spacing ? String(para.spacing) : '');
  }
  window.syncFormatBar = syncFormatBar;
  content.addEventListener('click', syncFormatBar);
  content.addEventListener('keyup', syncFormatBar);

  // ---------- formula dialog ----------
  let editing = null; // placement being edited, or null when inserting
  function renderFormulaPreview() {
    const source = $('#formula-source').value;
    const box = MathLayout.layout(source, 10, mathGlyphFor());
    const preview = $('#formula-preview'), k = 6, ratio = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(120, (box.width + 4) * k), h = Math.max(60, (box.height + box.depth + 4) * k);
    preview.width = w * ratio; preview.height = h * ratio; preview.style.width = `${w}px`; preview.style.height = `${h}px`;
    const ctx = preview.getContext('2d');
    ctx.setTransform(ratio * k, 0, 0, ratio * k, ratio * 2 * k, ratio * 2 * k);
    ctx.lineWidth = .35; ctx.lineCap = ctx.lineJoin = 'round'; ctx.strokeStyle = box.error ? '#c2410c' : '#30343a';
    for (const points of box.error ? box.placeholder : box.strokes) { ctx.beginPath(); ctx.moveTo(...points[0]); if (points.length === 1) ctx.lineTo(points[0][0] + .01, points[0][1]); for (const p of points.slice(1)) ctx.lineTo(...p); ctx.stroke(); }
    const message = box.error || (box.missing.length ? `字库中缺少：${box.missing.join(' ')}` : '');
    $('#formula-error').textContent = message;
    $('#formula-error').hidden = !message;
    $('#formula-accept').disabled = Boolean(box.error) || !source.trim();
  }
  function openFormula(placement = null) {
    if (locked()) return;
    editing = placement;
    const chars = Array.from(content.value);
    $('#formula-source').value = placement ? chars.slice(placement.index + 2, placement.end - 2).join('') : '';
    $('#formula-title').textContent = placement ? '编辑公式' : '插入公式';
    $('#formula-accept').textContent = placement ? '更新' : '插入';
    $('#formula-remove').hidden = !placement;
    renderFormulaPreview();
    $('#formula-dialog').showModal();
    $('#formula-source').focus();
  }
  /** Replace a code point range through execCommand so the browser's undo history keeps working. */
  function replaceRange(from, to, text) {
    const chars = Array.from(content.value);
    const start = chars.slice(0, from).join('').length, end = chars.slice(0, to).join('').length;
    if (paperMode() || view === 'editor') content.focus({ preventScroll: true });
    content.setSelectionRange(start, end);
    if (!document.execCommand?.('insertText', false, text)) { content.setRangeText(text, start, end, 'end'); content.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  $('#insert-formula').addEventListener('click', () => openFormula(null));
  // Keep writing after the dialog closes (focus would otherwise return to the toolbar button).
  $('#formula-dialog').addEventListener('close', () => { if (!content.disabled) { content.focus({ preventScroll: true }); update({ follow: true }); } });
  $('#formula-source').addEventListener('input', renderFormulaPreview);
  for (const button of $$('.formula-palette button')) button.addEventListener('click', () => {
    const field = $('#formula-source'), text = button.dataset.insert;
    field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end');
    const hole = field.value.indexOf('□');
    if (hole >= 0) field.setSelectionRange(hole, hole + 1);
    field.focus();
    renderFormulaPreview();
  });
  for (const id of ['formula-cancel', 'formula-close']) $(`#${id}`).addEventListener('click', () => $('#formula-dialog').close());
  $('#formula-remove').addEventListener('click', () => {
    if (editing) replaceRange(editing.index, editing.end, '');
    closeFormula();
  });
  $('#formula-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const source = $('#formula-source').value.trim().replace(/□/g, '');
    if (!source || MathLayout.layout(source, 10, mathGlyphFor()).error) return;
    const text = `\\(${source}\\)`;
    if (editing) replaceRange(editing.index, editing.end, text);
    else { const [start, end] = [content.selectionStart, content.selectionEnd]; const chars = Array.from(content.value.slice(0, start)).length; replaceRange(chars, chars + Array.from(content.value.slice(start, end)).length, text); }
    closeFormula();
  });
  /** Close and continue writing right away (synchronously: keys typed next must reach the text). */
  function closeFormula() {
    $('#formula-dialog').close();
    if (!content.disabled) { content.focus({ preventScroll: true }); update({ follow: true }); }
  }
})();
