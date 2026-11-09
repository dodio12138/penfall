/* Drawings (SVG / DXF) → polylines in millimetres (top-left origin, y down), grouped by colour.
 * DXF parsing, simplification and colour mapping are pure (Node tests); SVG uses the browser's geometry engine. */
(function (root) {
  'use strict';
  const MAX_POINTS = 400000;

  // --- colours ---
  const ACI = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#000000', 8: '#808080', 9: '#c0c0c0' };
  function hexColor(value) {
    if (typeof value !== 'string') return '#000000';
    const text = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(text)) return text;
    if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join('')}`;
    const rgb = text.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (rgb) return `#${rgb.slice(1, 4).map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('')}`;
    return '#000000';
  }
  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  /** Index (0-based) of the pen whose colour is closest to the drawing colour (white / black both map to dark). */
  function nearestPen(color, pens) {
    let [r, g, b] = channels(hexColor(color));
    if (r > 235 && g > 235 && b > 235) [r, g, b] = [0, 0, 0]; // white lines in CAD files mean "default"
    let best = 0, bestDistance = Infinity;
    pens.forEach((pen, index) => {
      const [pr, pg, pb] = channels(pen.color);
      const mean = (r + pr) / 2; // "redmean" perceptual approximation
      const distance = (2 + mean / 256) * (r - pr) ** 2 + 4 * (g - pg) ** 2 + (2 + (255 - mean) / 256) * (b - pb) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    });
    return best;
  }

  // --- geometry ---
  /** Ramer–Douglas–Peucker; keeps endpoints. */
  function simplify(points, tolerance) {
    if (points.length < 3) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [start, end] = stack.pop();
      const [ax, ay] = points[start], [bx, by] = points[end];
      const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
      let index = -1, max = tolerance;
      for (let i = start + 1; i < end; i++) {
        // Closed shapes start and end at the same point: measure from that point instead of a zero-length line.
        const distance = length < 1e-9 ? Math.hypot(points[i][0] - ax, points[i][1] - ay) : Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / length;
        if (distance > max) { max = distance; index = i; }
      }
      if (index > 0) { keep[index] = 1; stack.push([start, index], [index, end]); }
    }
    return points.filter((_, i) => keep[i]);
  }
  function arcPoints(cx, cy, r, start, end, clockwise = false, step = .3) {
    let sweep = end - start;
    if (clockwise) { while (sweep > 0) sweep -= Math.PI * 2; } else { while (sweep < 0) sweep += Math.PI * 2; }
    if (Math.abs(sweep) < 1e-9) sweep = clockwise ? -Math.PI * 2 : Math.PI * 2;
    const count = Math.max(8, Math.min(2000, Math.ceil(Math.abs(sweep) * r / step)));
    return Array.from({ length: count + 1 }, (_, i) => { const a = start + sweep * i / count; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  }
  /** Polyline vertices with DXF bulge values (arc segments). */
  function bulgePolyline(vertices, closed) {
    const points = [];
    const count = closed ? vertices.length : vertices.length - 1;
    for (let i = 0; i < count; i++) {
      const [x1, y1, bulge] = vertices[i], [x2, y2] = vertices[(i + 1) % vertices.length];
      if (!points.length) points.push([x1, y1]);
      if (!bulge) { points.push([x2, y2]); continue; }
      const chord = Math.hypot(x2 - x1, y2 - y1), angle = 4 * Math.atan(bulge);
      const radius = chord / (2 * Math.sin(angle / 2));
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, h = radius * Math.cos(angle / 2);
      const nx = -(y2 - y1) / chord, ny = (x2 - x1) / chord;
      const cx = mx + nx * h, cy = my + ny * h;
      const arc = arcPoints(cx, cy, Math.abs(radius), Math.atan2(y1 - cy, x1 - cx), Math.atan2(y2 - cy, x2 - cx), bulge < 0);
      points.push(...arc.slice(1));
    }
    if (vertices.length === 1) points.push([vertices[0][0], vertices[0][1]]);
    return points;
  }
  /** Uniform B-spline / fit-point approximation: good enough for pen plotting of typical CAD splines. */
  function splinePoints(degree, controls, fits) {
    if (fits.length >= 2) return fits;
    if (controls.length <= degree) return controls;
    const n = controls.length, knots = [];
    for (let i = 0; i <= n + degree; i++) knots.push(i <= degree ? 0 : i >= n ? n - degree : i - degree);
    const point = (t) => {
      let k = degree;
      while (k < n - 1 && t >= knots[k + 1]) k++;
      const d = Array.from({ length: degree + 1 }, (_, j) => [...controls[j + k - degree]]);
      for (let r = 1; r <= degree; r++) for (let j = degree; j >= r; j--) {
        const i = j + k - degree, alpha = (t - knots[i]) / ((knots[i + degree - r + 1] - knots[i]) || 1);
        d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1]];
      }
      return d[degree];
    };
    const end = n - degree, steps = Math.min(4000, n * 16);
    return Array.from({ length: steps + 1 }, (_, i) => point(Math.min(end - 1e-9, end * i / steps)));
  }

  // --- DXF (ASCII) ---
  const DXF_UNITS = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: .0000254, 9: .0254 };
  function parseDxf(text) {
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
    if (!pairs.some(([code, value]) => code === 0 && value === 'SECTION')) throw Error('不是 ASCII DXF 文件（不支持二进制 DXF）');
    let unit = 1, section = '';
    const layers = new Map(), entities = [];
    for (let i = 0; i < pairs.length; i++) {
      const [code, value] = pairs[i];
      if (code === 0 && value === 'SECTION') { section = pairs[i + 1]?.[1] || ''; continue; }
      if (section === 'HEADER' && code === 9 && value === '$INSUNITS') unit = DXF_UNITS[+pairs[i + 1]?.[1]] ?? 1;
      if (code !== 0) continue;
      // Collect one record: everything up to the next group code 0.
      const record = { type: value, data: [] };
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) record.data.push(pairs[j]);
      if (section === 'TABLES' && value === 'LAYER') {
        const name = record.data.find(([c]) => c === 2)?.[1], color = Math.abs(+(record.data.find(([c]) => c === 62)?.[1] ?? 7));
        if (name) layers.set(name, ACI[color] || '#000000');
      }
      if (section === 'ENTITIES' || section === 'BLOCKS') entities.push({ ...record, section });
    }
    const paths = [];
    const get = (data, code, fallback = 0) => { const found = data.find(([c]) => c === code); return found ? +found[1] : fallback; };
    const all = (data, code) => data.filter(([c]) => c === code).map(([, v]) => +v);
    const colorOf = (data) => { const aci = data.find(([c]) => c === 62); const layer = data.find(([c]) => c === 8)?.[1]; return aci && +aci[1] !== 256 && +aci[1] !== 0 ? ACI[Math.abs(+aci[1])] || '#000000' : layers.get(layer) || '#000000'; };
    let polyline = null;
    for (const entity of entities.filter((item) => item.section === 'ENTITIES')) {
      const { type, data } = entity;
      const color = colorOf(data);
      const add = (points, closed = false) => { if (points.length) paths.push({ color, points: closed ? [...points, points[0]] : points }); };
      if (type === 'LINE') add([[get(data, 10), get(data, 20)], [get(data, 11), get(data, 21)]]);
      else if (type === 'CIRCLE') add(arcPoints(get(data, 10), get(data, 20), get(data, 40), 0, Math.PI * 2));
      else if (type === 'ARC') add(arcPoints(get(data, 10), get(data, 20), get(data, 40), get(data, 50) * Math.PI / 180, get(data, 51) * Math.PI / 180));
      else if (type === 'LWPOLYLINE') {
        const xs = all(data, 10), ys = all(data, 20), vertices = xs.map((x, i) => [x, ys[i], 0]);
        let vertex = -1;
        for (const [c, v] of data) { if (c === 10) vertex++; if (c === 42 && vertex >= 0) vertices[vertex][2] = +v; }
        add(bulgePolyline(vertices, (get(data, 70) & 1) === 1));
      } else if (type === 'POLYLINE') polyline = { color, closed: (get(data, 70) & 1) === 1, vertices: [] };
      else if (type === 'VERTEX' && polyline) polyline.vertices.push([get(data, 10), get(data, 20), get(data, 42)]);
      else if (type === 'SEQEND' && polyline) { if (polyline.vertices.length) paths.push({ color: polyline.color, points: bulgePolyline(polyline.vertices, polyline.closed) }); polyline = null; }
      else if (type === 'ELLIPSE') {
        const cx = get(data, 10), cy = get(data, 20), mx = get(data, 11), my = get(data, 21), ratio = get(data, 40, 1);
        let start = get(data, 41), end = get(data, 42, Math.PI * 2);
        if (end <= start) end += Math.PI * 2;
        const major = Math.hypot(mx, my), angle = Math.atan2(my, mx), count = Math.max(16, Math.ceil((end - start) * major / .3));
        add(Array.from({ length: count + 1 }, (_, i) => { const t = start + (end - start) * i / count; const x = major * Math.cos(t), y = major * ratio * Math.sin(t); return [cx + x * Math.cos(angle) - y * Math.sin(angle), cy + x * Math.sin(angle) + y * Math.cos(angle)]; }));
      } else if (type === 'SPLINE') {
        const controls = all(data, 10).map((x, i) => [x, all(data, 20)[i]]), fits = all(data, 11).map((x, i) => [x, all(data, 21)[i]]);
        add(splinePoints(get(data, 71, 3), controls, fits));
      } else if (type === 'POINT') add([[get(data, 10), get(data, 20)]]);
    }
    if (!paths.length) throw Error('DXF 中没有可绘制的线条（支持 LINE、ARC、CIRCLE、LWPOLYLINE、POLYLINE、ELLIPSE、SPLINE）');
    // CAD y points up: flip into the paper's top-down frame and convert units to mm.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const path of paths) for (const [x, y] of path.points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return finish(paths.map((path) => ({ color: path.color, points: path.points.map(([x, y]) => [(x - minX) * unit, (maxY - y) * unit]) })), (maxX - minX) * unit, (maxY - minY) * unit);
  }
  function finish(paths, width, height) {
    let total = 0;
    const clean = [];
    for (const path of paths) {
      const points = simplify(path.points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])), .02);
      if (!points.length) continue;
      total += points.length;
      if (total > MAX_POINTS) throw Error('图形过于复杂（超过 40 万点），请简化后再导入');
      clean.push({ color: hexColor(path.color), points });
    }
    if (!clean.length) throw Error('图形中没有可绘制的线条');
    return { width: Math.max(width, .1), height: Math.max(height, .1), paths: clean, colors: [...new Set(clean.map((path) => path.color))] };
  }

  // --- SVG (browser only): sanitized copy rendered off-screen, sampled with getPointAtLength ---
  const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
  const lengthMm = (value) => { const match = String(value || '').trim().match(/^([\d.]+)\s*(mm|cm|in|pt|pc|px)?$/); return match ? +match[1] * UNIT_MM[match[2] || ''] : null; };
  function parseSvg(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const source = doc.documentElement;
    if (source.nodeName !== 'svg' || doc.querySelector('parsererror')) throw Error('SVG 解析失败');
    // Never execute or fetch anything from an imported file.
    for (const node of source.querySelectorAll('script, foreignObject, image, iframe, use[href^="http"], use[*|href^="http"]')) node.remove();
    for (const node of [source, ...source.querySelectorAll('*')]) for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name) || /^(javascript|data|https?):/i.test(attribute.value.trim()) && /href$/i.test(attribute.name)) node.removeAttribute(attribute.name);
    const box = (source.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const widthMm = lengthMm(source.getAttribute('width')), heightMm = lengthMm(source.getAttribute('height'));
    const view = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? box : [0, 0, widthMm ? widthMm / UNIT_MM.px : 300, heightMm ? heightMm / UNIT_MM.px : 150];
    const mmPerUnit = widthMm ? widthMm / view[2] : heightMm ? heightMm / view[3] : UNIT_MM.px;
    const host = document.createElement('div');
    // Not visibility:hidden — that is inherited and would make every shape look hidden.
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none';
    const svg = document.importNode(source, true);
    svg.setAttribute('width', String(view[2])); svg.setAttribute('height', String(view[3]));
    host.append(svg);
    document.body.append(host);
    try {
      const paths = [];
      const step = Math.max(.2 / mmPerUnit, 1e-6);
      for (const element of svg.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse')) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const stroke = style.stroke !== 'none' ? style.stroke : style.fill !== 'none' ? style.fill : null;
        if (!stroke || typeof element.getTotalLength !== 'function') continue;
        const total = element.getTotalLength();
        if (!(total > 0)) continue;
        const matrix = element.getCTM();
        const count = Math.min(200000, Math.max(2, Math.ceil(total / step)));
        let current = [], previous = null;
        for (let i = 0; i <= count; i++) {
          const local = element.getPointAtLength(total * i / count);
          const p = matrix ? local.matrixTransform(matrix) : local;
          const point = [p.x * mmPerUnit, p.y * mmPerUnit];
          // A jump much longer than the sampling step is a "move to" between sub-paths: start a new line.
          if (previous && Math.hypot(point[0] - previous[0], point[1] - previous[1]) > Math.max(1, total / count * mmPerUnit * 3)) { if (current.length > 1) paths.push({ color: stroke, points: current }); current = []; }
          current.push(point); previous = point;
        }
        if (current.length > 1) paths.push({ color: stroke, points: current });
      }
      return finish(paths, view[2] * mmPerUnit, view[3] * mmPerUnit);
    } finally { host.remove(); }
  }

  /** Default placement: natural size at the top-left of the writing area, shrunk to fit if larger. */
  function defaultPlacement(drawing, paper) {
    const area = paper.width - paper.margin * 2, areaHeight = paper.height - paper.margin * 2;
    const scale = Math.min(1, area / drawing.width, areaHeight / drawing.height);
    return { page: 1, x: paper.margin, y: paper.margin, width: Math.round(drawing.width * scale * 10) / 10 };
  }
  /** Drawing paths on the paper (mm, top-down) for a placement, tagged with page and pen. */
  function placePaths(drawing, placement, pens) {
    const scale = placement.width / drawing.width;
    return drawing.paths.map((path) => ({ page: placement.page, pen: nearestPen(path.color, pens) + 1, color: path.color, points: path.points.map(([x, y]) => [placement.x + x * scale, placement.y + y * scale]) }));
  }

  const api = { parseDxf, parseSvg, simplify, nearestPen, hexColor, defaultPlacement, placePaths, bulgePolyline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Drawing = api;
})(typeof window !== 'undefined' ? window : globalThis);
