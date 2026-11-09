'use strict';
// Authenticated USB bridge (server.py): connection, status polling and hardware job submission.
const BRIDGE_POLL_MS = 700;
const ACTIVE_JOB_STATES = ['running', 'paused', 'draining'];
let hardware = { connected: false, state: 'disconnected', ack: 0, total: 0 };
let hardwareJob = false;
let traceVerified = false;
let ownJobId = '';
let lastHardwareMessage = '';
let bridgeKey = '';
let polling = false;
let bridgeHealthy = false;
let jobRequestPending = false;
let coordinateBusy = false;
const LOCKED_BY_CONTROLLER = ['#content', '#title', '#gcode', '#import-gcode', '#load-demo', ...motionInputs.map((id) => `#${id}`), '#machine-x', '#machine-y', '#machine-z-min', '#machine-z-max',
  ...settings.map((id) => `#${id}`), ...['x', 'y', 'z'].flatMap((axis) => ['min', 'max'].map((bound) => `#travel-${axis}-${bound}`))];

function controllerBusy() { return coordinateBusy || ['coordinate', 'sync', 'job'].includes(hardware.coordinates?.operation); }
function refreshSendButton() {
  const noDocument = Boolean(window.Workspace && (!window.Workspace.activeId || window.Workspace.blocked));
  const invalid = toolpath.errors.length > 0 || !toolpath.segments.length || noDocument;
  // Simulation 梳串s first and can generate the program from the text, so text alone is enough to start.
  const regenerable = !noDocument && (content.value.trim() || layout.paths?.length) && (programSource === 'generated' || !codeEditor.value.trim());
  const busy = hardwareJob || controllerBusy() || simulation.state === 'running' || simulation.state === 'paused';
  $('#start').disabled = busy || (invalid && !regenerable);
  $('#send-job').disabled = !bridgeHealthy || !hardware.connected || !window.Coordinates?.canSend() || busy || invalid;
}
function lockEditors(locked) {
  for (const selector of LOCKED_BY_CONTROLLER) $(selector).disabled = locked;
  window.Workspace?.refreshLocks();
}
async function api(path, body) {
  const post = body !== undefined;
  const response = await fetch(`/api/${path}`, {
    method: post ? 'POST' : 'GET',
    headers: { 'X-Bridge-Key': bridgeKey, ...(post ? { 'Content-Type': 'application/json' } : {}) },
    body: post ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(path === 'status' || path === 'ports' ? 5000 : 30000),
  });
  let data;
  try { data = await response.json(); } catch { throw Error('当前服务没有 USB 桥接接口，请改用 python3 server.py 启动。'); }
  if (!response.ok) {
    const error = Error(data.error || `桥接请求失败 ${response.status}`);
    error.httpStatus = response.status;
    error.bridgeState = data.status;
    throw error;
  }
  return data;
}
function setDeviceIndicator(state, text) {
  $('#device-status').textContent = text;
  $('#device-dot').classList.toggle('connected', state === 'connected');
  $('#device-dot').classList.toggle('warning', state === 'warning');
  const activity = $('#device-activity');
  activity.dataset.state = state;
  activity.title = `机器 · ${text}`;
  $('#machine-status').dataset.state = state;
  activity.setAttribute('aria-label', activity.title);
}
function applyHardware(state) {
  bridgeHealthy = true;
  hardware = state;
  traceVerified = Boolean(ownJobId && state.job_id === ownJobId);
  const wasJob = hardwareJob;
  hardwareJob = ACTIVE_JOB_STATES.includes(state.state);
  $('#mode-status').textContent = hardwareJob ? '机器任务进行中' : state.connected ? `已连接 ${state.port}` : '未连接机器';
  $('#mode-status').classList.toggle('hardware', hardwareJob);
  const alarm = state.portOpen && state.coordinates?.alarm;
  setDeviceIndicator(state.connected && !alarm ? 'connected' : state.portOpen ? 'warning' : 'idle', alarm ? '报警 · 可在「位置」解除' : state.connected ? `已连接 · ${state.port}` : state.portOpen ? '串口异常 · 需重连' : '未连接');
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
    $('#execution-mode').hidden = false;
    if (traceVerified) highlightLine(toolpath.commands[Math.max(0, state.ack - 1)]?.line);
  } else if (wasJob) {
    resetSimulation();
    updateTask();
    $('#task-state').textContent = state.state === 'complete' ? '设备已 Idle' : state.state === 'error' ? '设备错误' : '已停止';
    if (state.state === 'complete' && traceVerified) announceNextPage();
    $('#task-mode').textContent = '刀轨模拟';
    $('#execution-mode').textContent = '当前：仅模拟';
    $('#execution-mode').hidden = true;
  }
  lockEditors(hardwareJob || controllerBusy());
  refreshSendButton();
  drawToolpath();
  connectionButtons();
  window.dispatchEvent(new CustomEvent('bridge-state', { detail: state }));
}
function bridgeUnavailable(error) {
  bridgeHealthy = false;
  setDeviceIndicator('warning', '状态未知 · 通信异常');
  $('#bridge-status').textContent = error.message;
  window.dispatchEvent(new Event('bridge-unavailable'));
  refreshSendButton();
  connectionButtons();
}
function connectionButtons() {
  $('#serial-connect').disabled = hardware.connected || hardware.portOpen || hardwareJob || controllerBusy() || !$('#serial-port').value || !$('#bridge-key').value.trim() || !$('#protocol-confirm').checked;
  $('#serial-disconnect').disabled = !bridgeHealthy || !(hardware.connected || hardware.portOpen) || hardwareJob || controllerBusy();
  $('#refresh-ports').disabled = !$('#bridge-key').value.trim();
  if ($('#bridge-key').value.trim()) bridgeKey = $('#bridge-key').value.trim();
}
async function bridgeAction(action) {
  try { applyHardware(await api(action, {})); }
  catch (error) {
    if (!error.httpStatus) bridgeUnavailable(error);
    else if (error.bridgeState) applyHardware(error.bridgeState);
    refreshSendButton();
    connectionButtons();
    log(`[控制器] ${error.message}。请求失败不代表机器停止，请观察设备，必要时使用物理急停。`);
  }
}
async function pollHardware() {
  if (polling || jobRequestPending || !bridgeKey || (!hardware.connected && !hardware.portOpen && !hardwareJob)) return;
  polling = true;
  try { applyHardware(await api('status')); }
  catch (error) {
    bridgeUnavailable(error);
    $('#mode-status').textContent = '机器状态未知';
    if (hardwareJob) { $('#task-state').textContent = '通信中断，进度为上次应答'; }
    $('#send-job').disabled = true;
    if (lastHardwareMessage !== error.message) { log(`桥接状态未知：${error.message}。请检查实际机器；网络断开不会自动急停。`); lastHardwareMessage = error.message; }
  } finally { polling = false; }
}
async function refreshPorts() {
  bridgeKey = $('#bridge-key').value.trim();
  const button = $('#refresh-ports');
  button.disabled = true;
  $('#bridge-status').textContent = '正在查询串口…';
  try {
    const data = await api('ports');
    const previous = $('#serial-port').value;
    $('#serial-port').replaceChildren(...data.ports.map((port) => new Option(`${port.path} · ${port.name}`, port.path, false, port.path === previous)));
    if (!data.ports.length) $('#serial-port').append(new Option('未发现串口', ''));
    $('#bridge-status').textContent = data.ports.length ? `发现 ${data.ports.length} 个串口` : '未发现串口，请确认 USB 连接和驱动。';
    applyHardware(await api('status'));
  } catch (error) { $('#bridge-status').textContent = error.message; }
  connectionButtons();
}
async function connectSerial() {
  bridgeKey = $('#bridge-key').value.trim();
  if (!$('#protocol-confirm').checked) { $('#bridge-status').textContent = '请先确认设备确实使用标准 GRBL。'; connectionButtons(); return; }
  $('#serial-connect').disabled = true;
  $('#bridge-status').textContent = '正在连接并等待 GRBL 启动标识…';
  try { traceVerified = false; applyHardware(await api('connect', { port: $('#serial-port').value, baud: Number($('#baud').value), confirm: true })); }
  catch (error) { $('#bridge-status').textContent = error.message; }
  connectionButtons();
}
async function sendJob() {
  if (window.Workspace?.syncBeforeRun && !await window.Workspace.syncBeforeRun()) { log('梳串失败（未保存或文件冲突），未发送。'); return; }
  parseProgram();
  if (!drawable()) return;
  if (programDirty) { log('G-code 与当前文稿 / 笔起点不一致（已过期），请重新生成后再发送；未发送任何内容。'); selectView('path'); return; }
  if (!$('#safety-confirm').checked) { openConnection('pane-limits'); $('#safety-confirm').focus(); log('请先在「机器 › 行程与安全」核对并勾选发送前确认。'); return; }
  // 运笔 presses past the pen-down Z: say so here instead of a bare range error from the server.
  if (toolpath.bounds.minZ < Number($('#machine-z-min').value) - 1e-9 || toolpath.bounds.maxZ > Number($('#machine-z-max').value) + 1e-9) { openConnection('pane-limits'); log(`程序的 Z 范围 ${toolpath.bounds.minZ.toFixed(2)}…${toolpath.bounds.maxZ.toFixed(2)} mm 超出「行程与安全」的 Z 下限 / 上限。运笔会越过落笔 Z 继续加压，请核对弹簧笔架行程后调整 Z 范围或压深；未发送。`); return; }
  const target = window.Workspace?.activeId, source = codeEditor.value;
  const approved = window.Coordinates?.snapshot();
  const machine = window.Coordinates?.machineLimits();
  if (!approved?.ready || !approved.idle) { log('坐标未就绪，请先读取并确认纸张原点。'); return; }
  if (!machine) { openConnection('pane-limits'); log('请在「机器 › 行程与安全」填写机器 XYZ 最小 / 最大行程（机器坐标）。'); return; }
  const liftText = $('#pen-mode').value === 'z' ? 'Z 轴抬笔' : `舵机抬笔（落笔 M3 S${$('#servo-down').value}，抬笔 ${$('#pen-mode').value === 'servo-m5' ? 'M5' : `M3 S${$('#servo-up').value}`}）`;
  if (!await AppDialogs.confirm({ title: '发送至真实机器', message: `坐标系 ${approved.wcs} · ${liftText}。请核对纸张原点、机器行程与抬落笔方式，并准备好物理急停。`, confirmLabel: '确认发送', danger: true })) return;
  if (!bridgeHealthy || !hardware.connected || hardwareJob || controllerBusy() || window.Coordinates?.snapshot()?.token !== approved.token || window.Workspace?.blocked || !$('#safety-confirm').checked || codeEditor.value !== source || window.Workspace?.activeId !== target) { log('设备或程序状态已改变，请重新检查后发送。'); return; }
  // Paper area (dialog width / height) mapped through the pen origin into work coordinates.
  const area = paperWorkBounds(+$('#machine-x').value, +$('#machine-y').value);
  const limits = { ...area, x: +$('#machine-x').value, y: +$('#machine-y').value, zmin: +$('#machine-z-min').value, zmax: +$('#machine-z-max').value };
  const previous = { ...hardware };
  const lines = toolpath.commands.map((command) => command.code);
  jobRequestPending = true;
  hardwareJob = true;
  lockEditors(true);
  refreshSendButton();
  $('#pause').disabled = true; $('#stop').disabled = true;
  $('#task-mode').textContent = '真实设备';
  $('#mode-status').textContent = '正在提交任务';
  $('#task-state').textContent = '提交中，等待服务确认';
  $('#execution-mode').textContent = '正在提交硬件任务（不自动重试）';
  $('#execution-mode').hidden = false;
  try {
    // Servo pen lift: the server then accepts exactly these M3 S / M5 / G4 P lines and nothing else.
    const lift = penLift();
    const result = await api('job', { lines, limits, machine, expected: approved.token, reviewed: true, ...(lift.mode === 'z' ? {} : { pen: lift }) });
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
      setDeviceIndicator('warning', '任务提交结果未知');
      $('#mode-status').textContent = '任务结果待确认';
      $('#task-state').textContent = '提交结果未知，正在重新查询';
      $('#pause').disabled = false; $('#stop').disabled = false;
      log(`任务提交结果未知：${error.message}。机器可能已经开始执行，未自动重发；请观察机器，必要时物理急停。`);
    }
  } finally {
    jobRequestPending = false;
    refreshSendButton();
    connectionButtons();
  }
}

$('#refresh-ports').addEventListener('click', refreshPorts);
for (const id of ['bridge-key', 'serial-port', 'protocol-confirm']) $(`#${id}`).addEventListener('input', connectionButtons);
$('#bridge-key').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); if (!$('#refresh-ports').disabled) refreshPorts(); } });
$('#serial-connect').addEventListener('click', connectSerial);
$('#serial-disconnect').addEventListener('click', () => bridgeAction('disconnect'));
$('#send-job').addEventListener('click', sendJob);
// The access key is stable across server restarts (.bridge-key) and remembered on this device.
try { const saved = localStorage.getItem('penfall:bridge-key'); if (saved) { $('#bridge-key').value = saved; bridgeKey = saved; } } catch { /* optional */ }
$('#bridge-key').addEventListener('change', () => { try { const value = $('#bridge-key').value.trim(); if (value) localStorage.setItem('penfall:bridge-key', value); } catch { /* optional */ } });
connectionButtons();
setInterval(pollHardware, BRIDGE_POLL_MS);
