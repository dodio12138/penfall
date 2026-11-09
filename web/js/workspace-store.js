(function (root) {
  'use strict';
  const KEY = 'web-typewriter:projects:v3';
  const Glyphs = typeof module !== 'undefined' && module.exports ? require('./glyphs.js') : root.Glyphs;
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  class ConflictError extends Error {}
  // Stored JSON always starts with version + revision (see normalize); read it without parsing megabytes.
  const REVISION_PREFIX = /^\{"version":3,"revision":"([A-Za-z0-9-]*)"/;
  function storedRevision(raw) {
    if (raw === null) return '';
    const match = REVISION_PREFIX.exec(raw.slice(0, 200));
    return match ? match[1] : normalize(JSON.parse(raw)).revision;
  }
  function normalize(data) {
    if (!data || data.version !== 3 || !Array.isArray(data.documents) || data.documents.length > 200) throw Error('不是有效的 v3 工作区备份，最多支持 200 份文稿。');
    const ids = new Set();
    const documents = data.documents.map(doc => {
      if (!doc || typeof doc.id !== 'string' || !doc.id || ids.has(doc.id)) throw Error('工作区文稿 ID 缺失或重复。');
      ids.add(doc.id);
      if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 120 || /[\\/\u0000-\u001f]/.test(doc.name)) throw Error('文稿名称无效。');
      for (const key of ['content', 'gcode']) if (typeof doc[key] !== 'string' || doc[key].length > 500000) throw Error('文稿 / G-code 需为不超过 500000 字符的文本。');
      const strings = value => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([key, val]) => key !== '__proto__' && typeof val === 'string'));
      return { id: doc.id, name: doc.name.trim(), title: typeof doc.title === 'string' ? doc.title.slice(0,120) : '', content: doc.content, gcode: doc.gcode, settings: strings(doc.settings), motion: strings(doc.motion), programDirty: doc.programDirty === true, programSource: ['generated','manual'].includes(doc.programSource) ? doc.programSource : '', glyphs: Glyphs.normalizeSelection(doc.glyphs), view: ['editor','gcode','preview','path'].includes(doc.view) ? doc.view : 'editor', updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '' };
    });
    const openIds = [...new Set((Array.isArray(data.openIds) ? data.openIds : []).filter(id => ids.has(id)))];
    const activeId = ids.has(data.activeId) ? data.activeId : null;
    if (activeId && !openIds.includes(activeId)) openIds.push(activeId);
    return { version: 3, revision: typeof data.revision === 'string' ? data.revision : '', documents, openIds, activeId };
  }
  class Store {
    constructor(storage) { this.storage = storage; this.revision = ''; }
    load() {
      const raw = this.storage.getItem(KEY);
      const data = raw === null ? null : normalize(JSON.parse(raw));
      this.revision = data?.revision || '';
      return data;
    }
    write(data) {
      if (storedRevision(this.storage.getItem(KEY)) !== this.revision) throw new ConflictError('另一个页面已更新工作区。请先下载本页备份，再载入最新版本。');
      const next = normalize(data);
      next.revision = uid();
      const encoded = JSON.stringify(next);
      if (encoded.length > 8_000_000) throw Error('工作区超过 8 MB 文本上限，请先导出并清理文稿。');
      this.storage.setItem(KEY, encoded);
      this.revision = next.revision;
      data.revision = next.revision;
      return data;
    }
  }
  const api = { KEY, uid, normalize, Store, ConflictError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkspaceStorage = api;
})(typeof window !== 'undefined' ? window : globalThis);
