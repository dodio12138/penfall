/* Glyph libraries + per-document glyph selection (see docs/glyph-format.md). Pure logic; also used by Node tests. */
(function (root) {
  'use strict';
  const FORMAT = 'web-typewriter/glyph-library';
  const BUILTIN_ID = 'builtin-latin';
  const STRATEGIES = ['first', 'cycle', 'random'];
  const LIBRARY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const VARIANT_ID = /^[A-Za-z0-9_-]{1,32}$/;
  const LIMITS = { variants: 32, strokes: 64, points: 2000, totalPoints: 5_000_000, prefer: 5000, pins: 20000, libraries: 16 };

  const isChar = (value) => typeof value === 'string' && Array.from(value).length === 1;
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

  /** Validate a library file; returns a clean, serializable copy or throws a readable error. */
  function normalizeLibrary(raw) {
    if (!raw || raw.format !== FORMAT || raw.version !== 1) throw Error('不是 v1 字形库文件（format 应为 web-typewriter/glyph-library）。');
    if (!LIBRARY_ID.test(raw.id || '')) throw Error('字库 id 无效：1–64 位小写字母、数字、- _ .');
    const unitsPerEm = raw.unitsPerEm === undefined ? 1000 : raw.unitsPerEm;
    if (!Number.isFinite(unitsPerEm) || unitsPerEm < 16 || unitsPerEm > 16384) throw Error('unitsPerEm 无效。');
    if (!Array.isArray(raw.glyphs) || !raw.glyphs.length) throw Error('字库中没有字形。');
    const bound = unitsPerEm * 4, seen = new Set();
    let total = 0;
    const glyphs = raw.glyphs.map((glyph, glyphIndex) => {
      const where = `第 ${glyphIndex + 1} 个字`;
      if (!glyph || !isChar(glyph.char)) throw Error(`${where}：char 必须是一个字符。`);
      if (seen.has(glyph.char)) throw Error(`字符「${glyph.char}」重复。`);
      seen.add(glyph.char);
      if (!Array.isArray(glyph.variants) || !glyph.variants.length || glyph.variants.length > LIMITS.variants) throw Error(`「${glyph.char}」需要 1–${LIMITS.variants} 个变体。`);
      const ids = new Set();
      const variants = glyph.variants.map((variant) => {
        if (!variant || !VARIANT_ID.test(variant.id || '') || ids.has(variant.id)) throw Error(`「${glyph.char}」的变体 id 缺失、无效或重复。`);
        ids.add(variant.id);
        const advance = variant.advance === undefined ? unitsPerEm : variant.advance;
        if (!Number.isFinite(advance) || advance <= 0 || advance > bound) throw Error(`「${glyph.char}/${variant.id}」advance 无效。`);
        if (!Array.isArray(variant.strokes) || !variant.strokes.length || variant.strokes.length > LIMITS.strokes) throw Error(`「${glyph.char}/${variant.id}」需要 1–${LIMITS.strokes} 笔。`);
        const strokes = variant.strokes.map((stroke) => {
          if (!Array.isArray(stroke) || !stroke.length || stroke.length > LIMITS.points) throw Error(`「${glyph.char}/${variant.id}」笔画点数无效。`);
          total += stroke.length;
          return stroke.map((point) => {
            if (!Array.isArray(point) || point.length < 2 || point.length > 4 || !point.every(Number.isFinite) || Math.abs(point[0]) > bound || Math.abs(point[1]) > bound) throw Error(`「${glyph.char}/${variant.id}」含无效坐标。`);
            return point.slice(0, 4);
          });
        });
        if (total > LIMITS.totalPoints) throw Error('字库点数超过 500 万上限。');
        const clean = { id: variant.id, advance, strokes };
        if (Array.isArray(variant.tags)) clean.tags = variant.tags.filter((tag) => typeof tag === 'string').slice(0, 16).map((tag) => tag.slice(0, 32));
        if (variant.source && typeof variant.source === 'object' && !Array.isArray(variant.source)) clean.source = JSON.parse(JSON.stringify(variant.source));
        return clean;
      });
      return { char: glyph.char, variants };
    });
    return { format: FORMAT, version: 1, id: raw.id, name: text(raw.name, 80) || raw.id, author: text(raw.author, 120), license: text(raw.license, 200), description: text(raw.description, 500), unitsPerEm, glyphs };
  }
  /** Library with a char → variants index, for lookups. */
  function indexLibrary(library) {
    return { ...library, chars: new Map(library.glyphs.map((glyph) => [glyph.char, glyph.variants])) };
  }

  // Built-in single-line Latin set. Source grid is 2 × 2 (x 0–2, y 0–2 top-down); mapped to a 700 × 1000 em box.
  const BUILTIN_STROKES = {
    A:'0,2 1,0 2,2|0.5,1 1.5,1', B:'0,2 0,0 1.4,0 2,.5 1.4,1 0,1|1.4,1 2,1.5 1.4,2 0,2',
    C:'2,.2 1.5,0 .5,0 0,.5 0,1.5 .5,2 1.5,2 2,1.8', D:'0,2 0,0 1,0 2,.5 2,1.5 1,2 0,2',
    E:'2,0 0,0 0,2 2,2|0,1 1.5,1', F:'0,2 0,0 2,0|0,1 1.5,1', G:'2,.3 1.5,0 .5,0 0,.5 0,1.5 .5,2 2,2 2,1 1,1',
    H:'0,0 0,2|2,0 2,2|0,1 2,1', I:'0,0 2,0|1,0 1,2|0,2 2,2', J:'0,0 2,0 2,1.5 1.5,2 .5,2 0,1.5',
    K:'0,0 0,2|2,0 0,1 2,2', L:'0,0 0,2 2,2', M:'0,2 0,0 1,1 2,0 2,2', N:'0,2 0,0 2,2 2,0',
    O:'.5,0 1.5,0 2,.5 2,1.5 1.5,2 .5,2 0,1.5 0,.5 .5,0', P:'0,2 0,0 1.5,0 2,.5 1.5,1 0,1',
    Q:'.5,0 1.5,0 2,.5 2,1.5 1.5,2 .5,2 0,1.5 0,.5 .5,0|1,1 2,2', R:'0,2 0,0 1.5,0 2,.5 1.5,1 0,1|1,1 2,2',
    S:'2,0 .5,0 0,.5 .5,1 1.5,1 2,1.5 1.5,2 0,2', T:'0,0 2,0|1,0 1,2', U:'0,0 0,1.5 .5,2 1.5,2 2,1.5 2,0',
    V:'0,0 1,2 2,0', W:'0,0 .5,2 1,1 1.5,2 2,0', X:'0,0 2,2|2,0 0,2', Y:'0,0 1,1 2,0|1,1 1,2', Z:'0,0 2,0 0,2 2,2',
    0:'.5,0 1.5,0 2,.5 2,1.5 1.5,2 .5,2 0,1.5 0,.5 .5,0|.4,1.7 1.6,.3',
    1:'.5,.5 1,0 1,2|.3,2 1.7,2', 2:'0,.4 .5,0 1.5,0 2,.5 0,2 2,2', 3:'0,0 2,0 1,1 2,1.5 1.5,2 0,2',
    4:'1.5,2 1.5,0 0,1.3 2,1.3', 5:'2,0 0,0 0,1 1.5,1 2,1.5 1.5,2 0,2', 6:'2,0 .5,0 0,1.5 .5,2 1.5,2 2,1.5 1.5,1 0,1',
    7:'0,0 2,0 .5,2', 8:'.5,0 1.5,0 2,.5 0,1.5 .5,2 1.5,2 2,1.5 0,.5 .5,0', 9:'2,1 .5,1 0,.5 .5,0 1.5,0 2,.5 2,1.5 1.5,2 0,2',
    '-':'0,1 2,1', '.':'.9,1.9 1,2', ',':'1,1.8 .7,2.3', ':':'1,.5 1,.6|1,1.5 1,1.6', '/':'0,2 2,0', '!':'1,0 1,1.4|1,1.9 1,2', '?':'0,.3 .5,0 1.5,0 2,.5 1,1 1,1.4|1,1.9 1,2', '+':'0,1 2,1|1,0 1,2', '=':'0,.7 2,.7|0,1.3 2,1.3'
  };
  let builtin = null;
  function builtinLibrary() {
    if (builtin) return builtin;
    const glyphs = [];
    for (const [char, source] of Object.entries(BUILTIN_STROKES)) {
      const strokes = source.split('|').map((stroke) => stroke.split(' ').map((point) => { const [x, y] = point.split(',').map(Number); return [x * 350, y * 500]; }));
      glyphs.push({ char, variants: [{ id: 'v1', advance: 700, strokes }] });
      // Lowercase letters reuse the capital shapes, as the original generator did.
      if (/[A-Z]/.test(char)) glyphs.push({ char: char.toLowerCase(), variants: [{ id: 'v1', advance: 700, strokes }] });
    }
    builtin = indexLibrary(normalizeLibrary({ format: FORMAT, version: 1, id: BUILTIN_ID, name: '内置单线英文', description: '英文字母（小写按大写书写）、数字及 - . , : / ! ? + =', license: '随本项目提供', unitsPerEm: 1000, glyphs }));
    return builtin;
  }

  const DEFAULT_SELECTION = Object.freeze({ libraries: [BUILTIN_ID], strategy: 'first', seed: 1, prefer: {}, pins: [] });
  function validRef(ref) { return ref && LIBRARY_ID.test(ref.library || '') && VARIANT_ID.test(ref.variant || ''); }
  /** Per-document selection; unknown or malformed parts fall back to defaults, never throw. */
  function normalizeSelection(raw) {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const libraries = Array.isArray(value.libraries) ? [...new Set(value.libraries.filter((id) => typeof id === 'string' && LIBRARY_ID.test(id)))].slice(0, LIMITS.libraries) : [...DEFAULT_SELECTION.libraries];
    const prefer = {};
    if (value.prefer && typeof value.prefer === 'object' && !Array.isArray(value.prefer)) {
      for (const [char, ref] of Object.entries(value.prefer).slice(0, LIMITS.prefer)) if (char !== '__proto__' && isChar(char) && validRef(ref)) prefer[char] = { library: ref.library, variant: ref.variant };
    }
    const pins = [];
    const used = new Set();
    for (const pin of Array.isArray(value.pins) ? value.pins.slice(0, LIMITS.pins) : []) {
      if (pin && Number.isInteger(pin.at) && pin.at >= 0 && !used.has(pin.at) && isChar(pin.char) && validRef(pin)) { used.add(pin.at); pins.push({ at: pin.at, char: pin.char, library: pin.library, variant: pin.variant }); }
    }
    pins.sort((a, b) => a.at - b.at);
    return {
      libraries,
      strategy: STRATEGIES.includes(value.strategy) ? value.strategy : DEFAULT_SELECTION.strategy,
      seed: Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 2147483647 ? value.seed : DEFAULT_SELECTION.seed,
      prefer, pins,
    };
  }

  function hash(seed, char, occurrence) {
    let h = (seed ^ 0x9e3779b9) >>> 0;
    for (const value of [char.codePointAt(0), occurrence]) { h = Math.imul(h ^ value, 0x85ebca6b) >>> 0; h = (h ^ (h >>> 13)) >>> 0; h = Math.imul(h, 0xc2b2ae35) >>> 0; h = (h ^ (h >>> 16)) >>> 0; }
    return h;
  }
  /**
   * Returns resolve(index, char) → { library, variant, unitsPerEm, advance, strokes, source } | null.
   * Stateful (counts occurrences): create one per layout pass and call in text order.
   */
  function createResolver(selection, libraries) {
    const enabled = selection.libraries.map((id) => libraries.get(id)).filter(Boolean);
    const pins = new Map(selection.pins.map((pin) => [pin.at, pin]));
    const occurrences = new Map();
    const find = (ref, char) => {
      if (!ref || !selection.libraries.includes(ref.library)) return null;
      const library = libraries.get(ref.library);
      const variant = library?.chars.get(char)?.find((item) => item.id === ref.variant);
      return variant ? { library, variant } : null;
    };
    return function resolve(index, char) {
      const occurrence = occurrences.get(char) || 0;
      occurrences.set(char, occurrence + 1);
      const pin = pins.get(index);
      let hit = pin && pin.char === char ? find(pin, char) : null, source = 'pin';
      if (!hit) { hit = find(selection.prefer[char], char); source = 'prefer'; }
      if (!hit) {
        const library = enabled.find((item) => item.chars.has(char));
        if (!library) return null;
        const variants = library.chars.get(char);
        const pick = selection.strategy === 'cycle' ? occurrence % variants.length : selection.strategy === 'random' ? hash(selection.seed, char, occurrence) % variants.length : 0;
        hit = { library, variant: variants[pick] };
        source = selection.strategy;
      }
      return { library: hit.library.id, variant: hit.variant.id, unitsPerEm: hit.library.unitsPerEm, advance: hit.variant.advance, strokes: hit.variant.strokes, source };
    };
  }
  /** Every variant of a character across the enabled libraries, in priority order (for pickers). */
  function candidates(selection, libraries, char) {
    const result = [];
    for (const id of selection.libraries) {
      const library = libraries.get(id);
      for (const variant of library?.chars.get(char) || []) result.push({ library: id, libraryName: library.name, unitsPerEm: library.unitsPerEm, variant: variant.id, advance: variant.advance, strokes: variant.strokes });
    }
    return result;
  }
  /** Keep pins attached to the same characters across an edit (single contiguous change). */
  function shiftPins(pins, before, after) {
    if (!pins.length || before === after) return pins;
    const a = Array.from(before), b = Array.from(after);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const delta = b.length - a.length, changedEnd = a.length - suffix;
    return pins.flatMap((pin) => {
      const at = pin.at < prefix ? pin.at : pin.at >= changedEnd ? pin.at + delta : -1;
      return at >= 0 && b[at] === pin.char ? [{ ...pin, at }] : [];
    });
  }

  /**
   * Hershey .jhf (ASCII order, glyph 1 = space) → library. Coordinates are letters relative to 'R';
   * " R" lifts the pen. Cap height (y −12…9) maps to the em box so 字高 ≈ capital height.
   */
  function fromJHF(source, meta) {
    const lines = [];
    for (const raw of source.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      // Some distributions wrap long glyphs onto continuation lines without a 5-column id.
      if (/^\s*\d+\s*\d+/.test(raw.slice(0, 8)) || !lines.length) lines.push(raw); else lines[lines.length - 1] += raw;
    }
    const units = 1000, capTop = -12, base = 9, scale = units / (base - capTop);
    const value = (char) => char.charCodeAt(0) - 82;
    const glyphs = [];
    lines.forEach((line, index) => {
      const code = 32 + index;
      if (code <= 32 || code >= 127) return;
      const left = value(line[8]), right = value(line[9]);
      const strokes = [];
      let stroke = [];
      for (let i = 10; i + 1 < line.length; i += 2) {
        if (line[i] === ' ' && line[i + 1] === 'R') { if (stroke.length) strokes.push(stroke); stroke = []; continue; }
        stroke.push([Math.round((value(line[i]) - left) * scale * 10) / 10, Math.round((value(line[i + 1]) - capTop) * scale * 10) / 10]);
      }
      if (stroke.length) strokes.push(stroke);
      if (strokes.length) glyphs.push({ char: String.fromCharCode(code), variants: [{ id: 'v1', advance: Math.max(1, Math.round((right - left) * scale)), strokes }] });
    });
    return normalizeLibrary({ format: FORMAT, version: 1, unitsPerEm: units, license: 'Hershey Fonts：可自由使用、转换与再分发，须附致谢：The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of Standards. The format of the Font data was originally created by James Hurt, Cognition, Inc.', ...meta, glyphs });
  }

  const api = { FORMAT, fromJHF, BUILTIN_ID, STRATEGIES, DEFAULT_SELECTION, normalizeLibrary, indexLibrary, builtinLibrary, normalizeSelection, createResolver, candidates, shiftPins };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Glyphs = api;
})(typeof window !== 'undefined' ? window : globalThis);
