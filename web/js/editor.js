'use strict';
// Text editor, paper layout preview, view switching and the shared simulation/task state.
const LEGACY_DRAFT_KEYS = ['web-typewriter:workspace:v2', 'web-typewriter:draft:v1'];
const title = $('#title');
const content = $('#content');
const settings = ['paper', 'orientation', 'font', 'font-size', 'line-gap', 'letter-gap', 'margin'];
const defaults = { paper: 'a4', orientation: 'portrait', font: 'serif', 'font-size': '5', 'line-gap': '3', 'letter-gap': '1', margin: '20' };
const PAPER_SIZES = { a4: [210, 297], a5: [148, 210] };
const PREVIEW_PX_PER_MM = 2.5;
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

function makeLayout() {
  const c = config();
  let [width, height] = PAPER_SIZES[c.paper];
  if (c.orientation === 'landscape') [width, height] = [height, width];
  const size = Number(c['font-size']);
  const margin = Number(c.margin);
  const letterGap = Number(c['letter-gap']);
  const lineHeight = size + Number(c['line-gap']);
  const context = $('#preview').getContext('2d');
  context.font = `${size}px ${c.font}`;
  const glyphs = [];
  const widths = new Map();
  let x = margin;
  let y = margin;
  let overflow = false;
  for (const char of content.value.replace(/\r\n?/g, '\n')) {
    if (char === '\n') { x = margin; y += lineHeight; continue; }
    const printable = char === '\t' ? '    ' : char;
    if (!widths.has(printable)) widths.set(printable, context.measureText(printable).width);
    const advance = widths.get(printable) + letterGap;
    if (x + advance - letterGap > width - margin && x > margin) { x = margin; y += lineHeight; }
    if (y + size > height - margin) { overflow = true; break; }
    glyphs.push({ char: printable, x, y });
    x += advance;
  }
  return { width, height, margin, size, font: c.font, paper: c.paper, orientation: c.orientation, glyphs, overflow };
}
function updateLayoutInfo() {
  $('#paper-info').textContent = `${layout.paper.toUpperCase()} · ${layout.orientation === 'landscape' ? '横向' : '纵向'} · ${layout.width} × ${layout.height} mm`;
  $('#layout-status').textContent = layout.overflow ? '内容超出一页，请缩小字号或分段书写；暂不支持多页。' : '';
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
  ctx.fillStyle = '#30343a';
  for (const glyph of glyphs) ctx.fillText(glyph.char, glyph.x, glyph.y);
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
