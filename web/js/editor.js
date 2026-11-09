'use strict';
// Text editor, paper layout preview, view switching and the shared simulation/task state.
const LEGACY_DRAFT_KEYS = ['web-typewriter:workspace:v2', 'web-typewriter:draft:v1'];
const title = $('#title');
const content = $('#content');
const settings = ['paper', 'orientation', 'font', 'font-size', 'line-gap', 'letter-gap', 'margin', 'gutter'];
const defaults = { paper: 'a4', orientation: 'portrait', font: 'serif', 'font-size': '5', 'line-gap': '3', 'letter-gap': '1', margin: '20', gutter: '0' };
const PAPER_SIZES = { a4: [210, 297], a5: [148, 210] };
const PREVIEW_PX_PER_MM = 2.5;
const ORIGIN_DEFAULTS = { 'origin-corner': 'bottom-left', 'origin-x': '0', 'origin-y': '0', 'x-dir': '1', 'y-dir': '1' };
const CORNER_NAMES = { 'bottom-left': '左下角', 'top-left': '左上角', 'top-right': '右上角', 'bottom-right': '右下角' };
const VIEWS = { editor: 'edit-tab', gcode: 'gcode-tab', preview: 'preview-tab', path: 'path-tab' };
let simulation = { state: 'idle', done: 0, timer: null };
let layout = { glyphs: [], overflow: false };

function validSetting(id, value) {
  const field = $(`#${id}`);
  if (typeof value !== 'string') return false;
  if (field.tagName === 'SELECT') return [...field.options].some((option) => option.value === value);
  return value !== '' && Number.isFinite(Number(value)) && Number(value) >= Number(field.min) && Number(value) <= Number(field.max);
}
function config() {
  return Object.fromEntries(settings.map((id) => [id, validSetting(id, $(`#${id}`).value) ? $(`#${id}`).value : defaults[id]]));
}
// --- Pen origin: where work (0,0) sits on the paper, and which way the machine axes point. ---
function originSetting(id) {
  const value = $(`#${id}`).value;
  return validSetting(id, value) ? value : ORIGIN_DEFAULTS[id];
}
/** Pen zero in paper mm measured from the paper's left / bottom edge, plus axis signs. */
function penOrigin(paper = layout) {
  const corner = originSetting('origin-corner');
  const dx = Number(originSetting('origin-x')), dy = Number(originSetting('origin-y'));
  const right = corner.endsWith('right'), top = corner.startsWith('top');
  return { corner, dx, dy, x: right ? paper.width - dx : dx, y: top ? paper.height - dy : dy, dirX: Number(originSetting('x-dir')), dirY: Number(originSetting('y-dir')) };
}
function paperToWork(x, y, origin = penOrigin()) {
  return { x: origin.dirX * (x - origin.x), y: origin.dirY * (y - origin.y) };
}
/** Axis-aligned paper rectangle [0..width]×[0..height] expressed in work coordinates. */
function paperWorkBounds(width, height, origin = penOrigin()) {
  const a = paperToWork(0, 0, origin), b = paperToWork(width, height, origin);
  return { xmin: Math.min(a.x, b.x), xmax: Math.max(a.x, b.x), ymin: Math.min(a.y, b.y), ymax: Math.max(a.y, b.y) };
}
const mm = (value) => String(Number((value || 0).toFixed(2)));
function updateOriginSummary() {
  const origin = penOrigin();
  const area = paperWorkBounds(layout.width, layout.height, origin);
  const horizontal = origin.corner.endsWith('right') ? '右边' : '左边', vertical = origin.corner.startsWith('top') ? '上边' : '下边';
  $('#origin-summary').textContent = `零点在纸张${CORNER_NAMES[origin.corner]}：距${horizontal} ${mm(origin.dx)} mm、距${vertical} ${mm(origin.dy)} mm。纸张对应工件坐标 X ${mm(area.xmin)}…${mm(area.xmax)} · Y ${mm(area.ymin)}…${mm(area.ymax)}。把笔移到此点后，在「坐标定位」中 XY 置零。`;
  const dialogArea = paperWorkBounds(Number($('#machine-x').value) || 0, Number($('#machine-y').value) || 0, origin);
  $('#paper-range-hint').textContent = `按「笔起点」换算后校验：X ${mm(dialogArea.xmin)}…${mm(dialogArea.xmax)} · Y ${mm(dialogArea.ymin)}…${mm(dialogArea.ymax)} mm（工件坐标）。`;
}
/** Paper preview marker: pen zero with +X / +Y arrows, drawn in top-down paper mm. */
function drawOriginMarker(ctx) {
  const origin = penOrigin();
  const cx = origin.x, cy = layout.height - origin.y, arm = Math.max(8, Math.min(layout.width, layout.height) * .06);
  const arrow = (dx, dy, label) => {
    const ex = cx + dx * arm, ey = cy + dy * arm;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey);
    ctx.lineTo(ex - dx * 2 - dy * 1.2, ey - dy * 2 - dx * 1.2); ctx.moveTo(ex, ey); ctx.lineTo(ex - dx * 2 + dy * 1.2, ey - dy * 2 + dx * 1.2); ctx.stroke();
    ctx.fillText(label, ex + dx * 1.5 + (dy ? 1.5 : 0), ey + dy * 1.5 - (dx ? 1.5 : 0));
  };
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = '#1766aa';
  ctx.lineWidth = .4;
  ctx.font = '4px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.stroke();
  arrow(origin.dirX, 0, 'X+');
  arrow(0, -origin.dirY, 'Y+');
  ctx.fillText('笔零点 (0,0)', cx + (origin.corner.endsWith('right') ? -22 : 2.5), cy + (origin.corner.startsWith('top') ? 4 : -4));
  ctx.restore();
}
function activeEditor() {
  return $('#gcode-view').hidden ? content : $('#gcode');
}
function updateCursor() {
  const editor = activeEditor();
  const before = editor.value.slice(0, editor.selectionStart).split('\n');
  $('#cursor').textContent = `行 ${before.length}，列 ${Array.from(before.at(-1)).length + 1}`;
}
function updateEditor() {
  $('#count').textContent = `${Array.from(content.value.replace(/\s/g, '')).length} 字`;
  renderLineNumbers($('#line-numbers'), content);
  updateCursor();
}
function save() {
  return window.Workspace ? window.Workspace.capture() : false;
}
/** One-time migration source: the pre-v3 single draft. Workspace persists everything afterwards. */
function restoreLegacyDraft() {
  try {
    const raw = LEGACY_DRAFT_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
    const draft = JSON.parse(raw || 'null');
    if (draft && typeof draft.title === 'string' && typeof draft.content === 'string') {
      title.value = draft.title;
      content.value = draft.content;
      settings.forEach((id) => { if (validSetting(id, draft.settings?.[id])) $(`#${id}`).value = draft.settings[id]; });
    }
  } catch { /* Corrupt legacy draft: start empty, the workspace handles its own recovery. */ }
}

// --- Pens (workspace pen rack) and the draft's drawing ---
function penList() { return window.Workspace?.pens || Links.DEFAULT_PENS; }
function penName(index) { return penList()[index - 1]?.name || `笔 ${index}`; }
function penColor(index) { return penList()[index - 1]?.color || '#30343a'; }
/** Rebuild the pen pickers after the pen rack changed, keeping valid choices. */
function renderPenOptions() {
  for (const [id, withAll] of [['text-pen', false], ['pen', true]]) {
    const select = $(`#${id}`), value = select.value;
    select.replaceChildren(...(withAll ? [new Option('全部（不换笔）', 'all')] : []), ...penList().map((pen, index) => new Option(`${index + 1} · ${pen.name}`, String(index + 1))));
    select.value = [...select.options].some((option) => option.value === value) ? value : select.options[0].value;
    select.dispatchEvent(new Event('change'));
  }
}
let drawingState = null; // { file, text, model?, error? } for the active draft
const drawingCache = new Map();
function setDrawing(file, text) {
  if (!file) { drawingState = null; return; }
  const key = `${Links.extname(file)}:${Links.hash(text)}`;
  if (!drawingCache.has(key)) {
    try { drawingCache.set(key, { model: Links.extname(file) === '.dxf' ? Drawing.parseDxf(text) : Drawing.parseSvg(text) }); }
    catch (error) { drawingCache.set(key, { error: error.message }); }
  }
  drawingState = { file, text, ...drawingCache.get(key) };
}
function drawingPlacement() {
  if (!drawingState?.model) return null;
  const read = (id) => Number($(`#drawing-${id}`).value);
  const placement = { page: Math.min(99, Math.max(1, Math.round(read('page')) || 1)), x: read('x'), y: read('y'), width: read('width') };
  return [placement.x, placement.y, placement.width].every(Number.isFinite) && placement.width > 0 ? placement : null;
}
function setDrawingInputs(placement) {
  for (const key of ['page', 'x', 'y', 'width']) $(`#drawing-${key}`).value = placement ? String(placement[key]) : '';
}
/** Pens with something to write (on one page, or anywhere). */
function usedPens(page) {
  const pens = new Set();
  const textPen = Number($('#text-pen').value) || 1;
  if ((layout.placements || []).some((item) => page === undefined || item.page === page)) pens.add(textPen);
  for (const path of layout.paths || []) if (page === undefined || path.page === page) pens.add(path.pen);
  return [...pens].sort((a, b) => a - b);
}

/** Same layout as the generator (PathEngine.layoutText); characters without a glyph use system-font widths. */
function makeLayout() {
  const c = config();
  let [width, height] = PAPER_SIZES[c.paper];
  if (c.orientation === 'landscape') [width, height] = [height, width];
  const size = Number(c['font-size']);
  const context = $('#preview').getContext('2d');
  context.font = `${size}px ${c.font}`;
  const widths = new Map();
  const fallbackAdvance = (char) => { if (!widths.has(char)) widths.set(char, context.measureText(char).width); return widths.get(char); };
  const result = PathEngine.layoutText(content.value, { width, height, margin: Number(c.margin), gutter: Number(c.gutter), size, gap: Number(c['letter-gap']), lineGap: Number(c['line-gap']) }, glyphResolver({ preview: true }), fallbackAdvance);
  const placement = drawingPlacement();
  const paths = placement ? Drawing.placePaths(drawingState.model, placement, penList()) : [];
  return { width, height, margin: Number(c.margin), gutter: Number(c.gutter), size, font: c.font, paper: c.paper, orientation: c.orientation, placements: result.placements, glyphs: result.placements, paths, missing: result.missing, overflow: result.overflow, pages: Math.max(result.pages, placement?.page || 1) };
}
/** Pages included in the current writing set (all / odd / even), in order. */
function pageSet() {
  const set = $('#page-set').value;
  const all = Array.from({ length: layout.pages || 1 }, (_, i) => i + 1);
  const pages = set === 'odd' ? all.filter((page) => page % 2) : set === 'even' ? all.filter((page) => !(page % 2)) : all;
  return pages.length ? pages : [1];
}
/** Page being previewed / generated (1-based): the requested page, moved into the current set if needed. */
function currentPage() {
  const requested = Number($('#page').value);
  const pages = pageSet();
  const wanted = Math.min(Math.max(1, Number.isInteger(requested) ? requested : 1), layout.pages || 1);
  return pages.includes(wanted) ? wanted : pages.find((page) => page >= wanted) || pages.at(-1);
}
function setPage(page) {
  const pages = pageSet();
  const next = pages.includes(page) ? page : pages[0];
  if (next === Number($('#page').value)) return;
  $('#page').value = String(next);
  $('#page').dispatchEvent(new Event('input', { bubbles: true }));
}
/** Step to the previous / next page inside the writing set. */
function stepPage(direction) {
  const pages = pageSet(), index = pages.indexOf(currentPage());
  const next = pages[index + direction];
  if (next) setPage(next);
}
function updatePagers() {
  const page = currentPage(), pages = layout.pages || 1, set = pageSet(), index = set.indexOf(page);
  const label = $('#page-set').value === 'all' ? `第 ${page} / ${pages} 页` : `第 ${page} 页 · ${$('#page-set').value === 'odd' ? '奇数页' : '偶数页'} ${index + 1}/${set.length}`;
  for (const pager of $$('.pager')) {
    pager.hidden = pages <= 1;
    pager.querySelector('.pager-label').textContent = label;
    pager.querySelector('.pager-prev').disabled = index <= 0;
    pager.querySelector('.pager-next').disabled = index >= set.length - 1;
  }
}
/** After a page is finished: tell the user what to write next. */
function announceNextPage() {
  const pen = $('#pen').value;
  if (pen !== 'all') {
    const pens = usedPens(currentPage()), next = pens[pens.indexOf(Number(pen)) + 1];
    if (next) { log(`本页「${penName(Number(pen))}」笔的内容已完成。换上「${penName(next)}」笔，在 G-code 页「笔」中选择 ${next} 后继续。`); return; }
  }
  if ((layout.pages || 1) <= 1) return;
  const set = pageSet(), next = set[set.indexOf(currentPage()) + 1];
  log(next ? `第 ${currentPage()} 页完成。换纸后点 › 继续写第 ${next} 页。` : `本批次（${$('#page-set').value === 'all' ? '全部页' : $('#page-set').value === 'odd' ? '奇数页' : '偶数页'}）最后一页已完成。${$('#page-set').value === 'odd' ? '双面书写：把整叠纸翻面放回，再选「仅偶数页」。' : ''}`);
}
function updateLayoutInfo() {
  $('#paper-info').textContent = `${layout.paper.toUpperCase()} · ${layout.orientation === 'landscape' ? '横向' : '纵向'} · ${layout.width} × ${layout.height} mm`;
  const notes = [];
  if (layout.missing?.length) notes.push(`缺字 ${layout.missing.length} 个（红色为系统字体示意，不能生成）`);
  if (layout.overflow) notes.push(`内容超过 ${PathEngine.MAX_PAGES} 页上限，请拆分文稿`);
  else if (layout.pages > 1) notes.push(`共 ${layout.pages} 页，每页单独生成与书写，换纸后再发送下一页`);
  if (drawingState?.error) notes.push(`图形无法解析：${drawingState.error}`);
  const legend = $('#pen-legend');
  legend.replaceChildren(...usedPens(currentPage()).map((pen) => { const chip = document.createElement('span'); chip.className = 'pen-chip'; chip.style.setProperty('--pen', penColor(pen)); chip.textContent = penName(pen); return chip; }));
  legend.hidden = usedPens().length < 2;
  $('#layout-status').textContent = notes.join('；');
  $('#paper-mode').textContent = glyphPreview && glyphLibraries.has(glyphPreview) ? `字库预览：${glyphCatalog.get(glyphPreview)?.name}（未应用）` : layout.missing?.length ? '单线笔迹 + 缺字示意' : '单线笔迹预览';
  updatePagers();
  updateOriginSummary();
  if (typeof updatePenPicker === 'function') updatePenPicker();
}
function previewZoom(stage) {
  const choice = $('#zoom').value;
  if (choice !== 'fit' && choice !== 'page') return Number(choice);
  const style = getComputedStyle(stage);
  const availableWidth = (stage.clientWidth || $('.main-area').clientWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
  const availableHeight = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 2;
  const byWidth = availableWidth / (layout.width * PREVIEW_PX_PER_MM);
  const byHeight = availableHeight / (layout.height * PREVIEW_PX_PER_MM);
  const fit = choice === 'page' && availableHeight > 40 ? Math.min(byWidth, byHeight) : byWidth;
  return Math.min(2, Math.max(.1, fit));
}
function renderPreview() {
  updateLayoutInfo();
  if ($('#preview-view').hidden) return;
  const canvas = $('#preview');
  const stage = $('.paper-stage');
  const scale = PREVIEW_PX_PER_MM * previewZoom(stage);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height, margin, size, font, glyphs } = layout;
  canvas.width = Math.round(width * scale * ratio);
  canvas.height = Math.round(height * scale * ratio);
  canvas.style.width = `${Math.round(width * scale)}px`;
  canvas.style.height = `${Math.round(height * scale)}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale * ratio, scale * ratio);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#dadfe5';
  ctx.lineWidth = 0.25;
  ctx.setLineDash([2, 2]);
  const binding = currentPage() % 2 ? layout.gutter || 0 : 0, bindingRight = currentPage() % 2 ? 0 : layout.gutter || 0;
  ctx.strokeRect(margin + binding, margin, width - 2 * margin - binding - bindingRight, height - 2 * margin);
  ctx.setLineDash([]);
  ctx.font = `${size}px ${font}`;
  ctx.textBaseline = 'top';
  ctx.lineCap = ctx.lineJoin = 'round';
  const pinned = new Set(glyphSelection.pins.map((pin) => pin.at));
  const page = currentPage();
  for (const item of glyphs) {
    if (item.page !== page) continue;
    if (!item.glyph) {
      // No stroke data: show the character in a system font, clearly marked as missing.
      ctx.fillStyle = '#c2410c';
      ctx.fillText(item.char, item.x, item.y);
      continue;
    }
    const scale = size / item.glyph.unitsPerEm;
    ctx.strokeStyle = ctx.fillStyle = penColor(Number($('#text-pen').value) || 1);
    ctx.lineWidth = window.Workspace?.penWidth || .5; // real pen width in mm
    ctx.beginPath();
    for (const stroke of item.glyph.strokes) {
      ctx.moveTo(item.x + stroke[0][0] * scale, item.y + stroke[0][1] * scale);
      if (stroke.length === 1) ctx.lineTo(item.x + stroke[0][0] * scale + .01, item.y + stroke[0][1] * scale);
      for (const point of stroke.slice(1)) ctx.lineTo(item.x + point[0] * scale, item.y + point[1] * scale);
    }
    ctx.stroke();
    if (pinned.has(item.index)) {
      ctx.fillStyle = '#1766aa';
      ctx.fillRect(item.x, item.y + size + .6, item.width, .4);
    }
  }
  ctx.lineWidth = window.Workspace?.penWidth || .5;
  for (const path of (layout.paths || []).filter((item) => item.page === page)) {
    ctx.strokeStyle = penColor(path.pen);
    ctx.beginPath();
    ctx.moveTo(...path.points[0]);
    if (path.points.length === 1) ctx.lineTo(path.points[0][0] + .01, path.points[0][1]);
    for (const point of path.points.slice(1)) ctx.lineTo(...point);
    ctx.stroke();
  }
  drawOriginMarker(ctx);
}

function updateTask() {
  const running = simulation.state === 'running';
  const paused = simulation.state === 'paused';
  const total = simulation.total || layout.glyphs.length;
  const percent = total ? Math.min(100, Math.floor(simulation.done / total * 100)) : 0;
  $('#progress').value = percent;
  $('#progress-label').textContent = `${percent}%`;
  $('#pause').disabled = !running && !paused;
  $('#pause').textContent = paused ? '继续' : '暂停';
  $('#stop').disabled = !running && !paused;
  $('#task-state').textContent = ({ idle: '就绪', running: '模拟中', paused: '已暂停', complete: '模拟完成' })[simulation.state];
  // Start / send availability also depends on the program and device, owned by program.js.
  if (typeof refreshSendButton === 'function') refreshSendButton();
  else $('#start').disabled = running || paused;
}
function resetSimulation(message) {
  const active = simulation.state === 'running' || simulation.state === 'paused';
  clearInterval(simulation.timer);
  simulation = { state: 'idle', done: 0, timer: null };
  if (active && message) log(message);
}
function changed() {
  resetSimulation('内容或参数已修改，模拟已重置。');
  updateEditor();
  save();
  layout = makeLayout();
  renderPreview();
  updateTask();
}
/** Switch the central view: 'editor' | 'gcode' | 'preview' | 'path'. */
function selectView(view, { focus = true } = {}) {
  if (!(view in VIEWS)) view = 'editor';
  for (const [name, tabId] of Object.entries(VIEWS)) {
    const active = name === view;
    $(`#${name}-view`).hidden = !active;
    const tab = $(`#${tabId}`);
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  if (view === 'preview') renderPreview();
  if (focus && view === 'editor' && !content.disabled) content.focus();
  window.dispatchEvent(new CustomEvent('workspace-view', { detail: view }));
}
function openConnection() {
  if (!$('#connection-dialog').open) $('#connection-dialog').showModal();
}
function toggleLog(show = $('#log').hidden) {
  $('#log').hidden = !show;
  $('#log-resizer').hidden = !show;
  $('#log-toggle').setAttribute('aria-expanded', String(show));
  $('#log-toggle').classList.toggle('selected', show);
}

updateEditor();
layout = makeLayout();
renderPreview();
updateTask();
log('工作台已就绪，设备状态尚未查询。');
content.addEventListener('input', changed);
title.addEventListener('input', save);
settings.forEach((id) => $(`#${id}`).addEventListener('input', changed));
content.addEventListener('scroll', () => { $('#line-numbers').scrollTop = content.scrollTop; });
['click', 'keyup', 'select'].forEach((event) => content.addEventListener(event, updateCursor));
for (const [view, tabId] of Object.entries(VIEWS)) $(`#${tabId}`).addEventListener('click', () => selectView(view));
$('.view-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = $$('.view-tabs [role="tab"]');
  const current = tabs.indexOf(document.activeElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
  tabs[index].click();
  tabs[index].focus();
});
$('#zoom').addEventListener('change', renderPreview);
for (const pager of $$('.pager')) {
  pager.querySelector('.pager-prev').addEventListener('click', () => stepPage(-1));
  pager.querySelector('.pager-next').addEventListener('click', () => stepPage(1));
}
$('#sidebar-toggle').addEventListener('click', () => document.body.classList.toggle('sidebar-hidden'));
if (window.innerWidth <= 900) document.body.classList.add('sidebar-hidden');
['#connect', '#device-activity'].forEach((id) => $(id).addEventListener('click', openConnection));
$('#help').addEventListener('click', () => $('#help-dialog').showModal());
$('#clear-log').addEventListener('click', () => $('#log').replaceChildren());
$('#log-toggle').addEventListener('click', () => toggleLog());
$('#export').addEventListener('click', () => {
  downloadText(content.value, window.Workspace?.activeName || `${safeFilename(title.value)}.txt`);
  log('已请求导出文本备份。');
});
