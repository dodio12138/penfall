/* Text layout + single-line G-code generation, and a strict G-code parser for preview. */
(function (root) {
  'use strict';
  const Glyphs = typeof module !== 'undefined' && module.exports ? require('./glyphs.js') : root.Glyphs;
  const defaultResolver = () => Glyphs.createResolver(Glyphs.DEFAULT_SELECTION, new Map([[Glyphs.BUILTIN_ID, Glyphs.builtinLibrary()]]));
  const WHITESPACE_ADVANCE = .7; // × font size, matches the built-in Latin advance.
  const MAX_PAGES = 99;

  /**
   * Shared by the paper preview and the generator so both place every character identically.
   * resolve(index, char) → glyph | null; fallbackAdvance(char) → mm width (at the base size) for characters without a glyph.
   * Indexes are Unicode code point positions in the original text (used by pins and formatting).
   *
   * options.format = { runs: [{ from, to, size?, pen? }], paras: [{ at, align?, indent? }] }  (optional rich formatting)
   * options.math(source, size, index) → { width, height, depth, strokes } lays out \( … \) formulas (optional).
   * Returns placements (glyphs and formulas), carets (one per index, for editing on the paper), missing, overflow, pages.
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
    const placements = [], missing = new Set(), carets = new Array(count + 1), formulaErrors = [];
    // Per-character size / pen from formatting runs; per-paragraph alignment / indent.
    const sizes = new Float64Array(count).fill(baseSize), pens = new Int8Array(count);
    for (const run of options.format?.runs || []) for (let i = Math.max(0, run.from); i < Math.min(count, run.to); i++) { if (run.size > 0) sizes[i] = run.size; if (run.pen > 0) pens[i] = run.pen; }
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
        const w = widthOf(char, glyph, size);
        if (!blank) placements.push({ index, char, x: x + (grid.cell - w) / 2, y: top + (grid.cell - size) / 2, page, width: w, size, pen: pens[index], glyph });
        x += grid.cell;
      }
      carets[count] = carets[count] || { page, x, y: top, height: grid.cell };
      return { placements, carets, missing: [...missing], overflow, pages: page };
    }

    // Flowing text: 1) break each paragraph into rows, 2) place rows (baseline, alignment, pages).
    const pitch = options.pitch > 0 ? options.pitch : 0;
    let start = 0;
    while (start <= count && !overflow) {
      let end = start;
      while (end < count && chars[end] !== '\n') end++;
      const para = paragraphs.get(start) || {};
      const indent = para.indent > 0 ? para.indent : 0;
      const items = [];
      for (let index = start; index < end; index++) {
        const formula = formulas.get(index);
        if (formula) {
          const box = options.math(formula.source, sizes[index], index);
          for (const char of box.missing || []) missing.add(char);
          if (box.error) formulaErrors.push({ index, source: formula.source, message: box.error });
          items.push({ kind: 'formula', index, end: formula.end, width: box.width, ascent: box.height, descent: box.depth, size: sizes[index], pen: pens[index], box });
          index = formula.end - 1;
          continue;
        }
        const char = chars[index];
        if (char === '\r') continue;
        const blank = /\s/.test(char), size = sizes[index];
        const glyph = blank ? null : resolve(index, char);
        if (!blank && !glyph) missing.add(char);
        items.push({ kind: blank ? 'blank' : 'char', index, char, glyph, width: widthOf(char, glyph, size), ascent: size, descent: 0, size, pen: pens[index] });
      }
      const rows = [];
      let row = [], x = 0, limit = available - indent;
      for (const item of items) {
        if (x + item.width > limit + 1e-9 && row.length) { rows.push(row); row = []; x = 0; limit = available; }
        row.push({ item, x });
        x += item.width + gap;
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
        const space = (number === 0 ? available - indent : available) - rowWidth;
        const offset = (number === 0 ? indent : 0) + (para.align === 'center' ? space / 2 : para.align === 'right' ? space : 0);
        const baseline = top + ascent, origin = left(page) + offset;
        for (const { item, x: cellX } of cells) {
          const x0 = origin + cellX;
          const caret = { page, x: x0, y: top, height: rowHeight };
          if (item.kind === 'formula') {
            for (let i = item.index; i < item.end; i++) carets[i] = caret;
            placements.push({ kind: 'formula', index: item.index, end: item.end, char: '∫', x: x0, y: baseline - item.ascent, page, width: item.width, height: rowHeight, size: item.size, pen: item.pen, box: item.box });
            continue;
          }
          carets[item.index] = caret;
          if (item.kind === 'char') placements.push({ index: item.index, char: item.char, x: x0, y: baseline - item.size, page, width: item.width, size: item.size, pen: item.pen, glyph: item.glyph });
        }
        // Caret after the row's last character (end of paragraph, or before the first char of the next row).
        const after = { page, x: origin + rowWidth, y: top, height: rowHeight };
        if (number === rows.length - 1) carets[end] = after;
        top += pitch ? Math.max(pitch, rowHeight + (pitch - baseSize > 0 ? 0 : lineGap)) : rowHeight + lineGap;
      });
      start = end + 1;
    }
    for (let i = 0; i <= count; i++) if (!carets[i]) carets[i] = carets[i - 1] || { page: 1, x: left(1), y: margin, height: baseSize };
    return { placements, carets, missing: [...missing], formulaErrors, overflow, pages: page };
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

  function generate(text, options) {
    const { width, height, margin, size, gap, lineGap, feed, penUp, penDown } = options;
    // Pen zero (work 0,0) in paper mm from the left / bottom edge, and machine axis directions.
    const origin = { x: 0, y: 0, dirX: 1, dirY: 1, ...options.origin };
    if (![origin.x, origin.y].every(Number.isFinite) || ![1, -1].includes(origin.dirX) || ![1, -1].includes(origin.dirY)) throw Error('笔起点或坐标方向无效。');
    if (![width,height,margin,size,gap,lineGap,feed,penUp,penDown].every(Number.isFinite) || width<=0 || height<=0 || size<=0 || feed<=0 || margin<0 || gap<0 || lineGap<0 || margin*2+size>Math.min(width,height) || penUp<=penDown) throw Error('纸张、速度或抬落笔参数无效（抬笔 Z 必须大于落笔 Z）。');
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
    const lines = ['; Single-line text / Z-axis pen profile - review before use',
      `; Pen zero at ${n(origin.x)} mm from paper left, ${n(origin.y)} mm from paper bottom; +X ${origin.dirX > 0 ? 'right' : 'left'}, +Y ${origin.dirY > 0 ? 'up' : 'down'}`,
      `; Page ${page} of ${pages}${pen === null ? '' : `; pen ${pen}`}`,
      'G21', 'G90', 'G17', `G0 Z${n(penUp)}`, `G1 F${n(feed)}`];
    const toWork = (px, py) => `X${n(origin.dirX*(px-origin.x))} Y${n(origin.dirY*(height-py-origin.y))}`;
    const stroke = (points) => {
      lines.push(`G0 ${toWork(...points[0])}`, `G1 Z${n(penDown)} F${n(Math.min(feed,300))}`);
      for (const p of points.slice(1)) lines.push(`G1 ${toWork(...p)} F${n(feed)}`);
      lines.push(`G0 Z${n(penUp)}`);
    };
    // Each character / formula is written with its own size and pen (formatting runs), else the text pen.
    for (const item of result.placements.filter((entry) => entry.page === page && (pen === null || pen === (entry.pen || textPen)))) {
      if (item.kind === 'formula') {
        for (const points of item.box.strokes) stroke(points.map(([px, py]) => [item.x + px, item.y + py]));
        continue;
      }
      const { x, y, glyph } = item;
      const scale = (item.size || size) / glyph.unitsPerEm;
      const point = p => `X${n(origin.dirX*(x+p[0]*scale-origin.x))} Y${n(origin.dirY*(height-y-p[1]*scale-origin.y))}`;
      for (const strokePoints of glyph.strokes) {
        lines.push(`G0 ${point(strokePoints[0])}`, `G1 Z${n(penDown)} F${n(Math.min(feed,300))}`);
        for (const p of strokePoints.slice(1)) lines.push(`G1 ${point(p)} F${n(feed)}`);
        lines.push(`G0 Z${n(penUp)}`);
      }
    }
    for (const points of orderPaths(drawings.filter((item) => item.page === page && (pen === null || item.pen === pen)).map((item) => item.points))) stroke(points);
    lines.push('; End - pen remains raised, no automatic homing');
    return lines.join('\n');
  }
  // Deliberately strict subset: do not silently simulate unknown machine commands.
  function parse(source, penDown=0) {
    if (source.length > 500000) return { segments: [], errors: ['程序超过 500 KB 预览上限，请拆分。'], commands: [], bounds: { minX:0,minY:0,maxX:0,maxY:0,minZ:0,maxZ:0 }, length: 0 };
    let pos={x:0,y:0,z:0}, absolute=true, unit=1, mode=0, feed=1000, explicitPen=null;
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
      const words={}; let invalid=false;
      for (const [,letter,num] of tokens) {
        const value=Number(num);
        if (!Number.isFinite(value)) {invalid=true;break;}
        if (letter==='G') {
          if ([0,1,2,3].includes(value)) mode=value;
          else if (value===90) absolute=true;
          else if (value===91) absolute=false;
          else if (value===20) unit=25.4;
          else if (value===21) unit=1;
          else if (value!==17) invalid=true;
        } else if (letter==='M') {
          if (value===3) explicitPen=true;
          else if (value===5) explicitPen=false;
          else if (![2,30].includes(value)) invalid=true;
          if ([2,30].includes(value)) { errors.push(`第 ${line} 行：请移除 M2 / M30 结束标记后再导入`); invalid=true; }
        } else if ('XYZIJFSN'.includes(letter)) { if (letter in words) invalid=true; words[letter]=value; }
        else invalid=true;
      }
      if (invalid) { errors.push(`第 ${line} 行：包含不支持的指令；仅支持 G0–G3、G17、G20/21、G90/91、M3/5 和 XYZ/IJ/F/S/N`); return; }
      if (words.F!==undefined) {feed=words.F*unit;if(feed<=0) {errors.push(`第 ${line} 行：进给速度必须为正数`);return;}}
      const next={...pos};
      for (const axis of ['x','y','z']) if (words[axis.toUpperCase()]!==undefined) next[axis]=(absolute?0:pos[axis])+words[axis.toUpperCase()]*unit;
      const hasXY=words.X!==undefined||words.Y!==undefined;
      const arc=[2,3].includes(mode)&&(hasXY||words.I!==undefined||words.J!==undefined);
      const rapid=mode===0;
      const drawing=!rapid&&(explicitPen===null?next.z<=penDown+.001:explicitPen);
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
    return {segments,errors,commands,bounds,length};
  }
  const api={generate,parse,layoutText,orderPaths,backgroundPaths,BACKGROUNDS,GRID_BACKGROUNDS,MAX_PAGES};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.PathEngine=api;
})(typeof window!=='undefined'?window:globalThis);
