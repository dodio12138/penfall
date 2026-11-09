'use strict';
const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = 'web-typewriter:workspace:v2';
const title = $('#title');
const content = $('#content');
const settings = ['paper', 'orientation', 'font', 'font-size', 'line-gap', 'letter-gap', 'margin'];
const defaults = { paper: 'a4', orientation: 'portrait', font: 'serif', 'font-size': '5', 'line-gap': '3', 'letter-gap': '1', margin: '20' };
let simulation = { state: 'idle', done: 0, timer: null };
let layout = { glyphs: [], overflow: false };
let logLines = 0;

function log(message) {
  const row = document.createElement('div');
  row.className = 'log-entry';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  row.append(time, document.createTextNode(message));
  $('#log').append(row);
  if (++logLines > 150) $('#log').firstChild.remove();
  $('#log').scrollTop = $('#log').scrollHeight;
}
function validSetting(id, value) {
  const field = $(`#${id}`);
  if (field.tagName === 'SELECT') return [...field.options].some((option) => option.value === value);
  return value !== '' && Number.isFinite(Number(value)) && Number(value) >= Number(field.min) && Number(value) <= Number(field.max);
}
function config() {
  return Object.fromEntries(settings.map((id) => [id, validSetting(id, $(`#${id}`).value) ? $(`#${id}`).value : defaults[id]]));
}
function updateCursor() {
  const editor = !$('#gcode-view').hidden ? $('#gcode') : content;
  const before = editor.value.slice(0, editor.selectionStart).split('\n');
  $('#cursor').textContent = `行 ${before.length}，列 ${Array.from(before.at(-1)).length + 1}`;
}
function updateEditor() {
  $('#count').textContent = `${Array.from(content.value.replace(/\s/g, '')).length} 字`;
  $('#line-numbers').textContent = Array.from({ length: content.value.split('\n').length }, (_, i) => i + 1).join('\n');
  $('#line-numbers').scrollTop = content.scrollTop;
  updateCursor();
}
function save() {
  if (window.Workspace) return window.Workspace.capture();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ title: title.value, content: content.value, settings: config(), updatedAt: new Date().toISOString() }));
    $('#status').textContent = '已保存到当前浏览器';
  } catch {
    $('#status').textContent = '本地保存失败，请导出备份';
  }
}
function restore() {
  try {
    const draft = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('web-typewriter:draft:v1') || 'null');
    if (draft && typeof draft.title === 'string' && typeof draft.content === 'string') {
      title.value = draft.title;
      content.value = draft.content;
      settings.forEach((id) => { if (validSetting(id, draft.settings?.[id])) $(`#${id}`).value = draft.settings[id]; });
      $('#status').textContent = '已恢复本地草稿';
    }
  } catch { $('#status').textContent = '无法读取草稿，请注意导出备份'; }
}
function makeLayout() {
  const c = config();
  let [width, height] = c.paper === 'a4' ? [210, 297] : [148, 210];
  if (c.orientation === 'landscape') [width, height] = [height, width];
  const size = Number(c['font-size']);
  const margin = Number(c.margin);
  const lineHeight = size + Number(c['line-gap']);
  const context = $('#preview').getContext('2d');
  context.font = `${size}px ${c.font}`;
  const glyphs = [];
  let x = margin;
  let y = margin;
  let overflow = false;
  for (const char of content.value.replace(/\r\n?/g, '\n')) {
    if (char === '\n') { x = margin; y += lineHeight; continue; }
    const printable = char === '\t' ? '    ' : char;
    const advance = context.measureText(printable).width + Number(c['letter-gap']);
    if (x + advance - Number(c['letter-gap']) > width - margin && x > margin) { x = margin; y += lineHeight; }
    if (y + size > height - margin) { overflow = true; break; }
    glyphs.push({ char: printable, x, y });
    x += advance;
  }
  return { width, height, margin, size, font: c.font, paper: c.paper, glyphs, overflow };
}
function renderPreview() {
  const canvas = $('#preview');
  const stage = $('.paper-stage');
  const padding = parseFloat(getComputedStyle(stage).paddingLeft) * 2;
  const zoom = $('#zoom').value === 'fit' ? Math.min(2, Math.max(.1, ((stage.clientWidth || $('.main-area').clientWidth) - padding - 2) / (layout.width * 2.5))) : Number($('#zoom').value);
  const scale = 2.5 * zoom;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height, margin, size, font, glyphs } = layout;
  canvas.width = Math.round(width * scale * ratio);
  canvas.height = Math.round(height * scale * ratio);
  canvas.style.width = `${width * scale}px`;
  canvas.style.height = `${height * scale}px`;
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
  glyphs.forEach((glyph) => {
    ctx.fillStyle = '#30343a';
    ctx.fillText(glyph.char, glyph.x, glyph.y);
  });
  $('#paper-info').textContent = `${layout.paper.toUpperCase()} · ${width} × ${height} mm`;
  $('#layout-status').textContent = layout.overflow ? '内容超出一页，请缩小字号或分段书写；暂不支持多页。' : '';
}
function updateTask() {
  const running = simulation.state === 'running';
  const paused = simulation.state === 'paused';
  const total = simulation.total || layout.glyphs.length;
  const percent = total ? Math.min(100, Math.floor(simulation.done / total * 100)) : 0;
  $('#progress').value = percent;
  $('#progress-label').textContent = `${percent}%`;
  $('#start').disabled = running || paused;
  $('#pause').disabled = !running && !paused;
  $('#pause').textContent = paused ? '继续' : '暂停';
  $('#stop').disabled = !running && !paused;
  $('#task-state').textContent = ({ idle: '就绪', running: '模拟中', paused: '已暂停', complete: '模拟完成' })[simulation.state];
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
function selectView(view) {
  view = view === true ? 'preview' : view === false ? 'editor' : view;
  for (const name of ['editor', 'gcode', 'preview', 'path']) {
    const active = name === view;
    $(`#${name}-view`).hidden = !active;
    const tab = $(`#${name === 'editor' ? 'edit' : name}-tab`);
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', String(active));
  }
  if (view === 'preview') renderPreview();
  if (view === 'editor') content.focus();
  window.dispatchEvent(new CustomEvent('workspace-view', { detail: view }));
}
function openConnection() {
  if (!$('#connection-dialog').open) $('#connection-dialog').showModal();
}

restore();
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
$('#edit-tab').addEventListener('click', () => selectView(false));
$('#preview-tab').addEventListener('click', () => selectView(true));
$('.view-tabs').addEventListener('keydown', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.view-tabs [role="tab"]')];
    const current = tabs.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    tabs[index].click();
    tabs[index].focus();
  }
});
$('#zoom').addEventListener('change', renderPreview);
$('#sidebar-toggle').addEventListener('click', () => document.body.classList.toggle('sidebar-hidden'));
if (window.innerWidth <= 900) document.body.classList.add('sidebar-hidden');
['#connect', '#device-activity'].forEach((id) => $(id).addEventListener('click', openConnection));
$('#help').addEventListener('click', () => $('#help-dialog').showModal());
$('#clear-log').addEventListener('click', () => { $('#log').replaceChildren(); logLines = 0; });
$('#log-toggle').addEventListener('click', () => {
  $('#log').hidden = !$('#log').hidden;
  $('#log-toggle').setAttribute('aria-expanded', String(!$('#log').hidden));
  $('#log-toggle').classList.toggle('selected', !$('#log').hidden);
  $('#log-resizer').hidden = $('#log').hidden;
});
$('#export').addEventListener('click', () => {
  const text = content.value;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = window.Workspace?.activeName || `${(title.value.trim() || '无题').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log('已请求导出文本备份。');
});
