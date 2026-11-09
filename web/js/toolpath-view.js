'use strict';
// XY toolpath canvas: grid, segments, run progress, pan / zoom (wheel, drag, pinch).
const pathCamera = { zoom: 1, x: 0, y: 0 };
const PATH_ZOOM_MIN = .2;
const PATH_ZOOM_MAX = 40;
let pathFrame = 0;

function resetPathCamera() {
  Object.assign(pathCamera, { zoom: 1, x: 0, y: 0 });
}
/**
 * World (work mm) ↔ screen (CSS px). Axes are flipped per the pen-origin directions so the page
 * always appears upright (paper top at the top of the screen); grid labels still show work coordinates.
 */
function pathTransform(w, h, camera = pathCamera) {
  const { dirX: sx, dirY: sy } = penOrigin();
  const b = { ...toolpath.bounds };
  if (layout.width) {
    // Fit the paper too, so a program that runs off the page is obvious.
    const area = paperWorkBounds(layout.width, layout.height);
    b.minX = Math.min(b.minX, area.xmin); b.maxX = Math.max(b.maxX, area.xmax);
    b.minY = Math.min(b.minY, area.ymin); b.maxY = Math.max(b.maxY, area.ymax);
  }
  const minX = sx > 0 ? b.minX : -b.maxX, maxX = sx > 0 ? b.maxX : -b.minX;
  const minY = sy > 0 ? b.minY : -b.maxY, maxY = sy > 0 ? b.maxY : -b.minY;
  const rangeX = Math.max(10, maxX - minX), rangeY = Math.max(10, maxY - minY);
  const scale = Math.max(.01, Math.min((w - 80) / rangeX, (h - 70) / rangeY)) * camera.zoom;
  const ox = (w - rangeX * scale) / 2 - minX * scale + camera.x;
  const oy = (h + rangeY * scale) / 2 + minY * scale + camera.y;
  return { scale, sx, sy, toScreen: (p) => [ox + sx * p.x * scale, oy - sy * p.y * scale], toWorld: (px, py) => ({ x: sx * (px - ox) / scale, y: sy * (oy - py) / scale }) };
}
/** Zoom while keeping the world point under (sx, sy) fixed on screen. */
function zoomPathAt(factor, sx, sy) {
  const canvas = $('#toolpath');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!toolpath.segments.length || !w || !h) return;
  const anchor = pathTransform(w, h).toWorld(sx, sy);
  pathCamera.zoom = Math.max(PATH_ZOOM_MIN, Math.min(PATH_ZOOM_MAX, pathCamera.zoom * factor));
  const base = pathTransform(w, h, { zoom: pathCamera.zoom, x: 0, y: 0 });
  const [bx, by] = base.toScreen(anchor);
  pathCamera.x = sx - bx;
  pathCamera.y = sy - by;
  requestDraw();
}
function requestDraw() {
  cancelAnimationFrame(pathFrame);
  pathFrame = requestAnimationFrame(drawToolpath);
}
function niceGridStep(target) {
  const base = Math.pow(10, Math.floor(Math.log10(target)));
  return ([1, 2, 5, 10].find((value) => value * base >= target) || 10) * base;
}
function drawGrid(ctx, view, w, h, color) {
  const a = view.toWorld(0, 0), b = view.toWorld(w, h);
  const [minX, maxX] = [Math.min(a.x, b.x), Math.max(a.x, b.x)], [minY, maxY] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  const grid = niceGridStep(60 / view.scale);
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = color('--quiet');
  for (let x = Math.floor(minX / grid) * grid; x <= maxX; x += grid) {
    const [px] = view.toScreen({ x, y: 0 });
    ctx.strokeStyle = Math.abs(x) < grid / 1e6 ? '#ffffff26' : '#ffffff0d';
    ctx.beginPath(); ctx.moveTo(Math.round(px) + .5, 0); ctx.lineTo(Math.round(px) + .5, h - 20); ctx.stroke();
    ctx.fillText(`${+x.toFixed(2)}`, px + 3, h - 7);
  }
  for (let y = Math.floor(minY / grid) * grid; y <= maxY; y += grid) {
    const [, py] = view.toScreen({ x: 0, y });
    ctx.strokeStyle = Math.abs(y) < grid / 1e6 ? '#ffffff26' : '#ffffff0d';
    ctx.beginPath(); ctx.moveTo(0, Math.round(py) + .5); ctx.lineTo(w, Math.round(py) + .5); ctx.stroke();
    if (py > 12 && py < h - 24) ctx.fillText(`${+y.toFixed(2)}`, 4, py - 3);
  }
}
/** Current paper (mapped through the pen origin) as a faint reference, plus the pen zero marker. */
function drawPaper(ctx, view, color) {
  if (!layout.width || !layout.height) return;
  const corners = [[0, 0], [layout.width, layout.height]].map(([x, y]) => view.toScreen(paperToWork(x, y)));
  const x0 = Math.min(corners[0][0], corners[1][0]), x1 = Math.max(corners[0][0], corners[1][0]);
  const y0 = Math.min(corners[0][1], corners[1][1]), y1 = Math.max(corners[0][1], corners[1][1]);
  ctx.save();
  ctx.fillStyle = '#ffffff05';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = color('--border');
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(Math.round(x0) + .5, Math.round(y0) + .5, Math.round(x1 - x0), Math.round(y1 - y0));
  ctx.setLineDash([]);
  ctx.fillStyle = color('--quiet');
  ctx.fillText(`${layout.paper.toUpperCase()} 纸张参考`, x0 + 5, Math.min(y1, ctx.canvas.clientHeight || y1) - 6);
  // Pen zero: where the program expects the pen to start.
  const [zx, zy] = view.toScreen({ x: 0, y: 0 });
  ctx.strokeStyle = ctx.fillStyle = color('--accent');
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(zx, zy, 6, 0, Math.PI * 2);
  ctx.moveTo(zx, zy); ctx.lineTo(zx + view.sx * 18, zy); ctx.moveTo(zx, zy); ctx.lineTo(zx, zy - view.sy * 18); ctx.stroke();
  ctx.fillText('X+', zx + view.sx * 21 - (view.sx < 0 ? 14 : 0), zy + 3);
  ctx.fillText('Y+', zx - 6, zy - view.sy * 22 + (view.sy < 0 ? 8 : 0));
  ctx.fillText('笔零点', zx + 9, zy + 16);
  ctx.restore();
}
// ---------- Z side view: the pen seen from the side during a run ----------
const Z_WINDOW_SECONDS = 4;
const segmentEndTimes = new WeakMap();
/** End time (s) of every segment, estimated like the simulation (feed rates, travel at SIM_RAPID_FEED). */
function endTimes(path) {
  if (!segmentEndTimes.has(path)) {
    let t = 0;
    segmentEndTimes.set(path, path.segments.map((segment) => (t += segment.distance / ((segment.rapid ? SIM_RAPID_FEED : segment.feed) / 60))));
  }
  return segmentEndTimes.get(path);
}
/**
 * Last seconds of pen height (left) and the pen above the paper (right). Z pens show real Z; servo pens show the
 * pen state. "Up" on screen is always away from the paper, whichever way the machine's +Z points.
 */
function drawZView(index, fraction, current, color, show) {
  const canvas = $('#z-view');
  canvas.hidden = !show;
  if (!show) return;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 130, dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const servo = $('#pen-mode').value !== 'z';
  const up = servo ? 1 : Number($('#pen-up').value), down = servo ? 0 : Number($('#pen-down').value);
  const away = Math.sign(up - down) || 1; // screen-up = away from the paper
  const value = (segment, point) => servo ? (segment.drawing ? down : up) : point.z;
  const values = servo ? [up, down] : [up, down, toolpath.bounds.minZ, toolpath.bounds.maxZ];
  const low = Math.min(...values.map((v) => v * away)), high = Math.max(...values.map((v) => v * away));
  const pad = Math.max(.3, (high - low) * .12);
  const top = 46, bottom = h - 14, plotLeft = 8, plotRight = w - 78;
  const y = (v) => bottom - (v * away - (low - pad)) / (high - low + 2 * pad) * (bottom - top);
  const times = endTimes(toolpath), segment = toolpath.segments[index];
  const start = index ? times[index - 1] : 0, now = start + (times[index] - start) * fraction;
  const x = (t) => plotRight - (now - t) / Z_WINDOW_SECONDS * (plotRight - plotLeft);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = color('--muted');
  ctx.fillText(`侧视 · 最近 ${Z_WINDOW_SECONDS} 秒`, 8, 13);
  // Pen-up and pen-down levels.
  ctx.lineWidth = 1;
  for (const level of [up, down]) {
    ctx.strokeStyle = color('--border'); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(plotLeft, Math.round(y(level)) + .5); ctx.lineTo(w - 6, Math.round(y(level)) + .5); ctx.stroke();
    ctx.setLineDash([]);
  }
  // History, oldest first: segments that ended inside the window, the current one up to "now". Each segment is
  // joined to the previous one, so servo up / down steps show as vertical moves.
  const recent = [];
  for (let i = index; i >= 0 && times[i] >= now - Z_WINDOW_SECONDS; i--) recent.unshift(i);
  ctx.lineWidth = 1.5;
  let previous = null;
  for (const i of recent) {
    const item = toolpath.segments[i], from = i ? times[i - 1] : 0, part = i === index ? fraction : 1;
    const startX = x(Math.max(from, now - Z_WINDOW_SECONDS)), startY = y(value(item, item.from));
    const endY = y(value(item, item.from) + (value(item, item.to) - value(item, item.from)) * part);
    ctx.strokeStyle = color(item.drawing ? '--success' : '--path-travel');
    ctx.beginPath(); ctx.moveTo(...(previous || [startX, startY])); ctx.lineTo(startX, startY); ctx.lineTo(x(from + (times[i] - from) * part), endY); ctx.stroke();
    previous = [x(from + (times[i] - from) * part), endY];
  }
  // Level labels on top of the curve, on a background so they stay readable.
  for (const [level, label] of [[up, servo ? '抬笔' : `抬笔 Z${+up.toFixed(2)}`], [down, servo ? '落笔' : `落笔 Z${+down.toFixed(2)}`]]) {
    const ly = y(level) + (level === down ? 12 : -4), width = ctx.measureText(label).width;
    ctx.fillStyle = color('--surface'); ctx.fillRect(plotLeft, ly - 10, width + 6, 13);
    ctx.fillStyle = color('--quiet'); ctx.fillText(label, plotLeft + 3, ly);
  }
  // The pen above the paper (paper surface drawn at the pen-down level).
  const penX = w - 40, tip = y(servo ? (segment.drawing ? down : up) : current.z), paper = y(down);
  ctx.fillStyle = '#d9d4c7'; ctx.fillRect(penX - 26, paper, 52, 4);
  ctx.fillStyle = color('--text'); ctx.strokeStyle = color('--text');
  ctx.beginPath(); ctx.moveTo(penX, tip); ctx.lineTo(penX - 4, tip - 7); ctx.lineTo(penX + 4, tip - 7); ctx.closePath(); ctx.fill();
  ctx.fillRect(penX - 4, tip - 40, 8, 33);
  ctx.fillStyle = color(segment.drawing ? '--success' : '--muted');
  ctx.textAlign = 'right';
  ctx.fillText(servo ? (segment.drawing ? '落笔' : '抬笔') : `Z ${current.z.toFixed(2)}`, penX - 12, 13);
  ctx.textAlign = 'left';
}
function drawToolpath() {
  // The stale warning must be correct even before the (animation-frame) redraw.
  $('#path-stale').hidden = !programDirty || !toolpath.segments.length;
  if ($('#path-view').hidden) return;
  const canvas = $('#toolpath');
  const container = $('.path-stage');
  const w = Math.max(200, container.clientWidth), h = Math.max(120, container.clientHeight);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const theme = getComputedStyle(document.documentElement);
  const palette = {};
  const color = (name) => palette[name] || (palette[name] = theme.getPropertyValue(name).trim());
  ctx.fillStyle = color('--bg');
  ctx.fillRect(0, 0, w, h);
  $('#path-empty').hidden = toolpath.segments.length > 0;
  $('#path-zoom').textContent = `${Math.round(pathCamera.zoom * 100)}%`;
  if (!toolpath.segments.length) { $('#path-position').hidden = true; $('#z-view').hidden = true; return; }

  const view = pathTransform(w, h);
  drawGrid(ctx, view, w, h, color);
  drawPaper(ctx, view, color);
  const showTravel = $('#show-travel').checked;
  const active = hardwareJob || simulation.state !== 'idle';
  const acknowledgedLine = hardwareJob && traceVerified && hardware.ack > 0 ? toolpath.commands[hardware.ack - 1]?.line || 0 : 0;
  let current = { x: 0, y: 0, z: 0 }, currentLine = 0;

  // Pen-width mode draws pen-down lines as wide as the real ink line (pen width × zoom).
  const inkWidth = $('#show-pen-width').checked ? Math.max(1, (window.Workspace?.penWidth || .5) * view.scale) : 0;
  ctx.lineCap = ctx.lineJoin = inkWidth ? 'round' : 'butt';
  // Batch the static drawing by style: far fewer canvas state changes on long programs.
  for (const drawing of [false, true]) {
    if (!drawing && !showTravel) continue;
    ctx.strokeStyle = color(drawing ? '--path-draw' : '--path-travel');
    ctx.lineWidth = drawing ? inkWidth || 1.4 : .8;
    if (drawing && inkWidth) ctx.strokeStyle = '#c7d3e3d9';
    // A single-pen program is drawn in that pen's colour (dark pens keep the default for contrast on the dark canvas).
    const pen = $('#pen').value;
    if (drawing && pen !== 'all') { const [r, g, b] = [1, 3, 5].map((i) => parseInt(penColor(Number(pen)).slice(i, i + 2), 16)); if (r * .299 + g * .587 + b * .114 > 70) ctx.strokeStyle = penColor(Number(pen)); }
    ctx.setLineDash(drawing ? [] : [4, 4]);
    ctx.beginPath();
    for (const segment of toolpath.segments) {
      if (segment.drawing !== drawing) continue;
      ctx.moveTo(...view.toScreen(segment.from)); ctx.lineTo(...view.toScreen(segment.to));
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  let currentIndex = -1, currentFraction = 0;
  if (active) {
    for (const [index, segment] of toolpath.segments.entries()) {
      let fraction = 0;
      if (hardwareJob && traceVerified) fraction = acknowledgedLine && segment.line <= acknowledgedLine ? 1 : 0;
      else if (!hardwareJob) fraction = Math.max(0, Math.min(1, (pathDistance - (segment.length - segment.distance)) / segment.distance));
      if (fraction <= 0) break;
      current = Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, segment.from[axis] + (segment.to[axis] - segment.from[axis]) * fraction]));
      currentLine = segment.line;
      currentIndex = index; currentFraction = fraction;
      if (segment.drawing || showTravel) {
        ctx.strokeStyle = color(segment.drawing ? '--success' : '--accent');
        ctx.lineWidth = segment.drawing ? inkWidth || 2 : 1;
        ctx.beginPath(); ctx.moveTo(...view.toScreen(segment.from)); ctx.lineTo(...view.toScreen(current)); ctx.stroke();
      }
    }
  }
  if (active && (!hardwareJob || traceVerified)) {
    const [px, py] = view.toScreen(current);
    ctx.strokeStyle = color('--warning'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.moveTo(px - 10, py); ctx.lineTo(px + 10, py); ctx.moveTo(px, py - 10); ctx.lineTo(px, py + 10); ctx.stroke();
  }
  drawZView(currentIndex, currentFraction, current, color, active && (!hardwareJob || traceVerified) && currentIndex >= 0 && $('#show-z-view').checked);
  $('#path-position').hidden = !active;
  $('#path-position').textContent = hardwareJob && !traceVerified ? '其他会话任务，无法关联轨迹' : !active ? '' : `${hardwareJob ? '已应答目标（非实测）' : '模拟位置'} · X ${current.x.toFixed(2)} · Y ${current.y.toFixed(2)} · Z ${current.z.toFixed(2)} mm${currentLine ? ` · 第 ${currentLine} 行` : ''}`;
  $('#path-stats').title = '轨迹长度包含抬落笔 Z 运动；模拟空移按 3000 mm/min 估算，不包含加减速。';
}

window.addEventListener('workspace-view', (event) => { if (event.detail === 'path') requestDraw(); });
new ResizeObserver(() => requestDraw()).observe($('.path-stage'));
$('#show-travel').addEventListener('change', drawToolpath);
$('#show-pen-width').checked = localStorage.getItem('penfall:show-pen-width') === '1';
$('#show-pen-width').addEventListener('change', () => { try { localStorage.setItem('penfall:show-pen-width', $('#show-pen-width').checked ? '1' : '0'); } catch { /* optional */ } drawToolpath(); });
$('#show-z-view').checked = localStorage.getItem('penfall:show-z-view') !== '0';
$('#show-z-view').addEventListener('change', () => { try { localStorage.setItem('penfall:show-z-view', $('#show-z-view').checked ? '1' : '0'); } catch { /* optional */ } drawToolpath(); });
$('#fit-path').addEventListener('click', () => { resetPathCamera(); drawToolpath(); });
(() => {
  const canvas = $('#toolpath');
  const pointers = new Map();
  let pinchDistance = 0;
  const local = (event) => { const rect = canvas.getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; };
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomPathAt(Math.exp(-event.deltaY * (event.deltaMode === 1 ? .05 : .0015)), ...local(event));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { resetPathCamera(); drawToolpath(); });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDistance = Math.hypot(a[0] - b[0], a[1] - b[1]); }
  });
  canvas.addEventListener('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 1) {
      pathCamera.x += event.clientX - previous[0];
      pathCamera.y += event.clientY - previous[1];
      requestDraw();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const rect = canvas.getBoundingClientRect();
      if (pinchDistance > 0) zoomPathAt(distance / pinchDistance, (a[0] + b[0]) / 2 - rect.left, (a[1] + b[1]) / 2 - rect.top);
      pinchDistance = distance;
    }
  });
  const end = (event) => { pointers.delete(event.pointerId); pinchDistance = 0; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
})();
