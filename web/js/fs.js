'use strict';
// Workspace storage backends with one interface:
//   list() → [{path, type, size?, mtime?}]   read(path) → {content, mtime}
//   write(path, content, base) → {mtime}      base: undefined = overwrite, null = create only, number = expected mtime
//   mkdir(path)   rename(from, to)   remove(path)
// A write whose `base` no longer matches fails with error.conflict = true (edited in another tab / program).
const SERVER_KEY_STORAGE = 'web-typewriter:bridge-key';

class FsConflict extends Error {
  constructor(message, mtime) { super(message); this.conflict = true; this.mtime = mtime; }
}

/** Browser workspaces in IndexedDB: survive reloads, no size pressure on localStorage, per browser only. */
const BrowserFS = (() => {
  let opening = null;
  const open = () => opening || (opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('web-typewriter-files', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('workspaces', { keyPath: 'name' });
      db.createObjectStore('entries', { keyPath: ['ws', 'path'] }).createIndex('ws', 'ws');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error('浏览器禁止本地存储，请允许存储或改用服务器工作区。'));
  }));
  const done = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  async function transaction(stores, mode, work) {
    const db = await open();
    const tx = db.transaction(stores, mode);
    const finished = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || Error('浏览器存储写入失败（可能空间不足）')); });
    let result;
    try { result = await work(tx); } catch (error) { try { tx.abort(); } catch { /* already finished */ } await finished.catch(() => {}); throw error; }
    await finished;
    return result;
  }
  let lastStamp = 0;
  const stamp = () => (lastStamp = Math.max(Date.now() * 1000, lastStamp + 1));
  const lowerKeys = (entries) => new Set(entries.map((entry) => entry.path.toLocaleLowerCase()));

  class Workspace {
    constructor(name) { this.name = name; this.backend = 'browser'; }
    get label() { return `本浏览器 · ${this.name}`; }
    async entries(tx) { return done(tx.objectStore('entries').index('ws').getAll(this.name)); }
    async list() {
      return transaction(['entries'], 'readonly', async (tx) => (await this.entries(tx)).map(({ path, type, content, mtime }) => ({ path, type, size: content?.length || 0, mtime })));
    }
    async read(path) {
      const entry = await transaction(['entries'], 'readonly', (tx) => done(tx.objectStore('entries').get([this.name, path])));
      if (!entry || entry.type !== 'file') throw Error(`文件不存在：${path}`);
      return { content: entry.content, mtime: entry.mtime };
    }
    async write(path, content, base) {
      if (!Links.validPath(path)) throw Error(`路径无效：${path}`);
      return transaction(['entries'], 'readwrite', async (tx) => {
        const store = tx.objectStore('entries');
        const existing = await done(store.get([this.name, path]));
        if (existing?.type === 'dir') throw Error('同名文件夹已存在');
        if (base === null && existing) throw new FsConflict('文件已存在', existing.mtime);
        if (typeof base === 'number' && existing?.mtime !== base) throw new FsConflict('文件已在其他地方被修改', existing?.mtime);
        const parent = Links.dirname(path);
        if (parent && (await done(store.get([this.name, parent])))?.type !== 'dir') throw Error('所在文件夹不存在');
        const mtime = stamp();
        await done(store.put({ ws: this.name, path, type: 'file', content, mtime }));
        return { mtime };
      });
    }
    async mkdir(path) {
      if (!Links.validPath(path, 'dir')) throw Error('文件夹名称无效');
      return transaction(['entries'], 'readwrite', async (tx) => {
        const store = tx.objectStore('entries');
        if (lowerKeys(await this.entries(tx)).has(path.toLocaleLowerCase())) throw Error('同名文件或文件夹已存在');
        const parent = Links.dirname(path);
        if (parent && (await done(store.get([this.name, parent])))?.type !== 'dir') throw Error('上级文件夹不存在');
        await done(store.put({ ws: this.name, path, type: 'dir', mtime: stamp() }));
      });
    }
    async rename(from, to) {
      return transaction(['entries'], 'readwrite', async (tx) => {
        const store = tx.objectStore('entries');
        const all = await this.entries(tx);
        const source = all.find((entry) => entry.path === from);
        if (!source) throw Error('原文件不存在');
        if (!Links.validPath(to, source.type)) throw Error('新名称无效');
        if (from.toLocaleLowerCase() !== to.toLocaleLowerCase() && lowerKeys(all).has(to.toLocaleLowerCase())) throw Error('目标名称已存在');
        if (source.type === 'dir' && (to === from || to.startsWith(`${from}/`))) throw Error('不能移动到自身内部');
        const parent = Links.dirname(to);
        if (parent && !all.some((entry) => entry.path === parent && entry.type === 'dir')) throw Error('目标文件夹不存在');
        for (const entry of all.filter((item) => item.path === from || item.path.startsWith(`${from}/`))) {
          await done(store.delete([this.name, entry.path]));
          await done(store.put({ ...entry, path: to + entry.path.slice(from.length), mtime: entry.type === 'file' ? stamp() : entry.mtime }));
        }
      });
    }
    async remove(path) {
      return transaction(['entries'], 'readwrite', async (tx) => {
        const store = tx.objectStore('entries');
        const targets = (await this.entries(tx)).filter((entry) => entry.path === path || entry.path.startsWith(`${path}/`));
        if (!targets.length) throw Error('文件不存在');
        for (const entry of targets) await done(store.delete([this.name, entry.path]));
      });
    }
  }
  return {
    Workspace,
    async workspaces() { return transaction(['workspaces'], 'readonly', async (tx) => (await done(tx.objectStore('workspaces').getAll())).map((item) => item.name)); },
    async create(name, manifest) {
      if (!Links.validPart(name)) throw Error('工作区名称无效');
      await transaction(['workspaces', 'entries'], 'readwrite', async (tx) => {
        if (await done(tx.objectStore('workspaces').get(name))) throw Error('同名工作区已存在');
        await done(tx.objectStore('workspaces').put({ name, created: new Date().toISOString() }));
        await done(tx.objectStore('entries').put({ ws: name, path: Links.MANIFEST, type: 'file', content: manifest, mtime: stamp() }));
      });
      return new Workspace(name);
    },
  };
})();

/** Folders under the server's workspace root (server.py --workspaces); needs the access key. */
const ServerFS = (() => {
  const key = () => localStorage.getItem(SERVER_KEY_STORAGE) || (typeof bridgeKey === 'string' ? bridgeKey : '');
  async function call(action, body, query) {
    const url = `/api/fs/${action}${query ? `?${new URLSearchParams(query)}` : ''}`;
    let response;
    try {
      response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'X-Bridge-Key': key(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    } catch (error) { throw Error(`无法连接服务器：${error.message}`); }
    let data;
    try { data = await response.json(); } catch { throw Error('当前服务不提供工作区接口，请用 python3 server.py 启动。'); }
    if (response.status === 409) throw new FsConflict(data.error, data.mtime);
    if (!response.ok) { const error = Error(data.error || `服务器错误 ${response.status}`); error.status = response.status; throw error; }
    return data;
  }
  class Workspace {
    constructor(name) { this.name = name; this.backend = 'server'; }
    get label() { return `服务器 · ${this.name}`; }
    async list() { return (await call('list', null, { ws: this.name })).entries; }
    read(path) { return call('read', null, { ws: this.name, path }); }
    write(path, content, base) { return call('write', { ws: this.name, path, content, ...(base === undefined ? {} : { base }) }); }
    mkdir(path) { return call('mkdir', { ws: this.name, path }); }
    rename(from, to) { return call('rename', { ws: this.name, from, to }); }
    remove(path) { return call('delete', { ws: this.name, path }); }
  }
  return {
    Workspace,
    hasKey: () => Boolean(key()),
    setKey(value) { if (value) localStorage.setItem(SERVER_KEY_STORAGE, value); else localStorage.removeItem(SERVER_KEY_STORAGE); },
    async workspaces() { return (await call('workspaces')).workspaces; },
    async create(name) { await call('workspaces', { name }); return new Workspace(name); },
  };
})();

/** Archive (all files of a workspace in one JSON) for backup / moving between backends. */
async function exportArchive(fsys) {
  const entries = await fsys.list();
  const files = [];
  for (const entry of entries.filter((item) => item.type === 'file')) files.push({ path: entry.path, content: (await fsys.read(entry.path)).content });
  return { format: Links.ARCHIVE_FORMAT, version: 1, name: fsys.name, exportedAt: new Date().toISOString(), dirs: entries.filter((item) => item.type === 'dir').map((item) => item.path), files };
}
