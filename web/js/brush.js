/* 运笔 (stroke dynamics): imitates how a hand writes a stroke — 起 (press on entry), 行 (steady, faster),
 * 转 (slow down and press at sharp turns), 收 (press-and-lift, or taper out for 撇 / 捺 / 钩) — as a pressure and a
 * speed value per point. Pure logic, shared by the paper preview, the generator and Node tests.
 *
 * Model (per stroke, along its arc length s):
 *  - Speed: bell-shaped like human movements (minimum-jerk / sigma-lognormal velocity profiles): slow at both
 *    ends, fast in the middle, dips at corners. Implemented with smoothstep ramps and Gaussian dips.
 *  - Pressure: an envelope over entry / body / exit plus bumps at corners (pressure rises where the hand slows,
 *    as in velocity-simulated pressure for digital ink).
 *  - Corners: turning angle at a vertex above CORNER_DEG.
 *  - Ending: a short tail after a corner (钩) or a diagonal ending (撇 / 捺) tapers out; otherwise 顿收.
 * The machine writes pressure as extra Z depth on a spring-loaded pen holder; speed as the feed of each segment.
 */
(function (root) {
  'use strict';
  const CORNER_DEG = 35;
  const BODY = .5; // pressure while moving through the middle of a stroke
  // Pen types: how much the line reacts. entry / exit: zone length × font size; pressure: 0–1 strength;
  // depth: max extra Z press (mm); speed: slowest speed × feed; corner / hook: 0–1; width: line width × pen width.
  const PENS = {
    gel: { name: '中性笔 / 圆珠笔', entry: 12, exit: 12, pressure: 30, depth: .3, speed: 70, corner: 30, hook: 0, widthMin: 90, widthMax: 115 },
    fountain: { name: '钢笔', entry: 15, exit: 18, pressure: 55, depth: .4, speed: 60, corner: 50, hook: 20, widthMin: 75, widthMax: 135 },
    felt: { name: '软头笔 / 签字笔', entry: 18, exit: 22, pressure: 75, depth: 1, speed: 55, corner: 60, hook: 40, widthMin: 55, widthMax: 190 },
    brush: { name: '毛笔 / 秀丽笔', entry: 25, exit: 30, pressure: 100, depth: 2, speed: 45, corner: 80, hook: 50, widthMin: 30, widthMax: 320 },
  };

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
  const mix = (a, b, t) => a + (b - a) * smooth(t);

  /** UI percentages → fractions. Returns null when the values are unusable. */
  function normalize(raw) {
    if (!raw) return null;
    const num = (key, low, high) => clamp(Number(raw[key]) || 0, low, high);
    return {
      entry: num('entry', 0, 50) / 100, exit: num('exit', 0, 50) / 100, pressure: num('pressure', 0, 100) / 100,
      depth: num('depth', 0, 5), speed: num('speed', 20, 100) / 100, corner: num('corner', 0, 100) / 100, hook: num('hook', 0, 100) / 100,
      widthMin: num('widthMin', 10, 100) / 100, widthMax: Math.max(num('widthMin', 10, 100), num('widthMax', 100, 600)) / 100,
    };
  }

  /**
   * Shape one stroke (paper mm points) written at font size `size`.
   * Returns { points, p, f }: p = pressure 0–1 (BODY when strength is 0), f = speed × feed (≤ 1).
   */
  function shapeStroke(input, size, brush) {
    const points = input.filter((point, index) => index === 0 || Math.hypot(point[0] - input[index - 1][0], point[1] - input[index - 1][1]) > 1e-6);
    const strength = brush.pressure, slow = brush.speed;
    const level = (raw) => clamp(BODY + (raw - BODY) * strength, 0, 1);
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    const total = lengths.at(-1);
    // 点: a dot or a very short stroke is a press — written slowly with full pressure.
    if (points.length < 2 || total < size * .12) return { points, p: points.map(() => level(1)), f: points.map(() => slow) };

    // 转: sharp turns at interior vertices (curves made of many small turns do not count).
    const corners = [];
    for (let i = 1; i < points.length - 1; i++) {
      const a = [points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]], b = [points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]];
      const turn = Math.acos(clamp((a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b)), -1, 1)) * 180 / Math.PI;
      if (turn > CORNER_DEG) corners.push({ s: lengths[i], k: clamp((turn - CORNER_DEG) / 55, .3, 1) * brush.corner });
    }
    // Entry / exit zones, shrunk to fit short strokes.
    let entry = Math.max(.3, brush.entry * size), exit = Math.max(.3, brush.exit * size);
    if (entry + exit > total * .8) { const k = total * .8 / (entry + exit); entry *= k; exit *= k; }
    const at = (s) => {
      let i = 1;
      while (i < lengths.length - 1 && lengths[i] < s) i++;
      const t = (s - lengths[i - 1]) / Math.max(1e-9, lengths[i] - lengths[i - 1]);
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
    };
    // 收: taper out (出锋) for a short tail after the last corner (钩) or a diagonal ending (撇 / 捺); else 顿收.
    const tailStart = at(Math.max(0, total - size * .25)), end = points.at(-1);
    const tail = [end[0] - tailStart[0], end[1] - tailStart[1]], tailLength = Math.hypot(...tail) || 1;
    const lastCorner = corners.at(-1);
    const hook = lastCorner && total - lastCorner.s < size * .3;
    const diagonal = Math.abs(tail[0]) > tailLength * .35 && Math.abs(tail[1]) > tailLength * .35;
    const taper = hook || diagonal;
    const width = size * .07; // corner influence
    const raw = (s) => {
      const u = s / entry, v = (total - s) / exit;
      let value = BODY;
      if (u < 1) value = u < .3 ? mix(.35, .9, u / .3) : mix(.9, BODY, (u - .3) / .7); // 起: 顿笔 then 提 to the body
      if (v < 1) value = taper ? mix(.08, value, v) : v < .45 ? mix(.45, .85, v / .45) : mix(.85, value, (v - .45) / .55);
      for (const corner of corners) value += .4 * corner.k * Math.exp(-(((s - corner.s) / width) ** 2));
      return clamp(value, 0, 1);
    };
    const speed = (s) => {
      let dip = Math.max(1 - smooth(s / entry), 1 - smooth((total - s) / exit));
      for (const corner of corners) dip = Math.max(dip, corner.k * Math.exp(-(((s - corner.s) / width) ** 2)));
      return 1 - (1 - slow) * clamp(dip, 0, 1);
    };
    // Resample densely only where pressure / speed change (ends, corners); keep long straight runs as one segment.
    const step = clamp(size * .1, .3, .8);
    const marks = new Set(lengths);
    for (let s = 0; s < entry; s += step) marks.add(s);
    for (let s = total; s > total - exit; s -= step) marks.add(s);
    for (const corner of corners) for (let s = corner.s - 2 * width; s <= corner.s + 2 * width; s += step) if (s > 0 && s < total) marks.add(s);
    const stations = [...marks].sort((a, b) => a - b).filter((s, index, list) => index === 0 || s - list[index - 1] > .05 || s === total);
    const out = { points: stations.map(at), p: stations.map((s) => level(raw(s))), f: stations.map(speed) };
    // 入锋 / 回锋: the pen lands just before the stroke and leaves with a small return (or a thin tip when tapering).
    if (brush.hook > 0) {
      const reach = brush.hook * size * .06;
      const first = out.points[0], second = at(Math.min(total, step * 2));
      const d0 = [second[0] - first[0], second[1] - first[1]], n0 = Math.hypot(...d0) || 1;
      // Approach from behind and slightly above the stroke direction.
      out.points.unshift([first[0] - d0[0] / n0 * reach * .7, first[1] - d0[1] / n0 * reach * .7 - reach * .25]);
      out.p.unshift(level(.15)); out.f.unshift(slow);
      const dx = tail[0] / tailLength, dy = tail[1] / tailLength;
      if (taper) { out.points.push([end[0] + dx * reach * .8, end[1] + dy * reach * .8]); out.p.push(level(.02)); }
      else { out.points.push([end[0] - dx * reach * .5, end[1] - dy * reach * .5 - reach * .3]); out.p.push(level(.3)); }
      out.f.push(slow);
    }
    return out;
  }

  /** Line width (× pen width) for a pressure: soft tips spread faster under heavy pressure (gamma 1.5). */
  const width = (brush, p) => brush.widthMin + (brush.widthMax - brush.widthMin) * Math.pow(clamp(p, 0, 1), 1.5);
  const api = { PENS, BODY, CORNER_DEG, normalize, shapeStroke, width };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Brush = api;
})(typeof window !== 'undefined' ? window : globalThis);
