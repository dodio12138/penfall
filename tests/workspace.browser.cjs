'use strict';
// Workspace / file tree / drafts / 梳串. Needs Playwright and a running server.py (any --workspaces dir).
// Runs in isolated browser contexts; the server workspace part creates a uniquely named workspace.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = process.env.TEST_URL || 'http://127.0.0.1:5173';
const key = fs.readFileSync(path.join(__dirname, '../.bridge-key'), 'utf8').trim();

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { errors.push(`Unexpected native dialog: ${dialog.type()}`); dialog.dismiss(); });
    const accept = async (name) => {
      await page.locator('#action-dialog').waitFor({ state: 'visible' });
      if (name !== undefined) await page.locator('#action-name').fill(name);
      await page.locator('#action-accept').click();
      await page.locator('#action-dialog').waitFor({ state: 'hidden' });
    };
    const saved = () => page.waitForFunction(() => document.querySelector('#save-indicator').textContent === '已保存');
    const row = (name) => page.locator('#file-tree .tree-row').filter({ has: page.locator('.tree-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    const rowPath = (path) => page.locator(`#file-tree .tree-row[data-path="${path}"]`);
    const treeNames = () => page.locator('#file-tree .tree-name').allTextContents();
    const logText = () => page.locator('#log').innerText();

    // Fresh browser: a workspace with one empty draft is created and opened.
    await page.goto(url);
    await page.locator('#content').fill('HELLO HELLO 123');
    assert.match(await page.locator('#workspace-switcher').inputValue(), /^browser:/);
    await page.locator('#gcode-tab').click();
    await page.locator('#generate-code').click();
    const firstCode = await page.locator('#gcode').inputValue();
    assert(firstCode.includes('G21'));
    await saved();
    await row('未命名').locator('.tree-twisty').click();
    assert.deepEqual(await treeNames(), ['未命名', '未命名.gcode', '未命名.txt', 'workspace.wtw']);

    // New draft is independent (text, program, parameters).
    await page.locator('#new-document').click();
    await accept('第二份');
    await page.waitForFunction(() => document.title.startsWith('第二份'));
    assert.equal(await page.locator('#content').inputValue(), '');
    assert.equal(await page.locator('#gcode').inputValue(), '');
    await page.locator('#content').fill('SECOND');
    await page.locator('[data-panel=settings]').click();
    await page.locator('#font-size').fill('8');
    await page.locator('#feed').fill('900');
    await page.locator('[data-panel=files]').click();
    await saved();
    // Rename a draft: link, text (and program) are renamed together; tab and title follow.
    await row('第二份').click();
    await page.keyboard.press('F2');
    await accept('已重命名');
    await page.waitForFunction(() => document.title.startsWith('已重命名'));
    assert((await treeNames()).includes('已重命名'));
    assert(!(await treeNames()).includes('第二份'));
    await page.locator('#document-tabs .document-tab-name').filter({ hasText: '未命名' }).click();
    assert.equal(await page.locator('#content').inputValue(), 'HELLO HELLO 123');
    assert.equal(await page.locator('#gcode').inputValue(), firstCode);
    assert.equal(await page.locator('#font-size').inputValue(), '5');

    // Find / replace still edits the real document.
    await page.locator('#edit-tab').click();
    await page.keyboard.press('ControlOrMeta+f');
    await page.locator('#find-query').fill('HELLO');
    assert.equal(await page.locator('#find-result').textContent(), '1 / 2');
    await page.locator('#replace-query').fill('HI');
    await page.locator('#replace-all').click();
    assert.equal(await page.locator('#content').inputValue(), 'HI HI 123');
    await page.locator('#find-close').click();
    // Generated program follows the text automatically.
    await page.waitForFunction((code) => document.querySelector('#gcode').value !== code, firstCode);
    await saved();

    // Folder, drag & drop, context-menu copy and delete.
    await page.locator('#new-folder').click();
    await accept('信件');
    await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .tree-name')].some((el) => el.textContent === '信件'));
    await row('已重命名').dragTo(row('信件'));
    await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .tree-row')].some((el) => el.dataset.path === '信件/已重命名.wtl'));
    await page.locator('#document-tabs .document-tab-name').filter({ hasText: '已重命名' }).click();
    assert.equal(await page.locator('#content').inputValue(), 'SECOND');
    assert.equal(await page.locator('#feed').inputValue(), '900');
    await row('已重命名').click({ button: 'right' });
    await page.locator('.context-menu button', { hasText: '创建副本' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .tree-name')].some((el) => el.textContent === '已重命名 副本'));
    await row('已重命名 副本').locator('.tree-more').click();
    await page.locator('.context-menu button', { hasText: '删除' }).click();
    await accept();
    await page.waitForFunction(() => ![...document.querySelectorAll('#file-tree .tree-name')].some((el) => el.textContent === '已重命名 副本'));
    await page.locator('#file-filter').fill('重命名');
    assert.deepEqual(await treeNames(), ['信件', '已重命名', '已重命名.txt']);
    await page.locator('#file-filter').fill('');

    // Reload restores the workspace, open tabs and contents.
    await saved();
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#document-tabs .document-tab').length === 2);
    assert.equal(await page.locator('#content').inputValue(), 'SECOND');
    assert.equal(await page.locator('#feed').inputValue(), '900');

    // 梳串 before simulating: generated programs are regenerated, hand-edited ones are kept and reported.
    await page.locator('#document-tabs .document-tab-name').filter({ hasText: '未命名' }).click();
    await page.locator('#gcode-tab').click();
    await page.locator('#gcode').press('End');
    await page.locator('#gcode').type('\n; my edit');
    await page.locator('#edit-tab').click();
    await page.locator('#content').fill('CHANGED');
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#log').innerText.includes('手动版本'));
    await accept(); // "simulate the existing (stale) program?"
    await page.locator('#stop').click();
    assert((await page.locator('#gcode').inputValue()).includes('; my edit'));
    await page.locator('#path-regenerate').click();
    assert(!(await page.locator('#gcode').inputValue()).includes('; my edit'));
    await saved();

    // Another tab edits the same file: this tab picks it up when simulating (no unsaved work here).
    const other = await context.newPage();
    await other.goto(url);
    await other.locator('#document-tabs .document-tab-name').filter({ hasText: '未命名' }).click();
    await other.locator('#edit-tab').click();
    await other.locator('#content').fill('FROM OTHER TAB');
    await other.waitForFunction(() => document.querySelector('#save-indicator').textContent === '已保存');
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#content').value === 'FROM OTHER TAB');
    // The other tab already regenerated its program, so the reloaded pair is consistent.
    await page.waitForFunction(() => document.querySelector('#log').innerText.includes('已重新载入'));
    await page.waitForFunction(() => document.querySelector('#log').innerText.includes('正文与 G-code 一致'));
    await page.locator('#stop').click();
    // Conflicting unsaved edits: the second writer gets a conflict and chooses what to keep.
    await other.locator('#content').fill('OTHER AGAIN');
    await other.waitForFunction(() => document.querySelector('#save-indicator').textContent === '已保存');
    await page.locator('#edit-tab').click();
    await page.locator('#content').fill('MINE');
    await page.waitForFunction(() => !document.querySelector('#workspace-warning').hidden);
    assert.equal(await page.locator('#save-indicator').textContent(), '保存冲突');
    assert(await page.locator('#content').isDisabled());
    await page.locator('#conflict-reload').click();
    await accept();
    await page.waitForFunction(() => document.querySelector('#content').value === 'OTHER AGAIN');
    assert(!await page.locator('#content').isDisabled());
    await other.close();

    // Backup / import an archive into a folder; plain TXT import becomes a draft; TXT export is exact.
    await saved();
    let download = page.waitForEvent('download');
    await page.locator('#explorer-more').click();
    await page.locator('#backup-workspace').click();
    const backup = await download;
    const archive = JSON.parse(fs.readFileSync(await backup.path(), 'utf8'));
    assert.equal(archive.format, 'penfall/workspace-archive');
    assert(archive.files.some((file) => file.path === '信件/已重命名.wtl'));
    await row('未命名').click();
    await page.locator('#document-file').setInputFiles({ name: backup.suggestedFilename(), mimeType: 'application/json', buffer: fs.readFileSync(await backup.path()) });
    await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .tree-row')].some((el) => el.dataset.path === '我的工作区/信件'));
    await page.locator('#file-tree .tree-row[data-path="我的工作区/信件"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .tree-row')].some((el) => el.dataset.path === '我的工作区/信件/已重命名.wtl'));
    const body = Buffer.from('Imported exact body\nline 2');
    await rowPath('未命名.wtl').click();
    await page.locator('#document-file').setInputFiles({ name: 'imported.txt', mimeType: 'text/plain', buffer: body });
    await page.waitForFunction(() => document.querySelector('#content').value.startsWith('Imported exact'));
    download = page.waitForEvent('download');
    await page.locator('#editor-more').click();
    await page.locator('#export').click();
    const txt = await download;
    assert.equal(txt.suggestedFilename(), 'imported.txt');
    assert.equal(fs.readFileSync(await txt.path(), 'utf8'), body.toString());

    // Pen width is a workspace setting used by the paper and the toolpath.
    await page.locator('[data-panel=machine]').click();
    await page.evaluate(() => { document.querySelector('#pane-pens').open = true; });
    await page.locator('#pen-width').fill('1.2');
    await page.locator('[data-panel=files]').click();
    await page.locator('#path-tab').click();
    await page.locator('#show-pen-width').check();
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#pen-width').value === '1.2');
    assert(await page.locator('#show-pen-width').isChecked());
    await page.waitForFunction(() => document.querySelectorAll('#document-tabs .document-tab').length > 0); // tabs restored

    // Close all tabs → welcome; reopen from the tree. Camera and sidebar resizing still work.
    while (await page.locator('#document-tabs .close-document').count()) await page.locator('#document-tabs .close-document').last().click();
    await page.locator('#empty-workspace').waitFor();
    await rowPath('未命名.wtl').click();
    await page.locator('#empty-workspace').waitFor({ state: 'hidden' });
    await page.locator('#path-tab').click();
    await page.locator('#toolpath').hover();
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => document.querySelector('#path-zoom').textContent !== '100%');
    await page.locator('#fit-path').click();
    assert.equal(await page.locator('#path-zoom').textContent(), '100%');
    await page.locator('#sidebar-resizer').focus();
    const width = await page.locator('#sidebar').evaluate((el) => el.offsetWidth);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#sidebar').evaluate((el) => el.offsetWidth), width + 10);

    // Server workspace: real folder on the machine running server.py.
    const wsName = `测试-${Date.now()}`;
    await page.locator('[data-select-id=workspace-switcher]').click();
    await page.getByRole('option', { name: /连接服务器工作区/ }).click();
    await accept(key);
    await page.locator('[data-select-id=workspace-switcher]').click();
    await page.getByRole('option', { name: /新建服务器工作区/ }).click();
    await accept(wsName);
    await page.waitForFunction((name) => document.querySelector('#workspace-switcher').value === `server:${name}`, wsName);
    await page.locator('#new-document').click();
    await accept('服务器稿');
    await page.locator('#content').fill('ON DISK');
    await saved();
    const listing = await page.evaluate(async ([name, secret]) => (await (await fetch(`/api/fs/list?ws=${encodeURIComponent(name)}`, { headers: { 'X-Bridge-Key': secret } })).json()).entries.map((entry) => entry.path), [wsName, key]);
    assert.deepEqual(listing.sort(), ['workspace.wtw', '服务器稿.txt', '服务器稿.wtl'].sort());
    const onDisk = await page.evaluate(async ([name, secret]) => (await (await fetch(`/api/fs/read?ws=${encodeURIComponent(name)}&path=${encodeURIComponent('服务器稿.txt')}`, { headers: { 'X-Bridge-Key': secret } })).json()).content, [wsName, key]);
    assert.equal(onDisk, 'ON DISK');
    // Switch back to the browser workspace; tabs come back.
    await page.locator('[data-select-id=workspace-switcher]').click();
    await page.getByRole('option', { name: '本浏览器 · 我的工作区' }).click();
    await page.waitForFunction(() => document.querySelector('#workspace-switcher').value === 'browser:我的工作区');
    await page.waitForFunction(() => document.querySelector('#document-tabs .document-tab'));

    // Mobile layout: drawer explorer, simulation controls.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator('#gcode-tab').click();
    await page.locator('#path-tab').click();
    await page.locator('#start').click();
    await page.locator('#pause').click();
    assert.equal(await page.locator('#pause').textContent(), '继续');
    await page.locator('#stop').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#sidebar-toggle').click();
    assert(await page.locator('#file-tree').isVisible());
    assert(await page.locator('#new-document').isVisible());
    assert.deepEqual(errors, []);
    console.log('Workspace checks passed: drafts (txt + gcode + wtl), tree rename/move/copy/delete/filter, find/replace, reload, 梳串 (regenerate / manual / other tab), conflicts, backup + import, TXT export, pen width, close/reopen, camera, resizing, server workspace on disk, mobile.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
