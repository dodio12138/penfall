'use strict';
// Drawings (SVG / DXF) and multi-pen writing: import, safe parsing, pen mapping, per-pen programs,
// adding a drawing to a text draft, placement, rename / copy with the draft, pen rack.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const url = process.env.TEST_URL || 'http://127.0.0.1:5173';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">
  <script>window.__svgScriptRan = true</script>
  <rect x="5" y="5" width="40" height="40" fill="none" stroke="#000" onload="window.__svgScriptRan = true"/>
  <circle cx="75" cy="25" r="20" fill="none" stroke="red"/>
  <path d="M 10 10 L 40 40 M 40 10 L 10 40" stroke="blue" fill="none"/>
</svg>`;
const dxf = ['0','SECTION','2','HEADER','9','$INSUNITS','70','4','0','ENDSEC','0','SECTION','2','ENTITIES',
  '0','LINE','8','0','62','1','10','0','20','0','11','30','21','0','0','CIRCLE','8','0','10','15','20','15','40','10','0','ENDSEC','0','EOF'].join('\n');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const accept = async (name) => {
      await page.locator('#action-dialog').waitFor({ state: 'visible' });
      if (name !== undefined) await page.locator('#action-name').fill(name);
      await page.locator('#action-accept').click();
      await page.locator('#action-dialog').waitFor({ state: 'hidden' });
    };
    const code = () => page.locator('#gcode').inputValue();
    await page.goto(url);
      await page.evaluate(()=>document.querySelectorAll('details.pane').forEach(d=>{d.open=true;}));
    await page.locator('#content:not([disabled])').waitFor();

    // SVG import → a draft with the drawing; scripts / handlers never run.
    await page.locator('#document-file').setInputFiles({ name: 'shapes.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
    await page.waitForFunction(() => document.title.startsWith('shapes'));
    assert.equal(await page.evaluate(() => window.__svgScriptRan), undefined);
    await page.locator('#file-tree .tree-row[data-path="shapes.wtl"] .tree-twisty').click();
    assert(await page.locator('#file-tree .tree-row[data-path="shapes.svg"]').isVisible());
    assert.deepEqual(await page.evaluate(() => [...new Set(layout.paths.map((path) => path.pen))].sort()), [1, 2, 3]);
    await page.locator('#preview-tab').click();
    assert.equal(await page.locator('#pen-legend .pen-chip').count(), 3);

    // One program per pen; "all" warns that colours are not changed.
    await page.locator('#gcode-tab').click();
    await page.locator('#generate-code').click();
    assert.match(await page.locator('#code-state').textContent(), /含 3 种颜色/);
    await page.locator('[data-select-id=pen]').click();
    await page.getByRole('option', { name: /2 · 红/ }).click();
    await page.waitForFunction(() => document.querySelector('#gcode').value.includes('; pen 2'));
    const red = await code();
    assert.match(red, /G0 X(9[0-9]|8[0-9]|1[01][0-9])/); // circle around x = 20 + 75 mm
    assert.doesNotMatch(red, /G0 X25 Y272\b/);           // the black rectangle corner is not in the red program
    // Finishing a pen tells you which pen comes next.
    await page.evaluate(() => announceNextPage());
    assert.match(await page.locator('#log').innerText(), /换上「蓝」笔/);

    // Placement: width / position change the program (generated → follows automatically).
    await page.locator('[data-panel=settings]').click();
    await page.locator('#drawing-width').fill('50');
    await page.waitForFunction((before) => document.querySelector('#gcode').value !== before, red);
    await page.locator('#drawing-fit').click();
    assert.equal(await page.locator('#drawing-x').inputValue(), '20');

    // Pen rack: recolouring a pen changes which pen a colour maps to.
    await page.locator('[data-panel=machine]').click(); // pen rack = machine setting of the workspace
    await page.locator('#pen-list .pen-row').nth(1).locator('input[type=color]').evaluate((input) => { input.value = '#00aa00'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => !layout.paths.some((path) => path.pen === 2));
    await page.locator('#add-pen').click();
    assert.equal(await page.locator('#pen-list .pen-row').count(), 4);

    // Add a DXF drawing to a text draft; rename keeps all four files together.
    await page.locator('[data-panel=files]').click();
    await page.locator('#new-document').click();
    await accept('教案');
    await page.locator('#content').fill('HELLO');
    await page.locator('[data-panel=settings]').click();
    await page.locator('#drawing-file').setInputFiles({ name: 'part.dxf', mimeType: 'application/dxf', buffer: Buffer.from(dxf) });
    await page.waitForFunction(() => !document.querySelector('#drawing-fields').hidden);
    assert.match(await page.locator('#drawing-size').textContent(), /原始 30\.0 × 25\.0 mm/);
    await page.locator('[data-panel=files]').click();
    await page.locator('#file-tree .tree-row[data-path="教案.wtl"]').click();
    await page.keyboard.press('F2');
    await accept('物理教案');
    await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .tree-row')].some((row) => row.dataset.path === '物理教案.wtl'));
    await page.locator('#file-tree .tree-row[data-path="物理教案.wtl"] .tree-twisty').click();
    assert(await page.locator('#file-tree .tree-row[data-path="物理教案.dxf"]').isVisible());
    assert.equal(await page.locator('#drawing-name').textContent(), '物理教案.dxf');
    await page.locator('#gcode-tab').click();
    await page.locator('#generate-code').click();
    assert.match(await code(), /G1 /);
    assert.deepEqual(errors, []);
    console.log('Drawing checks passed: SVG import (sanitized), DXF attach, pen mapping, per-pen programs, next-pen prompt, placement, pen rack, rename with drawing.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
