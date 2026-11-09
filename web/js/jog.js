'use strict';
// 机器 › 点动: move one machine axis by a step, or continuously while a button is held.
// Uses GRBL's $J= jog (server.py → grbl.Session.jog): relative, modal state untouched, cancelable with 0x85.
// Hold mode queues short segments (≈0.25 s of travel, at most 2 in flight) and cancels on release, so a lost
// connection lets the machine run on for at most about half a second.
(() => {
  const SEGMENT_SECONDS = .25, HOLD_INTERVAL_MS = 200, MAX_IN_FLIGHT = 2;
  let holding = null; // { axis, dir, timer, inFlight, button }
  let busy = false, lastError = '';

  /** Travel limits per axis (machine coordinates) for the axes whose min / max are filled in. */
  function limits() {
    const result = {};
    for (const axis of 'xyz') {
      const low = $(`#travel-${axis}-min`), high = $(`#travel-${axis}-max`);
      if (low.value.trim() === '' || high.value.trim() === '' || !low.checkValidity() || !high.checkValidity()) continue;
      if (Number(low.value) < Number(high.value)) Object.assign(result, { [`${axis}min`]: Number(low.value), [`${axis}max`]: Number(high.value) });
    }
    return result;
  }
  const feed = () => { const value = Number($('#jog-feed').value); return value >= 10 && value <= 10000 ? value : null; };
  /** Why jogging is not possible right now ('' = it is). */
  function blocked() {
    const data = window.Coordinates?.snapshot();
    const state = data?.machineState?.split(':')[0];
    if (!bridgeHealthy || !hardware.connected) return hardware.coordinates?.alarm ? '控制器报警，请先在「位置」解除' : '连接控制器后可点动';
    if (hardwareJob) return '书写任务进行中';
    if (controllerBusy()) return '控制器正在同步';
    if (!data?.fresh || !data.mpos) return '位置未知，请先读取坐标';
    if (!['Idle', 'Jog'].includes(state)) return `控制器状态为 ${state || '未知'}`;
    if (!feed()) return '速度应在 10–10000 mm/min';
    return '';
  }
  function render() {
    const reason = blocked(), known = limits();
    for (const button of $$('.jog-button')) button.disabled = Boolean(reason) || busy && !holding;
    $('#jog-stop').disabled = !bridgeHealthy || !hardware.portOpen;
    const missing = [...'XYZ'].filter((axis) => !(axis.toLowerCase() + 'min' in known));
    const note = lastError || reason || `按机器坐标轴移动，不是纸面方向。${missing.length ? `${missing.join(' / ')} 轴未填写机器行程：不检查目标位置，单步最多 10 mm。` : '目标位置按「行程与安全」中的机器行程检查。'}`;
    $('#jog-note').textContent = note;
    $('#jog-note').classList.toggle('warning', Boolean(lastError) || Boolean(missing.length && !reason));
    const state = window.Coordinates?.snapshot()?.machineState?.split(':')[0];
    $('#jog-state').textContent = holding ? `${holding.axis}${holding.dir > 0 ? '+' : '−'} 移动中` : state === 'Jog' ? '点动中' : reason ? '不可用' : '就绪';
  }
  async function jog(axis, distance) {
    try {
      applyHardware(await api('jog', { axis, distance: Number(distance.toFixed(3)), feed: feed(), limits: limits() }));
      lastError = '';
      return true;
    } catch (error) {
      lastError = `点动被拒绝：${error.message}`;
      if (error.bridgeState) applyHardware(error.bridgeState); else if (!error.httpStatus) bridgeUnavailable(error);
      return false;
    } finally { render(); }
  }
  async function cancel() {
    try { applyHardware(await api('jog/cancel', {})); }
    catch (error) { log(`点动停止请求失败：${error.message}。请观察机器，必要时用物理急停。`); }
    render();
  }
  async function step(button) {
    if (busy || blocked()) return;
    busy = true; render();
    await jog(button.dataset.axis, Number(button.dataset.dir) * Number($('#jog-step').value));
    busy = false; render();
  }
  // ---------- hold to move ----------
  function startHold(button) {
    if (holding || blocked()) return;
    const segment = feed() / 60 * SEGMENT_SECONDS;
    holding = { axis: button.dataset.axis, dir: Number(button.dataset.dir), inFlight: 0, button, stopped: false };
    button.classList.add('active');
    const tick = async () => {
      const hold = holding;
      if (!hold || hold.stopped || hold.inFlight >= MAX_IN_FLIGHT) return;
      hold.inFlight++;
      const ok = await jog(hold.axis, hold.dir * Math.min(segment, 10));
      hold.inFlight--;
      if (!ok) stopHold();
    };
    tick();
    holding.timer = setInterval(tick, HOLD_INTERVAL_MS);
    render();
  }
  function stopHold() {
    if (!holding) return;
    holding.stopped = true;
    clearInterval(holding.timer);
    holding.button.classList.remove('active');
    holding = null;
    cancel(); // drops queued segments and stops at once
  }
  for (const button of $$('.jog-button')) {
    button.addEventListener('click', () => { if ($('#jog-mode').value === 'step') step(button); });
    button.addEventListener('pointerdown', (event) => {
      if ($('#jog-mode').value !== 'hold' || event.button !== 0) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      startHold(button);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, stopHold);
  }
  // Leaving the page or switching windows while holding must never leave the machine moving.
  for (const type of ['blur', 'pagehide']) window.addEventListener(type, stopHold);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopHold(); });
  $('#jog-stop').addEventListener('click', () => { if (holding) stopHold(); else cancel(); });
  for (const id of ['jog-feed', 'jog-step', 'jog-mode']) $(`#${id}`).addEventListener('input', () => { lastError = ''; render(); });
  for (const axis of 'xyz') for (const bound of ['min', 'max']) $(`#travel-${axis}-${bound}`).addEventListener('input', render);
  window.addEventListener('bridge-state', render);
  window.addEventListener('bridge-unavailable', () => { stopHold(); render(); });
  // Remember the step / speed / mode on this device.
  try {
    const saved = JSON.parse(localStorage.getItem('penfall:jog') || '{}');
    for (const id of ['jog-step', 'jog-feed', 'jog-mode']) if (typeof saved[id] === 'string' && saved[id]) { $(`#${id}`).value = saved[id]; $(`#${id}`).dispatchEvent(new Event('input')); }
  } catch { /* defaults */ }
  for (const id of ['jog-step', 'jog-feed', 'jog-mode']) $(`#${id}`).addEventListener('change', () => { try { localStorage.setItem('penfall:jog', JSON.stringify(Object.fromEntries(['jog-step', 'jog-feed', 'jog-mode'].map((key) => [key, $(`#${key}`).value])))); } catch { /* optional */ } });
  setInterval(render, 500);
  render();
})();
