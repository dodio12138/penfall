'use strict';
// Glyph libraries (built-in / server / imported into IndexedDB), the per-document selection and the 字形 panel.
// Loaded before editor.js so pins are shifted before the editor re-lays out the text on input.
const glyphLibraries = new Map([[Glyphs.BUILTIN_ID, Glyphs.builtinLibrary()]]);
const glyphCatalog = new Map([[Glyphs.BUILTIN_ID, { id: Glyphs.BUILTIN_ID, name: Glyphs.builtinLibrary().name, origin: 'builtin', chars: Glyphs.builtinLibrary().glyphs.length, description: Glyphs.builtinLibrary().description }]]);
const GLYPH_ORIGIN_NAMES = { builtin: '内置', server: '服务器', user: '本浏览器' };
let glyphSelection = Glyphs.normalizeSelection();
let glyphText = '';
let glyphPanelTimer;
const glyphLoading = new Map();

let glyphPreview = null; // library id previewed on the paper (hover / 👁), never used for generation
let glyphPreviewPinned = false;
let hoverPreviewBlockedUntil = 0; // rows re-render under a still pointer after 👁: ignore that synthetic hover
function previewSelection() {
  if (!glyphPreview || !glyphLibraries.has(glyphPreview)) return glyphSelection;
  return { ...glyphSelection, libraries: [glyphPreview, ...glyphSelection.libraries.filter((id) => id !== glyphPreview)], prefer: {}, pins: [] };
}
/** Generation always uses the saved selection; the paper preview may show a temporary library preview. */
function glyphResolver({ preview = false } = {}) { return Glyphs.createResolver(preview ? previewSelection() : glyphSelection, glyphLibraries); }
/** Formula glyphs: real lower-case letters / symbols first (the built-in Latin set writes lower case as capitals). */
function mathGlyphFor() {
  const selection = previewSelection();
  const order = [...selection.libraries.filter((id) => id !== Glyphs.BUILTIN_ID), Glyphs.BUILTIN_ID];
  const cache = new Map();
  return (char) => {
    if (cache.has(char)) return cache.get(char);
    let found = null;
    for (const id of order) {
      const library = glyphLibraries.get(id), variant = library?.chars.get(char)?.[0];
      if (variant) { found = { unitsPerEm: library.unitsPerEm, advance: variant.advance, strokes: variant.strokes }; break; }
    }
    cache.set(char, found);
    return found;
  };
}
function setGlyphPreview(id) {
  if (glyphPreview === id) return;
  glyphPreview = id;
  if (id) ensureGlyphLibrary(id);
  layout = makeLayout();
  renderPreview();
  for (const row of $$('#glyph-libraries .glyph-library')) row.classList.toggle('previewing', row.dataset.id === id);
}
function glyphCandidates(char) { return Glyphs.candidates(glyphSelection, glyphLibraries, char); }
function glyphLocked() {
  return Boolean(window.Workspace && (!window.Workspace.activeId || window.Workspace.blocked)) || (typeof hardwareJob !== 'undefined' && (hardwareJob || controllerBusy()));
}

// --- Imported libraries live in IndexedDB: they can be far larger than the localStorage workspace. ---
const GlyphDB = (() => {
  let opening = null;
  const open = () => opening || (opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('web-typewriter-glyphs', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('libraries', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error('无法打开浏览器字库存储'));
  }));
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('libraries', mode);
      const request = action(transaction.objectStore('libraries'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || Error('浏览器字库存储失败'));
    });
  };
  return { all: () => run('readonly', (store) => store.getAll()), put: (library) => run('readwrite', (store) => store.put(library)), remove: (id) => run('readwrite', (store) => store.delete(id)) };
})();

function registerLibrary(library, origin, extra = {}) {
  const indexed = Glyphs.indexLibrary(library);
  glyphLibraries.set(library.id, indexed);
  glyphCatalog.set(library.id, { id: library.id, name: library.name, origin, chars: library.glyphs.length, description: library.description, author: library.author, license: library.license, ...extra });
}
/** Load selected server libraries on demand; re-layout once they arrive. */
function ensureGlyphLibraries() {
  for (const id of glyphSelection.libraries) ensureGlyphLibrary(id);
}
function ensureGlyphLibrary(id) {
  const entry = glyphCatalog.get(id);
  {
    if (glyphLibraries.has(id) || entry?.origin !== 'server' || glyphLoading.has(id)) return;
    glyphLoading.set(id, fetch(`./glyphs/${encodeURIComponent(entry.file)}`)
      .then((response) => { if (!response.ok) throw Error(`HTTP ${response.status}`); return response.json(); })
      .then((raw) => { registerLibrary(Glyphs.normalizeLibrary(raw), 'server', { file: entry.file }); glyphLibrariesArrived(); })
      .catch((error) => { glyphCatalog.set(id, { ...entry, error: error.message }); log(`字库「${entry.name}」加载失败：${error.message}`); renderGlyphPanel(); })
      .finally(() => glyphLoading.delete(id)));
  }
}
function glyphLibrariesArrived() {
  if (typeof makeLayout !== 'function') return;
  layout = makeLayout();
  renderPreview();
  renderGlyphPanel();
  if (programDirty) scheduleRegenerate();
}
async function loadGlyphCatalog() {
  try {
    for (const raw of await GlyphDB.all()) {
      try { registerLibrary(Glyphs.normalizeLibrary(raw), 'user'); } catch (error) { log(`浏览器中的字库 ${raw?.id || ''} 无效，已跳过：${error.message}`); }
    }
  } catch (error) { log(`无法读取浏览器字库：${error.message}`); }
  try {
    const response = await fetch('./glyphs/index.json');
    if (response.ok) {
      const index = await response.json();
      for (const entry of Array.isArray(index.libraries) ? index.libraries : []) {
        if (typeof entry?.id === 'string' && typeof entry.file === 'string' && /^[\w.-]+\.json$/.test(entry.file) && !glyphCatalog.has(entry.id)) {
          glyphCatalog.set(entry.id, { id: entry.id, name: String(entry.name || entry.id).slice(0, 80), origin: 'server', file: entry.file, chars: Number(entry.chars) || 0, description: String(entry.description || '').slice(0, 300) });
        }
      }
    }
  } catch { /* Static hosting without a glyph index: built-in and imported libraries still work. */ }
  ensureGlyphLibraries();
  glyphLibrariesArrived();
}

// --- Selection changes (all go through here so preview, program and storage stay in sync). ---
function setGlyphSelection(raw, text) {
  glyphPreview = null; glyphPreviewPinned = false;
  glyphSelection = Glyphs.normalizeSelection(raw);
  glyphText = text;
  ensureGlyphLibraries();
  renderGlyphPanel();
}
function updateGlyphSelection(change) {
  if (glyphLocked()) return;
  const next = JSON.parse(JSON.stringify(glyphSelection));
  change(next);
  glyphSelection = Glyphs.normalizeSelection(next);
  ensureGlyphLibraries();
  layout = makeLayout();
  renderPreview();
  markStale();
  scheduleRegenerate();
  updateTask();
  window.Workspace?.capture();
  renderGlyphPanel();
}
function scheduleGlyphPanel() {
  clearTimeout(glyphPanelTimer);
  glyphPanelTimer = setTimeout(renderGlyphPanel, 250);
}
$('#content').addEventListener('input', () => {
  const text = $('#content').value;
  glyphSelection.pins = Glyphs.shiftPins(glyphSelection.pins, glyphText, text);
  glyphText = text;
  scheduleGlyphPanel();
});

// --- Rendering helpers ---
function glyphSvg(candidate, height = 34) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const pad = candidate.unitsPerEm * .08;
  const width = Math.max(candidate.advance, candidate.unitsPerEm * .4);
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${width + pad * 2} ${candidate.unitsPerEm + pad * 2}`);
  svg.setAttribute('height', String(height));
  svg.setAttribute('width', String(Math.round(height * (width + pad * 2) / (candidate.unitsPerEm + pad * 2))));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('glyph-thumb');
  for (const stroke of candidate.strokes) {
    const line = document.createElementNS(svg.namespaceURI, stroke.length === 1 ? 'circle' : 'polyline');
    if (stroke.length === 1) { line.setAttribute('cx', stroke[0][0]); line.setAttribute('cy', stroke[0][1]); line.setAttribute('r', candidate.unitsPerEm * .03); }
    else line.setAttribute('points', stroke.map((point) => `${point[0]},${point[1]}`).join(' '));
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
  }
  return svg;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderGlyphLibraries(locked) {
  const list = $('#glyph-libraries');
  const selected = glyphSelection.libraries;
  const ids = [...selected, ...[...glyphCatalog.keys()].filter((id) => !selected.includes(id))];
  list.replaceChildren(...ids.map((id) => {
    const entry = glyphCatalog.get(id);
    const enabled = selected.includes(id);
    const row = element('div', `glyph-library${enabled ? ' enabled' : ''}${entry ? '' : ' missing'}${glyphPreview === id ? ' previewing' : ''}`);
    row.setAttribute('role', 'listitem');
    row.dataset.id = id;
    // Hovering a library previews the whole paper in it (mouse); 👁 toggles the preview (touch / keyboard).
    row.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse' && glyphLibraries.has(id) && !glyphPreviewPinned && performance.now() > hoverPreviewBlockedUntil) setGlyphPreview(id); });
    row.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && !glyphPreviewPinned) setGlyphPreview(null); });
    const label = element('label', 'glyph-library-name');
    const check = element('input');
    check.type = 'checkbox'; check.checked = enabled; check.disabled = locked || (!entry && !enabled);
    check.addEventListener('change', () => updateGlyphSelection((next) => {
      next.libraries = check.checked ? [...next.libraries, id] : next.libraries.filter((value) => value !== id);
    }));
    const name = element('span', '', entry ? entry.name : `未找到：${id}`);
    label.append(check, name);
    const loading = glyphLoading.has(id);
    const meta = element('span', 'glyph-library-meta', !entry ? '此文稿引用的字库不在本浏览器或服务器上' : `${enabled ? `优先级 ${selected.indexOf(id) + 1} · ` : ''}${entry.chars} 字 · ${GLYPH_ORIGIN_NAMES[entry.origin]}${loading ? ' · 加载中…' : entry.error ? ' · 加载失败' : ''}`);
    row.title = [entry?.description, entry?.author && `作者：${entry.author}`, entry?.license && `授权：${entry.license}`].filter(Boolean).join('\n');
    const actions = element('span', 'glyph-library-actions');
    const button = (text, title, action, disabled = locked) => {
      const node = element('button', '', text);
      node.type = 'button'; node.title = title; node.setAttribute('aria-label', `${title}：${entry?.name || id}`); node.disabled = disabled;
      node.addEventListener('click', action);
      actions.append(node);
    };
    if (enabled) {
      const index = selected.indexOf(id);
      button('↑', '提高优先级', () => updateGlyphSelection((next) => { next.libraries.splice(index, 1); next.libraries.splice(index - 1, 0, id); }), locked || index === 0);
      button('↓', '降低优先级', () => updateGlyphSelection((next) => { next.libraries.splice(index, 1); next.libraries.splice(index + 1, 0, id); }), locked || index === selected.length - 1);
    }
    if (entry) button(glyphPreviewPinned && glyphPreview === id ? '◉' : '👁', glyphPreviewPinned && glyphPreview === id ? '结束预览' : '在纸张上预览此字库', () => { const on = !(glyphPreviewPinned && glyphPreview === id); glyphPreviewPinned = on; hoverPreviewBlockedUntil = performance.now() + 800; setGlyphPreview(on ? id : null); renderGlyphPanel(); }, false);
    if (glyphLibraries.has(id)) button('⤓', '导出字库 JSON', () => exportGlyphLibrary(id), false);
    if (entry?.origin === 'user') button('×', '从本浏览器删除字库', () => deleteGlyphLibrary(id));
    row.append(label, actions, meta, librarySample(id));
    return row;
  }));
}
/** A strip of the current text (or a default sample) written in one library. */
function librarySample(id) {
  const strip = element('div', 'glyph-sample');
  const library = glyphLibraries.get(id);
  if (!library) { strip.textContent = glyphLoading.has(id) ? '加载中…' : '点 👁 加载并预览'; return strip; }
  const fromText = distinctChars($('#content').value).filter((char) => library.chars.has(char));
  const sample = (fromText.length >= 4 ? fromText : Array.from('AaBb 永和 123').filter((char) => library.chars.has(char))).slice(0, 12);
  if (!sample.length) { strip.textContent = '与当前正文没有共同的字'; return strip; }
  for (const char of sample) {
    const variant = library.chars.get(char)[0];
    strip.append(glyphSvg({ unitsPerEm: library.unitsPerEm, advance: variant.advance, strokes: variant.strokes }, 18));
  }
  return strip;
}
function distinctChars(text) {
  return [...new Set(Array.from(text).filter((char) => !/\s/.test(char)))];
}
function renderGlyphPreferences(locked, chars) {
  const list = $('#glyph-prefer-list');
  const rows = [];
  for (const char of chars) {
    const options = glyphCandidates(char);
    if (options.length < 2) continue;
    if (rows.length >= 60) break;
    const current = glyphSelection.prefer[char];
    const row = element('div', 'glyph-prefer');
    row.append(element('span', 'glyph-prefer-char', char));
    const choices = element('div', 'glyph-choices');
    const auto = element('button', `glyph-choice auto${current ? '' : ' selected'}`, '自动');
    auto.type = 'button'; auto.disabled = locked; auto.setAttribute('aria-pressed', String(!current));
    auto.title = '按选字策略选择';
    auto.addEventListener('click', () => updateGlyphSelection((next) => { delete next.prefer[char]; }));
    choices.append(auto);
    for (const option of options) {
      const active = current?.library === option.library && current?.variant === option.variant;
      const choice = element('button', `glyph-choice${active ? ' selected' : ''}`);
      choice.type = 'button'; choice.disabled = locked; choice.setAttribute('aria-pressed', String(active));
      choice.title = `${option.libraryName} · ${option.variant}`;
      choice.setAttribute('aria-label', `「${char}」默认用 ${option.libraryName} ${option.variant}`);
      choice.append(glyphSvg(option, 30));
      choice.addEventListener('click', () => updateGlyphSelection((next) => { next.prefer[char] = { library: option.library, variant: option.variant }; }));
      choices.append(choice);
    }
    row.append(choices);
    rows.push(row);
  }
  if (!rows.length) rows.push(element('p', 'sidebar-note', '正文中没有多种写法可选的字。导入含多个变体的字库后，可在这里为每个字选默认写法。'));
  list.replaceChildren(...rows);
}
function renderGlyphPanel() {
  clearTimeout(glyphPanelTimer);
  if (!$('#glyphs-section')) return;
  const locked = glyphLocked();
  renderGlyphLibraries(locked);
  $('#glyph-strategy').value = glyphSelection.strategy;
  $('#glyph-strategy').disabled = locked;
  if (document.activeElement !== $('#glyph-seed')) $('#glyph-seed').value = String(glyphSelection.seed);
  $('#glyph-seed').disabled = locked || glyphSelection.strategy !== 'random';
  $('#glyph-reshuffle').disabled = locked || glyphSelection.strategy !== 'random';
  $('#glyph-import').disabled = Boolean(window.Workspace?.blocked);
  const chars = distinctChars($('#content').value);
  const missing = chars.filter((char) => !glyphCandidates(char).length);
  const coverage = $('#glyph-coverage');
  coverage.classList.toggle('warning', missing.length > 0);
  coverage.textContent = !chars.length ? '正文为空。' : missing.length
    ? `正文 ${chars.length} 个不同字符，缺 ${missing.length} 个：${missing.slice(0, 40).join(' ')}${missing.length > 40 ? ' …' : ''}。缺字无法生成 G-code，纸张页以红色系统字体示意。`
    : `正文 ${chars.length} 个不同字符，已全部由启用的字库覆盖。`;
  renderGlyphPreferences(locked, chars);
  $('#glyph-pin-count').textContent = `逐字指定 ${glyphSelection.pins.length} 处`;
  $('#glyph-clear-pins').disabled = locked || !glyphSelection.pins.length;
}

// --- Library import / export / delete ---
async function importGlyphLibraries(files) {
  for (const file of files) {
    try {
      if (file.size > 60_000_000) throw Error('文件超过 60 MB。');
      const library = /\.jhf$/i.test(file.name)
        ? Glyphs.fromJHF(await file.text(), { id: `jhf-${file.name.replace(/\.jhf$/i, '').toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 56)}`, name: `Hershey ${file.name.replace(/\.jhf$/i, '')}`, description: `由 ${file.name} 转换` })
        : Glyphs.normalizeLibrary(JSON.parse(await file.text()));
      const existing = glyphCatalog.get(library.id);
      if (existing && existing.origin !== 'user') throw Error(`id「${library.id}」与${GLYPH_ORIGIN_NAMES[existing.origin]}字库重名，请修改 id 后再导入。`);
      if (existing && !await AppDialogs.confirm({ title: '替换字库', message: `本浏览器已有字库「${existing.name}」（${library.id}），用新文件替换？引用它的文稿会使用新的字形。`, confirmLabel: '替换' })) continue;
      await GlyphDB.put(library);
      registerLibrary(library, 'user');
      log(`已导入字库「${library.name}」：${library.glyphs.length} 个字，保存在本浏览器。`);
      if (!glyphLocked() && !glyphSelection.libraries.includes(library.id)) updateGlyphSelection((next) => { next.libraries.unshift(library.id); });
      else glyphLibrariesArrived();
    } catch (error) {
      log(`字库 ${file.name} 导入失败：${error.message}`);
      AppDialogs.confirm({ title: '字库导入失败', message: `${file.name}\n${error.message}`, confirmLabel: '知道了' });
    }
  }
  renderGlyphPanel();
}
function exportGlyphLibrary(id) {
  const { chars, ...library } = glyphLibraries.get(id);
  downloadText(JSON.stringify(library), `${id}.glyphs.json`, 'application/json');
}
async function deleteGlyphLibrary(id) {
  const entry = glyphCatalog.get(id);
  if (!await AppDialogs.confirm({ title: '删除字库', message: `从本浏览器删除「${entry.name}」？引用它的文稿会提示缺少字库，相关的字无法生成。建议先导出备份。`, confirmLabel: '删除', danger: true })) return;
  try {
    await GlyphDB.remove(id);
    glyphLibraries.delete(id);
    glyphCatalog.delete(id);
    glyphLibrariesArrived();
    markStale();
    log(`已删除字库「${entry.name}」。`);
  } catch (error) { log(`删除字库失败：${error.message}`); }
}

// --- Per-occurrence picker on the paper preview ---
let glyphPicker = null;
function closeGlyphPicker(restoreFocus = false) {
  if (!glyphPicker) return;
  glyphPicker.remove();
  glyphPicker = null;
  if (restoreFocus) $('#preview').focus();
}
function openGlyphPicker(placement, clientX, clientY) {
  closeGlyphPicker();
  const options = glyphCandidates(placement.char);
  const pin = glyphSelection.pins.find((item) => item.at === placement.index);
  const occurrence = Array.from($('#content').value).slice(0, placement.index + 1).filter((char) => char === placement.char).length;
  const panel = element('div', 'glyph-picker');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `选择「${placement.char}」的写法`);
  const heading = element('div', 'glyph-picker-heading');
  heading.append(element('strong', '', `「${placement.char}」第 ${occurrence} 处`), element('span', '', pin ? '已单独指定' : placement.glyph ? `自动 · ${glyphCatalog.get(placement.glyph.library)?.name || placement.glyph.library}` : '缺字'));
  panel.append(heading);
  if (!options.length) panel.append(element('p', 'sidebar-note', '启用的字库中没有这个字。请在「字形」面板导入或启用含此字的字库。'));
  const grid = element('div', 'glyph-choices');
  for (const option of options) {
    const active = placement.glyph?.library === option.library && placement.glyph?.variant === option.variant;
    const choice = element('button', `glyph-choice${active ? ' selected' : ''}`);
    choice.type = 'button';
    choice.title = `${option.libraryName} · ${option.variant}`;
    choice.setAttribute('aria-label', `这一处用 ${option.libraryName} ${option.variant}`);
    choice.setAttribute('aria-pressed', String(active));
    choice.append(glyphSvg(option, 44), element('small', 'glyph-caption', options.some((item) => item.library !== option.library) ? `${option.libraryName.slice(0, 4)}·${option.variant}` : option.variant));
    choice.addEventListener('click', () => {
      updateGlyphSelection((next) => {
        next.pins = next.pins.filter((item) => item.at !== placement.index);
        next.pins.push({ at: placement.index, char: placement.char, library: option.library, variant: option.variant });
      });
      closeGlyphPicker(true);
    });
    grid.append(choice);
  }
  panel.append(grid);
  const actions = element('div', 'glyph-picker-actions');
  const action = (text, handler, disabled) => { const node = element('button', '', text); node.type = 'button'; node.disabled = disabled; node.addEventListener('click', () => { handler(); closeGlyphPicker(true); }); actions.append(node); };
  action('全文此字都用这种', () => updateGlyphSelection((next) => { next.prefer[placement.char] = { library: placement.glyph.library, variant: placement.glyph.variant }; }), !placement.glyph);
  action('恢复自动', () => updateGlyphSelection((next) => { next.pins = next.pins.filter((item) => item.at !== placement.index); }), !pin);
  action('关闭', () => {}, false);
  panel.append(actions);
  document.body.append(panel);
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, clientX - rect.width / 2))}px`;
  panel.style.top = `${clientY + 14 + rect.height > innerHeight - 8 ? Math.max(8, clientY - rect.height - 14) : clientY + 14}px`;
  glyphPicker = panel;
  (panel.querySelector('.glyph-choice.selected') || panel.querySelector('button')).focus();
}
function placementAt(event) {
  const canvas = $('#preview');
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width * layout.width;
  const y = (event.clientY - rect.top) / rect.height * layout.height;
  const page = currentPage();
  return layout.placements?.find((item) => item.page === page && x >= item.x - .5 && x <= item.x + item.width + .5 && y >= item.y - .5 && y <= item.y + (item.size || layout.size) + .5);
}
// Clicking the paper places the caret (paper editor); right-click / long-press a character chooses its variant.
$('#preview').addEventListener('contextmenu', (event) => {
  const placement = placementAt(event);
  if (!placement || placement.kind === 'formula') return;
  event.preventDefault();
  if (!glyphLocked()) openGlyphPicker(placement, event.clientX, event.clientY);
});
document.addEventListener('pointerdown', (event) => { if (glyphPicker && !glyphPicker.contains(event.target) && event.target !== $('#preview')) closeGlyphPicker(); }, true);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && glyphPicker) { event.preventDefault(); event.stopPropagation(); closeGlyphPicker(true); } }, true);
window.addEventListener('workspace-view', () => closeGlyphPicker());
window.addEventListener('resize', () => closeGlyphPicker());

// --- Panel controls ---
// Rows are re-rendered while hovering (e.g. a library finishes loading): leaving the list always ends a hover preview.
$('#glyph-libraries').addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && !glyphPreviewPinned) setGlyphPreview(null); });
$('#glyph-strategy').addEventListener('change', (event) => updateGlyphSelection((next) => { next.strategy = event.target.value; }));
$('#glyph-seed').addEventListener('change', (event) => {
  const seed = Number(event.target.value);
  if (Number.isInteger(seed) && seed >= 0 && seed <= 2147483647) updateGlyphSelection((next) => { next.seed = seed; });
  else event.target.value = String(glyphSelection.seed);
});
$('#glyph-reshuffle').addEventListener('click', () => updateGlyphSelection((next) => { next.seed = Math.floor(Math.random() * 2147483647); }));
$('#glyph-clear-pins').addEventListener('click', () => updateGlyphSelection((next) => { next.pins = []; }));
$('#glyph-import').addEventListener('click', () => $('#glyph-file').click());
$('#glyph-file').addEventListener('change', (event) => { const files = [...event.target.files]; event.target.value = ''; importGlyphLibraries(files); });
window.addEventListener('DOMContentLoaded', loadGlyphCatalog);
