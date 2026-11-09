'use strict';
// Templates & paper ruling: create from built-in / workspace templates, apply, save, written ruling.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const url = process.env.TEST_URL || 'http://127.0.0.1:5173';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await (await browser.newContext({ viewport: { width, height: 844 } })).newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const sidebar = async (panel) => { if (width <= 900 && await page.locator('#sidebar').isHidden()) await page.locator('#sidebar-toggle').click(); await page.locator(`[data-panel=${panel}]`).click(); };
      const closeSidebar = async () => { if (width <= 900 && await page.locator('#sidebar').isVisible()) await page.locator('#sidebar-backdrop').click({ position: { x: width - 80, y: 20 } }); };
      const pick = async (name, draftName) => {
        await page.locator('#template-dialog').waitFor();
        await page.locator('.template-card').filter({ hasText: name }).click();
        if (draftName !== undefined) await page.locator('#template-name').fill(draftName);
        await page.locator('#template-accept').click();
        await page.locator('#template-dialog').waitFor({ state: 'hidden' });
      };
      await page.goto(url);
      await page.locator('#content:not([disabled])').waitFor();
      // New from a built-in grid template: settings, starter text, one character per cell.
      await sidebar('files');
      await page.locator('#new-from-template').click();
      assert.equal(await page.locator('.template-card').count(), 8);
      assert((await page.locator('#template-dialog').boundingBox()).width <= width);
      await pick('方格纸', '方格练习');
      await page.waitForFunction(() => document.title.startsWith('方格练习'));
      assert.equal(await page.locator('#bg-kind').inputValue(), 'grid');
      await closeSidebar();
      await page.locator('#edit-tab').click();
      await page.locator('#content').fill('AB\nC');
      const cells = await page.evaluate(() => layout.placements.map((item) => [item.char, +(item.x + item.width / 2).toFixed(2), +(item.y + layout.size / 2).toFixed(2)]));
      assert.deepEqual(cells, [['A', 25, 25], ['B', 35, 25], ['C', 25, 35]]); // centred in 10 mm cells
      // Ruling only in the preview by default; "用笔画出" writes it with its own pen.
      await page.locator('#gcode-tab').click();
      await page.locator('#generate-code').click();
      const plain = (await page.locator('#gcode').inputValue()).split('\n').length;
      await sidebar('settings');
      await page.locator('[data-select-id=bg-write]').click();
      await page.getByRole('option', { name: '用笔画出' }).click();
      assert(await page.locator('#bg-pen-label').isVisible());
      await page.waitForFunction((count) => document.querySelector('#gcode').value.split('\n').length > count + 100, plain);
      // Save as a workspace template, then create a draft from it.
      await page.locator('#save-template').click();
      await page.locator('#action-name').fill('我的方格');
      await page.locator('#action-accept').click();
      await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .tree-row')].some((row) => row.dataset.path === '模板/我的方格.wtt'));
      await sidebar('files');
      await page.locator('#file-tree .tree-row[data-path="模板/我的方格.wtt"]').click();
      await pick('我的方格', '从我的模板');
      await page.waitForFunction(() => document.title.startsWith('从我的模板'));
      assert.equal(await page.locator('#bg-write').inputValue(), 'yes');
      assert.equal(await page.locator('#content').inputValue(), 'AB\nC');
      // Apply a template to an existing draft keeps the text, changes the format.
      await sidebar('settings');
      await page.locator('#apply-template').click();
      await page.locator('.template-card').filter({ hasText: '横线信纸' }).click();
      await page.locator('#template-accept').click();
      await page.waitForFunction(() => document.querySelector('#bg-kind').value === 'lines');
      assert.equal(await page.locator('#content').inputValue(), 'AB\nC');
      assert.equal(await page.evaluate(() => layout.placements[2].y - layout.placements[0].y), 9);
      assert.deepEqual(errors, []);
      console.log(`Templates ${width}px: built-in + workspace templates, grid cells, written ruling, save / apply passed.`);
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
