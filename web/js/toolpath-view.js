'use strict';
// XY toolpath canvas: grid, segments, run progress, pan / zoom (wheel, drag, pinch).
const pathCamera = { zoom: 1, x: 0, y: 0 };
const PATH_ZOOM_MIN = .2;
const PATH_ZOOM_MAX = 40;
let pathFrame = 0;

function resetPathCamera() {
  Object.assign(pathCamera, { zoom: 1, x: 0, y: 0 });
}
/** World (mm) ↔ screen (CSS px) transform for the current camera. */
function pathTransform(w, h, camera = pathCamera) {
  const b = toolpath.bounds;
  const rangeX = Math.max(10, b.maxX - b.minX), rangeY = Math.max(10, b.maxY - b.minY);
  const scale = Math.max(.01, Math.min((w - 80) / rangeX, (h - 70) / rangeY)) * camera.zoom;
  const ox = (w - rangeX * scale) / 2 - b.minX * scale + camera.x;
  const oy = (h + rangeY * scale) / 2 + b.minY * scale + camera.y;
  return { scale, ox, oy, toScreen: (p) => [ox + p.x * scale, oy - p.y * scale], toWorld: (sx, sy) => ({ x: (sx - ox) / scale, y: (oy - sy) / scale }) };
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
  const topLeft = view.toWorld(0, 0), bottomRight = view.toWorld(w, h);
  const grid = niceGridStep(60 / view.scale);
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = color('--quiet');
  for (let x = Math.floor(topLeft.x / grid) * grid; x <= bottomRight.x; x += grid) {
    const [px] = view.toScreen({ x, y: 0 });
    const axis = Math.abs(x) < grid / 1e6;
    ctx.strokeStyle = axis ? '#ffffff26' : '#ffffff0d';
    ctx.beginPath(); ctx.moveTo(Math.round(px) + .5, 0); ctx.lineTo(Math.round(px) + .5, h - 20); ctx.stroke();
    ctx.fillText(`${+x.toFixed(2)}`, px + 3, h - 7);
  }
  for (let y = Math.floor(bottomRight.y / grid) * grid; y <= topLeft.y; y += grid) {
    const [, py] = view.toScreen({ x: 0, y });
    const axis = Math.abs(y) < grid / 1e6;
    ctx.strokeStyle = axis ? '#ffffff26' : '#ffffff0d';
    ctx.beginPath(); ctx.moveTo(0, Math.round(py) + .5); ctx.lineTo(w, Math.round(py) + .5); ctx.stroke();
    if (py > 12 && py < h - 24) ctx.fillText(`${+y.toFixed(2)}`, 4, py - 3);
  }
}
/** Generated programs use paper coordinates; draw the current paper as a faint reference. */
function drawPaper(ctx, view, color) {
  if (!layout.width || !layout.height) return;
  const [x0, y0] = view.toScreen({ x: 0, y: layout.height });
  const [x1, y1] = view.toScreen({ x: layout.width, y: 0 });
  ctx.save();
  ctx.fillStyle = '#ffffff05';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = color('--border');
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(Math.round(x0) + .5, Math.round(y0) + .5, Math.round(x1 - x0), Math.round(y1 - y0));
  ctx.setLineDash([]);
  ctx.fillStyle = color('--quiet');
  ctx.fillText(`${layout.paper.toUpperCase()} 纸张参考`, x0 + 5, Math.max(y0, 0) + 14);
  ctx.restore();
}
function drawToolpath() {
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
  if (!toolpath.segments.length) { $('#path-position').hidden = true; return; }

  const view = pathTransform(w, h);
  drawGrid(ctx, view, w, h, color);
  drawPaper(ctx, view, color);
  const showTravel = $('#show-travel').checked;
  const active = hardwareJob || simulation.state !== 'idle';
  const acknowledgedLine = hardwareJob && traceVerified && hardware.ack > 0 ? toolpath.commands[hardware.ack - 1]?.line || 0 : 0;
  let current = { x: 0, y: 0, z: 0 }, currentLine = 0;

  // Batch the static drawing by style: far fewer canvas state changes on long programs.
  for (const drawing of [false, true]) {
    if (!drawing && !showTravel) continue;
    ctx.strokeStyle = color(drawing ? '--path-draw' : '--path-travel');
    ctx.lineWidth = drawing ? 1.4 : .8;
    ctx.setLineDash(drawing ? [] : [4, 4]);
    ctx.beginPath();
    for (const segment of toolpath.segments) {
      if (segment.drawing !== drawing) continue;
      ctx.moveTo(...view.toScreen(segment.from)); ctx.lineTo(...view.toScreen(segment.to));
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (active) {
    for (const segment of toolpath.segments) {
      let fraction = 0;
      if (hardwareJob && traceVerified) fraction = acknowledgedLine && segment.line <= acknowledgedLine ? 1 : 0;
      else if (!hardwareJob) fraction = Math.max(0, Math.min(1, (pathDistance - (segment.length - segment.distance)) / segment.distance));
      if (fraction <= 0) break;
      current = Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, segment.from[axis] + (segment.to[axis] - segment.from[axis]) * fraction]));
      currentLine = segment.line;
      if (segment.drawing || showTravel) {
        ctx.strokeStyle = color(segment.drawing ? '--success' : '--accent');
        ctx.lineWidth = segment.drawing ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(...view.toScreen(segment.from)); ctx.lineTo(...view.toScreen(current)); ctx.stroke();
      }
    }
  }
  if (active && (!hardwareJob || traceVerified)) {
    const [px, py] = view.toScreen(current);
    ctx.strokeStyle = color('--warning'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.moveTo(px - 10, py); ctx.lineTo(px + 10, py); ctx.moveTo(px, py - 10); ctx.lineTo(px, py + 10); ctx.stroke();
  }
  $('#path-position').hidden = !active;
  $('#path-position').textContent = hardwareJob && !traceVerified ? '其他会话任务，无法关联轨迹' : !active ? '' : `${hardwareJob ? '已应答目标（非实测）' : '模拟位置'} · X ${current.x.toFixed(2)} · Y ${current.y.toFixed(2)} · Z ${current.z.toFixed(2)} mm${currentLine ? ` · 第 ${currentLine} 行` : ''}`;
  $('#path-stats').title = '轨迹长度包含抬落笔 Z 运动；模拟空移按 3000 mm/min 估算，不包含加减速。';
}

window.addEventListener('workspace-view', (event) => { if (event.detail === 'path') requestDraw(); });
new ResizeObserver(() => requestDraw()).observe($('.path-stage'));
$('#show-travel').addEventListener('change', drawToolpath);
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
