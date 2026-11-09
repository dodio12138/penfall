/* Text layout + single-line G-code generation, and a strict G-code parser for preview. */
(function (root) {
  'use strict';
  const Glyphs = typeof module !== 'undefined' && module.exports ? require('./glyphs.js') : root.Glyphs;
  const Brush = typeof module !== 'undefined' && module.exports ? require('./brush.js') : root.Brush;
  const defaultResolver = () => Glyphs.createResolver(Glyphs.DEFAULT_SELECTION, new Map([[Glyphs.BUILTIN_ID, Glyphs.builtinLibrary()]]));
  const WHITESPACE_ADVANCE = .7; // × font size, matches the built-in Latin advance.
  const MAX_PAGES = 99;
  const SCRIPT = { sup: { scale: .6, shift: -.38 }, sub: { scale: .6, shift: .18 } }; // × the run's font size
  const LIST_HANG = 2; // list marker column, × base font size
  // 连笔 only between Latin letters / digits: joined 楷书 characters or punctuation look like stray strokes.
  const JOINABLE = /^[\p{Script=Latin}\p{N}]$/u;

  // --- 拟真 (natural handwriting): reproducible per-character variation from a seed. ---
  /** Deterministic noise in [-1, 1) for (seed, index, channel). */
  function noise(seed, index, channel) {
    let h = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b); h ^= h >>> 16;
    return (h >>> 0) / 4294967296 * 2 - 1;
  }
  /** Slowly drifting noise (a baseline wanders over a few characters instead of jumping). */
  function drift(seed, index, channel, period = 5) {
    const at = index / period, i = Math.floor(at), t = at - i, s = t * t * (3 - 2 * t);
    return noise(seed, i, channel) * (1 - s) + noise(seed, i + 1, channel) * s;
  }
  /**
   * natural = { size, baseline, spacing (fractions of the font size), slant / slantVar (degrees), join (0–1), seed }.
   * Returns null when off, else vary(index, size) → { scale, dy, tilt (tan of slant), extra (advance, mm) } and join(index).
   */
  function naturalVariation(natural) {
    if (!natural) return null;
    const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));
    const size = clamp(natural.size, .5), baseline = clamp(natural.baseline, .5), spacing = clamp(natural.spacing, 1), slantVar = clamp(natural.slantVar, 30), join = clamp(natural.join, 1);
    const slant = Math.max(-30, Math.min(30, Number(natural.slant) || 0));
    const seed = (Number(natural.seed) >>> 0) || 1;
    return {
      vary: (index, fontSize) => ({
        scale: 1 + size * noise(seed, index, 1),
        dy: baseline * fontSize * (drift(seed, index, 2) * .7 + noise(seed, index, 3) * .3),
        tilt: Math.tan((slant + slantVar * (drift(seed, index, 4, 7) * .5 + noise(seed, index, 5) * .5)) * Math.PI / 180),
        extra: spacing * fontSize * .5 * noise(seed, index, 6),
      }),
      join: (index) => join > 0 && (noise(seed, index, 7) + 1) / 2 < join,
    };
  }

  /**
   * Shared by the paper preview and the generator so both place every character identically.
   * resolve(index, char) → glyph | null; fallbackAdvance(char) → mm width (at the base size) for characters without a glyph.
   * Indexes are Unicode code point positions in the original text (used by pins and formatting).
   *
   * options.format = { runs: [{ from, to, size?, pen?, underline?, strike?, script? }], paras: [{ at, align?, indent?, spacing?, list? }] }
   * options.math(source, size, index) → { width, height, depth, strokes } lays out \( … \) formulas (optional).
   * options.natural → 拟真 variation (see naturalVariation); options.marker(char) → glyph for list numbers.
   * Returns placements (glyphs and formulas), decorations (underline / strike / bullets, pen paths), carets (one per
   * index, for editing on the paper), missing, overflow, pages. textStrokes() turns them into pen strokes.
   */
  function layoutText(text, options, resolve = defaultResolver(), fallbackAdvance = () => options.size * WHITESPACE_ADVANCE) {
    const { width, height, margin, size: baseSize, gap, lineGap } = options;
    // Binding gutter for double-sided writing: left side on odd pages, right side on even pages.
    const gutter = options.gutter || 0;
    const left = (page) => margin + (page % 2 ? gutter : 0);
    const available = width - margin * 2 - gutter;
    const bottom = height - margin;
    const chars = Array.from(text);
    const count = chars.length;
    const placements = [], decorations = [], missing = new Set(), carets = new Array(count + 1), formulaErrors = [];
    // Per-character size / pen / decoration from formatting runs; per-paragraph alignment / indent / spacing / list.
    const sizes = new Float64Array(count).fill(baseSize), pens = new Int8Array(count), lines = new Uint8Array(count), scripts = new Array(count);
    for (const run of options.format?.runs || []) for (let i = Math.max(0, run.from); i < Math.min(count, run.to); i++) {
      if (run.size > 0) sizes[i] = run.size;
      if (run.pen > 0) pens[i] = run.pen;
      if (run.underline) lines[i] |= 1;
      if (run.strike) lines[i] |= 2;
      if (SCRIPT[run.script]) scripts[i] = SCRIPT[run.script];
    }
    const natural = naturalVariation(options.natural);
    const marker = options.marker || ((char) => resolve(-1, char));
    const paragraphs = new Map((options.format?.paras || []).map((para) => [para.at, para]));
    // \( … \) formulas (same line), laid out as one atomic box.
    const formulas = new Map();
    if (options.math) for (let i = 0; i + 1 < count; i++) {
      if (chars[i] !== '\\' || chars[i + 1] !== '(') continue;
      for (let j = i + 2; j + 1 < count && chars[j] !== '\n'; j++) if (chars[j] === '\\' && chars[j + 1] === ')') { formulas.set(i, { end: j + 2, source: chars.slice(i + 2, j).join('') }); i = j + 1; break; }
    }
    let page = 1, top = margin, overflow = false;
    const grid = options.grid && options.grid.cell > 0 ? options.grid : null;
    const widthOf = (char, glyph, size) => /\s/.test(char)
      ? (char === '\t' ? 4 * (size * WHITESPACE_ADVANCE + gap) - gap : size * WHITESPACE_ADVANCE)
      : glyph ? glyph.advance / glyph.unitsPerEm * size : fallbackAdvance(char) * size / baseSize;

    if (grid) {
      // Grid paper (方格 / 田字格 / 稿纸): one character per cell, centred.
      const pitch = grid.cell + (grid.gap || 0);
      let x = left(1);
      const rightEdge = () => left(page) + available;
      for (let index = 0; index < count; index++) {
        let char = chars[index];
        if (char === '\r') { if (chars[index + 1] === '\n') { carets[index] = { page, x, y: top, height: grid.cell }; continue; } char = '\n'; }
        if (char === '\n') { carets[index] = { page, x, y: top, height: grid.cell }; x = left(page); top += pitch; continue; }
        const blank = /\s/.test(char), size = Math.min(sizes[index], grid.cell);
        const glyph = blank ? null : resolve(index, char);
        if (!blank && !glyph) missing.add(char);
        if (x + grid.cell > rightEdge() + 1e-9 && x > left(page)) { x = left(page); top += pitch; }
        if (top + grid.cell > bottom + 1e-9) {
          if (page >= MAX_PAGES) { overflow = true; break; }
          page++; x = left(page); top = margin;
        }
        carets[index] = { page, x, y: top, height: grid.cell };
        const v = natural && glyph ? natural.vary(index, size) : null;
        const drawn = v ? Math.min(grid.cell, size * v.scale) : size, w = widthOf(char, glyph, drawn);
        if (!blank) placements.push({ index, char, x: x + (grid.cell - w) / 2 + (v ? v.extra * .3 : 0), y: top + (grid.cell - size) / 2 + (size - drawn) + (v ? v.dy * .5 : 0), page, width: w, size: drawn, pen: pens[index], glyph, ...(v ? { tilt: v.tilt } : {}) });
        x += grid.cell;
      }
      carets[count] = carets[count] || { page, x, y: top, height: grid.cell };
      return { placements, decorations, carets, missing: [...missing], overflow, pages: page };
    }

    // Flowing text: 1) break each paragraph into rows, 2) place rows (baseline, alignment, pages).
    const pitch = options.pitch > 0 ? options.pitch : 0;
    let start = 0, listNumber = 0;
    while (start <= count && !overflow) {
      let end = start;
      while (end < count && chars[end] !== '\n') end++;
      const para = paragraphs.get(start) || {};
      // Lists hang their marker in a column left of the text; numbering continues over consecutive numbered paragraphs.
      const list = para.list === 'bullet' || para.list === 'number' ? para.list : null;
      listNumber = list === 'number' ? listNumber + 1 : 0;
      const hang = list ? LIST_HANG * baseSize : 0;
      const indent = list ? 0 : para.indent > 0 ? para.indent : 0;
      const items = [];
      for (let index = start; index < end; index++) {
        const formula = formulas.get(index);
        if (formula) {
          const box = options.math(formula.source, sizes[index], index);
          for (const char of box.missing || []) missing.add(char);
          if (box.error) formulaErrors.push({ index, source: formula.source, message: box.error });
          items.push({ kind: 'formula', index, end: formula.end, width: box.width, ascent: box.height, descent: box.depth, size: sizes[index], pen: pens[index], lines: lines[index], box });
          index = formula.end - 1;
          continue;
        }
        const char = chars[index];
        if (char === '\r') continue;
        const blank = /\s/.test(char), base = sizes[index], script = scripts[index];
        const glyph = blank ? null : resolve(index, char);
        if (!blank && !glyph) missing.add(char);
        const v = natural && glyph ? natural.vary(index, base) : null;
        const size = base * (script ? script.scale : 1) * (v ? v.scale : 1), shift = script ? script.shift * base : 0;
        items.push({ kind: blank ? 'blank' : 'char', index, char, glyph, width: widthOf(char, glyph, size), extra: v ? Math.max(-gap - base * .1, v.extra) : 0, ascent: Math.max(base * (script ? script.scale : 1) - shift, base * (script ? 0 : 1)), descent: Math.max(0, shift), size, shift: shift + (v ? v.dy : 0), tilt: v ? v.tilt : 0, lines: lines[index], pen: pens[index], join: Boolean(v && natural.join(index)) });
      }
      const rows = [];
      let row = [], x = 0, limit = available - indent - hang;
      for (const item of items) {
        if (x + item.width > limit + 1e-9 && row.length) { rows.push(row); row = []; x = 0; limit = available - hang; }
        row.push({ item, x });
        x += item.width + gap + (item.extra || 0);
      }
      rows.push(row);
      rows.forEach((cells, number) => {
        if (overflow) return;
        const ascent = cells.reduce((value, cell) => Math.max(value, cell.item.ascent), cells.length ? 0 : sizes[Math.min(start, count - 1)] || baseSize);
        const descent = cells.reduce((value, cell) => Math.max(value, cell.item.descent), 0);
        const rowHeight = ascent + descent;
        if (top + rowHeight > bottom + 1e-9) {
          // Continue on a new sheet; the machine writes one page per program.
          if (page >= MAX_PAGES) { overflow = true; return; }
          page++; top = margin;
        }
        const last = cells.at(-1);
        const rowWidth = last ? last.x + last.item.width : 0;
        const space = (number === 0 ? available - indent : available) - hang - rowWidth;
        const offset = hang + (number === 0 ? indent : 0) + (para.align === 'center' ? space / 2 : para.align === 'right' ? space : 0);
        const baseline = top + ascent, origin = left(page) + offset;
        if (number === 0 && list) addMarker(list, listNumber, left(page), hang, baseline, page, cells[0]?.item.pen ?? pens[start] ?? 0);
        let previous = null;
        for (const { item, x: cellX } of cells) {
          const x0 = origin + cellX;
          const caret = { page, x: x0, y: top, height: rowHeight };
          item.x0 = x0;
          if (item.kind === 'formula') {
            for (let i = item.index; i < item.end; i++) carets[i] = caret;
            placements.push({ kind: 'formula', index: item.index, end: item.end, char: '∫', x: x0, y: baseline - item.ascent, page, width: item.width, height: rowHeight, size: item.size, pen: item.pen, box: item.box });
            previous = null;
            continue;
          }
          carets[item.index] = caret;
          if (item.kind === 'char') {
            // 连笔: only straight after another character of the same pen on this row.
            const join = item.join && previous && previous.index === item.index - 1 && previous.pen === item.pen && JOINABLE.test(item.char) && JOINABLE.test(previous.char);
            const placement = { index: item.index, char: item.char, x: x0, y: baseline - item.size + item.shift, page, width: item.width, size: item.size, pen: item.pen, glyph: item.glyph };
            if (item.tilt) placement.tilt = item.tilt;
            if (join) placement.joinPrevious = true;
            placements.push(placement);
            previous = item;
          } else previous = null;
        }
        addLines(cells, baseline, page);
        // Caret after the row's last character (end of paragraph, or before the first char of the next row).
        const after = { page, x: origin + rowWidth, y: top, height: rowHeight };
        if (number === rows.length - 1) carets[end] = after;
        // Paragraph line spacing (×): free text scales the row pitch; ruled paper skips whole lines.
        const spacing = para.spacing > 0 ? para.spacing : 1;
        top += pitch ? Math.max(pitch, rowHeight + (pitch - baseSize > 0 ? 0 : lineGap)) * Math.max(1, Math.round(spacing)) : (rowHeight + lineGap) * spacing;
      });
      start = end + 1;
    }
    for (let i = 0; i <= count; i++) if (!carets[i]) carets[i] = carets[i - 1] || { page: 1, x: left(1), y: margin, height: baseSize };
    return { placements, decorations, carets, missing: [...missing], formulaErrors, overflow, pages: page };

    /** List marker in the hanging column: a small dot, or "n." in glyphs (right-aligned to the text). */
    function addMarker(kind, n, x, width, baseline, markerPage, pen) {
      if (kind === 'bullet') {
        const r = baseSize * .1, cx = x + width * .45, cy = baseline - baseSize * .4;
        decorations.push({ page: markerPage, pen, kind: 'bullet', points: Array.from({ length: 9 }, (_, i) => [cx + r * Math.cos(i * Math.PI / 4), cy + r * Math.sin(i * Math.PI / 4)]) });
        return;
      }
      const marks = Array.from(`${n}.`).map((char) => {
        const glyph = marker(char);
        if (!glyph) missing.add(char);
        return { char, glyph, width: widthOf(char, glyph, baseSize) };
      });
      let at = x + width - baseSize * .5 - marks.reduce((sum, mark) => sum + mark.width, 0) - gap * (marks.length - 1);
      for (const mark of marks) {
        if (mark.glyph) placements.push({ kind: 'marker', index: -1, char: mark.char, x: at, y: baseline - baseSize, page: markerPage, width: mark.width, size: baseSize, pen, glyph: mark.glyph });
        at += mark.width + gap;
      }
    }
    /** Underline / strike-through spans over consecutive decorated cells of a row (blanks between them included). */
    function addLines(cells, baseline, linePage) {
      for (const [bit, kind] of [[1, 'underline'], [2, 'strike']]) {
        let span = null;
        const flush = () => {
          if (!span) return;
          const y = kind === 'underline' ? baseline + span.size * .12 + .3 : baseline - span.size * .42;
          decorations.push({ page: linePage, pen: span.pen, kind, points: [[span.from, y], [span.to, y]] });
          span = null;
        };
        for (const { item } of cells) {
          const on = item.lines & bit;
          if (!on || (span && span.pen !== item.pen)) flush();
          if (!on) continue;
          if (!span) span = { from: item.x0, to: item.x0 + item.width, size: item.size, pen: item.pen };
          else { span.to = item.x0 + item.width; span.size = Math.max(span.size, item.size); }
        }
        flush();
      }
    }
  }

  /**
   * Pen strokes of a text layout in paper mm (top-down): glyphs (with 拟真 slant and 连笔), list numbers, formulas,
   * underlines / strike-through / bullets. Shared by the paper preview and the generator → [{ page, pen, points }].
   * pen 0 = the draft's text pen. With brush (运笔, see brush.js), written strokes also get p (pressure) and f (speed).
   */
  function textStrokes(result, brush = null) {
    const strokes = layoutStrokes(result);
    const shape = Brush.normalize(brush);
    if (!shape) return strokes;
    return strokes.map((stroke) => stroke.size ? { page: stroke.page, pen: stroke.pen, ...Brush.shapeStroke(stroke.points, stroke.size, shape) } : stroke);
  }
  function layoutStrokes(result) {
    const strokes = [];
    let tail = null; // last stroke of the previous character, for 连笔
    for (const item of result.placements) {
      if (item.kind === 'formula') {
        for (const points of item.box.strokes) strokes.push({ page: item.page, pen: item.pen || 0, size: item.size, points: points.map(([px, py]) => [item.x + px, item.y + py]) });
        tail = null;
        continue;
      }
      if (!item.glyph) { tail = null; continue; }
      const k = item.size / item.glyph.unitsPerEm, tilt = item.tilt || 0;
      // Slant shears around the baseline (glyph bottom) so letters lean without leaving their row.
      const map = tilt ? ([u, v]) => [item.x + u * k + (item.size - v * k) * tilt, item.y + v * k] : ([u, v]) => [item.x + u * k, item.y + v * k];
      const own = item.glyph.strokes.map((points) => ({ page: item.page, pen: item.pen || 0, size: item.size, points: points.map(map) }));
      if (item.joinPrevious && tail && own.length) {
        const from = tail.points.at(-1), to = own[0].points[0];
        // Lift-free connection only for nearby strokes; a slight downward bow like a hand's 连笔.
        if (Math.hypot(to[0] - from[0], to[1] - from[1]) <= item.size * .9 && to[0] >= from[0] - item.size * .15) {
          const bow = [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + item.size * .06];
          tail.points.push(bow, ...own.shift().points);
        }
      }
      strokes.push(...own);
      tail = strokes.at(-1)?.page === item.page ? strokes.at(-1) : null;
    }
    for (const decoration of result.decorations || []) strokes.push({ page: decoration.page, pen: decoration.pen || 0, points: decoration.points });
    return strokes;
  }

  const BACKGROUNDS = ['none', 'lines', 'four-line', 'grid', 'tianzige', 'mizige', 'composition'];
  const GRID_BACKGROUNDS = ['grid', 'tianzige', 'mizige', 'composition'];
  /** Dashed line as short pen strokes (so a pen can draw it too). */
  function dashed(a, b, dash = 1.2, space = 1.2) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]), parts = [];
    for (let at = 0; at < length; at += dash + space) {
      const end = Math.min(length, at + dash);
      parts.push([[a[0] + (b[0] - a[0]) * at / length, a[1] + (b[1] - a[1]) * at / length], [a[0] + (b[0] - a[0]) * end / length, a[1] + (b[1] - a[1]) * end / length]]);
    }
    return parts;
  }
  /**
   * Paper ruling for every page, matching layoutText's rows / cells exactly.
   * background: { kind, cell (grid cell or line pitch, mm), gap (row gap for 稿纸) } → [{ page, points, dashed }]
   */
  function backgroundPaths(background, options, pages) {
    const kind = background?.kind;
    if (!kind || kind === 'none') return [];
    const { width, height, margin, size } = options, gutter = options.gutter || 0;
    const result = [];
    for (let page = 1; page <= pages; page++) {
      const left = margin + (page % 2 ? gutter : 0), right = width - margin - (page % 2 ? 0 : gutter), bottom = height - margin;
      const add = (points, isDashed = false) => result.push({ page, points, dashed: isDashed });
      if (GRID_BACKGROUNDS.includes(kind)) {
        const cell = background.cell, gap = kind === 'composition' ? background.gap || 0 : 0;
        const columns = Math.floor((right - left) / cell + 1e-9), rows = Math.floor((bottom - margin + gap) / (cell + gap) + 1e-9);
        if (columns < 1 || rows < 1) continue;
        const x1 = left + columns * cell;
        for (let row = 0; row < rows; row++) {
          const top = margin + row * (cell + gap), low = top + cell;
          if (gap || row === 0) add([[left, top], [x1, top]]);
          add([[left, low], [x1, low]]);
          for (let column = 0; column <= columns; column++) add([[left + column * cell, top], [left + column * cell, low]]);
          if (kind === 'tianzige' || kind === 'mizige') for (let column = 0; column < columns; column++) {
            const cx = left + column * cell;
            for (const part of [...dashed([cx, top + cell / 2], [cx + cell, top + cell / 2]), ...dashed([cx + cell / 2, top], [cx + cell / 2, low])]) add(part, true);
            if (kind === 'mizige') for (const part of [...dashed([cx, top], [cx + cell, low]), ...dashed([cx + cell, top], [cx, low])]) add(part, true);
          }
        }
      } else {
        const pitch = background.cell > 0 ? background.cell : size + (options.lineGap || 0);
        for (let top = margin; top + size <= bottom + 1e-9; top += pitch) {
          if (kind === 'lines') add([[left, top + size + .6], [right, top + size + .6]]);
          else for (const [ratio, isDashed] of [[0, false], [1 / 3, true], [1, false], [4 / 3, false]]) {
            const y = top + size * ratio;
            if (y > bottom + 1e-9) continue;
            if (isDashed) for (const part of dashed([left, y], [right, y], 2, 1.5)) add(part, true); else add([[left, y], [right, y]]);
          }
        }
      }
    }
    return result;
  }

  /** Greedy nearest-neighbour order (paths may be reversed) to cut pen-up travel between drawing strokes. */
  function orderPaths(paths) {
    const left = paths.filter((points) => points.length);
    const ordered = [];
    let at = [0, 0];
    while (left.length) {
      let best = 0, reverse = false, distance = Infinity;
      for (let i = 0; i < left.length; i++) {
        const start = left[i][0], end = left[i].at(-1);
        const ds = (start[0] - at[0]) ** 2 + (start[1] - at[1]) ** 2, de = (end[0] - at[0]) ** 2 + (end[1] - at[1]) ** 2;
        if (ds < distance) { distance = ds; best = i; reverse = false; }
        if (de < distance) { distance = de; best = i; reverse = true; }
      }
      const [next] = left.splice(best, 1);
      const points = reverse ? [...next].reverse() : next;
      ordered.push(points);
      at = points.at(-1);
    }
    return ordered;
  }

  const PEN_MODES = ['z', 'servo-m5', 'servo-s'];
  /**
   * How the pen is lifted. 'z': Z axis (penUp / penDown in mm, either direction: +Z may point away from or towards
   * the paper; press = continuing past penDown away from penUp). Servo boards driven by the spindle PWM:
   * 'servo-m5' = M3 S<down> to write, M5 to lift; 'servo-s' = M3 S<down> / M3 S<up>. dwell (s) lets the servo settle.
   */
  function penProfile(options) {
    const lift = options.penLift || { mode: 'z' };
    if (!PEN_MODES.includes(lift.mode)) throw Error('抬笔方式无效。');
    if (lift.mode === 'z') {
      if (![options.penUp, options.penDown].every(Number.isFinite) || Math.abs(options.penUp - options.penDown) < .2) throw Error('抬笔 Z 与落笔 Z 至少相差 0.2 mm。');
      return { mode: 'z', up: options.penUp, down: options.penDown, press: Math.sign(options.penDown - options.penUp), dwell: 0 };
    }
    const dwell = lift.dwell === undefined ? 0 : Number(lift.dwell);
    const valid = (value) => Number.isFinite(value) && value >= 0 && value <= 10000;
    if (!valid(lift.down) || (lift.mode === 'servo-s' && (!valid(lift.up) || lift.up === lift.down)) || !(dwell >= 0 && dwell <= 5)) throw Error('舵机抬笔参数无效（S 值 0–10000，抬笔与落笔 S 不能相同，等待 0–5 秒）。');
    return { mode: lift.mode, down: lift.down, up: lift.mode === 'servo-s' ? lift.up : null, dwell };
  }

  function generate(text, options) {
    const { width, height, margin, size, gap, lineGap, feed } = options;
    // Pen zero (work 0,0) in paper mm from the left / bottom edge, and machine axis directions.
    const origin = { x: 0, y: 0, dirX: 1, dirY: 1, ...options.origin };
    if (![origin.x, origin.y].every(Number.isFinite) || ![1, -1].includes(origin.dirX) || ![1, -1].includes(origin.dirY)) throw Error('笔起点或坐标方向无效。');
    if (![width,height,margin,size,gap,lineGap,feed].every(Number.isFinite) || width<=0 || height<=0 || size<=0 || feed<=0 || margin<0 || gap<0 || lineGap<0 || margin*2+size>Math.min(width,height)) throw Error('纸张、速度或抬落笔参数无效（抬笔 Z 必须大于落笔 Z）。');
    const lift = penProfile(options);
    const result = layoutText(text, options, options.resolve || defaultResolver());
    // Drawing paths (paper mm, top-down) already placed on pages and assigned to pens.
    const drawings = Array.isArray(options.paths) ? options.paths : [];
    const pages = Math.max(result.pages, ...drawings.map((item) => item.page));
    const pen = options.pen === undefined || options.pen === 'all' ? null : Number(options.pen);
    const textPen = options.textPen || 1;
    if (result.missing.length) throw Error(`字库暂不支持：${result.missing.slice(0,20).join(' ')}${result.missing.length > 20 ? ` 等 ${result.missing.length} 个字` : ''}。请在「字形」面板启用含这些字的字库，或导入外部生成的 G-code；不能用系统字体冒充笔迹。`);
    if (result.formulaErrors?.length) throw Error(`公式有误：${result.formulaErrors[0].message}（${result.formulaErrors[0].source}）`);
    if (!text.trim() && !drawings.length) throw Error('请先输入书写内容或添加图形。');
    if (result.overflow) throw Error(`内容超过 ${MAX_PAGES} 页上限，请拆分文稿。`);
    const page = options.page === undefined ? 1 : options.page;
    if (!Number.isInteger(page) || page < 1 || page > pages) throw Error(`页码无效：共 ${pages} 页。`);
    const n = value => Number(value.toFixed(3));
    const servo = lift.mode !== 'z';
    const raise = servo ? [lift.mode === 'servo-m5' ? 'M5' : `M3 S${n(lift.up)}`, ...(lift.dwell ? [`G4 P${n(lift.dwell)}`] : [])] : [`G0 Z${n(lift.up)}`];
    // Z pen: rapid to 0.5 mm before the paper, then touch down gently (a slow move over the whole lift took ~1 s per stroke).
    const approach = !servo && Math.abs(lift.up - lift.down) > .6 ? [`G0 Z${n(lift.down - lift.press * .5)}`] : [];
    const touch = (z) => [...approach, `G1 Z${z} F${n(Math.min(feed,300))}`];
    const lower = servo ? [`M3 S${n(lift.down)}`, ...(lift.dwell ? [`G4 P${n(lift.dwell)}`] : [])] : touch(n(lift.down));
    // 运笔: pressure → extra Z depth (spring-loaded holder, Z only), speed → feed of each segment.
    const brush = Brush.normalize(options.brush);
    const depth = brush && !servo ? brush.depth : 0;
    const zAt = (p) => n(lift.down + lift.press * depth * p); // deeper = further from the pen-up height
    const profile = (servo ? `servo pen (M3 S${n(lift.down)} down, ${lift.mode === 'servo-m5' ? 'M5' : `M3 S${n(lift.up)}`} up)` : `Z-axis pen (Z${n(lift.up)} up, Z${n(lift.down)} down, +Z ${lift.press < 0 ? 'away from' : 'towards'} paper)`) + (brush ? `, stroke dynamics${depth ? ` (press to Z${zAt(1)})` : ' (speed only)'}` : '');
    const lines = [`; Single-line text / ${profile} profile - review before use`,
      `; Pen zero at ${n(origin.x)} mm from paper left, ${n(origin.y)} mm from paper bottom; +X ${origin.dirX > 0 ? 'right' : 'left'}, +Y ${origin.dirY > 0 ? 'up' : 'down'}`,
      `; Page ${page} of ${pages}${pen === null ? '' : `; pen ${pen}`}`,
      'G21', 'G90', 'G17', ...raise, `G1 F${n(feed)}`];
    const toWork = (px, py) => `X${n(origin.dirX*(px-origin.x))} Y${n(origin.dirY*(height-py-origin.y))}`;
    const stroke = (points, pressure, speed) => {
      lines.push(`G0 ${toWork(...points[0])}`);
      if (pressure && depth) lines.push(...touch(zAt(pressure[0]))); else lines.push(...lower);
      points.slice(1).forEach((p, i) => lines.push(`G1 ${toWork(...p)}${pressure && depth ? ` Z${zAt(pressure[i + 1])}` : ''} F${speed ? Math.max(1, Math.round(feed * speed[i + 1])) : n(feed)}`));
      lines.push(...raise);
    };
    // Each character / formula / decoration is written with its own pen (formatting runs), else the text pen.
    for (const item of textStrokes(result, options.brush)) if (item.page === page && (pen === null || pen === (item.pen || textPen))) stroke(item.points, item.p, item.f);
    for (const points of orderPaths(drawings.filter((item) => item.page === page && (pen === null || item.pen === pen)).map((item) => item.points))) stroke(points);
    lines.push('; End - pen remains raised, no automatic homing');
    return lines.join('\n');
  }
  // Deliberately strict subset: do not silently simulate unknown machine commands.
  /**
   * profile (optional): { mode: 'servo-s', down, up }: M3 S<up> lifts the pen instead of writing;
   * { mode: 'z', up, down }: Z axis in either direction (writing = at or beyond penDown, away from penUp).
   */
  function parse(source, penDown=0, profile=null) {
    if (source.length > 500000) return { segments: [], errors: ['程序超过 500 KB 预览上限，请拆分。'], commands: [], bounds: { minX:0,minY:0,maxX:0,maxY:0,minZ:0,maxZ:0 }, length: 0, dwell: 0 };
    let pos={x:0,y:0,z:0}, absolute=true, unit=1, mode=0, feed=1000, explicitPen=null, spindle=false, spindleS=null, dwell=0;
    const segments=[], errors=[], commands=[];
    const bounds={minX:0,minY:0,maxX:0,maxY:0,minZ:0,maxZ:0};
    let length=0;
    source.split(/\r?\n/).forEach((raw,index)=>{
      if (segments.length >= 200000) { if (errors.at(-1) !== '轨迹超过 200000 段，请拆分。') errors.push('轨迹超过 200000 段，请拆分。'); return; }
      const line=index+1;
      const code=raw.replace(/\([^)]*\)/g,'').replace(/;.*/,'').trim().toUpperCase();
      if (!code) return;
      const tokens=[...code.matchAll(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)];
      if (!tokens.length || code.replace(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g,'').trim()) { errors.push(`第 ${line} 行：无法解析`); return; }
      const words={}; let invalid=false, pause=false, m3=false;
      for (const [,letter,num] of tokens) {
        const value=Number(num);
        if (!Number.isFinite(value)) {invalid=true;break;}
        if (letter==='G') {
          if ([0,1,2,3].includes(value)) mode=value;
          else if (value===4) pause=true;
          else if (value===90) absolute=true;
          else if (value===91) absolute=false;
          else if (value===20) unit=25.4;
          else if (value===21) unit=1;
          else if (value!==17) invalid=true;
        } else if (letter==='M') {
          if (value===3) { explicitPen=true; spindle=true; m3=true; }
          else if (value===5) { explicitPen=false; spindle=false; }
          else if (![2,30].includes(value)) invalid=true;
          if ([2,30].includes(value)) { errors.push(`第 ${line} 行：请移除 M2 / M30 结束标记后再导入`); invalid=true; }
        } else if ('XYZIJFSNP'.includes(letter)) { if (letter in words) invalid=true; words[letter]=value; }
        else invalid=true;
      }
      // G4 P<seconds> (dwell) stands alone; P is accepted nowhere else.
      if (!invalid && (pause ? words.P===undefined || words.P<0 || words.P>60 || Object.keys(words).some((key)=>!'PN'.includes(key)) : words.P!==undefined)) invalid=true;
      if (invalid) { errors.push(`第 ${line} 行：包含不支持的指令；仅支持 G0–G4、G17、G20/21、G90/91、M3/5 和 XYZ/IJ/F/S/N/P`); return; }
      if (pause) { dwell+=words.P; commands.push({line,code}); return; }
      // Two-value servo profile: the S value decides whether M3 writes (close to the down value) or lifts.
      if (words.S!==undefined) spindleS=words.S;
      if (profile?.mode==='servo-s' && spindle && (m3 || words.S!==undefined) && spindleS!==null) explicitPen=Math.abs(spindleS-profile.down)<=Math.abs(spindleS-profile.up);
      if (words.F!==undefined) {feed=words.F*unit;if(feed<=0) {errors.push(`第 ${line} 行：进给速度必须为正数`);return;}}
      const next={...pos};
      for (const axis of ['x','y','z']) if (words[axis.toUpperCase()]!==undefined) next[axis]=(absolute?0:pos[axis])+words[axis.toUpperCase()]*unit;
      const hasXY=words.X!==undefined||words.Y!==undefined;
      const arc=[2,3].includes(mode)&&(hasXY||words.I!==undefined||words.J!==undefined);
      const rapid=mode===0;
      const press=profile?.mode==='z'&&Number.isFinite(profile.up)&&profile.up!==penDown?Math.sign(penDown-profile.up):-1;
      const drawing=!rapid&&(explicitPen===null?(next.z-penDown)*press>=-.001:explicitPen);
      const add=(from,to)=>{
        const distance=Math.hypot(to.x-from.x,to.y-from.y,to.z-from.z);
        if (distance<1e-9) return;
        length+=distance;
        segments.push({from:{...from},to:{...to},line,rapid,drawing,feed,length,distance});
        for (const p of [from,to]) for (const axis of ['X','Y','Z']) {bounds[`min${axis}`]=Math.min(bounds[`min${axis}`],p[axis.toLowerCase()]);bounds[`max${axis}`]=Math.max(bounds[`max${axis}`],p[axis.toLowerCase()]);}
      };
      if (arc) {
        if (words.I===undefined&&words.J===undefined) {errors.push(`第 ${line} 行：圆弧需要相对圆心 I/J；暂不支持 R 圆弧`);return;}
        const cx=pos.x+(words.I||0)*unit,cy=pos.y+(words.J||0)*unit;
        const radius=Math.hypot(pos.x-cx,pos.y-cy),endRadius=Math.hypot(next.x-cx,next.y-cy);
        if (radius<.001||Math.abs(radius-endRadius)>.05) {errors.push(`第 ${line} 行：圆弧半径不一致`);return;}
        const start=Math.atan2(pos.y-cy,pos.x-cx),end=Math.atan2(next.y-cy,next.x-cx);
        let angle=end-start;
        if(mode===2) {while(angle>=-1e-10) angle-=2*Math.PI;} else {while(angle<=1e-10) angle+=2*Math.PI;}
        const steps=Math.min(10000,Math.max(8,Math.ceil(Math.abs(angle)*radius/.5)));
        let from=pos;
        for(let i=1;i<=steps;i++) {const a=start+angle*i/steps;const to=i===steps?next:{x:cx+radius*Math.cos(a),y:cy+radius*Math.sin(a),z:pos.z+(next.z-pos.z)*i/steps};add(from,to);from=to;}
      } else if (hasXY||words.Z!==undefined) add(pos,next);
      pos=next;
      commands.push({line,code});
    });
    return {segments,errors,commands,bounds,length,dwell};
  }
  const api={generate,parse,layoutText,textStrokes,naturalVariation,orderPaths,backgroundPaths,BACKGROUNDS,GRID_BACKGROUNDS,PEN_MODES,MAX_PAGES};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.PathEngine=api;
})(typeof window!=='undefined'?window:globalThis);
