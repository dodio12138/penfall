/* Workspace file formats (docs/workspace-format.md): .wtl links a .txt and its .gcode; workspace.wtw holds
 * workspace-level machine settings. Pure logic, shared with Node tests. */
(function (root) {
  'use strict';
  const Glyphs = typeof module !== 'undefined' && module.exports ? require('./glyphs.js') : root.Glyphs;
  const Machines = typeof module !== 'undefined' && module.exports ? require('./machines.js') : root.Machines;
  const LINK_FORMAT = 'penfall/link';
  const WORKSPACE_FORMAT = 'penfall/workspace';
  const ARCHIVE_FORMAT = 'penfall/workspace-archive';
  // Files written before the project was renamed (web-typewriter → Penfall) are still accepted.
  const isFormat = (value, current) => value === current || value === current.replace('penfall/', 'web-typewriter/');
  const MANIFEST = 'workspace.wtw';
  const TEXT_TYPES = ['.txt', '.md'];
  const CODE_TYPES = ['.gcode', '.nc', '.tap'];
  const DRAWING_TYPES = ['.svg', '.dxf'];
  const FILE_TYPES = [...TEXT_TYPES, ...CODE_TYPES, ...DRAWING_TYPES, '.wtl', '.wtw', '.wtt'];
  const DEFAULT_PENS = [{ name: '黑', color: '#1f2328' }, { name: '红', color: '#d0342c' }, { name: '蓝', color: '#2563eb' }];
  const VIEWS = ['editor', 'gcode', 'preview', 'path'];
  const PART = /^[^\u0000-\u001f\\/:*?"<>|]{1,120}$/;

  // --- Paths (POSIX, relative to the workspace root) ---
  const dirname = (path) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
  const extname = (path) => { const name = basename(path); const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot).toLowerCase() : ''; };
  const stem = (path) => { const name = basename(path); const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(0, dot) : name; };
  const join = (...parts) => parts.filter(Boolean).join('/');
  function validPart(part) { return PART.test(part) && !part.startsWith('.') && part.trim() === part && !part.endsWith('.'); }
  /** Same rules as the server: no traversal, no hidden files, limited depth, known file types. */
  function validPath(path, kind = 'file') {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) return false;
    const parts = path.split('/');
    return parts.length <= 8 && parts.every(validPart) && (kind !== 'file' || FILE_TYPES.includes(extname(path)));
  }
  function nameError(name) {
    if (!name || !name.trim()) return '请输入名称';
    if (!validPart(name.trim())) return '名称不能包含 / \\ : * ? " < > | 或控制字符，不能以 . 开头或结尾';
    return '';
  }
  function uniqueStem(taken, folder, wanted, extensions) {
    const has = (name) => extensions.some((ext) => taken.has(join(folder, name + ext).toLocaleLowerCase()));
    if (!has(wanted)) return wanted;
    for (let index = 2; index < 1000; index++) if (!has(`${wanted} (${index})`)) return `${wanted} (${index})`;
    throw Error('无法生成唯一名称');
  }

  // --- Content hash (cyrb53): detects edits made outside the app, not a security feature. ---
  function hash(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const strings = (value) => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([key, item]) => key !== '__proto__' && typeof item === 'string' && item.length <= 100));
  /** Everything except the text that changes the generated program. */
  function paramsHash(link) {
    const motion = { ...link.motion };
    const format = link.style && (link.style.runs.length || link.style.paras.length) ? [link.style] : [];
    return hash(JSON.stringify([Object.entries(link.settings).sort(), Object.entries(motion).sort(), link.glyphs, ...(link.drawing ? [link.drawing] : []), ...format]));
  }
  /** Inputs of the generator besides parameters: the text, plus the drawing file when there is one. */
  const inputHash = (text, drawing) => drawing ? hash(`${text}\u0000${drawing}`) : hash(text);

  // --- Rich formatting overlay on the plain text (kept in the .wtl, like pins) ---
  const ALIGNS = ['left', 'center', 'right'];
  const SCRIPTS = ['sup', 'sub'];
  const LISTS = ['bullet', 'number'];
  const RUN_KEYS = ['size', 'pen', 'underline', 'strike', 'script'];
  const PARA_KEYS = ['align', 'indent', 'spacing', 'list'];
  const hasRun = (run) => RUN_KEYS.some((key) => run[key] !== undefined);
  const sameRun = (a, b) => RUN_KEYS.every((key) => a[key] === b[key]);
  /**
   * runs: [{ from, to, size?, pen?, underline?, strike?, script? }] (code point ranges);
   * paras: [{ at, align?, indent?, spacing?, list? }] (paragraph start).
   */
  function normalizeFormat(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const runs = (Array.isArray(value.runs) ? value.runs : []).slice(0, 20000).flatMap((run) => {
      if (!run || !Number.isInteger(run.from) || !Number.isInteger(run.to) || run.from < 0 || run.to <= run.from) return [];
      const clean = { from: run.from, to: run.to };
      if (Number.isFinite(run.size) && run.size >= 1 && run.size <= 80) clean.size = run.size;
      if (Number.isInteger(run.pen) && run.pen >= 1 && run.pen <= 8) clean.pen = run.pen;
      if (run.underline === true) clean.underline = true;
      if (run.strike === true) clean.strike = true;
      if (SCRIPTS.includes(run.script)) clean.script = run.script;
      return hasRun(clean) ? [clean] : [];
    }).sort((a, b) => a.from - b.from);
    const seen = new Set();
    const paras = (Array.isArray(value.paras) ? value.paras : []).slice(0, 20000).flatMap((para) => {
      if (!para || !Number.isInteger(para.at) || para.at < 0 || seen.has(para.at)) return [];
      const clean = { at: para.at };
      if (ALIGNS.includes(para.align) && para.align !== 'left') clean.align = para.align;
      if (Number.isFinite(para.indent) && para.indent > 0 && para.indent <= 100) clean.indent = para.indent;
      if (Number.isFinite(para.spacing) && para.spacing > 1 && para.spacing <= 3) clean.spacing = para.spacing;
      if (LISTS.includes(para.list)) clean.list = para.list;
      if (!PARA_KEYS.some((key) => clean[key] !== undefined)) return [];
      seen.add(para.at);
      return [clean];
    }).sort((a, b) => a.at - b.at);
    return { runs, paras };
  }
  /**
   * Keep formatting attached to the same text across an edit (one contiguous change), like a word processor:
   * text typed at the end of a run continues the run; paragraphs keep their attributes.
   */
  function shiftFormat(format, before, after) {
    if (before === after || (!format.runs.length && !format.paras.length)) return format;
    const a = Array.from(before), b = Array.from(after);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const oldEnd = a.length - suffix, newEnd = b.length - suffix, delta = b.length - a.length;
    const runs = format.runs.map((run) => {
      const from = run.from < prefix ? run.from : run.from >= oldEnd ? run.from + delta : prefix;
      const to = run.to < prefix ? run.to : run.to === prefix ? (run.from < prefix ? newEnd : run.to) : run.to >= oldEnd ? run.to + delta : newEnd;
      return { ...run, from, to };
    }).filter((run) => run.to > run.from && run.from < b.length).map((run) => ({ ...run, to: Math.min(run.to, b.length) }));
    const paras = format.paras.map((para) => ({ ...para, at: para.at <= prefix ? para.at : para.at >= oldEnd ? para.at + delta : -1 }))
      .filter((para) => para.at >= 0 && para.at <= b.length && (para.at === 0 || b[para.at - 1] === '\n'));
    return { runs, paras };
  }

  /** Set (value) or clear (null) run attributes on [from, to): splits / merges runs as needed. */
  function applyRun(style, from, to, attrs) {
    if (to <= from) return style;
    const pieces = [];
    for (const run of style.runs) {
      if (run.to <= from || run.from >= to) { pieces.push(run); continue; }
      if (run.from < from) pieces.push({ ...run, to: from });
      if (run.to > to) pieces.push({ ...run, from: to });
      pieces.push({ ...run, from: Math.max(run.from, from), to: Math.min(run.to, to), inside: true });
    }
    // Gaps inside the range not covered by any run get a new run.
    const covered = pieces.filter((run) => run.inside).sort((a, b) => a.from - b.from);
    let at = from;
    for (const run of covered) { if (run.from > at) pieces.push({ from: at, to: run.from, inside: true }); at = Math.max(at, run.to); }
    if (at < to) pieces.push({ from: at, to, inside: true });
    const runs = pieces.map(({ inside, ...run }) => {
      if (!inside) return run;
      const next = { ...run };
      for (const [key, value] of Object.entries(attrs)) { if (value === null || value === undefined) delete next[key]; else next[key] = value; }
      return next;
    }).filter(hasRun).sort((a, b) => a.from - b.from);
    // Merge neighbours with identical attributes.
    const merged = [];
    for (const run of runs) {
      const last = merged.at(-1);
      if (last && last.to === run.from && sameRun(last, run)) last.to = run.to; else merged.push({ ...run });
    }
    return { runs: merged, paras: style.paras };
  }
  /** Paragraph start indices for the paragraphs touching [from, to]. */
  function paragraphStarts(text, from, to) {
    const chars = Array.from(text), starts = [];
    let start = from;
    while (start > 0 && chars[start - 1] !== '\n') start--;
    starts.push(start);
    for (let i = start; i < Math.min(to, chars.length); i++) if (chars[i] === '\n' && i + 1 <= to) starts.push(i + 1);
    return [...new Set(starts)];
  }
  function applyParagraph(style, starts, attrs) {
    const paras = new Map(style.paras.map((para) => [para.at, { ...para }]));
    for (const at of starts) {
      const next = { ...(paras.get(at) || { at }) };
      for (const [key, value] of Object.entries(attrs)) { if (value === null || value === undefined || value === 'left' || value === 0 || (key === 'spacing' && value <= 1)) delete next[key]; else next[key] = value; }
      if (PARA_KEYS.some((key) => next[key] !== undefined)) paras.set(at, next); else paras.delete(at);
    }
    return { runs: style.runs, paras: [...paras.values()].sort((a, b) => a.at - b.at) };
  }

  function normalizeLink(raw, linkPath) {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (value.format !== undefined && !isFormat(value.format, LINK_FORMAT)) throw Error('不是稿件链接文件（format 应为 penfall/link）');
    const name = stem(linkPath || 'untitled.wtl');
    const sibling = (key, fallback, types) => (typeof value[key] === 'string' && validPart(value[key]) && types.includes(extname(value[key])) ? value[key] : fallback);
    const sync = value.sync && typeof value.sync === 'object' ? value.sync : {};
    const drawing = value.drawing && typeof value.drawing === 'object' ? value.drawing : null;
    const number = (item, min, max) => Number.isFinite(item) && item >= min && item <= max ? item : null;
    return {
      format: LINK_FORMAT, version: 1,
      text: sibling('text', `${name}.txt`, TEXT_TYPES),
      gcode: sibling('gcode', `${name}.gcode`, CODE_TYPES),
      settings: strings(value.settings),
      motion: strings(value.motion),
      glyphs: Glyphs.normalizeSelection(value.glyphs),
      view: VIEWS.includes(value.view) ? value.view : 'editor',
      style: normalizeFormat(value.style), // rich formatting overlay (sizes, pens, alignment, indents)
      // Optional drawing (SVG / DXF in the same folder) placed on a page: x / y = top-left on paper, width in mm.
      drawing: drawing && typeof drawing.file === 'string' && validPart(drawing.file) && DRAWING_TYPES.includes(extname(drawing.file))
        ? { file: drawing.file, page: Number.isInteger(drawing.page) && drawing.page >= 1 && drawing.page <= 99 ? drawing.page : 1, x: number(drawing.x, -1000, 2000), y: number(drawing.y, -1000, 2000), width: number(drawing.width, .1, 4000) }
        : null,
      sync: {
        source: ['generated', 'manual'].includes(sync.source) ? sync.source : '',
        textHash: typeof sync.textHash === 'string' ? sync.textHash : '',
        paramsHash: typeof sync.paramsHash === 'string' ? sync.paramsHash : '',
        gcodeHash: typeof sync.gcodeHash === 'string' ? sync.gcodeHash : '',
        at: typeof sync.at === 'string' ? sync.at : '',
      },
    };
  }
  const serializeLink = (link) => JSON.stringify(link, null, 2) + '\n';
  /** Record that text, parameters and program currently belong together. */
  function markSynced(link, text, gcode, source, drawing = '') {
    link.sync = { source, textHash: inputHash(text, drawing), paramsHash: paramsHash(link), gcodeHash: hash(gcode), at: new Date().toISOString() };
    return link;
  }
  /**
   * 梳串: compare files with the hashes recorded at the last sync.
   *  - 'synced'     nothing changed since text and program were last consistent
   *  - 'regenerate' text / parameters changed and the program is unmodified generator output → regenerate
   *  - 'stale'      text / parameters changed but the program was written by hand → warn, never overwrite
   *  - 'external'   the program changed outside the app → keep it, now treated as manual
   *  - 'empty'      no program yet → generate from the text
   *  - 'new'        a program exists but was never synced (e.g. copied in) → treated as manual
   */
  function analyzeSync(link, text, gcode, drawing = '') {
    const sync = link.sync;
    if (!gcode.trim()) return { state: 'empty', source: sync.source };
    if (!sync.gcodeHash) return { state: 'new', source: sync.source || 'manual' };
    if (hash(gcode) !== sync.gcodeHash) return { state: 'external', source: 'manual' };
    const inputsChanged = inputHash(text, drawing) !== sync.textHash || paramsHash(link) !== sync.paramsHash;
    if (!inputsChanged) return { state: 'synced', source: sync.source };
    return { state: sync.source === 'generated' ? 'regenerate' : 'stale', source: sync.source };
  }

  function normalizeManifest(raw) {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (value.format !== undefined && !isFormat(value.format, WORKSPACE_FORMAT)) throw Error('不是工作区清单（format 应为 penfall/workspace）');
    const machine = value.machine && typeof value.machine === 'object' ? value.machine : {};
    const penWidth = Number.isFinite(machine.penWidth) && machine.penWidth >= .05 && machine.penWidth <= 5 ? machine.penWidth : .5;
    const pens = (Array.isArray(machine.pens) ? machine.pens : DEFAULT_PENS).filter((pen) => pen && typeof pen.name === 'string' && /^#[0-9a-f]{6}$/i.test(pen.color || '')).slice(0, 8).map((pen) => ({ name: pen.name.trim().slice(0, 12) || '笔', color: pen.color.toLowerCase() }));
    // 机型: applied preset, motion defaults for new drafts, paper range / travel, and this workspace's presets.
    return { format: WORKSPACE_FORMAT, version: 1, machine: { penWidth, pens: pens.length ? pens : DEFAULT_PENS.map((pen) => ({ ...pen })), ...Machines.normalizeMachine(machine) } };
  }

  /**
   * Flat listing → tree. Like VS Code file nesting, `x.wtl` groups `x.txt` / `x.gcode` (same stem, same folder)
   * into one draft node; everything else stays a plain file. Folders first, then natural name order.
   */
  function buildTree(entries) {
    const rootNode = { type: 'dir', path: '', name: '', children: [] };
    const folders = new Map([['', rootNode]]);
    const folder = (path) => {
      if (folders.has(path)) return folders.get(path);
      const node = { type: 'dir', path, name: basename(path), children: [] };
      folders.set(path, node);
      folder(dirname(path)).children.push(node);
      return node;
    };
    const files = [];
    for (const entry of entries) (entry.type === 'dir' ? folder(entry.path) : files.push(entry));
    const byPath = new Map(files.map((entry) => [entry.path, entry]));
    const nested = new Set();
    for (const entry of files) {
      if (extname(entry.path) !== '.wtl') continue;
      const base = join(dirname(entry.path), stem(entry.path));
      const text = TEXT_TYPES.map((ext) => base + ext).find((path) => byPath.has(path)) || null;
      const gcode = CODE_TYPES.map((ext) => base + ext).find((path) => byPath.has(path)) || null;
      const drawing = DRAWING_TYPES.map((ext) => base + ext).find((path) => byPath.has(path)) || null;
      const children = [text, gcode, drawing].filter(Boolean).map((path) => ({ type: 'file', path, name: basename(path) }));
      children.forEach((child) => nested.add(child.path));
      folder(dirname(entry.path)).children.push({ type: 'link', path: entry.path, name: stem(entry.path), text, gcode, drawing, children });
    }
    for (const entry of files) {
      if (extname(entry.path) === '.wtl' || nested.has(entry.path)) continue;
      folder(dirname(entry.path)).children.push({ type: 'file', path: entry.path, name: basename(entry.path) });
    }
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    const sort = (node) => {
      node.children.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : collator.compare(a.name, b.name));
      node.children.forEach((child) => child.children && sort(child));
    };
    sort(rootNode);
    return rootNode;
  }
  /** Which document a path opens: a draft (via its .wtl), or a standalone text / program file. */
  function documentFor(path, existing) {
    const ext = extname(path);
    if (ext === '.wtl') return { kind: 'link', key: path, view: null };
    const link = join(dirname(path), stem(path)) + '.wtl';
    if ((TEXT_TYPES.includes(ext) || CODE_TYPES.includes(ext) || DRAWING_TYPES.includes(ext)) && existing.has(link)) return { kind: 'link', key: link, view: CODE_TYPES.includes(ext) ? 'gcode' : DRAWING_TYPES.includes(ext) ? 'preview' : 'editor' };
    if (TEXT_TYPES.includes(ext)) return { kind: 'text', key: path, view: 'editor' };
    if (CODE_TYPES.includes(ext)) return { kind: 'gcode', key: path, view: 'gcode' };
    return null;
  }

  function normalizeArchive(raw) {
    if (!raw || !isFormat(raw.format, ARCHIVE_FORMAT) || raw.version !== 1 || !Array.isArray(raw.files)) throw Error('不是工作区备份（format 应为 penfall/workspace-archive）');
    const dirs = (Array.isArray(raw.dirs) ? raw.dirs : []).filter((path) => validPath(path, 'dir'));
    const files = raw.files.filter((file) => file && validPath(file.path) && typeof file.content === 'string' && file.content.length <= 1_500_000);
    if (files.length > 5000) throw Error('备份文件过多');
    return { format: ARCHIVE_FORMAT, version: 1, name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '', dirs, files };
  }

  const api = { RUN_KEYS, PARA_KEYS, normalizeFormat, shiftFormat, applyRun, applyParagraph, paragraphStarts, inputHash, LINK_FORMAT, WORKSPACE_FORMAT, ARCHIVE_FORMAT, MANIFEST, TEXT_TYPES, CODE_TYPES, DRAWING_TYPES, DEFAULT_PENS, FILE_TYPES, dirname, basename, extname, stem, join, validPart, validPath, nameError, uniqueStem, hash, paramsHash, normalizeLink, serializeLink, markSynced, analyzeSync, normalizeManifest, buildTree, documentFor, normalizeArchive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Links = api;
})(typeof window !== 'undefined' ? window : globalThis);
