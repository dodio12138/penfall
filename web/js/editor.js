'use strict';
// Text editor, paper layout preview, view switching and the shared simulation/task state.
const LEGACY_DRAFT_KEYS = ['web-typewriter:workspace:v2', 'web-typewriter:draft:v1'];
const title = $('#title');
const content = $('#content');
const settings = ['paper', 'orientation', 'font', 'font-size', 'line-gap', 'letter-gap', 'margin'];
const defaults = { paper: 'a4', orientation: 'portrait', font: 'serif', 'font-size': '5', 'line-gap': '3', 'letter-gap': '1', margin: '20' };
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
  const result = PathEngine.layoutText(content.value, { width, height, margin: Number(c.margin), size, gap: Number(c['letter-gap']), lineGap: Number(c['line-gap']) }, glyphResolver(), fallbackAdvance);
  return { width, height, margin: Number(c.margin), size, font: c.font, paper: c.paper, orientation: c.orientation, placements: result.placements, glyphs: result.placements, missing: result.missing, overflow: result.overflow, pages: result.pages };
}
/** Page being previewed / generated (1-based), clamped to the current layout. */
function currentPage() {
  const requested = Number($('#page').value);
  return Math.min(Math.max(1, Number.isInteger(requested) ? requested : 1), layout.pages || 1);
}
function setPage(page) {
  const next = Math.min(Math.max(1, page), layout.pages || 1);
  if (next === Number($('#page').value)) return;
  $('#page').value = String(next);
  $('#page').dispatchEvent(new Event('input', { bubbles: true }));
}
function updatePagers() {
  const page = currentPage(), pages = layout.pages || 1;
  for (const pager of $$('.pager')) {
    pager.hidden = pages <= 1;
    pager.querySelector('.pager-label').textContent = `第 ${page} / ${pages} 页`;
    pager.querySelector('.pager-prev').disabled = page <= 1;
    pager.querySelector('.pager-next').disabled = page >= pages;
  }
}
function updateLayoutInfo() {
  $('#paper-info').textContent = `${layout.paper.toUpperCase()} · ${layout.orientation === 'landscape' ? '横向' : '纵向'} · ${layout.width} × ${layout.height} mm`;
  const notes = [];
  if (layout.missing?.length) notes.push(`缺字 ${layout.missing.length} 个（红色为系统字体示意，不能生成）`);
  if (layout.overflow) notes.push(`内容超过 ${PathEngine.MAX_PAGES} 页上限，请拆分文稿`);
  else if (layout.pages > 1) notes.push(`共 ${layout.pages} 页，每页单独生成与书写，换纸后再发送下一页`);
  $('#layout-status').textContent = notes.join('；');
  $('#paper-mode').textContent = layout.missing?.length ? '单线笔迹 + 缺字示意' : '单线笔迹预览';
  updatePagers();
  updateOriginSummary();
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
  ctx.strokeRect(margin, margin, width - 2 * margin, height - 2 * margin);
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
    ctx.strokeStyle = ctx.fillStyle = '#30343a';
    ctx.lineWidth = .35;
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
function selectView(view) {
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
  if (view === 'editor' && !content.disabled) content.focus();
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
  pager.querySelector('.pager-prev').addEventListener('click', () => setPage(currentPage() - 1));
  pager.querySelector('.pager-next').addEventListener('click', () => setPage(currentPage() + 1));
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
