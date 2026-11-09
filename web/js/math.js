/* Formula typesetting: a LaTeX subset → single-line strokes (mm). Pure logic, shared with Node tests.
 *   \frac{a}{b}  \sqrt[n]{x}  x^{2}  x_{i}  \sum_{i=1}^{n}  \prod  \int_a^b  \oint  \lim_{x\to0}
 *   \left( … \right)  ( … ) auto-sized around tall content   \text{…}   Greek letters, common symbols
 * Boxes use baseline coordinates: x right, y down, baseline at y = 0; size s = font size in mm. */
(function (root) {
  'use strict';
  const SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
    infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', uparrow: '↑', downarrow: '↓', in: '∈', cup: '∪', cap: '∩', subset: '⊂', supset: '⊃',
    angle: '∠', perp: '⊥', parallel: '∥', because: '∵', therefore: '∴', degree: '°', circ: '°', cdots: '…', ldots: '…', dots: '…', prime: '′', partial: '∂', nabla: '∇', triangle: '△', odot: '⊙',
    quad: ' ', qquad: '  ', ',': ' ', ';': ' ', '!': '', '{': '{', '}': '}', '%': '%', '$': '$', '#': '#', '&': '&', '_': '_', '\\': '\\',
  };
  const BIG = { sum: '∑', prod: '∏', int: '∫', oint: '∮', iint: '∫∫' };
  const FUNCTIONS = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'lg', 'exp', 'max', 'min', 'lim', 'arcsin', 'arccos', 'arctan', 'det'];
  const BINARY = new Set([...'+-=<>×÷·±∓≤≥≠≈≡∼∝→←⇒∈∪∩⊂⊃']);
  const OPEN = { '(': ')', '[': ']', '{': '}', '|': '|' };

  // --- parsing: source → tree ---
  function tokenize(source) {
    const tokens = [];
    for (let i = 0; i < source.length;) {
      const char = source[i];
      if (char === '\\') {
        const match = source.slice(i + 1).match(/^([A-Za-z]+|.)/);
        if (!match) throw Error('公式末尾多了反斜杠');
        tokens.push({ type: 'command', value: match[1] });
        i += 1 + match[1].length;
      } else if (/\s/.test(char)) i++;
      else { tokens.push({ type: 'char', value: char }); i += [...source.slice(i, i + 2)][0].length; }
    }
    return tokens;
  }
  function parse(source) {
    const tokens = tokenize(source);
    let at = 0;
    const peek = () => tokens[at];
    const next = () => tokens[at++];
    const expect = (value) => { const token = next(); if (!token || token.value !== value) throw Error(`公式缺少「${value}」`); };
    function group() {
      if (peek()?.value === '{' && peek().type === 'char') { next(); const list = sequence('}'); expect('}'); return { type: 'row', items: list }; }
      const token = peek();
      if (!token) throw Error('公式不完整（缺少参数）');
      return primary();
    }
    function optional() {
      if (peek()?.value !== '[') return null;
      next(); const list = sequence(']'); expect(']'); return { type: 'row', items: list };
    }
    function primary() {
      const token = next();
      if (token.type === 'char') {
        if (token.value === '{') { const list = sequence('}'); expect('}'); return { type: 'row', items: list }; }
        if (token.value === '(' || token.value === '[') {
          const close = OPEN[token.value], list = sequence(close);
          if (peek()?.value === close) { next(); return { type: 'fence', open: token.value, close, body: { type: 'row', items: list }, auto: true }; }
          return { type: 'row', items: [{ type: 'symbol', char: token.value }, ...list] };
        }
        if (token.value === '^' || token.value === '_') throw Error(`「${token.value}」前缺少底数`);
        return { type: 'symbol', char: token.value };
      }
      const name = token.value;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') return { type: 'frac', num: group(), den: group() };
      if (name === 'sqrt') { const index = optional(); return { type: 'sqrt', index, body: group() }; }
      if (name === 'text' || name === 'mathrm' || name === 'operatorname') {
        expect('{');
        let text = '';
        while (peek() && peek().value !== '}') { const t = next(); text += t.type === 'command' ? (SYMBOLS[t.value] ?? t.value) : t.value; }
        expect('}');
        return { type: 'text', text };
      }
      if (name === 'left') {
        const open = next();
        const list = sequence('\\right');
        if (peek()?.value !== 'right') throw Error('\\left 缺少对应的 \\right');
        next();
        const close = next();
        return { type: 'fence', open: open.value === '.' ? '' : open.value, close: close.value === '.' ? '' : close.value, body: { type: 'row', items: list } };
      }
      if (BIG[name]) return { type: 'big', char: BIG[name], limits: name === 'sum' || name === 'prod' };
      if (FUNCTIONS.includes(name)) return { type: 'function', text: name, limits: name === 'lim' || name === 'max' || name === 'min' };
      if (name in SYMBOLS) return { type: 'symbol', char: SYMBOLS[name] };
      throw Error(`不支持的命令 \\${name}`);
    }
    function sequence(close) {
      const items = [];
      while (peek() && !(peek().value === close && (close !== '\\right' || peek().type === 'command'))) {
        if (close === '\\right' && peek().type === 'command' && peek().value === 'right') break;
        let item = primary();
        // Scripts: ^ and _ in any order, each once.
        while (peek() && (peek().value === '^' || peek().value === '_') && peek().type === 'char') {
          const kind = next().value === '^' ? 'sup' : 'sub';
          if (item.type !== 'scripts') item = { type: 'scripts', base: item, sup: null, sub: null };
          if (item[kind]) throw Error(`重复的${kind === 'sup' ? '上标' : '下标'}`);
          item[kind] = group();
        }
        items.push(item);
      }
      return items;
    }
    const items = sequence(null);
    if (at < tokens.length) throw Error(`多余的「${tokens[at].value}」`);
    return { type: 'row', items };
  }

  // --- layout: tree → box { w, h, d, strokes } ---
  const box = (w = 0, h = 0, d = 0, strokes = []) => ({ w, h, d, strokes });
  const shift = (strokes, dx, dy) => strokes.map((stroke) => stroke.map(([x, y]) => [x + dx, y + dy]));
  function hbox(boxes, gaps = []) {
    let x = 0;
    const result = box();
    boxes.forEach((item, i) => {
      x += gaps[i] || 0;
      result.strokes.push(...shift(item.strokes, x, 0));
      x += item.w;
      result.h = Math.max(result.h, item.h); result.d = Math.max(result.d, item.d);
    });
    result.w = x + (gaps[boxes.length] || 0);
    return result;
  }
  function layoutTree(tree, s, glyphFor, missing) {
    const axis = -.27 * s; // fraction bars sit on the maths axis (middle of "+")
    function glyph(char, size = s) {
      const found = glyphFor(char);
      if (!found) {
        missing.add(char);
        const w = size * .6;
        return box(w, size * .8, 0, [[[w * .1, 0], [w * .9, 0], [w * .9, -size * .8], [w * .1, -size * .8], [w * .1, 0]]]);
      }
      const k = size / found.unitsPerEm;
      const strokes = found.strokes.map((stroke) => stroke.map(([x, y]) => [x * k, y * k - size]));
      let h = 0, d = 0;
      for (const stroke of strokes) for (const [, y] of stroke) { h = Math.max(h, -y); d = Math.max(d, y); }
      return box(found.advance * k, Math.max(h, size * .7), d, strokes);
    }
    const text = (value, size) => hbox([...value].map((char) => char === ' ' ? box(size * .35) : glyph(char, size)));
    function stretchedFence(char, h, d, size) {
      const top = -h - size * .08, bottom = d + size * .08, w = size * .35, mid = (top + bottom) / 2;
      if (!char) return box(size * .1);
      let strokes;
      if (char === '(' || char === ')') {
        const arc = Array.from({ length: 13 }, (_, i) => { const a = -Math.PI / 2 + Math.PI * i / 12; return [w * .75 - Math.cos(a) * w * .5, mid + Math.sin(a) * (bottom - top) / 2]; });
        strokes = [char === '(' ? arc : arc.map(([x, y]) => [w - x, y])];
      } else if (char === '[' || char === ']') {
        const near = w * .3, far = w * .75;
        strokes = [char === '[' ? [[far, top], [near, top], [near, bottom], [far, bottom]] : [[w - far, top], [w - near, top], [w - near, bottom], [w - far, bottom]]];
      } else if (char === '|') strokes = [[[w / 2, top], [w / 2, bottom]]];
      else if (char === '{' || char === '}') {
        const brace = [[w * .8, top], [w * .5, top + (mid - top) * .15], [w * .5, mid - (mid - top) * .2], [w * .2, mid], [w * .5, mid + (bottom - mid) * .2], [w * .5, bottom - (bottom - mid) * .15], [w * .8, bottom]];
        strokes = [char === '{' ? brace : brace.map(([x, y]) => [w - x, y])];
      } else return glyph(char, size);
      return box(w, -top, bottom, strokes);
    }
    function lay(node, size) {
      switch (node.type) {
        case 'row': {
          const parts = node.items.map((item) => lay(item, size));
          // Thin space around binary operators / relations, like TeX.
          const gaps = [0];
          node.items.forEach((item, i) => {
            const binary = item.type === 'symbol' && BINARY.has(item.char) && i > 0;
            gaps[i] = (gaps[i] || 0) + (binary ? size * .12 : 0);
            gaps[i + 1] = binary ? size * .12 : (item.type === 'big' || item.type === 'function' ? size * .1 : 0);
          });
          return hbox(parts, gaps);
        }
        case 'symbol': return node.char === ' ' ? box(size * .35) : glyph(node.char, size);
        case 'text': return text(node.text, size);
        case 'function': {
          const word = text(node.text, size);
          return node.limits ? Object.assign(word, { limits: true }) : word;
        }
        case 'big': {
          // Integral glyphs are slim in most fonts: draw them taller than ∑ / ∏.
          const symbol = hbox([...node.char].map((char) => glyph(char, size * (node.limits ? 1.3 : 1.8))));
          // Centre big operators on the maths axis.
          const centre = (symbol.d - symbol.h) / 2, offset = axis - centre;
          return Object.assign(box(symbol.w, symbol.h - offset, symbol.d + offset, shift(symbol.strokes, 0, offset)), { limits: node.limits, big: true });
        }
        case 'frac': {
          const small = size * .82;
          const num = lay(node.num, small), den = lay(node.den, small);
          const w = Math.max(num.w, den.w) + size * .25, gap = size * .14;
          const numBase = axis - gap - num.d, denBase = axis + gap + den.h;
          return box(w, -(numBase - num.h), denBase + den.d, [
            ...shift(num.strokes, (w - num.w) / 2, numBase), ...shift(den.strokes, (w - den.w) / 2, denBase),
            [[size * .05, axis], [w - size * .05, axis]],
          ]);
        }
        case 'sqrt': {
          const body = lay(node.body, size);
          const top = -(body.h + size * .15), bottom = body.d + size * .05, height = bottom - top;
          const lead = Math.max(size * .5, height * .32);
          const tick = [[0, bottom - height * .42], [lead * .22, bottom - height * .5], [lead * .5, bottom], [lead * .95, top], [lead + body.w + size * .1, top]];
          const result = box(lead + body.w + size * .15, -top, bottom, [tick, ...shift(body.strokes, lead, 0)]);
          if (node.index) {
            const index = lay(node.index, size * .55);
            const y = bottom - height * .5 - size * .08 - index.d;
            result.strokes.push(...shift(index.strokes, Math.max(0, lead * .2 - index.w / 2), y));
            result.h = Math.max(result.h, -(y - index.h));
          }
          return result;
        }
        case 'fence': {
          const body = lay(node.body, size);
          const tall = !node.auto || body.h + body.d > size * 1.35;
          const open = tall ? stretchedFence(node.open, body.h, body.d, size) : glyph(node.open, size);
          const close = tall ? stretchedFence(node.close, body.h, body.d, size) : glyph(node.close, size);
          return hbox([open, body, close], [0, size * .05, size * .05, 0]);
        }
        case 'scripts': {
          const base = lay(node.base, size), small = size * .7;
          const sup = node.sup && lay(node.sup, small), sub = node.sub && lay(node.sub, small);
          if (base.limits) {
            // Limits above / below (∑, ∏, lim): centred on the operator.
            const w = Math.max(base.w, sup?.w || 0, sub?.w || 0);
            const result = box(w, base.h, base.d, shift(base.strokes, (w - base.w) / 2, 0));
            if (sup) { const y = -base.h - size * .06 - sup.d; result.strokes.push(...shift(sup.strokes, (w - sup.w) / 2, y)); result.h = -(y - sup.h); }
            if (sub) { const y = base.d + size * .02 + sub.h * .8; result.strokes.push(...shift(sub.strokes, (w - sub.w) / 2, y)); result.d = y + sub.d; }
            return result;
          }
          const supY = sup ? -Math.max(size * .42, base.h - sup.h * .55) : 0;
          const subY = sub ? Math.max(size * .2, base.d + sub.h * .45 - size * .1) : 0;
          const kern = base.big ? size * .05 : size * .04;
          const result = box(base.w + kern + Math.max(sup?.w || 0, (sub?.w || 0) - (base.big ? size * .15 : 0)) + size * .04, base.h, base.d, [...base.strokes]);
          if (sup) { result.strokes.push(...shift(sup.strokes, base.w + kern, supY)); result.h = Math.max(result.h, -(supY - sup.h)); }
          if (sub) { result.strokes.push(...shift(sub.strokes, base.w + kern - (base.big ? size * .15 : 0), subY)); result.d = Math.max(result.d, subY + sub.d); }
          return result;
        }
        default: throw Error('未知公式结构');
      }
    }
    return lay(tree, s);
  }

  /**
   * Formula → box in mm with strokes relative to the box's top-left corner.
   * glyphFor(char) → { unitsPerEm, advance, strokes } | null. Errors become a dashed box (never silently dropped).
   */
  function layout(source, size, glyphFor) {
    const missing = new Set();
    try {
      const result = layoutTree(parse(source), size, glyphFor, missing);
      const h = Math.max(result.h, size * .75), d = Math.max(result.d, size * .05);
      return { width: Math.max(result.w, size * .3), height: h, depth: d, strokes: shift(result.strokes, 0, h).filter((stroke) => stroke.length), missing: [...missing], error: null };
    } catch (error) {
      const w = size * 2.5, h = size;
      const dash = Array.from({ length: 10 }, (_, i) => [[w * i / 10, 0], [w * (i + .5) / 10, 0]]);
      return { width: w, height: h, depth: 0, strokes: [], placeholder: [...dash, ...shift(dash, 0, h)], missing: [...missing], error: error.message };
    }
  }

  const api = { parse, layout, SYMBOLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MathLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
