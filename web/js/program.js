'use strict';
// G-code program: parse, generate, import/export, stale tracking and the toolpath simulation.
const LEGACY_PROGRAM_KEYS = { code: 'web-typewriter:gcode:v1', dirty: 'web-typewriter:gcode-dirty:v1', motion: 'web-typewriter:motion:v1' };
const SIM_TICK_MS = 50;
const SIM_RAPID_FEED = 3000; // mm/min estimate for G0 travel moves.
const codeEditor = $('#gcode');
/** Show only the background fields that apply to the chosen ruling. */
function updateBackgroundFields() {
  const kind = $('#bg-kind').value;
  $('#bg-cell-label').hidden = kind === 'none';
  $('#bg-cell-label').firstChild.textContent = ['lines', 'four-line'].includes(kind) ? '行距 / mm' : '格子 / mm';
  $('#bg-gap-label').hidden = kind !== 'composition';
  $('#bg-pen-label').hidden = kind === 'none' || $('#bg-write').value !== 'yes';
}
/** Only the pen-lift fields of the chosen method (Z axis / servo) are shown. */
function updatePenFields() {
  const mode = $('#pen-mode').value, servo = mode !== 'z';
  for (const id of ['pen-up-label', 'pen-down-label']) $(`#${id}`).hidden = servo;
  for (const id of ['servo-down-label', 'pen-delay-label']) $(`#${id}`).hidden = !servo;
  $('#servo-up-label').hidden = mode !== 'servo-s';
}
/** Pen lift of the draft for the generator, the preview parser and the server's job check. */
function penLift() {
  const mode = $('#pen-mode').value;
  return mode === 'z' ? { mode, up: Number($('#pen-up').value), down: Number($('#pen-down').value) } : { mode, down: Number($('#servo-down').value), up: mode === 'servo-s' ? Number($('#servo-up').value) : null, dwell: Number($('#pen-delay').value) };
}
const motionInputs = ['feed', 'pen-mode', 'pen-up', 'pen-down', 'servo-down', 'servo-up', 'pen-delay', 'origin-corner', 'origin-x', 'origin-y', 'x-dir', 'y-dir', 'page', 'page-set', 'text-pen', 'pen'];
// Which job of the draft is generated: one page × one pen. They only change the generator output.
const JOB_INPUTS = ['page', 'page-set', 'pen'];
let toolpath = PathEngine.parse('');
let programDirty = false;
// 'generated': exact generator output → kept in sync automatically. 'manual': edited / imported → never rewritten.
let programSource = '';
let regenerateTimer;
let parseTimer;
let pathDistance = 0;

function formatBounds(b) {
  return `X ${b.minX.toFixed(1)}…${b.maxX.toFixed(1)} / Y ${b.minY.toFixed(1)}…${b.maxY.toFixed(1)}`;
}
/** Writing time estimated from feed rates (travel at SIM_RAPID_FEED) plus dwells; no acceleration model. */
function estimateSeconds(path) {
  return path.segments.reduce((sum, segment) => sum + segment.distance / ((segment.rapid ? SIM_RAPID_FEED : segment.feed) / 60), 0) + (path.dwell || 0);
}
function formatDuration(seconds) {
  const total = Math.max(1, Math.round(seconds)), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return h ? `约 ${h} 小时 ${m} 分` : m ? `约 ${m} 分 ${s} 秒` : `约 ${s} 秒`;
}
function programSummary() {
  if (!codeEditor.value.trim()) return '尚未生成 / 导入';
  if (toolpath.errors.length) return `${toolpath.errors.length} 个解析问题，禁止运行`;
  const page = programSource === 'generated' && layout.pages > 1 ? `第 ${currentPage()} / ${layout.pages} 页 · ` : '';
  const pens = usedPens(currentPage());
  const pen = programSource !== 'generated' || pens.length < 2 ? '' : $('#pen').value === 'all' ? `含 ${pens.length} 种颜色，当前程序不换笔 · ` : `只写「${penName(Number($('#pen').value))}」笔 · `;
  const time = toolpath.segments.length ? ` · 预计 ${formatDuration(estimateSeconds(toolpath))}` : '';
  return `${page}${pen}${toolpath.commands.length} 行指令 · ${toolpath.segments.length} 段轨迹${time}${programDirty ? ' · 文稿已修改，请重新生成或确认使用现有代码' : ''}`;
}
function parseProgram({ keepCamera = false } = {}) {
  clearTimeout(parseTimer);
  resetSimulation();
  pathDistance = 0;
  if (!keepCamera) resetPathCamera();
  toolpath = PathEngine.parse(codeEditor.value, Number($('#pen-down').value), penLift());
  renderLineNumbers($('#gcode-lines'), codeEditor);
  $('#code-errors').textContent = toolpath.errors.slice(0, 6).join('\n') + (toolpath.errors.length > 6 ? `\n… 另有 ${toolpath.errors.length - 6} 个问题` : '');
  $('#code-state').textContent = programSummary();
  $('#code-state').classList.toggle('has-error', toolpath.errors.length > 0);
  const seconds = estimateSeconds(toolpath);
  $('#path-stats').textContent = `${toolpath.segments.length} 段 · ${toolpath.length.toFixed(1)} mm${seconds ? ` · 预计 ${formatDuration(seconds)}` : ''} · ${formatBounds(toolpath.bounds)}`;
  $('#path-stats').title = '预计书写时间按进给速度估算（空移 3000 mm/min，含抬落笔等待），不含加减速';
  updateTask();
  drawToolpath();
  window.Workspace?.capture();
}
/** Pre-v3 storage: used once when migrating into the first workspace document. */
function loadLegacyProgram() {
  try {
    codeEditor.value = localStorage.getItem(LEGACY_PROGRAM_KEYS.code) || '';
    programDirty = localStorage.getItem(LEGACY_PROGRAM_KEYS.dirty) === 'true';
    const saved = JSON.parse(localStorage.getItem(LEGACY_PROGRAM_KEYS.motion) || '{}');
    for (const id of motionInputs) if (validSetting(id, saved[id])) $(`#${id}`).value = saved[id];
  } catch { /* Legacy data is optional. */ }
}
function drawable() {
  if (!codeEditor.value.trim() || !toolpath.segments.length) { log('请先生成或导入含运动指令的 G-code。'); selectView('gcode'); return false; }
  if (toolpath.errors.length) { log('G-code 存在不支持的指令，请先修正，未执行任何内容。'); selectView('gcode'); return false; }
  return true;
}
function markStale() {
  if (!codeEditor.value || programDirty) return;
  programDirty = true;
  window.Workspace?.capture();
  $('#code-state').textContent = '文稿 / 参数已修改，现有 G-code 未更新。请重新生成，或明确使用现有代码。';
  drawToolpath();
}
function highlightLine(line) {
  if (!line) return;
  const rows = codeEditor.value.split('\n');
  let start = 0;
  for (let index = 0; index < line - 1 && index < rows.length; index++) start += rows[index].length + 1;
  codeEditor.setSelectionRange(start, start + (rows[line - 1]?.length || 0));
  scrollToLine(codeEditor, line, $('#gcode-lines'));
}
function setProgram(text, view, source = 'manual', options) {
  codeEditor.value = text;
  programDirty = false;
  programSource = source;
  parseProgram(options);
  if (view) selectView(view);
}
function buildProgram() {
  if (!settings.every((id) => validSetting(id, $(`#${id}`).value)) || !motionInputs.every((id) => $(`#${id}`).checkValidity() && $(`#${id}`).value !== '')) throw Error('请修正排版或笔轴参数。');
  // Same layout options as the paper (formatting, formulas, list numbers, 拟真), with the applied glyph selection.
  return PathEngine.generate(content.value, { ...layoutOptions(), feed: +$('#feed').value, penUp: +$('#pen-up').value, penDown: +$('#pen-down').value, penLift: penLift(), origin: penOrigin(), resolve: glyphResolver(), page: currentPage(), paths: [...(layout.backgroundWritten ? layout.background.map((rule) => ({ page: rule.page, pen: Number($('#bg-pen').value) || 1, points: rule.points })) : []), ...layout.paths], pen: $('#pen').value, textPen: Number($('#text-pen').value) || 1 });
}
function generateProgram(view = 'gcode') {
  clearTimeout(regenerateTimer);
  try {
    setProgram(buildProgram(), view, 'generated');
    log(`已生成单线 G-code（毫米 / 绝对坐标 / ${$('#pen-mode').value === 'z' ? 'Z 轴抬笔' : '舵机抬笔'}）。真实发送前必须核对设备兼容性。`);
  } catch (error) {
    log(`生成失败，保留原有 G-code：${error.message}`);
    $('#code-errors').textContent = error.message;
    selectView(view);
  }
}
/** Generator output follows text / layout / origin edits; manual programs only get marked stale. */
function scheduleRegenerate() {
  if (programSource !== 'generated' || !codeEditor.value) return;
  clearTimeout(regenerateTimer);
  regenerateTimer = setTimeout(() => {
    if (programSource !== 'generated' || hardwareJob || controllerBusy() || window.Workspace?.blocked || simulation.state === 'running' || simulation.state === 'paused') return;
    try { setProgram(buildProgram(), null, 'generated', { keepCamera: true }); }
    catch (error) {
      $('#code-state').textContent = `无法自动更新，现有 G-code 已过期：${error.message}`;
      drawToolpath();
    }
  }, 300);
}
function downloadProgram() {
  if (!codeEditor.value.trim()) { log('没有可下载的 G-code。'); return; }
  const suffix = programSource === 'generated' && layout.pages > 1 ? `-p${currentPage()}` : '';
  const name = window.Workspace?.activeName ? window.Workspace.activeName.replace(/\.txt$/i, `${suffix}.gcode`) : `${safeFilename(title.value, 'writing')}${suffix}.gcode`;
  downloadText(codeEditor.value, name);
}

// --- Simulation: estimated from feed rates, no acceleration model. ---
function stepSimulation(cursor) {
  let remaining = SIM_TICK_MS / 1000 * Number($('#sim-speed').value);
  while (remaining > 0 && cursor.index < toolpath.segments.length) {
    const segment = toolpath.segments[cursor.index];
    const speed = (segment.rapid ? SIM_RAPID_FEED : segment.feed) / 60;
    const leftTime = (segment.distance - cursor.consumed) / speed;
    if (remaining >= leftTime) { remaining -= leftTime; cursor.consumed = 0; pathDistance = segment.length; cursor.index++; }
    else { cursor.consumed += remaining * speed; pathDistance = segment.length - segment.distance + cursor.consumed; remaining = 0; }
  }
  simulation.done = pathDistance;
  if (cursor.index >= toolpath.segments.length) {
    clearInterval(simulation.timer);
    simulation.state = 'complete';
    log('刀轨模拟完成，未向机器发送指令。');
    announceNextPage();
  }
  highlightLine(toolpath.segments[Math.min(cursor.index, toolpath.segments.length - 1)]?.line);
  updateTask();
  drawToolpath();
}
async function startSimulation() {
  if (hardwareJob || controllerBusy() || window.Workspace?.blocked) return;
  $('#start').disabled = true;
  // 梳串: save, pick up outside edits and bring the program in line with the text before running.
  if (window.Workspace?.syncBeforeRun && !await window.Workspace.syncBeforeRun()) { updateTask(); return; }
  if (hardwareJob || controllerBusy() || simulation.state === 'running') return;
  parseProgram();
  if (!drawable()) return;
  const target = window.Workspace?.activeId, source = codeEditor.value;
  if (programDirty && !await AppDialogs.confirm({ title: '模拟现有代码', message: '文稿参数已修改，G-code 尚未更新。仍使用现有代码？', confirmLabel: '模拟' })) return;
  if (hardwareJob || controllerBusy() || window.Workspace?.blocked || codeEditor.value !== source || window.Workspace?.activeId !== target) return;
  pathDistance = 0;
  simulation.state = 'running';
  simulation.total = toolpath.length;
  selectView('path');
  updateTask();
  log(`开始刀轨模拟：按指令进给速度估算；空移按 ${SIM_RAPID_FEED} mm/min，不含加减速。`);
  const cursor = { index: 0, consumed: 0 };
  simulation.timer = setInterval(() => { if (simulation.state === 'running') stepSimulation(cursor); }, SIM_TICK_MS);
}

$('#generate-code').addEventListener('click', () => generateProgram());
$('#path-regenerate').addEventListener('click', () => generateProgram('path'));
$('#load-demo').addEventListener('click', async () => {
  if ($('#help-dialog').open) $('#help-dialog').close();
  const target = window.Workspace?.activeId;
  try {
    const previousCode = codeEditor.value;
    if (previousCode.trim() && !await AppDialogs.confirm({ title: '载入示例', message: '将替换当前 G-code。', confirmLabel: '替换' })) return;
    if (hardwareJob || window.Workspace?.blocked || codeEditor.value !== previousCode) return;
    const response = await fetch('./demo.gcode');
    if (!response.ok) throw Error('示例读取失败');
    const text = await response.text();
    if (hardwareJob || (window.Workspace && window.Workspace.activeId !== target)) return;
    setProgram(text, 'path');
    log('已载入 20 × 20 mm 方框示例，可先运行模拟；不要未经确认发送到机器。');
  } catch (error) { log(error.message); }
});
$('#download-gcode').addEventListener('click', downloadProgram);
$('#import-gcode').addEventListener('click', () => $('#gcode-file').click());
$('#gcode-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  const target = window.Workspace?.activeId;
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 500000) throw Error('预览文件限制为 500 KB，请拆分任务。');
    const text = await file.text();
    if (hardwareJob || (window.Workspace && window.Workspace.activeId !== target)) throw Error('工作区状态已改变，请重新导入到目标文稿。');
    setProgram(text, 'gcode');
    log(`已导入 ${file.name}，请核对坐标与抬落笔方式。`);
  } catch (error) { log(error.message); }
});
codeEditor.addEventListener('input', () => {
  programDirty = false;
  programSource = 'manual';
  clearTimeout(regenerateTimer);
  resetSimulation('G-code 已修改，模拟重置。');
  renderLineNumbers($('#gcode-lines'), codeEditor);
  window.Workspace?.capture();
  clearTimeout(parseTimer);
  parseTimer = setTimeout(parseProgram, 250);
});
codeEditor.addEventListener('scroll', () => { $('#gcode-lines').scrollTop = codeEditor.scrollTop; });
for (const field of [content, ...settings.map((id) => $(`#${id}`)), ...motionInputs.filter((id) => !JOB_INPUTS.includes(id)).map((id) => $(`#${id}`))]) {
  field.addEventListener('input', () => { resetSimulation(); markStale(); updateTask(); scheduleRegenerate(); });
}
for (const id of motionInputs) $(`#${id}`).addEventListener('input', () => { window.Workspace?.capture(); renderPreview(); drawToolpath(); });
for (const id of ['machine-x', 'machine-y']) $(`#${id}`).addEventListener('input', updateOriginSummary);
// Switching pages only changes generator output; imported / edited programs are unaffected.
$('#page-set').addEventListener('input', () => { setPage(currentPage()); updatePagers(); });
$('#pen').addEventListener('input', updatePenPicker);
for (const id of ['bg-kind', 'bg-write']) $(`#${id}`).addEventListener('input', updateBackgroundFields);
$('#pen-mode').addEventListener('input', () => { updatePenFields(); parseProgram({ keepCamera: true }); });
updatePenFields();
/** The 笔 picker appears only when this page uses more than one pen. */
function updatePenPicker() {
  const pens = usedPens();
  $('.pen-picker').hidden = pens.length < 2 && $('#pen').value === 'all';
  for (const option of $('#pen').options) option.disabled = option.value !== 'all' && !pens.includes(Number(option.value));
}
// Drawing placement: changes re-layout immediately and count as generator parameters.
for (const key of ['page', 'x', 'y', 'width']) $(`#drawing-${key}`).addEventListener('input', () => {
  layout = makeLayout(); renderPreview(); resetSimulation(); markStale(); updateTask(); scheduleRegenerate(); window.Workspace?.capture(); updatePenPicker();
});
$('#pen').addEventListener('input', () => { if (programSource === 'generated') { resetSimulation(); markStale(); updateTask(); scheduleRegenerate(); } });
$('#page').addEventListener('input', () => { if (programSource === 'generated') { resetSimulation(); markStale(); updateTask(); scheduleRegenerate(); } });
$('#start').addEventListener('click', startSimulation);
$('#pause').addEventListener('click', () => {
  if (hardwareJob) return void bridgeAction(hardware.state === 'paused' ? 'resume' : 'pause');
  simulation.state = simulation.state === 'paused' ? 'running' : 'paused';
  updateTask();
  log(simulation.state === 'paused' ? '刀轨模拟暂停。' : '刀轨模拟继续。');
});
$('#stop').addEventListener('click', () => {
  if (hardwareJob) return void bridgeAction('stop');
  resetSimulation('刀轨模拟已停止。');
  pathDistance = 0;
  updateTask();
  drawToolpath();
});
