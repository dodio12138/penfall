'use strict';
let toolpath = PathEngine.parse('');
let programDirty = false;
let hardware = { connected: false, state: 'disconnected', ack: 0, total: 0 };
let hardwareJob = false;
let traceVerified = false;
let ownJobId = '';
let lastHardwareMessage = '';
let bridgeKey = '';
let polling = false;
let parseTimer;
let pathDistance = 0;
let bridgeHealthy = false;
let jobRequestPending = false;
let coordinateBusy = false;
function controllerBusy() { return coordinateBusy || ['coordinate','sync','job'].includes(hardware.coordinates?.operation); }
const pathCamera = { zoom: 1, x: 0, y: 0 };
const activeStates = ['running', 'paused', 'draining'];
const codeEditor = $('#gcode');
const motionInputs = ['feed', 'pen-up', 'pen-down'];

function codeLineNumbers() {
  $('#gcode-lines').textContent = Array.from({ length: codeEditor.value.split('\n').length }, (_, i) => i + 1).join('\n');
  $('#gcode-lines').scrollTop = codeEditor.scrollTop;
}
function parseProgram() {
  clearTimeout(parseTimer);
  resetSimulation();
  pathDistance = 0;
  Object.assign(pathCamera, { zoom:1, x:0, y:0 });
  toolpath = PathEngine.parse(codeEditor.value, Number($('#pen-down').value));
  codeLineNumbers();
  $('#code-errors').textContent = toolpath.errors.slice(0, 6).join('\n');
  $('#code-state').textContent = !codeEditor.value.trim() ? '' : toolpath.errors.length ? `${toolpath.errors.length} 个解析问题，禁止运行` : `${toolpath.commands.length} 行指令 · ${toolpath.segments.length} 段轨迹${programDirty ? ' · 文稿已修改，请重新生成或确认使用现有代码' : ''}`;
  $('#path-stats').textContent = `${toolpath.segments.length} 段 · ${toolpath.length.toFixed(1)} mm · X ${toolpath.bounds.minX.toFixed(1)}…${toolpath.bounds.maxX.toFixed(1)} / Y ${toolpath.bounds.minY.toFixed(1)}…${toolpath.bounds.maxY.toFixed(1)}`;
  updateTask();
  refreshSendButton();
  drawToolpath();
  if (window.Workspace) window.Workspace.capture();
  else try { localStorage.setItem('web-typewriter:gcode:v1', codeEditor.value); localStorage.setItem('web-typewriter:gcode-dirty:v1', String(programDirty)); } catch { log('G-code 本地保存失败，请下载备份。'); }
}
function drawable() {
  if (!codeEditor.value.trim() || !toolpath.segments.length) { log('请先生成或导入含运动指令的 G-code。'); selectView('gcode'); return false; }
  if (toolpath.errors.length) { log('G-code 存在不支持的指令，请先修正，未执行任何内容。'); selectView('gcode'); return false; }
  return true;
}
function drawToolpath() {
  if ($('#path-view').hidden) return;
  const canvas = $('#toolpath');
  const container = $('.path-stage');
  const w = Math.max(200, container.clientWidth), h = Math.max(120, container.clientHeight);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const theme = getComputedStyle(document.documentElement);
  const palette = {};
  const color = name => palette[name] || (palette[name] = theme.getPropertyValue(name).trim());
  ctx.fillStyle = color('--bg'); ctx.fillRect(0, 0, w, h);
  $('#path-empty').hidden = toolpath.segments.length > 0;
  if (!toolpath.segments.length) { $('#path-position').hidden = true; $('#path-zoom').textContent = '100%'; return; }
  const b = toolpath.bounds;
  const rangeX = Math.max(10, b.maxX - b.minX), rangeY = Math.max(10, b.maxY - b.minY);
  const scale = Math.max(.01, Math.min((w - 80) / rangeX, (h - 70) / rangeY)) * pathCamera.zoom;
  const ox = (w - rangeX * scale) / 2 - b.minX * scale + pathCamera.x;
  const oy = (h + rangeY * scale) / 2 + b.minY * scale + pathCamera.y;
  $('#path-zoom').textContent = `${Math.round(pathCamera.zoom * 100)}%`;
  const xy = p => [ox + p.x * scale, oy - p.y * scale];
  const targetGrid = Math.max(Math.max(rangeX, rangeY) / 8, 55 / scale);
  const gridBase = Math.pow(10, Math.floor(Math.log10(targetGrid)));
  const grid = ([1, 2, 5, 10].find(value => value * gridBase >= targetGrid) || 10) * gridBase;
  ctx.strokeStyle = '#ffffff0a'; ctx.lineWidth = 1;
  ctx.fillStyle = color('--quiet'); ctx.font = '10px monospace';
  for (let x = Math.floor(b.minX / grid) * grid; x <= b.maxX + grid; x += grid) {
    const px = xy({ x, y: 0 })[0];
    ctx.beginPath(); ctx.moveTo(px, 15); ctx.lineTo(px, h - 24); ctx.stroke(); ctx.fillText(`${+x.toFixed(2)}`, px + 3, h - 12);
  }
  for (let y = Math.floor(b.minY / grid) * grid; y <= b.maxY + grid; y += grid) {
    const py = xy({ x: 0, y })[1];
    ctx.beginPath(); ctx.moveTo(25, py); ctx.lineTo(w - 15, py); ctx.stroke();
  }
  let current = { x: 0, y: 0, z: 0 }, currentLine = 0;
  const active = hardwareJob || simulation.state !== 'idle';
  for (const segment of toolpath.segments) {
    const from = xy(segment.from), to = xy(segment.to);
    if (segment.drawing || $('#show-travel').checked) {
      ctx.strokeStyle = color(segment.drawing ? '--path-draw' : '--path-travel');
      ctx.lineWidth = segment.drawing ? 1.4 : .8;
      ctx.setLineDash(segment.drawing ? [] : [4, 4]);
      ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(...to); ctx.stroke();
    }
    let fraction = 0;
    if (hardwareJob && traceVerified) {
      const acknowledgedLine = toolpath.commands[Math.max(0, hardware.ack - 1)]?.line || 0;
      fraction = hardware.ack > 0 && segment.line <= acknowledgedLine ? 1 : 0;
    } else if (!hardwareJob && active) fraction = Math.max(0, Math.min(1, (pathDistance - (segment.length - segment.distance)) / segment.distance));
    if (fraction > 0) {
      current = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, segment.from[axis] + (segment.to[axis] - segment.from[axis]) * fraction]));
      currentLine = segment.line;
      if (segment.drawing || $('#show-travel').checked) {
        ctx.strokeStyle = color(segment.drawing ? '--success' : '--accent'); ctx.lineWidth = segment.drawing ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(...xy(current)); ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);
  if (active && (!hardwareJob || traceVerified)) {
    const [px, py] = xy(current);
    ctx.strokeStyle = color('--warning'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.moveTo(px - 10, py); ctx.lineTo(px + 10, py); ctx.moveTo(px, py - 10); ctx.lineTo(px, py + 10); ctx.stroke();
  }
  $('#path-position').hidden = !active;
  $('#path-position').textContent = hardwareJob && !traceVerified ? '其他会话任务，无法关联轨迹' : !active ? '' : `${hardwareJob ? '已应答目标（非实测）' : '模拟位置'} · X ${current.x.toFixed(2)} · Y ${current.y.toFixed(2)} · Z ${current.z.toFixed(2)} mm${currentLine ? ` · 第 ${currentLine} 行` : ''}`;
  $('#path-stats').title = '轨迹长度包含抬落笔 Z 运动；模拟空移按 3000 mm/min 估算，不包含加减速。';
}
function markStale() {
  if (!codeEditor.value) return;
  programDirty = true;
  if (window.Workspace) window.Workspace.capture();
  else try { localStorage.setItem('web-typewriter:gcode-dirty:v1', 'true'); } catch { /* Export remains available. */ }
  $('#code-state').textContent = '文稿 / 参数已修改，现有 G-code 未更新。请重新生成，或明确使用现有代码。';
  drawToolpath();
}
function highlightLine(line) {
  if (!line) return;
  const rows = codeEditor.value.split('\n');
  const start = rows.slice(0, line - 1).reduce((sum, row) => sum + row.length + 1, 0);
  codeEditor.setSelectionRange(start, start + (rows[line - 1]?.length || 0));
  codeEditor.scrollTop = Math.max(0, (line - 4) * 26);
  $('#gcode-lines').scrollTop = codeEditor.scrollTop;
}
function downloadProgram() {
  if (!codeEditor.value.trim()) { log('没有可下载的 G-code。'); return; }
  const url = URL.createObjectURL(new Blob([codeEditor.value], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url;
  a.download = window.Workspace?.activeName ? window.Workspace.activeName.replace(/\.txt$/i, '.gcode') : `${(title.value.trim() || 'writing').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}.gcode`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function refreshSendButton() {
  const invalid = toolpath.errors.length > 0 || !toolpath.segments.length || Boolean(window.Workspace && (!window.Workspace.activeId || window.Workspace.blocked));
  const busy = hardwareJob || controllerBusy() || simulation.state === 'running' || simulation.state === 'paused';
  $('#start').disabled = busy || invalid;
  $('#send-job').disabled = !bridgeHealthy || !hardware.connected || !window.Coordinates?.canSend() || busy || invalid;
}
function lockEditors(locked) {
  for (const selector of ['#content', '#title', '#gcode', '#generate', '#import-gcode', '#load-demo', '#feed', '#pen-up', '#pen-down', '#machine-x', '#machine-y', '#machine-z-min', '#machine-z-max', ...settings.map(id => `#${id}`), ...['x','y','z'].flatMap(axis => ['min','max'].map(bound => `#travel-${axis}-${bound}`))]) $(selector).disabled = locked;
  window.Workspace?.refreshLocks();
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Bridge-Key': bridgeKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === 'status' || path === 'ports' ? 5000 : 30000) });
  let data;
  try { data = await response.json(); } catch { throw Error('当前服务没有 USB 桥接接口，请改用 python3 server.py 启动。'); }
  if (!response.ok) { const error = Error(data.error || `桥接请求失败 ${response.status}`); error.httpStatus = response.status; error.bridgeState = data.status; throw error; }
  return data;
}
function applyHardware(state) {
  bridgeHealthy = true;
  hardware = state;
  traceVerified = Boolean(ownJobId && state.job_id === ownJobId);
  const wasJob = hardwareJob;
  hardwareJob = activeStates.includes(state.state);
  $('#mode-status').textContent = hardwareJob ? '◉ 真实设备任务' : '◉ 模拟模式';
  $('#device-status').textContent = state.connected ? `已连接 · ${state.port}` : state.portOpen ? '串口异常 · 需重连' : '未连接';
  $('#device-dot').classList.toggle('connected', state.connected);
  $('#connection-note').textContent = state.connected ? 'GRBL 1.1' : '仅支持已确认的 GRBL 1.1 控制器';
  $('#bridge-status').textContent = state.message;
  if (state.message && state.message !== lastHardwareMessage) { log(`[控制器] ${state.message}`); lastHardwareMessage = state.message; }
  if (hardwareJob) {
    resetSimulation();
    simulation.state = state.state === 'paused' ? 'paused' : 'running';
    simulation.total = state.total || 1;
    simulation.done = state.ack;
    updateTask();
    $('#task-state').textContent = state.state === 'draining' ? '等待 Idle' : `已应答 ${state.ack}/${state.total}`;
    $('#task-mode').textContent = '真实设备';
    $('#execution-mode').textContent = '硬件任务 · 进度为指令应答，非实测';
    if (traceVerified) highlightLine(toolpath.commands[Math.max(0, state.ack - 1)]?.line);
  } else if (wasJob) {
    resetSimulation();
    updateTask();
    $('#task-state').textContent = state.state === 'complete' ? '设备已 Idle' : state.state === 'error' ? '设备错误' : '已停止';
    $('#task-mode').textContent = '刀轨模拟';
    $('#execution-mode').textContent = '当前：仅模拟';
  }
  lockEditors(hardwareJob || controllerBusy());
  $('#start').disabled = hardwareJob || simulation.state === 'running' || simulation.state === 'paused';
  refreshSendButton(); drawToolpath();
  connectionButtons();
  window.dispatchEvent(new CustomEvent('bridge-state', { detail:state }));
}
function bridgeUnavailable(error) {
  bridgeHealthy = false;
  $('#device-status').textContent = '状态未知 · 通信异常';
  $('#device-dot').classList.remove('connected');
  $('#bridge-status').textContent = error.message;
  window.dispatchEvent(new Event('bridge-unavailable'));
  refreshSendButton(); connectionButtons();
}
function connectionButtons() {
  $('#serial-connect').disabled = hardware.connected || hardware.portOpen || hardwareJob || controllerBusy() || !$('#serial-port').value || !$('#bridge-key').value.trim() || !$('#protocol-confirm').checked;
  $('#serial-disconnect').disabled = !bridgeHealthy || !(hardware.connected || hardware.portOpen) || hardwareJob || controllerBusy();
}
async function bridgeAction(action) {
  try { applyHardware(await api(action, {})); }
  catch (error) {
    if (!error.httpStatus) {
      bridgeUnavailable(error);
    }
    refreshSendButton(); connectionButtons();
    log(`[控制器] ${error.message}。请求失败不代表机器停止，请观察设备，必要时使用物理急停。`);
  }
}
async function pollHardware() {
  if (polling || jobRequestPending || !bridgeKey || (!hardware.connected && !hardware.portOpen && !hardwareJob)) return;
  polling = true;
  try { applyHardware(await api('status')); }
  catch (error) {
    bridgeUnavailable(error);
    if (hardwareJob) { $('#mode-status').textContent = '◉ 硬件状态未知'; $('#task-state').textContent = '通信中断，进度为上次应答'; }
    $('#send-job').disabled = true;
    $('#connection-note').textContent = '桥接通信异常。机器可能仍在执行，必要时请使用物理急停。';
    if (lastHardwareMessage !== error.message) { log(`桥接状态未知：${error.message}。请检查实际机器；网络断开不会自动急停。`); lastHardwareMessage = error.message; }
  } finally { polling = false; }
}

$('#gcode-tab').addEventListener('click', () => selectView('gcode'));
$('#path-tab').addEventListener('click', () => selectView('path'));
window.addEventListener('workspace-view', (event) => { if (event.detail === 'path') requestAnimationFrame(drawToolpath); });
new ResizeObserver(drawToolpath).observe($('.path-stage'));
$('#show-travel').addEventListener('change', drawToolpath);
$('#fit-path').addEventListener('click', () => { Object.assign(pathCamera, { zoom:1, x:0, y:0 }); drawToolpath(); });
$('#toolpath').addEventListener('wheel', event => {
  event.preventDefault();
  pathCamera.zoom = Math.max(.2, Math.min(10, pathCamera.zoom * Math.exp(-event.deltaY * .0015)));
  drawToolpath();
}, { passive:false });
$('#toolpath').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const canvas = event.currentTarget;
  let x=event.clientX, y=event.clientY;
  canvas.setPointerCapture(event.pointerId);
  const move = pointer => { pathCamera.x += pointer.clientX-x; pathCamera.y += pointer.clientY-y; x=pointer.clientX; y=pointer.clientY; drawToolpath(); };
  const end = () => { canvas.removeEventListener('pointermove',move); canvas.removeEventListener('pointerup',end); canvas.removeEventListener('pointercancel',end); };
  canvas.addEventListener('pointermove',move); canvas.addEventListener('pointerup',end); canvas.addEventListener('pointercancel',end);
});
$('#generate').addEventListener('click', () => {
  try {
    if (!settings.every(id => validSetting(id, $(`#${id}`).value)) || !motionInputs.every(id => $(`#${id}`).checkValidity() && $(`#${id}`).value !== '')) throw Error('请修正排版或笔轴参数。');
    const c = config();
    codeEditor.value = PathEngine.generate(content.value, { width: layout.width, height: layout.height, margin: +c.margin, size: +c['font-size'], gap: +c['letter-gap'], lineGap: +c['line-gap'], feed: +$('#feed').value, penUp: +$('#pen-up').value, penDown: +$('#pen-down').value });
    programDirty = false; parseProgram(); selectView('gcode');
    log('已生成单线 G-code（毫米 / 绝对坐标 / Z 轴抬笔）。真实发送前必须核对设备兼容性。');
  } catch (error) { log(`生成失败，保留原有 G-code：${error.message}`); $('#code-errors').textContent = error.message; selectView('gcode'); }
});
$('#load-demo').addEventListener('click', async () => {
  if ($('#help-dialog').open) $('#help-dialog').close();
  const target = window.Workspace?.activeId;
  try {
    const previousCode = codeEditor.value;
    if (previousCode.trim() && !await AppDialogs.confirm({title:'载入示例',message:'将替换当前 G-code。',confirmLabel:'替换'})) return;
    if (hardwareJob || window.Workspace?.blocked || codeEditor.value !== previousCode) return;
    const response = await fetch('./demo.gcode');
    if (!response.ok) throw Error('示例读取失败');
    const text = await response.text();
    if (hardwareJob || (window.Workspace && window.Workspace.activeId !== target)) return;
    codeEditor.value = text; programDirty = false; parseProgram(); selectView('path');
    log('已载入 20 × 20 mm 方框示例，可先运行模拟；不要未经确认发送到机器。');
  } catch (error) { log(error.message); }
});
$('#download-gcode').addEventListener('click', downloadProgram);
$('#import-gcode').addEventListener('click', () => $('#gcode-file').click());
$('#gcode-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  const target = window.Workspace?.activeId;
  if (!file) return;
  try {
    if (file.size > 500000) throw Error('预览文件限制为 500 KB，请拆分任务。');
    const text = await file.text();
    if (hardwareJob || (window.Workspace && window.Workspace.activeId !== target)) throw Error('工作区状态已改变，请重新导入到目标文稿。');
    codeEditor.value = text; programDirty = false; parseProgram(); selectView('gcode'); log(`已导入 ${file.name}，请核对坐标与抬落笔方式。`);
  } catch (error) { log(error.message); }
  event.target.value = '';
});
codeEditor.addEventListener('input', () => { programDirty = false; window.Workspace?.capture(); resetSimulation('G-code 已修改，模拟重置。'); parseTimer = (clearTimeout(parseTimer), setTimeout(parseProgram, 250)); });
codeEditor.addEventListener('scroll', () => { $('#gcode-lines').scrollTop = codeEditor.scrollTop; });
for (const field of [content, ...settings.map(id => $(`#${id}`)), ...motionInputs.map(id => $(`#${id}`))]) field.addEventListener('input', () => { resetSimulation(); updateTask(); markStale(); refreshSendButton(); });
for (const id of motionInputs) $(`#${id}`).addEventListener('input', () => {
  if (window.Workspace) window.Workspace.capture();
  else try { localStorage.setItem('web-typewriter:motion:v1', JSON.stringify(Object.fromEntries(motionInputs.map(name => [name, $(`#${name}`).value])))); } catch { /* Not required for execution. */ }
});
$('#start').addEventListener('click', async () => {
  if (hardwareJob || controllerBusy() || window.Workspace?.blocked) return;
  parseProgram();
  if (!drawable()) return;
  const target = window.Workspace?.activeId, source = codeEditor.value;
  if (programDirty && !await AppDialogs.confirm({title:'模拟现有代码',message:'文稿参数已修改，G-code 尚未更新。仍使用现有代码？',confirmLabel:'模拟'})) return;
  if (hardwareJob || controllerBusy() || window.Workspace?.blocked || codeEditor.value !== source || window.Workspace?.activeId !== target) return;
  pathDistance = 0;
  simulation.state = 'running'; simulation.total = toolpath.length;
  selectView('path'); updateTask(); refreshSendButton();
  log('开始刀轨模拟：按指令进给速度估算；空移按 3000 mm/min，不含加减速。');
  let segmentIndex = 0, consumed = 0;
  simulation.timer = setInterval(() => {
    if (simulation.state !== 'running') return;
    let remaining = .05 * Number($('#sim-speed').value);
    while (remaining > 0 && segmentIndex < toolpath.segments.length) {
      const segment = toolpath.segments[segmentIndex];
      const speed = (segment.rapid ? 3000 : segment.feed) / 60;
      const leftTime = (segment.distance - consumed) / speed;
      if (remaining >= leftTime) { remaining -= leftTime; consumed = 0; pathDistance = segment.length; segmentIndex++; }
      else { consumed += remaining * speed; pathDistance = segment.length - segment.distance + consumed; remaining = 0; }
    }
    simulation.done = pathDistance;
    if (segmentIndex >= toolpath.segments.length) { clearInterval(simulation.timer); simulation.state = 'complete'; log('刀轨模拟完成，未向机器发送指令。'); }
    highlightLine(toolpath.segments[Math.min(segmentIndex, toolpath.segments.length - 1)]?.line);
    updateTask(); refreshSendButton(); drawToolpath();
  }, 50);
});
$('#pause').addEventListener('click', () => {
  if (hardwareJob) return void bridgeAction(hardware.state === 'paused' ? 'resume' : 'pause');
  simulation.state = simulation.state === 'paused' ? 'running' : 'paused';
  updateTask(); log(simulation.state === 'paused' ? '刀轨模拟暂停。' : '刀轨模拟继续。');
});
$('#stop').addEventListener('click', () => {
  if (hardwareJob) return void bridgeAction('stop');
  resetSimulation('刀轨模拟已停止。'); pathDistance = 0; updateTask(); refreshSendButton(); drawToolpath();
});
$('#refresh-ports').addEventListener('click', async () => {
  bridgeKey = $('#bridge-key').value.trim();
  try {
    const data = await api('ports');
    $('#serial-port').replaceChildren();
    data.ports.forEach(port => { const option = document.createElement('option'); option.value = port.path; option.textContent = `${port.path} · ${port.name}`; $('#serial-port').append(option); });
    $('#bridge-status').textContent = data.ports.length ? `发现 ${data.ports.length} 个串口` : '未发现串口，请确认 USB 连接和驱动。';
    applyHardware(await api('status'));
  } catch (error) { $('#bridge-status').textContent = error.message; }
  connectionButtons();
});
for (const id of ['bridge-key','serial-port','protocol-confirm']) $(`#${id}`).addEventListener('input', connectionButtons);
connectionButtons();
$('#serial-connect').addEventListener('click', async () => {
  $('#serial-connect').disabled = true;
  bridgeKey = $('#bridge-key').value.trim();
  if (!$('#protocol-confirm').checked) { $('#bridge-status').textContent = '请先确认设备确实使用标准 GRBL。'; return; }
  try { traceVerified = false; applyHardware(await api('connect', { port: $('#serial-port').value, baud: Number($('#baud').value), confirm: true })); }
  catch (error) { $('#bridge-status').textContent = error.message; }
  connectionButtons();
});
$('#serial-disconnect').addEventListener('click', () => bridgeAction('disconnect'));
$('#send-job').addEventListener('click', async () => {
  parseProgram();
  if (!drawable()) return;
  if (!$('#safety-confirm').checked) { openConnection(); $('#bridge-status').textContent = '请先核对并勾选发送前安全确认。'; return; }
  const target = window.Workspace?.activeId, source = codeEditor.value;
  const approved = window.Coordinates?.snapshot();
  const machine = window.Coordinates?.machineLimits();
  if (!approved?.ready || !approved.idle) { log('坐标未就绪，请先读取并确认纸张原点。'); return; }
  if (!machine) { openConnection(); $('#bridge-status').textContent = '请填写并核对机器 XYZ 最小 / 最大行程（机器坐标）。'; return; }
  if (!await AppDialogs.confirm({title:'发送至真实机器',message:`坐标系 ${approved.wcs}。请核对纸张原点、机器行程与抬落笔方式，并准备好物理急停。`,confirmLabel:'确认发送',danger:true})) return;
  if (!bridgeHealthy || !hardware.connected || hardwareJob || controllerBusy() || window.Coordinates?.snapshot()?.token !== approved.token || window.Workspace?.blocked || !$('#safety-confirm').checked || codeEditor.value !== source || window.Workspace?.activeId !== target) { log('设备或程序状态已改变，请重新检查后发送。'); return; }
  const limits = { x: +$('#machine-x').value, y: +$('#machine-y').value, zmin: +$('#machine-z-min').value, zmax: +$('#machine-z-max').value };
  const previous = { ...hardware };
  const lines = toolpath.commands.map(command => command.code);
  jobRequestPending = true;
  hardwareJob = true;
  lockEditors(true); refreshSendButton();
  $('#pause').disabled = true; $('#stop').disabled = true;
  $('#task-mode').textContent = '真实设备';
  $('#mode-status').textContent = '◉ 提交硬件任务中';
  $('#task-state').textContent = '提交中，等待服务确认';
  $('#execution-mode').textContent = '正在提交硬件任务（不自动重试）';
  try {
    const result = await api('job', { lines, limits, machine, expected:approved.token, reviewed: true });
    ownJobId = result.job_id;
    applyHardware(result);
    selectView('path');
  } catch (error) {
    traceVerified = false;
    if (error.httpStatus >= 400 && error.httpStatus < 500) {
      if (error.bridgeState) applyHardware(error.bridgeState);
      else { applyHardware(previous); bridgeUnavailable(error); }
      $('#task-state').textContent = '任务被服务拒绝';
      log(`服务拒绝了任务：${error.message}`);
    } else {
      bridgeUnavailable(error);
      ownJobId = '';
      $('#device-status').textContent = '任务提交结果未知';
      $('#device-dot').classList.remove('connected');
      $('#mode-status').textContent = '◉ 硬件状态待确认';
      $('#task-state').textContent = '提交结果未知，正在重新查询';
      $('#pause').disabled = false; $('#stop').disabled = false;
      log(`任务提交结果未知：${error.message}。机器可能已经开始执行，未自动重发；请观察机器，必要时物理急停。`);
    }
  } finally {
    jobRequestPending = false;
    refreshSendButton(); connectionButtons();
  }
});
setInterval(pollHardware, 700);
try {
  codeEditor.value = localStorage.getItem('web-typewriter:gcode:v1') || '';
  programDirty = localStorage.getItem('web-typewriter:gcode-dirty:v1') === 'true';
  const saved = JSON.parse(localStorage.getItem('web-typewriter:motion:v1') || '{}');
  for (const id of motionInputs) if (validSetting(id, saved[id])) $(`#${id}`).value = saved[id];
} catch { /* Editing remains available. */ }
parseProgram();
