'use strict';
// G-code program: parse, generate, import/export, stale tracking and the toolpath simulation.
const LEGACY_PROGRAM_KEYS = { code: 'web-typewriter:gcode:v1', dirty: 'web-typewriter:gcode-dirty:v1', motion: 'web-typewriter:motion:v1' };
const SIM_TICK_MS = 50;
const SIM_RAPID_FEED = 3000; // mm/min estimate for G0 travel moves.
const codeEditor = $('#gcode');
const motionInputs = ['feed', 'pen-up', 'pen-down'];
let toolpath = PathEngine.parse('');
let programDirty = false;
let parseTimer;
let pathDistance = 0;

function formatBounds(b) {
  return `X ${b.minX.toFixed(1)}…${b.maxX.toFixed(1)} / Y ${b.minY.toFixed(1)}…${b.maxY.toFixed(1)}`;
}
function programSummary() {
  if (!codeEditor.value.trim()) return '尚未生成 / 导入';
  if (toolpath.errors.length) return `${toolpath.errors.length} 个解析问题，禁止运行`;
  return `${toolpath.commands.length} 行指令 · ${toolpath.segments.length} 段轨迹${programDirty ? ' · 文稿已修改，请重新生成或确认使用现有代码' : ''}`;
}
function parseProgram() {
  clearTimeout(parseTimer);
  resetSimulation();
  pathDistance = 0;
  resetPathCamera();
  toolpath = PathEngine.parse(codeEditor.value, Number($('#pen-down').value));
  renderLineNumbers($('#gcode-lines'), codeEditor);
  $('#code-errors').textContent = toolpath.errors.slice(0, 6).join('\n') + (toolpath.errors.length > 6 ? `\n… 另有 ${toolpath.errors.length - 6} 个问题` : '');
  $('#code-state').textContent = programSummary();
  $('#code-state').classList.toggle('has-error', toolpath.errors.length > 0);
  $('#path-stats').textContent = `${toolpath.segments.length} 段 · ${toolpath.length.toFixed(1)} mm · ${formatBounds(toolpath.bounds)}`;
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
function setProgram(text, view) {
  codeEditor.value = text;
  programDirty = false;
  parseProgram();
  if (view) selectView(view);
}
function generateProgram() {
  try {
    if (!settings.every((id) => validSetting(id, $(`#${id}`).value)) || !motionInputs.every((id) => $(`#${id}`).checkValidity() && $(`#${id}`).value !== '')) throw Error('请修正排版或笔轴参数。');
    const c = config();
    const text = PathEngine.generate(content.value, { width: layout.width, height: layout.height, margin: +c.margin, size: +c['font-size'], gap: +c['letter-gap'], lineGap: +c['line-gap'], feed: +$('#feed').value, penUp: +$('#pen-up').value, penDown: +$('#pen-down').value });
    setProgram(text, 'gcode');
    log('已生成单线 G-code（毫米 / 绝对坐标 / Z 轴抬笔）。真实发送前必须核对设备兼容性。');
  } catch (error) {
    log(`生成失败，保留原有 G-code：${error.message}`);
    $('#code-errors').textContent = error.message;
    selectView('gcode');
  }
}
function downloadProgram() {
  if (!codeEditor.value.trim()) { log('没有可下载的 G-code。'); return; }
  const name = window.Workspace?.activeName ? window.Workspace.activeName.replace(/\.txt$/i, '.gcode') : `${safeFilename(title.value, 'writing')}.gcode`;
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
  }
  highlightLine(toolpath.segments[Math.min(cursor.index, toolpath.segments.length - 1)]?.line);
  updateTask();
  drawToolpath();
}
async function startSimulation() {
  if (hardwareJob || controllerBusy() || window.Workspace?.blocked) return;
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

$('#generate').addEventListener('click', generateProgram);
$('#generate-code').addEventListener('click', generateProgram);
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
  resetSimulation('G-code 已修改，模拟重置。');
  renderLineNumbers($('#gcode-lines'), codeEditor);
  window.Workspace?.capture();
  clearTimeout(parseTimer);
  parseTimer = setTimeout(parseProgram, 250);
});
codeEditor.addEventListener('scroll', () => { $('#gcode-lines').scrollTop = codeEditor.scrollTop; });
for (const field of [content, ...settings.map((id) => $(`#${id}`)), ...motionInputs.map((id) => $(`#${id}`))]) {
  field.addEventListener('input', () => { resetSimulation(); markStale(); updateTask(); });
}
for (const id of motionInputs) $(`#${id}`).addEventListener('input', () => window.Workspace?.capture());
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
