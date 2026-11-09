'use strict';
(() => {
  const { Store, KEY, uid, normalize, ConflictError } = WorkspaceStorage;
  let storage;
  try { storage = window.localStorage; }
  catch { storage = { getItem() { throw Error('浏览器禁止本地存储，请允许存储或下载备份。'); }, setItem() { throw Error('浏览器禁止本地存储。'); } }; }
  const store = new Store(storage);
  const motionDefaults = { feed: '1200', 'pen-up': '5', 'pen-down': '0', ...ORIGIN_DEFAULTS };
  let data, loading = true, blocked = false, dirty = false, rawRecovery = null;
  let currentView = 'editor', panel = 'files', tabsSignature = '';
  const active = () => data.documents.find(doc => doc.id === data.activeId);
  const snapshot = () => ({ title: title.value, content: content.value, gcode: codeEditor.value, settings: config(), motion: Object.fromEntries(motionInputs.map(id => [id, $(`#${id}`).value])), programDirty, programSource, glyphs: glyphSelection, view: currentView });
  const displayName = name => (name.trim().replace(/[\\/\u0000-\u001f]/g, '-').replace(/\.(txt|md|gcode|nc|tap)$/i, '').slice(0, 116) || '未命名') + '.txt';
  function uniqueName(name, exceptId, reserved = []) {
    const normalized = displayName(name);
    const taken = new Set([...data.documents.filter(doc => doc.id !== exceptId).map(doc => doc.name.toLocaleLowerCase()), ...reserved.map(value => value.toLocaleLowerCase())]);
    if (!taken.has(normalized.toLocaleLowerCase())) return normalized;
    for (let index = 2; index <= 1000; index++) {
      const candidate = `${normalized.slice(0,-4).slice(0,108)} (${index}).txt`;
      if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
    }
    throw Error('无法生成唯一文稿名称。');
  }

  const closeDrawerOnCompact = () => { if (innerWidth <= 900) document.body.classList.add('sidebar-hidden'); };
  function warn(message) {
    $('#workspace-warning').hidden = false;
    $('#workspace-warning-text').textContent = message;
  }
  function saveState(ok) {
    $('#save-indicator').textContent = ok ? '已保存' : blocked ? '保存冲突' : '未保存';
    $('#save-indicator').classList.toggle('unsaved', !ok);
    $('#save-indicator').title = ok ? '所有文稿数据已写入当前浏览器 localStorage' : '更改尚未写入浏览器，请下载备份';
    $('#status').textContent = ok ? '工作区已保存到当前浏览器' : '尚未保存，请查看提示并备份';
  }
  function persist() {
    if (loading) return true;
    if (blocked) { saveState(false); return false; }
    try {
      store.write(data);
      dirty = false;
      saveState(true);
      $('#workspace-warning').hidden = true;
      return true;
    } catch (error) {
      dirty = true;
      if (error instanceof ConflictError) { blocked = true; refreshLocks(); }
      warn(error.message || '保存失败，请下载工作区备份。');
      saveState(false);
      return false;
    }
  }
  function capture() {
    if (loading || !active()) return !blocked;
    const doc = active(), next = snapshot();
    const previous = Object.fromEntries(Object.keys(next).map(key => [key, doc[key]]));
    if (JSON.stringify(previous) === JSON.stringify(next)) return dirty ? persist() : !blocked;
    Object.assign(doc, next, { updatedAt: new Date().toISOString() });
    dirty = true;
    const ok = persist();
    renderChrome();
    return ok;
  }
  function refreshLocks() {
    const noDoc = !active(), locked = blocked || hardwareJob || controllerBusy() || noDoc;
    for (const id of ['content','title','gcode','generate','generate-code','import-gcode','load-demo','export','save-document',...settings,...motionInputs]) $(`#${id}`).disabled = locked;
    for (const id of ['new-document','import-document','rename-document','duplicate-document','delete-document','welcome-new','welcome-import']) $(`#${id}`).disabled = blocked || hardwareJob || controllerBusy() || (['rename-document','duplicate-document','delete-document'].includes(id) && noDoc);
    for (const button of document.querySelectorAll('#document-list button, #document-tabs button')) button.disabled = blocked || hardwareJob || controllerBusy();
    if (locked) $('#start').disabled = true;
    $('#send-job').disabled = $('#send-job').disabled || locked;
    $('#document-switcher').disabled = blocked || hardwareJob || controllerBusy() || !data.documents.length;
    $('#close-active-document').disabled = blocked || hardwareJob || controllerBusy() || noDoc;
    $('#find-query').disabled = noDoc;
    for (const id of ['replace-query','replace-one','replace-all']) $(`#${id}`).disabled = locked;
    $('#reload-workspace').disabled = hardwareJob || controllerBusy();
    if (!loading) scheduleGlyphPanel();
  }
  function renderExplorer() {
    const list = $('#document-list'); list.replaceChildren();
    const query = $('#file-filter').value.toLocaleLowerCase();
    const docs = data.documents.filter(doc => `${doc.name}\n${doc.title}\n${doc.content}`.toLocaleLowerCase().includes(query));
    $('#document-total').textContent = String(data.documents.length);
    for (const doc of docs) {
      const row = document.createElement('div'); row.className = 'document-entry';
      const button = document.createElement('button');
      button.className = `file-item${doc.id === data.activeId ? ' selected' : ''}`;
      button.dataset.documentId = doc.id;
      button.setAttribute('aria-current', doc.id === data.activeId ? 'true' : 'false');
      const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = 'TXT';
      const name = document.createElement('span'); name.className = 'document-name'; name.textContent = doc.name;
      button.append(icon, name); button.title = `${doc.name}\n${doc.content.length} 个字符 · ${doc.gcode.length} 个 G-code 字符`;
      button.addEventListener('click', () => openDocument(doc.id, 'editor'));
      row.append(button);
      if (doc.gcode.trim()) {
        const code = document.createElement('button'); code.className = 'file-item code-child';
        code.textContent = `〈〉 ${doc.name.replace(/\.txt$/i, '')}.gcode`;
        code.addEventListener('click', () => openDocument(doc.id, 'gcode'));
        row.append(code);
      }
      list.append(row);
    }
    if (!docs.length) { const empty = document.createElement('p'); empty.className = 'sidebar-note'; empty.textContent = query ? '没有匹配的文稿' : '暂无文稿，点击上方 ＋ 新建'; list.append(empty); }
  }
  function renderTabs() {
    const signature = JSON.stringify([data.openIds, data.activeId, data.documents.map(doc => [doc.id, doc.name])]);
    if (signature === tabsSignature) return;
    tabsSignature = signature;
    $('#document-tabs').replaceChildren();
    const picker = $('#document-switcher');
    picker.replaceChildren();
    const placeholder = new Option('选择文稿', '', !data.activeId, !data.activeId);
    placeholder.disabled = true;
    picker.append(placeholder);
    for (const doc of data.documents) picker.append(new Option(doc.name, doc.id, false, doc.id === data.activeId));
    for (const id of data.openIds) {
      const doc = data.documents.find(item => item.id === id);
      if (!doc) continue;
      const tab = document.createElement('div'); tab.className = `document-tab${id === data.activeId ? ' active' : ''}`;
      const open = document.createElement('button'); open.className = 'document-tab-name'; open.textContent = doc.name; open.title = `切换到 ${doc.name}`;
      open.setAttribute('aria-pressed', String(id === data.activeId)); open.addEventListener('click', () => openDocument(id));
      const close = document.createElement('button'); close.className = 'close-document'; close.textContent = '×'; close.setAttribute('aria-label', `关闭 ${doc.name}`);
      close.addEventListener('click', () => closeDocument(id));
      tab.append(open, close); $('#document-tabs').append(tab);
    }
  }
  function renderChrome() {
    const doc = active();
    document.title = doc ? `${doc.name} — 写字机工作台` : '写字机工作台';
    $('#window-title').textContent = doc?.name || '';
    $('#breadcrumbs').textContent = doc ? `浏览器文稿 › ${doc.name}${currentView === 'gcode' || currentView === 'path' ? ' › G-code' : ''}` : '';
    $('#language-status').textContent = currentView === 'gcode' ? 'G-code' : currentView === 'path' ? 'XY 刀轨' : currentView === 'preview' ? '纸张排版' : '纯文本';
    $('#cursor').hidden = !doc || !['editor','gcode'].includes(currentView);
    if (doc) updateCursor();
    $('.main-area').classList.toggle('no-document', !doc);
    $('#empty-workspace').hidden = Boolean(doc);
    renderExplorer(); renderTabs(); refreshLocks();
  }
  function applyDocument() {
    loading = true;
    clearTimeout(parseTimer);
    resetSimulation();
    const doc = active();
    title.value = doc?.title || ''; content.value = doc?.content || ''; codeEditor.value = doc?.gcode || '';
    for (const id of settings) $(`#${id}`).value = validSetting(id, doc?.settings[id]) ? doc.settings[id] : defaults[id];
    for (const id of motionInputs) $(`#${id}`).value = validSetting(id, doc?.motion[id]) ? doc.motion[id] : motionDefaults[id];
    programDirty = doc?.programDirty || false;
    programSource = doc?.programSource || '';
    setGlyphSelection(doc?.glyphs, content.value);
    clearTimeout(regenerateTimer);
    content.scrollTop = 0; codeEditor.scrollTop = 0;
    currentView = doc?.view || 'editor';
    updateEditor(); layout = makeLayout(); renderPreview(); parseProgram(); selectView(currentView);
    $('#safety-confirm').checked = false;
    $('#find-bar').hidden = true;
    loading = false;
    renderChrome();
  }
  function canChange() {
    if (hardwareJob || controllerBusy()) { log('控制器正在操作，暂不能切换或修改文稿。'); return false; }
    if (blocked) { warn('请先备份本页，再载入已保存版本解决冲突。'); return false; }
    return capture();
  }
  function openDocument(id, view) {
    if (!canChange()) return;
    if (!data.documents.some(doc => doc.id === id)) return;
    data.activeId = id;
    if (!data.openIds.includes(id)) data.openIds.push(id);
    if (view) active().view = view;
    applyDocument(); persist();
    closeDrawerOnCompact();
  }
  function closeDocument(id) {
    if (!canChange()) return;
    const index = data.openIds.indexOf(id);
    data.openIds = data.openIds.filter(value => value !== id);
    if (data.activeId === id) { data.activeId = data.openIds[Math.max(0, index - 1)] || null; applyDocument(); }
    renderChrome(); persist();
  }
  async function createDocument() {
    if (!canChange()) return;
    if (data.documents.length >= 200) { log('文稿数量上限为 200，请先备份并清理。'); return; }
    const name = await AppDialogs.askText({title:'新建文稿',value:`未命名-${data.documents.length + 1}.txt`,confirmLabel:'新建'});
    if (!name || !canChange() || data.documents.length >= 200) return;
    const doc = { id: uid(), name: uniqueName(name), title: '', content: '', gcode: '', settings: { ...defaults }, motion: { ...motionDefaults }, programDirty: false, programSource: '', glyphs: Glyphs.normalizeSelection(), view: 'editor', updatedAt: new Date().toISOString() };
    data.documents.push(doc); data.activeId = doc.id; data.openIds.push(doc.id);
    applyDocument(); persist(); showPanel('files');
    closeDrawerOnCompact();
    content.focus();
  }
  const download = (value, filename) => downloadText(value, filename, 'application/json');
  function backup() {
    capture();
    if (rawRecovery !== null) download(rawRecovery, 'damaged-workspace-original.json');
    download(JSON.stringify(data, null, 2), `writing-workspace-${new Date().toISOString().slice(0,10)}.json`);
    log('已请求下载全部工作区备份（JSON）；不包含桥接密钥。');
  }
  function showPanel(name, reveal = true) {
    panel = name;
    if (reveal) document.body.classList.remove('sidebar-hidden');
    $('#sidebar-label').textContent = ({settings:'书写设置',coordinates:'坐标定位',files:'资源管理器',glyphs:'字形'})[name];
    $('#explorer-section').hidden = name !== 'files';
    $('#explorer-actions').hidden = name !== 'files';
    $('#coordinates-section').hidden = name !== 'coordinates';
    $('#glyphs-section').hidden = name !== 'glyphs';
    if (name === 'glyphs') renderGlyphPanel();
    for (const id of ['settings-section','motion-section']) $(`#${id}`).hidden = name !== 'settings';
    document.querySelectorAll('[data-panel]').forEach(button => { const selected = button.dataset.panel === name; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
  }

  // Migrate the legacy draft only once; never overwrite an unreadable v3 database.
  try { data = store.load(); }
  catch (error) {
    blocked = true; dirty = true;
    try { rawRecovery = localStorage.getItem(KEY); } catch { /* Storage itself is unavailable. */ }
    warn(`工作区读取失败：${error.message}。原数据未被覆盖，请先下载备份。`);
  }
  if (!data) {
    // First run: migrate the pre-v3 single draft / program into the first document.
    restoreLegacyDraft(); loadLegacyProgram();
  }
  if (!data) {
    const doc = { id: uid(), name: '未命名-1.txt', ...snapshot(), updatedAt: new Date().toISOString() };
    data = { version:3, revision:'', documents:[doc], openIds:[doc.id], activeId:doc.id };
  }
  window.Workspace = { capture, refreshLocks, get activeId() { return data.activeId; }, get activeName() { return active()?.name || ''; }, get blocked() { return blocked; } };
  applyDocument(); showPanel(panel, false);
  if (!data.revision && !blocked) persist(); else saveState(!blocked);

  document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => showPanel(button.dataset.panel)));
  $('#file-filter').addEventListener('input', () => { renderExplorer(); refreshLocks(); });
  $('#document-switcher').addEventListener('change', event => {
    openDocument(event.target.value);
    // A refused switch (locked / unsaved) must not leave the picker showing another document.
    if (event.target.value !== (data.activeId || '')) { event.target.value = data.activeId || ''; event.target.dispatchEvent(new Event('input')); }
  });
  $('#close-active-document').addEventListener('click', () => { if (data.activeId) closeDocument(data.activeId); });
  $('#new-document').addEventListener('click', createDocument);
  $('#welcome-new').addEventListener('click', createDocument);
  $('#import-document').addEventListener('click', () => $('#document-file').click());
  $('#welcome-import').addEventListener('click', () => $('#document-file').click());
  $('#save-document').addEventListener('click', () => { if (capture() && persist()) log('工作区已写入当前浏览器。'); });
  $('#backup-workspace').addEventListener('click', backup);
  $('#rescue-workspace').addEventListener('click', backup);
  $('#reload-workspace').addEventListener('click', async () => {
    if (hardwareJob) return;
    if (!await AppDialogs.confirm({title:'载入已保存版本',message:'本页未保存改动将被放弃。请确认已下载备份。',confirmLabel:'载入',danger:true}) || hardwareJob) return;
    try {
      const next = store.load();
      if (!next) throw Error('已保存的工作区不存在。');
      data = next; blocked = false; dirty = false; rawRecovery = null; applyDocument(); saveState(true); $('#workspace-warning').hidden = true;
    } catch (error) { warn(error.message); }
  });
  $('#rename-document').addEventListener('click', async () => {
    if (!canChange() || !active()) return;
    const id = data.activeId;
    const name = await AppDialogs.askText({title:'重命名',value:active().name,confirmLabel:'保存'});
    if (!name || !canChange() || data.activeId !== id) return;
    active().name = uniqueName(name, id); persist(); renderChrome();
  });
  $('#duplicate-document').addEventListener('click', () => {
    if (!canChange() || !active()) return;
    if (data.documents.length >= 200) { log('文稿已达到 200 份上限。'); return; }
    const doc = JSON.parse(JSON.stringify(active())); doc.id = uid(); doc.name = uniqueName(`${doc.name.replace(/\.txt$/i,'')}-副本`); doc.updatedAt = new Date().toISOString();
    data.documents.push(doc); data.openIds.push(doc.id); data.activeId = doc.id; applyDocument(); persist();
  });
  $('#delete-document').addEventListener('click', async () => {
    if (!canChange() || !active()) return;
    const id = data.activeId;
    if (!await AppDialogs.confirm({title:'删除文稿',message:`删除「${active().name}」及其 G-code 和参数？此操作不能撤销。`,confirmLabel:'删除',danger:true}) || !canChange() || data.activeId !== id) return;
    data.documents = data.documents.filter(doc => doc.id !== id); data.openIds = data.openIds.filter(value => value !== id); data.activeId = data.openIds.at(-1) || null;
    applyDocument(); persist();
  });
  $('#document-file').addEventListener('change', async event => {
    const files = [...event.target.files]; event.target.value = '';
    if (!files.length || !canChange()) return;
    try {
      // Stage all files first: a bad import cannot leave half an imported backup behind.
      const incoming = [];
      for (const file of files) {
        if (file.size > (/\.json$/i.test(file.name) ? 8_000_000 : 500000)) throw Error(`${file.name} 文件过大。`);
        const text = await file.text();
        if (/\.json$/i.test(file.name)) {
          incoming.push(...normalize(JSON.parse(text)).documents.map(doc => ({ ...doc, id: uid() })));
        } else {
          const isCode = /\.(gcode|nc|tap)$/i.test(file.name);
          incoming.push({ id:uid(), name:displayName(file.name), title:'', content:isCode?'':text, gcode:isCode?text:'', settings:{...defaults}, motion:{...motionDefaults}, programDirty:false, programSource:isCode?'manual':'', glyphs:Glyphs.normalizeSelection(), view:isCode?'gcode':'editor', updatedAt:new Date().toISOString() });
        }
      }
      if (!canChange()) return;
      if (incoming.length + data.documents.length > 200) throw Error('导入后将超过 200 份文稿上限，未导入任何内容。');
      if (!incoming.length) throw Error('备份中没有文稿。');
      const reserved = [];
      for (const doc of incoming) { doc.name = uniqueName(doc.name, null, reserved); reserved.push(doc.name); }
      data.documents.push(...incoming); data.activeId = incoming[0].id; data.openIds.push(incoming[0].id);
      applyDocument(); persist(); showPanel('files');
      closeDrawerOnCompact();
      log(`已导入 ${incoming.length} 份文稿；原工作区保留。`);
    } catch (error) { log(`导入失败：${error.message}`); warn(`导入失败：${error.message}`); }
  });
  window.addEventListener('workspace-view', event => {
    currentView = event.detail;
    if (!loading) {
      capture(); renderChrome();
      if (!['editor','gcode'].includes(currentView)) $('#find-bar').hidden = true;
      else if (!$('#find-bar').hidden) collectMatches();
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === KEY && event.newValue !== JSON.stringify(data)) {
      blocked = true; warn('另一个页面已更新工作区。本页已暂停编辑，防止覆盖。请下载本页备份，再载入已保存版本。'); saveState(false); refreshLocks();
    }
  });
  window.addEventListener('beforeunload', event => {
    if (dirty || hardwareJob) { event.preventDefault(); event.returnValue = ''; }
  });
  for (const event of ['click','keyup','select']) codeEditor.addEventListener(event, updateCursor);

  // Find/replace uses the actual active textarea and its selection, never a mock editor.
  let matches = [], matchIndex = -1;
  const findEditor = () => currentView === 'gcode' ? codeEditor : content;
  function collectMatches() {
    const editor = findEditor(), query = $('#find-query').value;
    const caseSensitive = $('#find-case').checked;
    matches = [];
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matches = [...editor.value.matchAll(new RegExp(escaped, caseSensitive ? 'g' : 'gi'))].map(match => match.index);
    }
    matchIndex = matches.findIndex(start => start >= editor.selectionStart);
    if (matchIndex < 0 && matches.length) matchIndex = 0;
    $('#find-result').textContent = `${matches.length} 处`;
    return editor;
  }
  function selectMatch(direction = 0) {
    const editor = findEditor();
    if (!matches.length) { $('#find-result').textContent = '0 处'; return; }
    matchIndex = (Math.max(0, matchIndex) + direction + matches.length) % matches.length;
    const start = matches[matchIndex];
    editor.setSelectionRange(start, start + $('#find-query').value.length);
    scrollToLine(editor, editor.value.slice(0,start).split('\n').length, editor === content ? $('#line-numbers') : $('#gcode-lines'));
    $('#find-result').textContent = `${matchIndex + 1} / ${matches.length}`; updateCursor();
  }
  function openFind() {
    if (!active()) return;
    if (!['editor','gcode'].includes(currentView)) selectView('editor');
    $('#find-bar').hidden = false; collectMatches(); $('#find-query').focus(); $('#find-query').select();
  }
  $('#find-query').addEventListener('input', () => { collectMatches(); selectMatch(); });
  $('#find-case').addEventListener('change', () => { collectMatches(); selectMatch(); });
  $('#find-next').addEventListener('click', () => selectMatch(1));
  $('#find-prev').addEventListener('click', () => selectMatch(-1));
  $('#find-close').addEventListener('click', () => { $('#find-bar').hidden = true; findEditor().focus(); });
  $('#replace-one').addEventListener('click', () => {
    if (blocked || hardwareJob || !active()) return;
    const editor = findEditor();
    if (!matches.length) return;
    selectMatch(); editor.setRangeText($('#replace-query').value, editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input', { bubbles:true })); collectMatches(); selectMatch();
  });
  $('#replace-all').addEventListener('click', () => {
    if (blocked || hardwareJob || !active()) return;
    const editor = collectMatches();
    if (!matches.length) return;
    const replacement = $('#replace-query').value, length = $('#find-query').value.length;
    for (const start of [...matches].reverse()) editor.setRangeText(replacement, start, start + length, 'end');
    editor.dispatchEvent(new Event('input', { bubbles:true })); collectMatches();
  });
  [content,codeEditor].forEach(editor => editor.addEventListener('input', () => { if (!$('#find-bar').hidden) collectMatches(); }));
  document.addEventListener('keydown', event => {
    if (event.target.closest('dialog')) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); if (!blocked && !hardwareJob && capture()) persist(); }
    if (mod && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); }
    if (event.key === 'F3') { event.preventDefault(); if ($('#find-bar').hidden) openFind(); else selectMatch(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape' && !$('#find-bar').hidden) { event.preventDefault(); $('#find-close').click(); }
    if (event.key === 'Enter' && event.target === $('#find-query')) { event.preventDefault(); selectMatch(event.shiftKey ? -1 : 1); }
  });

  // Real resizing, with keyboard access and persistent dimensions.
  function resizer(id, property, min, max, horizontal) {
    const handle = $(`#${id}`);
    const clamp = value => Math.max(min, Math.min(max, value));
    const set = value => { const n = clamp(value); document.documentElement.style.setProperty(property, `${n}px`); handle.setAttribute('aria-valuenow', String(n)); try { localStorage.setItem(property,String(n)); } catch { /* Optional UI preference. */ } };
    handle.setAttribute('aria-valuemin',String(min)); handle.setAttribute('aria-valuemax',String(max));
    handle.setAttribute('aria-valuenow',String(horizontal ? $('#sidebar').getBoundingClientRect().width || 263 : $('#log').getBoundingClientRect().height || 110));
    try { const saved = localStorage.getItem(property); if (saved !== null && Number.isFinite(+saved)) set(+saved); } catch { /* Default CSS size. */ }
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const start = horizontal ? event.clientX : event.clientY;
      const size = horizontal ? $('#sidebar').getBoundingClientRect().width : $('#log').getBoundingClientRect().height;
      handle.setPointerCapture(event.pointerId);
      const move = pointer => set(size + (horizontal ? pointer.clientX - start : start - pointer.clientY));
      const end = () => { handle.removeEventListener('pointermove',move); handle.removeEventListener('pointerup',end); handle.removeEventListener('pointercancel',end); };
      handle.addEventListener('pointermove',move); handle.addEventListener('pointerup',end); handle.addEventListener('pointercancel',end);
      event.preventDefault();
    });
    handle.addEventListener('keydown', event => {
      const step = horizontal ? ({ArrowLeft:-10,ArrowRight:10})[event.key] : ({ArrowUp:10,ArrowDown:-10})[event.key];
      if (step) { event.preventDefault(); const size = horizontal ? $('#sidebar').getBoundingClientRect().width : $('#log').getBoundingClientRect().height; set(size+step); }
    });
  }
  resizer('sidebar-resizer','--sidebar-width',210,480,true);
  resizer('log-resizer','--log-height',50,350,false);
})();
