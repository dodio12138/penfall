'use strict';
// VS Code–style workspace: a folder of .txt / .gcode files; a .wtl draft links one text with its program
// (docs/workspace-format.md). Editors stay the single source of truth while a document is open.
(() => {
  const STATE_PREFIX = 'web-typewriter:ws-state:';
  const CURRENT_KEY = 'web-typewriter:workspace:current';
  const MIGRATED_KEY = 'web-typewriter:migrated-to-files';
  const SAVE_DELAY = 300;
  const motionDefaults = { feed: '1200', 'pen-up': '5', 'pen-down': '0', page: '1', 'page-set': 'all', ...ORIGIN_DEFAULTS };
  const TYPE_LABEL = { '.txt': 'TXT', '.md': 'MD', '.gcode': 'GC', '.nc': 'NC', '.tap': 'TAP', '.wtw': 'WS', '.wtl': '稿' };

  let fsys = null;
  let manifest = Links.normalizeManifest();
  let manifestMtime = null;
  let entries = [], known = new Set(), tree = Links.buildTree([]);
  const docs = new Map();
  let openKeys = [], activeKey = null;
  let loading = true, conflict = null, saveTimer = null, saveChain = Promise.resolve(), saveFailed = '';
  let selectedPath = '', expanded = new Set(), currentView = 'editor', panel = 'files', visibleRows = [];
  let workspaceList = { browser: [], server: [], serverError: '' };
  let viewMemory = {};

  const active = () => docs.get(activeKey) || null;
  const nodeByPath = new Map();
  const isLocked = () => Boolean(conflict) || hardwareJob || controllerBusy();
  const docLabel = (doc) => doc.kind === 'link' ? Links.stem(doc.key) : Links.basename(doc.key);
  const docParts = (doc) => ['text', 'gcode', 'link'].filter((part) => doc.paths[part]);
  const unsavedParts = (doc) => docParts(doc).filter((part) => serialized(doc, part) !== doc.saved[part] && !(part === 'gcode' && doc.saved.gcode === null && !doc.gcode));
  const serialized = (doc, part) => part === 'link' ? Links.serializeLink(doc.link) : doc[part];
  const anyUnsaved = () => [...docs.values()].some((doc) => unsavedParts(doc).length);

  // ---------- status / warnings ----------
  function warn(message, actions = false) {
    $('#workspace-warning').hidden = false;
    $('#workspace-warning-text').textContent = message;
    $('#conflict-reload').hidden = $('#conflict-overwrite').hidden = !actions;
  }
  function clearWarning() { $('#workspace-warning').hidden = true; }
  function saveState() {
    const pending = anyUnsaved();
    const text = conflict ? '保存冲突' : saveFailed ? '未保存' : pending ? '保存中…' : '已保存';
    $('#save-indicator').textContent = text;
    $('#save-indicator').classList.toggle('unsaved', text !== '已保存');
    $('#save-indicator').title = conflict ? '文件已在其他地方修改，请选择载入或覆盖' : saveFailed ? `写入失败：${saveFailed}` : `${fsys?.label || ''}`;
    $('#status').textContent = fsys ? `工作区：${fsys.label}` : '';
    for (const tab of $$('#document-tabs .document-tab')) {
      const doc = docs.get(tab.dataset.key);
      tab.classList.toggle('dirty', Boolean(doc && unsavedParts(doc).length));
    }
  }

  // ---------- saving ----------
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushAll(), SAVE_DELAY);
    saveState();
  }
  /** Serialized: one write sequence at a time, so mtimes stay consistent. */
  function flushAll() {
    clearTimeout(saveTimer);
    saveChain = saveChain.then(async () => {
      let ok = true;
      for (const doc of [...docs.values()]) ok = (await flush(doc)) && ok;
      saveState();
      renderTree();
      return ok;
    });
    return saveChain;
  }
  async function flush(doc) {
    if (conflict || !fsys) return false;
    try {
      if (doc.kind === 'text' && doc.gcode.trim()) await promoteToDraft(doc);
      let created = false;
      for (const part of unsavedParts(doc)) {
        const content = serialized(doc, part);
        const result = await fsys.write(doc.paths[part], content, doc.saved[part] === null ? null : doc.mtimes[part]);
        created ||= doc.saved[part] === null;
        doc.mtimes[part] = result.mtime;
        doc.saved[part] = content;
      }
      saveFailed = '';
      if (created) await refreshTree();
      return true;
    } catch (error) {
      if (error.conflict) {
        conflict = { key: doc.key };
        warn(`「${docLabel(doc)}」的文件已在其他地方（另一个页面或程序）被修改。请选择载入最新版本（放弃本页未保存的改动），或用本页内容覆盖。`, true);
        refreshLocks();
      } else {
        saveFailed = error.message;
        warn(`保存失败：${error.message}。内容仍在本页，请勿关闭；可下载工作区备份。`);
      }
      saveState();
      return false;
    }
  }
  /** A standalone text that gets a program becomes a draft: x.txt + x.gcode + x.wtl. */
  async function promoteToDraft(doc) {
    const folder = Links.dirname(doc.key), name = Links.stem(doc.key);
    const linkPath = Links.join(folder, `${name}.wtl`);
    if (known.has(linkPath)) throw Error(`已存在 ${linkPath}，请先重命名此文本`);
    const gcodeName = known.has(Links.join(folder, `${name}.gcode`)) ? `${Links.uniqueStem(known, folder, `${name}-程序`, ['.gcode'])}.gcode` : `${name}.gcode`;
    doc.link = Links.normalizeLink({ text: Links.basename(doc.key), gcode: gcodeName, settings: config(), motion: motionSnapshot(), glyphs: glyphSelection }, linkPath);
    if (!programDirty) Links.markSynced(doc.link, doc.text, doc.gcode, programSource);
    const oldKey = doc.key;
    Object.assign(doc, { kind: 'link', key: linkPath, paths: { text: doc.key, gcode: Links.join(folder, gcodeName), link: linkPath } });
    doc.saved.gcode = null; doc.saved.link = null;
    docs.delete(oldKey); docs.set(linkPath, doc);
    openKeys = openKeys.map((key) => key === oldKey ? linkPath : key);
    if (activeKey === oldKey) activeKey = linkPath;
    log(`已为「${Links.basename(oldKey)}」创建稿件链接 ${Links.basename(linkPath)}，正文与 G-code 现在成对管理。`);
    renderTabs();
  }

  // ---------- documents ----------
  async function readOptional(path) {
    try { return await fsys.read(path); } catch { return null; }
  }
  async function loadDoc(key, kind) {
    const doc = { key, kind, link: null, text: '', gcode: '', saved: { text: null, gcode: null, link: null }, mtimes: {}, paths: {}, programSource: '', programDirty: false, syncState: '' };
    if (kind === 'link') {
      const file = await fsys.read(key);
      let raw;
      try { raw = JSON.parse(file.content); } catch { throw Error(`${key} 不是有效的稿件链接（JSON 解析失败）`); }
      doc.link = Links.normalizeLink(raw, key);
      doc.saved.link = file.content; doc.mtimes.link = file.mtime;
      const folder = Links.dirname(key);
      doc.paths = { text: Links.join(folder, doc.link.text), gcode: Links.join(folder, doc.link.gcode), link: key };
    } else doc.paths = kind === 'text' ? { text: key } : { gcode: key };
    for (const part of ['text', 'gcode']) {
      if (!doc.paths[part]) continue;
      const file = await readOptional(doc.paths[part]);
      doc[part] = file?.content ?? '';
      doc.saved[part] = file ? file.content : null;
      doc.mtimes[part] = file?.mtime ?? null;
    }
    if (kind === 'gcode' && doc.saved.gcode === null) throw Error(`无法读取 ${key}`);
    doc.view = kind === 'gcode' ? 'gcode' : viewMemory[key] || doc.link?.view || 'editor';
    // 梳串 on open: compare with the hashes recorded when text and program were last consistent.
    if (doc.link) {
      const sync = Links.analyzeSync(doc.link, doc.text, doc.gcode);
      doc.syncState = sync.state;
      doc.programSource = sync.state === 'new' ? 'manual' : sync.source;
      doc.programDirty = sync.state === 'stale' || sync.state === 'regenerate';
      if (sync.state === 'external') log(`「${docLabel(doc)}」的 G-code 在别处被修改过，按手动版本保留，不会自动改写。`);
    } else doc.programSource = kind === 'gcode' ? 'manual' : '';
    return doc;
  }
  const motionSnapshot = () => Object.fromEntries(motionInputs.map((id) => [id, $(`#${id}`).value]));
  function applyDocument() {
    loading = true;
    clearTimeout(parseTimer);
    resetSimulation();
    const doc = active();
    const link = doc?.link;
    title.value = '';
    content.value = doc?.text || '';
    codeEditor.value = doc?.gcode || '';
    for (const id of settings) $(`#${id}`).value = validSetting(id, link?.settings[id]) ? link.settings[id] : defaults[id];
    for (const id of motionInputs) $(`#${id}`).value = validSetting(id, link?.motion[id]) ? link.motion[id] : motionDefaults[id];
    programDirty = doc?.programDirty || false;
    programSource = doc?.programSource || '';
    setGlyphSelection(link?.glyphs, content.value);
    content.scrollTop = 0; codeEditor.scrollTop = 0;
    const gcodeOnly = doc?.kind === 'gcode';
    for (const id of ['edit-tab', 'preview-tab']) $(`#${id}`).disabled = gcodeOnly;
    currentView = gcodeOnly && !['gcode', 'path'].includes(doc.view) ? 'gcode' : doc?.view || 'editor';
    updateEditor(); layout = makeLayout(); renderPreview(); parseProgram(); selectView(currentView, { focus: false });
    $('#safety-confirm').checked = false;
    $('#find-bar').hidden = true;
    loading = false;
    renderChrome();
    if (doc?.syncState === 'regenerate' && programSource === 'generated') scheduleRegenerate();
  }
  /** Editors → active document (called on every edit). Saving is debounced. */
  function capture() {
    if (loading) return !conflict;
    const doc = active();
    if (!doc) return true;
    if (doc.kind !== 'gcode') doc.text = content.value;
    doc.gcode = codeEditor.value;
    doc.view = currentView;
    doc.programDirty = programDirty;
    doc.programSource = programSource;
    if (doc.link) {
      // The current view is per-device UI state (kept in localStorage), not file content: no writes / conflicts on tab switches.
      Object.assign(doc.link, { settings: config(), motion: motionSnapshot(), glyphs: glyphSelection });
      const sync = doc.link.sync;
      // Record consistency only when text, parameters and program truly belong together.
      if (!programDirty && (sync.textHash !== Links.hash(doc.text) || sync.gcodeHash !== Links.hash(doc.gcode) || sync.paramsHash !== Links.paramsHash(doc.link) || sync.source !== programSource)) Links.markSynced(doc.link, doc.text, doc.gcode, programSource);
    }
    scheduleSave();
    return !conflict;
  }
  async function openPath(path, view) {
    if (path === Links.MANIFEST) { showPanel('settings'); $('#pen-width').focus(); return; } // machine settings of this workspace
    const target = Links.documentFor(path, known);
    if (!target) { log(`${Links.basename(path)} 不是可在编辑器中打开的文件。`); return; }
    if (hardwareJob || controllerBusy()) { log('控制器正在操作，暂不能切换文稿。'); return; }
    if (conflict) { warn('请先处理文件冲突。', true); return; }
    capture();
    if (!docs.has(target.key)) {
      try { docs.set(target.key, await loadDoc(target.key, target.kind)); }
      catch (error) { log(`打开失败：${error.message}`); warn(`打开失败：${error.message}`); return; }
    }
    if (!openKeys.includes(target.key)) openKeys.push(target.key);
    activeKey = target.key;
    const doc = active();
    if (view || target.view) doc.view = view || target.view;
    selectedPath = path;
    applyDocument();
    persistUiState();
    if (innerWidth <= 900) document.body.classList.add('sidebar-hidden');
  }
  async function closeDocument(key) {
    if (hardwareJob || controllerBusy()) return;
    capture();
    await flushAll();
    if (docs.has(key) && unsavedParts(docs.get(key)).length && !conflict) { log('文件尚未保存，未关闭标签。'); return; }
    const index = openKeys.indexOf(key);
    openKeys = openKeys.filter((item) => item !== key);
    docs.delete(key);
    if (activeKey === key) { activeKey = openKeys[Math.max(0, index - 1)] || null; applyDocument(); }
    else renderChrome();
    persistUiState();
  }

  // ---------- 梳串 before simulating / sending ----------
  async function syncBeforeRun() {
    const doc = active();
    if (!doc) return false;
    capture();
    if (!await flushAll() || conflict) return false;
    // Files changed on disk / in another tab since loading? Reload them first (nothing unsaved here now).
    const fresh = await loadDoc(doc.key, doc.kind).catch(() => null);
    if (fresh && docParts(doc).some((part) => fresh.saved[part] !== doc.saved[part])) {
      fresh.view = currentView;
      docs.set(doc.key, fresh);
      applyDocument();
      log(`梳串：「${docLabel(fresh)}」的文件在别处有更新，已重新载入。`);
    }
    const current = active();
    if (current.kind === 'gcode') return true;
    const state = current.link ? Links.analyzeSync(current.link, current.text, current.gcode).state : current.gcode.trim() ? 'new' : 'empty';
    const regenerate = content.value.trim() && (state === 'empty' || (programSource === 'generated' && (programDirty || state === 'regenerate')));
    if (regenerate) {
      try {
        setProgram(buildProgram(), null, 'generated', { keepCamera: true });
        log(state === 'empty' ? '梳串：已从正文生成 G-code。' : '梳串：正文 / 参数有变化，已重新生成 G-code。');
      } catch (error) { log(`梳串：无法从正文生成 G-code：${error.message}`); }
    } else if (programDirty || state === 'stale') log('梳串：G-code 为手动版本，与当前正文 / 参数不一致，未改写。');
    else log('梳串：正文与 G-code 一致。');
    capture();
    return flushAll();
  }

  // ---------- locks ----------
  function refreshLocks() {
    const doc = active(), noDoc = !doc, locked = isLocked() || noDoc;
    const gcodeOnly = doc?.kind === 'gcode';
    for (const id of ['content', 'title', 'gcode', 'generate', 'generate-code', 'import-gcode', 'load-demo', 'export', 'save-document', ...settings, ...motionInputs]) $(`#${id}`).disabled = locked;
    if (gcodeOnly) for (const id of ['content', 'generate', 'generate-code', 'export']) $(`#${id}`).disabled = true;
    const treeLocked = isLocked() || !fsys;
    for (const id of ['new-document', 'new-folder', 'import-document', 'rename-document', 'duplicate-document', 'delete-document', 'welcome-new', 'welcome-import', 'refresh-tree']) $(`#${id}`).disabled = treeLocked || (['rename-document', 'duplicate-document', 'delete-document'].includes(id) && !selectedPath);
    $('#pen-width').disabled = treeLocked;
    $('#workspace-switcher').disabled = isLocked();
    for (const button of $$('#document-tabs button')) button.disabled = hardwareJob || controllerBusy();
    if (locked) $('#start').disabled = true;
    $('#send-job').disabled = $('#send-job').disabled || locked;
    $('#document-switcher').disabled = hardwareJob || controllerBusy() || !openKeys.length;
    $('#close-active-document').disabled = hardwareJob || controllerBusy() || noDoc;
    $('#find-query').disabled = noDoc;
    for (const id of ['replace-query', 'replace-one', 'replace-all']) $(`#${id}`).disabled = locked;
    $('#conflict-reload').disabled = $('#conflict-overwrite').disabled = hardwareJob || controllerBusy();
    if (!loading) scheduleGlyphPanel();
  }

  // ---------- chrome: title, tabs, breadcrumbs ----------
  function renderTabs() {
    const tabs = $('#document-tabs');
    tabs.replaceChildren();
    const picker = $('#document-switcher');
    const placeholder = new Option(openKeys.length ? '选择已打开的文稿' : '没有打开的文稿', '', !activeKey, !activeKey);
    placeholder.disabled = true;
    picker.replaceChildren(placeholder);
    for (const key of openKeys) {
      const doc = docs.get(key);
      if (!doc) continue;
      picker.append(new Option(docLabel(doc), key, false, key === activeKey));
      const tab = element('div', `document-tab kind-${doc.kind}${key === activeKey ? ' active' : ''}`);
      tab.dataset.key = key;
      const open = element('button', 'document-tab-name', docLabel(doc));
      open.title = `${doc.key}${doc.kind === 'link' ? '（稿件：正文 + G-code）' : ''}`;
      open.setAttribute('aria-pressed', String(key === activeKey));
      open.addEventListener('click', () => openPath(doc.key));
      const close = element('button', 'close-document', '×');
      close.setAttribute('aria-label', `关闭 ${docLabel(doc)}`);
      close.addEventListener('click', () => closeDocument(key));
      tab.append(open, close);
      tabs.append(tab);
    }
  }
  function renderChrome() {
    const doc = active();
    document.title = doc ? `${docLabel(doc)} — 写字机工作台` : '写字机工作台';
    $('#window-title').textContent = doc ? `${docLabel(doc)} — ${fsys?.name || ''}` : fsys?.name || '';
    const crumbs = doc ? [fsys?.name, ...Links.dirname(doc.key).split('/').filter(Boolean), docLabel(doc)] : [];
    $('#breadcrumbs').textContent = crumbs.join(' › ') + (doc?.kind === 'link' ? (currentView === 'gcode' || currentView === 'path' ? ` › ${Links.basename(doc.paths.gcode)}` : ` › ${Links.basename(doc.paths.text)}`) : '');
    $('#language-status').textContent = currentView === 'gcode' ? 'G-code' : currentView === 'path' ? 'XY 刀轨' : currentView === 'preview' ? '纸张排版' : '纯文本';
    $('#cursor').hidden = !doc || !['editor', 'gcode'].includes(currentView);
    if (doc) updateCursor();
    $('.main-area').classList.toggle('no-document', !doc);
    $('#empty-workspace').hidden = Boolean(doc);
    renderTabs(); renderTree(); refreshLocks(); saveState();
  }

  // ---------- file tree ----------
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  async function refreshTree() {
    if (!fsys) return;
    try {
      entries = await fsys.list();
      known = new Set(entries.map((entry) => entry.path));
      tree = Links.buildTree(entries);
    } catch (error) { warn(`无法读取工作区：${error.message}`); }
    renderTree();
  }
  function nodeIcon(node) {
    if (node.type === 'dir') return '';
    if (node.type === 'link') return '稿';
    return TYPE_LABEL[Links.extname(node.path)] || '';
  }
  function openDocKeys() { return new Set(openKeys.flatMap((key) => { const doc = docs.get(key); return doc ? Object.values(doc.paths) : []; })); }
  function renderTree() {
    const container = $('#file-tree');
    const filter = $('#file-filter').value.trim().toLocaleLowerCase();
    const openPaths = openDocKeys();
    const activePaths = new Set(active() ? Object.values(active().paths) : []);
    const unsaved = new Set([...docs.values()].flatMap((doc) => unsavedParts(doc).map((part) => doc.paths[part])));
    nodeByPath.clear();
    visibleRows = [];
    const rows = [];
    const matches = (node) => !filter || node.name.toLocaleLowerCase().includes(filter) || (node.children || []).some(matches);
    const walk = (node, depth) => {
      for (const child of node.children) {
        if (!matches(child)) continue;
        nodeByPath.set(child.path, child);
        const expandable = child.type === 'dir' || (child.type === 'link' && child.children.length > 0);
        const open = expandable && (filter ? true : expanded.has(child.path));
        const row = element('div', `tree-row type-${child.type}${child.path === selectedPath ? ' selected' : ''}${activePaths.has(child.path) ? ' active' : ''}${openPaths.has(child.path) ? ' open' : ''}`);
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(depth + 1));
        row.setAttribute('aria-selected', String(child.path === selectedPath));
        if (expandable) row.setAttribute('aria-expanded', String(open));
        row.dataset.path = child.path;
        row.tabIndex = child.path === selectedPath ? 0 : -1;
        row.style.setProperty('--depth', depth);
        row.draggable = !isLocked();
        const twisty = element('span', 'tree-twisty', expandable ? (open ? '▾' : '▸') : '');
        const icon = element('span', `tree-icon ext-${Links.extname(child.path).slice(1) || child.type}`, nodeIcon(child));
        const name = element('span', 'tree-name', child.name);
        row.title = child.type === 'link' ? `${child.path}\n稿件：${[child.text, child.gcode].filter(Boolean).map(Links.basename).join(' + ') || '（缺少正文 / G-code 文件）'}` : child.path;
        const dirty = child.type === 'link' ? child.children.some((item) => unsaved.has(item.path)) || unsaved.has(child.path) : unsaved.has(child.path);
        const badge = element('span', 'tree-badge', dirty ? '●' : '');
        const more = element('button', 'tree-more', '⋯');
        more.type = 'button'; more.tabIndex = -1; more.setAttribute('aria-label', `${child.name} 的更多操作`);
        more.addEventListener('click', (event) => { event.stopPropagation(); select(child.path); showContextMenu(child, more.getBoundingClientRect().left, more.getBoundingClientRect().bottom); });
        row.append(twisty, icon, name, badge, more);
        rows.push(row);
        visibleRows.push(child);
        if (open) walk(child, depth + 1);
      }
    };
    walk(tree, 0);
    if (!rows.length) rows.push(element('p', 'sidebar-note tree-empty', filter ? '没有匹配的文件' : '工作区为空。点上方「新建稿件」或「导入」。'));
    const hadFocus = container.contains(document.activeElement) && document.activeElement !== container;
    container.replaceChildren(...rows);
    if (hadFocus) container.querySelector('.tree-row.selected')?.focus();
    $('#workspace-file-count').textContent = String(entries.filter((entry) => entry.type === 'file').length);
    refreshLocks();
  }
  function select(path, focus = false) {
    selectedPath = path;
    for (const row of $$('#file-tree .tree-row')) {
      const selected = row.dataset.path === path;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = selected ? 0 : -1;
      if (selected && focus) row.focus();
    }
    refreshLocks();
  }
  function toggle(path, open = !expanded.has(path)) {
    if (open) expanded.add(path); else expanded.delete(path);
    persistUiState();
    renderTree();
    select(path, true);
  }
  function activate(node, view) {
    if (node.type === 'dir') toggle(node.path);
    else openPath(node.path, view);
  }
  const rowNode = (event) => nodeByPath.get(event.target.closest('.tree-row')?.dataset.path);
  $('#file-tree').addEventListener('click', (event) => {
    const node = rowNode(event);
    if (!node) return;
    select(node.path);
    if (event.target.closest('.tree-twisty') && node.type !== 'file') toggle(node.path);
    else activate(node);
  });
  $('#file-tree').addEventListener('dblclick', (event) => { const node = rowNode(event); if (node?.type === 'link') toggle(node.path, true); });
  $('#file-tree').addEventListener('contextmenu', (event) => {
    const node = rowNode(event);
    event.preventDefault();
    if (node) select(node.path);
    showContextMenu(node || { type: 'dir', path: '', name: fsys?.name || '', children: [] }, event.clientX, event.clientY);
  });
  $('#file-tree').addEventListener('keydown', (event) => {
    const index = visibleRows.findIndex((node) => node.path === selectedPath);
    const node = visibleRows[index];
    const move = (next) => { const target = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, next))]; if (target) select(target.path, true); };
    const expandable = node && (node.type === 'dir' || (node.type === 'link' && node.children.length));
    const handled = {
      ArrowDown: () => move(index + 1), ArrowUp: () => move(index - 1), Home: () => move(0), End: () => move(visibleRows.length - 1),
      ArrowRight: () => expandable && (expanded.has(node.path) ? move(index + 1) : toggle(node.path, true)),
      ArrowLeft: () => {
        if (expandable && expanded.has(node.path)) return toggle(node.path, false);
        const parent = node && (visibleRows.find((item) => item.children?.includes(node)));
        if (parent) select(parent.path, true);
      },
      Enter: () => node && activate(node), ' ': () => node && activate(node),
      F2: () => node && renameNode(node), Delete: () => node && deleteNode(node),
      ContextMenu: () => { const row = $(`#file-tree .tree-row.selected`); if (node && row) { const rect = row.getBoundingClientRect(); showContextMenu(node, rect.left + 24, rect.bottom); } },
    }[event.key];
    if (handled && !event.metaKey && !event.ctrlKey) { event.preventDefault(); handled(); }
  });
  $('#file-tree').addEventListener('focus', (event) => {
    if (event.target === $('#file-tree') && visibleRows.length) select(selectedPath && nodeByPath.has(selectedPath) ? selectedPath : visibleRows[0].path, true);
  });
  // Drag a row onto a folder (or the empty area = workspace root) to move it.
  let dragged = null;
  $('#file-tree').addEventListener('dragstart', (event) => {
    dragged = rowNode(event) || null;
    if (!dragged || isLocked()) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragged.path);
  });
  const dropFolder = (event) => {
    const node = rowNode(event);
    if (!node) return '';
    return node.type === 'dir' ? node.path : Links.dirname(node.path);
  };
  $('#file-tree').addEventListener('dragover', (event) => {
    if (!dragged) return;
    const target = dropFolder(event);
    if (target === dragged.path || target.startsWith(`${dragged.path}/`)) return;
    event.preventDefault();
    $$('#file-tree .drop-target').forEach((row) => row.classList.remove('drop-target'));
    event.target.closest('.tree-row')?.classList.add('drop-target');
    $('#file-tree').classList.toggle('drop-root', !event.target.closest('.tree-row'));
  });
  $('#file-tree').addEventListener('dragleave', () => { $$('#file-tree .drop-target').forEach((row) => row.classList.remove('drop-target')); $('#file-tree').classList.remove('drop-root'); });
  $('#file-tree').addEventListener('drop', (event) => {
    event.preventDefault();
    $('#file-tree').classList.remove('drop-root');
    $$('#file-tree .drop-target').forEach((row) => row.classList.remove('drop-target'));
    const node = dragged; dragged = null;
    if (node && Links.dirname(node.path) !== dropFolder(event)) moveNode(node, dropFolder(event));
  });
  $('#file-tree').addEventListener('dragend', () => { dragged = null; });

  // ---------- context menu ----------
  let menu = null;
  function closeMenu() { menu?.remove(); menu = null; }
  function showContextMenu(node, x, y) {
    closeMenu();
    const folder = node.type === 'dir' ? node.path : Links.dirname(node.path);
    const items = [];
    if (node.type !== 'dir') items.push(['打开', () => activate(node)]);
    if (node.type === 'link') items.push(['打开 G-code', () => openPath(node.path, 'gcode')]);
    items.push(['新建稿件…', () => createDraft(folder)], ['新建文件夹…', () => createFolder(folder)], ['导入到此处…', () => importInto(folder)]);
    if (node.path) items.push(null, ['重命名…', () => renameNode(node)], ['创建副本', () => duplicateNode(node)], ['删除…', () => deleteNode(node), 'danger']);
    menu = element('div', 'context-menu');
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (!item) { menu.append(element('div', 'context-separator')); continue; }
      const button = element('button', item[2] || '', item[0]);
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = isLocked();
      button.addEventListener('click', () => { closeMenu(); item[1](); });
      menu.append(button);
    }
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(innerWidth - rect.width - 4, x))}px`;
    menu.style.top = `${Math.max(4, Math.min(innerHeight - rect.height - 4, y))}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
    menu.addEventListener('keydown', (event) => {
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu(); $('#file-tree .tree-row.selected')?.focus(); }
    });
  }
  document.addEventListener('pointerdown', (event) => { if (menu && !menu.contains(event.target)) closeMenu(); }, true);
  window.addEventListener('resize', closeMenu);

  // ---------- file operations ----------
  /** All files a node stands for: a draft moves / renames / deletes together. */
  function members(node) {
    if (node.type === 'link') return [node.path, node.text, node.gcode].filter(Boolean);
    return [node.path];
  }
  async function guarded(work) {
    if (isLocked() || !fsys) return;
    capture();
    if (!await flushAll()) return;
    try { await work(); } catch (error) { log(error.message); AppDialogs.confirm({ title: '操作失败', message: error.message, confirmLabel: '知道了' }); }
    await refreshTree();
  }
  const ask = (title, value, confirmLabel) => AppDialogs.askText({ title, value, confirmLabel, validate: Links.nameError });
  async function createDraft(folder = currentFolder()) {
    const name = await ask('新建稿件', '未命名', '新建');
    if (!name) return;
    await guarded(async () => {
      const stem = Links.uniqueStem(known, folder, name.trim(), ['.wtl', '.txt', '.md', '.gcode']);
      const link = Links.normalizeLink({ settings: { ...defaults }, motion: { ...motionDefaults }, glyphs: Glyphs.normalizeSelection() }, Links.join(folder, `${stem}.wtl`));
      await fsys.write(Links.join(folder, `${stem}.txt`), '', null);
      await fsys.write(Links.join(folder, `${stem}.wtl`), Links.serializeLink(link), null);
      if (folder) expanded.add(folder);
      await refreshTree();
      await openPath(Links.join(folder, `${stem}.wtl`), 'editor');
      showPanel('files', false);
      content.focus();
    });
  }
  async function createFolder(folder = currentFolder()) {
    const name = await ask('新建文件夹', '新文件夹', '新建');
    if (!name) return;
    await guarded(async () => {
      await fsys.mkdir(Links.join(folder, name.trim()));
      if (folder) expanded.add(folder);
      selectedPath = Links.join(folder, name.trim());
    });
  }
  function currentFolder() {
    const node = nodeByPath.get(selectedPath);
    return !node ? '' : node.type === 'dir' ? node.path : Links.dirname(node.path);
  }
  /** Rename or move a node (and a draft's members), then fix the link file and any open tabs. */
  async function relocate(node, folder, newName) {
    const renames = [];
    if (node.type === 'link') {
      for (const path of members(node)) renames.push([path, Links.join(folder, `${newName}${Links.extname(path)}`)]);
    } else renames.push([node.path, Links.join(folder, newName)]);
    for (const [, to] of renames) if (known.has(to) && !renames.some(([from]) => from.toLocaleLowerCase() === to.toLocaleLowerCase())) throw Error(`已存在 ${to}`);
    const affected = [...docs.values()].filter((doc) => Object.values(doc.paths).some((path) => renames.some(([from]) => path === from || path.startsWith(`${from}/`))));
    for (const [from, to] of renames) if (from !== to) await fsys.rename(from, to);
    if (node.type === 'link') {
      const linkPath = renames[0][1];
      const file = await fsys.read(linkPath);
      const link = Links.normalizeLink(JSON.parse(file.content), linkPath);
      link.text = node.text ? `${newName}${Links.extname(node.text)}` : `${newName}.txt`;
      link.gcode = node.gcode ? `${newName}${Links.extname(node.gcode)}` : `${newName}.gcode`;
      await fsys.write(linkPath, Links.serializeLink(link), file.mtime);
    }
    const remap = (path) => { for (const [from, to] of renames) { if (path === from) return to; if (path.startsWith(`${from}/`)) return to + path.slice(from.length); } return path; };
    for (const doc of affected) {
      const key = remap(doc.key);
      const fresh = await loadDoc(key, doc.kind);
      fresh.view = doc.view;
      docs.delete(doc.key); docs.set(key, fresh);
      openKeys = openKeys.map((item) => item === doc.key ? key : item);
      if (activeKey === doc.key) activeKey = key;
    }
    expanded = new Set([...expanded].map(remap));
    selectedPath = remap(node.path);
    await refreshTree();
    if (affected.some((doc) => doc.key === activeKey || remap(doc.key) === activeKey)) applyDocument(); else renderChrome();
    persistUiState();
  }
  async function renameNode(node) {
    if (!node?.path) return;
    const current = node.type === 'link' ? node.name : node.name;
    const name = await ask(node.type === 'link' ? '重命名稿件（正文与 G-code 一起改名）' : '重命名', current, '重命名');
    if (!name || name.trim() === current) return;
    let newName = name.trim();
    if (node.type === 'file' && Links.extname(newName) !== Links.extname(node.path) && !Links.FILE_TYPES.includes(Links.extname(newName))) newName += Links.extname(node.path);
    await guarded(() => relocate(node, Links.dirname(node.path), newName));
  }
  async function moveNode(node, folder) {
    await guarded(() => relocate(node, folder, node.type === 'link' ? node.name : node.name));
    if (folder) { expanded.add(folder); renderTree(); }
  }
  async function duplicateNode(node) {
    if (!node?.path || node.type === 'dir') { if (node?.type === 'dir') log('暂不支持复制整个文件夹。'); return; }
    await guarded(async () => {
      const folder = Links.dirname(node.path);
      if (node.type === 'link') {
        const stem = Links.uniqueStem(known, folder, `${node.name} 副本`, ['.wtl', '.txt', '.md', '.gcode', '.nc', '.tap']);
        for (const path of [node.text, node.gcode].filter(Boolean)) await fsys.write(Links.join(folder, stem + Links.extname(path)), (await fsys.read(path)).content, null);
        const link = Links.normalizeLink(JSON.parse((await fsys.read(node.path)).content), Links.join(folder, `${stem}.wtl`));
        link.text = `${stem}${Links.extname(node.text || '.txt')}`; link.gcode = `${stem}${Links.extname(node.gcode || '.gcode')}`;
        await fsys.write(Links.join(folder, `${stem}.wtl`), Links.serializeLink(link), null);
        selectedPath = Links.join(folder, `${stem}.wtl`);
      } else {
        const ext = Links.extname(node.path);
        const stem = Links.uniqueStem(known, folder, `${Links.stem(node.path)} 副本`, [ext]);
        await fsys.write(Links.join(folder, stem + ext), (await fsys.read(node.path)).content, null);
        selectedPath = Links.join(folder, stem + ext);
      }
    });
  }
  async function deleteNode(node) {
    if (!node?.path) return;
    const list = node.type === 'dir' ? `文件夹「${node.name}」及其中所有文件` : members(node).map(Links.basename).join('、');
    if (!await AppDialogs.confirm({ title: '删除', message: `删除 ${list}？此操作不能撤销。`, confirmLabel: '删除', danger: true })) return;
    await guarded(async () => {
      const paths = node.type === 'dir' ? [node.path] : members(node);
      const gone = (path) => paths.some((item) => path === item || path.startsWith(`${item}/`));
      for (const doc of [...docs.values()]) {
        if (!Object.values(doc.paths).some(gone)) continue;
        docs.delete(doc.key);
        openKeys = openKeys.filter((key) => key !== doc.key);
        if (activeKey === doc.key) activeKey = openKeys.at(-1) || null;
      }
      for (const path of paths) await fsys.remove(path);
      selectedPath = '';
      applyDocument();
      persistUiState();
    });
  }
  function importInto(folder) {
    $('#document-file').dataset.folder = folder;
    $('#document-file').click();
  }
  async function importFiles(files, folder) {
    await guarded(async () => {
      let count = 0, first = '';
      for (const file of files) {
        if (file.size > 6_000_000) throw Error(`${file.name} 文件过大`);
        const text = await file.text();
        const ext = Links.extname(file.name);
        if (ext === '.json') {
          const raw = JSON.parse(text);
          if (raw?.format === Links.ARCHIVE_FORMAT) count += await importArchive(Links.normalizeArchive(raw), folder);
          else if (raw?.version === 3 && Array.isArray(raw.documents)) count += await importLegacyDocuments(WorkspaceStorage.normalize(raw).documents, folder);
          else throw Error(`${file.name} 不是工作区备份`);
          continue;
        }
        if (Links.TEXT_TYPES.includes(ext)) {
          const stem = Links.uniqueStem(known, folder, Links.stem(file.name), ['.wtl', '.txt', '.md', '.gcode']);
          await fsys.write(Links.join(folder, `${stem}${ext}`), text, null);
          const link = Links.normalizeLink({ text: `${stem}${ext}`, settings: { ...defaults }, motion: { ...motionDefaults } }, Links.join(folder, `${stem}.wtl`));
          await fsys.write(Links.join(folder, `${stem}.wtl`), Links.serializeLink(link), null);
          first ||= Links.join(folder, `${stem}.wtl`);
        } else if (Links.CODE_TYPES.includes(ext)) {
          if (text.length > 500000) throw Error(`${file.name} 超过 500 KB 预览上限`);
          const stem = Links.uniqueStem(known, folder, Links.stem(file.name), [ext, '.wtl']);
          await fsys.write(Links.join(folder, `${stem}${ext}`), text, null);
          first ||= Links.join(folder, `${stem}${ext}`);
        } else throw Error(`${file.name}：只支持 .txt .md .gcode .nc .tap 或工作区备份 .json`);
        known.add(first); count++;
        await refreshTree();
      }
      if (folder) expanded.add(folder);
      log(`已导入 ${count} 个文件 / 稿件。`);
      await refreshTree();
      if (first) await openPath(first);
    });
  }
  async function importArchive(archive, folder) {
    const base = Links.join(folder, Links.uniqueStem(known, folder, archive.name || '导入的工作区', ['']));
    await fsys.mkdir(base);
    const dirs = new Set(archive.dirs);
    archive.files.forEach((file) => { for (let dir = Links.dirname(file.path); dir; dir = Links.dirname(dir)) dirs.add(dir); });
    for (const dir of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) await fsys.mkdir(Links.join(base, dir));
    for (const file of archive.files) await fsys.write(Links.join(base, file.path), file.content, null);
    expanded.add(base);
    return archive.files.length;
  }
  /** v3 browser documents (old format) → drafts in the given folder. */
  async function importLegacyDocuments(documents, folder) {
    const taken = new Set(known);
    for (const doc of documents) {
      const stem = Links.uniqueStem(taken, folder, Links.stem(doc.name) || '未命名', ['.wtl', '.txt', '.gcode']);
      const link = Links.normalizeLink({ settings: doc.settings, motion: doc.motion, glyphs: doc.glyphs, view: doc.view }, Links.join(folder, `${stem}.wtl`));
      if (doc.gcode && !doc.programDirty) Links.markSynced(link, doc.content, doc.gcode, doc.programSource || 'manual');
      await fsys.write(Links.join(folder, `${stem}.txt`), doc.content, null);
      if (doc.gcode) await fsys.write(Links.join(folder, `${stem}.gcode`), doc.gcode, null);
      await fsys.write(Links.join(folder, `${stem}.wtl`), Links.serializeLink(link), null);
      ['.wtl', '.txt', '.gcode'].forEach((ext) => taken.add(Links.join(folder, stem + ext)));
    }
    return documents.length;
  }
  async function backup() {
    if (!fsys) return;
    capture();
    await flushAll();
    try {
      const archive = await exportArchive(fsys);
      // Unsaved editor contents are included, so a backup works even when saving fails.
      for (const doc of docs.values()) for (const part of unsavedParts(doc)) {
        const file = archive.files.find((item) => item.path === doc.paths[part]);
        if (file) file.content = serialized(doc, part); else archive.files.push({ path: doc.paths[part], content: serialized(doc, part) });
      }
      downloadText(JSON.stringify(archive, null, 2), `${safeFilename(fsys.name)}-${new Date().toISOString().slice(0, 10)}.wtbackup.json`, 'application/json');
      log(`已下载工作区备份（${archive.files.length} 个文件，不含访问密钥和字库）。`);
    } catch (error) { warn(`备份失败：${error.message}`); }
  }

  // ---------- workspace manifest (machine settings shared by all drafts) ----------
  let manifestTimer;
  async function loadManifest() {
    const file = await readOptional(Links.MANIFEST);
    try { manifest = Links.normalizeManifest(file ? JSON.parse(file.content) : {}); } catch { manifest = Links.normalizeManifest(); log('workspace.wtw 无效，使用默认机器设置。'); }
    manifestMtime = file?.mtime ?? null;
    $('#pen-width').value = String(manifest.machine.penWidth);
  }
  function saveManifest() {
    clearTimeout(manifestTimer);
    manifestTimer = setTimeout(async () => {
      try { manifestMtime = (await fsys.write(Links.MANIFEST, JSON.stringify(manifest, null, 2) + '\n', manifestMtime === null ? null : manifestMtime)).mtime; }
      catch (error) {
        if (error.conflict) { await loadManifest(); log('工作区设置已在别处修改，已载入最新值。'); renderPreview(); drawToolpath(); }
        else log(`工作区设置保存失败：${error.message}`);
      }
    }, SAVE_DELAY);
  }
  $('#pen-width').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    if (!(value >= .05 && value <= 5)) return;
    manifest.machine.penWidth = value;
    saveManifest();
    renderPreview();
    drawToolpath();
  });

  // ---------- workspaces ----------
  const uiStateKey = () => fsys ? `${STATE_PREFIX}${fsys.backend}:${fsys.name}` : '';
  function persistUiState() {
    if (!fsys) return;
    for (const [key, doc] of docs) viewMemory[key] = doc.view;
    try { localStorage.setItem(uiStateKey(), JSON.stringify({ open: openKeys, active: activeKey, expanded: [...expanded], selected: selectedPath, views: viewMemory })); } catch { /* optional */ }
  }
  async function openWorkspace(next, { initial = false } = {}) {
    if (fsys && !initial) {
      capture();
      if (!await flushAll()) { warn('当前工作区有未保存的内容，未切换。'); renderWorkspaceSwitcher(); return; }
    }
    loading = true;
    fsys = next;
    docs.clear(); openKeys = []; activeKey = null; conflict = null; saveFailed = ''; clearWarning();
    try { localStorage.setItem(CURRENT_KEY, JSON.stringify({ backend: next.backend, name: next.name })); } catch { /* optional */ }
    let state = {};
    try { state = JSON.parse(localStorage.getItem(uiStateKey()) || '{}'); } catch { /* fresh state */ }
    expanded = new Set(Array.isArray(state.expanded) ? state.expanded : []);
    selectedPath = typeof state.selected === 'string' ? state.selected : '';
    viewMemory = state.views && typeof state.views === 'object' ? state.views : {};
    await loadManifest();
    await refreshTree();
    for (const key of Array.isArray(state.open) ? state.open : []) {
      if (!known.has(key) || docs.has(key)) continue;
      const target = Links.documentFor(key, known);
      if (!target || target.key !== key) continue;
      try { docs.set(key, await loadDoc(key, target.kind)); openKeys.push(key); } catch { /* skip unreadable */ }
    }
    activeKey = openKeys.includes(state.active) ? state.active : openKeys[0] || null;
    if (!openKeys.length) {
      const first = entries.find((entry) => Links.extname(entry.path) === '.wtl');
      if (first) { docs.set(first.path, await loadDoc(first.path, 'link')); openKeys.push(first.path); activeKey = first.path; }
    }
    loading = false;
    applyDocument();
    renderWorkspaceSwitcher();
    persistUiState();
    if (!initial) log(`已打开工作区：${next.label}`);
  }
  async function loadWorkspaceList() {
    try { workspaceList.browser = await BrowserFS.workspaces(); } catch (error) { workspaceList.browser = []; warn(error.message); }
    workspaceList.server = []; workspaceList.serverError = '';
    if (ServerFS.hasKey()) {
      try { workspaceList.server = await ServerFS.workspaces(); }
      catch (error) { workspaceList.serverError = error.message; }
    }
  }
  function renderWorkspaceSwitcher() {
    const picker = $('#workspace-switcher');
    const options = [];
    const group = (label, backend, names) => {
      if (!names.length) return;
      const optgroup = document.createElement('optgroup');
      optgroup.label = label;
      for (const name of names) optgroup.append(new Option(`${backend === 'browser' ? '本浏览器' : '服务器'} · ${name}`, `${backend}:${name}`, false, fsys?.backend === backend && fsys?.name === name));
      options.push(optgroup);
    };
    group('本浏览器（IndexedDB）', 'browser', workspaceList.browser);
    group('服务器文件夹', 'server', workspaceList.server);
    const actions = document.createElement('optgroup');
    actions.label = '操作';
    actions.append(new Option('＋ 新建浏览器工作区…', 'action:new-browser'));
    if (ServerFS.hasKey() && !workspaceList.serverError) actions.append(new Option('＋ 新建服务器工作区…', 'action:new-server'));
    actions.append(new Option(ServerFS.hasKey() ? (workspaceList.serverError ? '服务器不可用 · 重新输入密钥…' : '更换服务器访问密钥…') : '连接服务器工作区（输入密钥）…', 'action:server-key'));
    options.push(actions);
    picker.replaceChildren(...options);
    picker.value = fsys ? `${fsys.backend}:${fsys.name}` : '';
    picker.dispatchEvent(new Event('input'));
  }
  $('#workspace-switcher').addEventListener('change', async (event) => {
    const value = event.target.value;
    const reset = () => { event.target.value = fsys ? `${fsys.backend}:${fsys.name}` : ''; event.target.dispatchEvent(new Event('input')); };
    reset();
    if (isLocked()) return;
    const [kind, name] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
    try {
      if (kind === 'browser') await openWorkspace(new BrowserFS.Workspace(name));
      else if (kind === 'server') await openWorkspace(new ServerFS.Workspace(name));
      else if (name === 'new-browser' || name === 'new-server') {
        const title = name === 'new-browser' ? '新建浏览器工作区' : '新建服务器工作区';
        const wsName = await AppDialogs.askText({ title, value: '新工作区', confirmLabel: '新建', validate: Links.nameError });
        if (!wsName) return;
        const manifestText = JSON.stringify(Links.normalizeManifest({ machine: { penWidth: manifest.machine.penWidth } }), null, 2) + '\n';
        const created = name === 'new-browser' ? await BrowserFS.create(wsName.trim(), manifestText) : await ServerFS.create(wsName.trim());
        await loadWorkspaceList();
        await openWorkspace(created);
      } else if (name === 'server-key') {
        const key = await AppDialogs.askText({ title: '服务器访问密钥', message: '启动 server.py 时终端显示的访问密钥（保存在 .bridge-key，重启不变）。密钥会记在本设备浏览器中。', value: '', confirmLabel: '连接', type: 'password', validate: (text) => text.trim() ? '' : '请输入密钥' });
        if (!key) return;
        ServerFS.setKey(key.trim());
        if (typeof bridgeKey !== 'undefined') { bridgeKey = key.trim(); $('#bridge-key').value = key.trim(); connectionButtons(); }
        await loadWorkspaceList();
        if (workspaceList.serverError) { warn(`服务器工作区不可用：${workspaceList.serverError}`); ServerFS.setKey(''); }
        else log(`已连接服务器工作区（${workspaceList.server.length} 个）。`);
        renderWorkspaceSwitcher();
      }
    } catch (error) { warn(error.message); renderWorkspaceSwitcher(); }
  });

  // ---------- startup: pick a workspace; migrate old browser documents once ----------
  async function migrateLegacy(workspace) {
    let documents = [];
    try { documents = new WorkspaceStorage.Store(localStorage).load()?.documents || []; } catch { /* unreadable v3 is left untouched */ }
    if (!documents.length) {
      restoreLegacyDraft(); loadLegacyProgram();
      if (content.value || codeEditor.value) documents = [{ name: '未命名.txt', content: content.value, gcode: codeEditor.value, settings: config(), motion: motionSnapshot(), glyphs: Glyphs.normalizeSelection(), programDirty, programSource: '', view: 'editor' }];
    }
    fsys = workspace;
    if (documents.length) {
      await importLegacyDocuments(documents, '');
      log(`已把旧版浏览器中的 ${documents.length} 份文稿转换为工作区文件（旧数据保留未删）。`);
    } else {
      const link = Links.normalizeLink({ settings: { ...defaults }, motion: { ...motionDefaults } }, '未命名.wtl');
      await workspace.write('未命名.txt', '', null);
      await workspace.write('未命名.wtl', Links.serializeLink(link), null);
    }
    try { localStorage.setItem(MIGRATED_KEY, '1'); } catch { /* optional */ }
  }
  async function start() {
    await loadWorkspaceList();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CURRENT_KEY) || 'null'); } catch { /* none */ }
    let workspace = null;
    if (saved?.backend === 'server' && workspaceList.server.includes(saved.name)) workspace = new ServerFS.Workspace(saved.name);
    else if (saved?.backend === 'browser' && workspaceList.browser.includes(saved.name)) workspace = new BrowserFS.Workspace(saved.name);
    else if (workspaceList.browser.length) workspace = new BrowserFS.Workspace(workspaceList.browser[0]);
    if (!workspace) {
      try {
        workspace = await BrowserFS.create('我的工作区', JSON.stringify(Links.normalizeManifest(), null, 2) + '\n');
        workspaceList.browser = ['我的工作区'];
        if (!localStorage.getItem(MIGRATED_KEY)) await migrateLegacy(workspace);
      } catch (error) {
        loading = false;
        warn(`无法创建浏览器工作区：${error.message}`);
        renderWorkspaceSwitcher();
        refreshLocks();
        return;
      }
    }
    await openWorkspace(workspace, { initial: true });
  }

  // ---------- panels & wiring ----------
  function showPanel(name, reveal = true) {
    panel = name;
    if (reveal) document.body.classList.remove('sidebar-hidden');
    $('#sidebar-label').textContent = ({ settings: '书写设置', coordinates: '坐标定位', files: '资源管理器', glyphs: '字形' })[name];
    $('#explorer-section').hidden = name !== 'files';
    $('#explorer-actions').hidden = name !== 'files';
    $('#coordinates-section').hidden = name !== 'coordinates';
    $('#glyphs-section').hidden = name !== 'glyphs';
    if (name === 'glyphs') renderGlyphPanel();
    for (const id of ['settings-section', 'motion-section']) $(`#${id}`).hidden = name !== 'settings';
    $$('[data-panel]').forEach((button) => { const selected = button.dataset.panel === name; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
  }
  window.Workspace = {
    capture, refreshLocks, syncBeforeRun,
    save: async () => { capture(); if (await flushAll()) log('工作区已保存。'); },
    get activeId() { return activeKey; },
    get activeName() { const doc = active(); return doc ? (doc.kind === 'link' ? `${Links.stem(doc.key)}.txt` : Links.basename(doc.key)) : ''; },
    get blocked() { return Boolean(conflict); },
    get penWidth() { return manifest.machine.penWidth; },
    get name() { return fsys?.label || ''; },
  };
  $$('[data-panel]').forEach((button) => button.addEventListener('click', () => showPanel(button.dataset.panel)));
  showPanel(panel, false);
  $('#file-filter').addEventListener('input', renderTree);
  $('#document-switcher').addEventListener('change', (event) => {
    const key = event.target.value;
    event.target.value = activeKey || '';
    event.target.dispatchEvent(new Event('input'));
    if (key) openPath(key);
  });
  $('#close-active-document').addEventListener('click', () => { if (activeKey) closeDocument(activeKey); });
  $('#new-document').addEventListener('click', () => createDraft());
  $('#welcome-new').addEventListener('click', () => createDraft(''));
  $('#new-folder').addEventListener('click', () => createFolder());
  $('#import-document').addEventListener('click', () => importInto(currentFolder()));
  $('#welcome-import').addEventListener('click', () => importInto(''));
  $('#refresh-tree').addEventListener('click', () => refreshTree());
  $('#collapse-tree').addEventListener('click', () => { expanded.clear(); persistUiState(); renderTree(); });
  $('#rename-document').addEventListener('click', () => renameNode(nodeByPath.get(selectedPath)));
  $('#duplicate-document').addEventListener('click', () => duplicateNode(nodeByPath.get(selectedPath)));
  $('#delete-document').addEventListener('click', () => deleteNode(nodeByPath.get(selectedPath)));
  $('#document-file').addEventListener('change', (event) => {
    const files = [...event.target.files];
    const folder = event.target.dataset.folder || '';
    event.target.value = '';
    if (files.length) importFiles(files, folder);
  });
  $('#save-document').addEventListener('click', () => window.Workspace.save());
  $('#backup-workspace').addEventListener('click', backup);
  $('#conflict-reload').addEventListener('click', async () => {
    if (hardwareJob || !conflict) return;
    if (!await AppDialogs.confirm({ title: '载入最新版本', message: '放弃本页未保存的改动，载入文件的最新内容？可先下载工作区备份。', confirmLabel: '载入', danger: true })) return;
    const key = conflict.key;
    conflict = null; clearWarning();
    try {
      const doc = docs.get(key);
      const fresh = await loadDoc(key, doc.kind);
      fresh.view = doc.view;
      docs.set(key, fresh);
      if (activeKey === key) applyDocument(); else renderChrome();
      log('已载入文件的最新版本。');
    } catch (error) { warn(error.message); }
  });
  $('#conflict-overwrite').addEventListener('click', async () => {
    if (hardwareJob || !conflict) return;
    const doc = docs.get(conflict.key);
    if (!await AppDialogs.confirm({ title: '覆盖文件', message: `用本页内容覆盖「${docLabel(doc)}」的文件？其他地方的修改会丢失。`, confirmLabel: '覆盖', danger: true })) return;
    // Re-read current mtimes so the next write is accepted, then save normally.
    for (const part of docParts(doc)) { const file = await readOptional(doc.paths[part]); doc.mtimes[part] = file?.mtime ?? null; if (!file) doc.saved[part] = null; else if (doc.saved[part] === null) doc.saved[part] = ''; }
    conflict = null; clearWarning(); refreshLocks();
    if (await flushAll()) log('已用本页内容覆盖文件。');
  });
  window.addEventListener('workspace-view', (event) => {
    currentView = event.detail;
    if (!loading) { capture(); renderChrome(); persistUiState(); }
  });
  // Changes made in another tab / program show up when coming back to this page.
  window.addEventListener('focus', async () => {
    if (loading || !fsys || conflict || anyUnsaved()) return;
    const before = JSON.stringify(entries.map((entry) => [entry.path, entry.mtime]));
    await refreshTree();
    if (JSON.stringify(entries.map((entry) => [entry.path, entry.mtime])) === before) return;
    const doc = active();
    if (doc) {
      const fresh = await loadDoc(doc.key, doc.kind).catch(() => null);
      if (fresh && docParts(doc).some((part) => fresh.saved[part] !== doc.saved[part])) { fresh.view = currentView; docs.set(doc.key, fresh); applyDocument(); log(`「${docLabel(fresh)}」已在别处更新，已重新载入。`); }
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (anyUnsaved() || hardwareJob) { flushAll(); event.preventDefault(); event.returnValue = ''; }
  });
  for (const event of ['click', 'keyup', 'select']) codeEditor.addEventListener(event, updateCursor);
  refreshLocks();
  start();
})();
