'use strict';
// Glyph libraries + selection: import to IndexedDB, priority, strategies, per-character defaults,
// per-occurrence picks on the paper, pins following edits, persistence and server libraries.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const url=process.env.TEST_URL||'http://127.0.0.1:5173';
const library={format:'web-typewriter/glyph-library',version:1,id:'test-hand',name:'测试手写',unitsPerEm:1000,glyphs:[
  {char:'永',variants:[{id:'a',advance:1000,strokes:[[[100,100],[100,900]]]},{id:'b',advance:1000,strokes:[[[200,100],[800,900]]]},{id:'c',advance:1000,strokes:[[[500,500],[600,600]]]}]},
]};
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  try {
    for(const width of [1280,390]) {
      const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(url);
      const code=()=>page.locator('#gcode').inputValue();
      const openPanel=async()=>{ if(width<=900&&await page.locator('#sidebar').isHidden())await page.locator('#sidebar-toggle').click(); await page.locator('[data-panel=glyphs]').click(); };
      const closePanel=async()=>{ if(width<=900)await page.locator('#sidebar-backdrop').click({position:{x:width-80,y:20}}); };
      await page.locator('#content').fill('永永永 AB');
      await openPanel();
      assert.match(await page.locator('#glyph-coverage').textContent(),/缺 1 个：永/);
      await page.locator('#glyph-file').setInputFiles({name:'hand.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(library))});
      await page.waitForFunction(()=>document.querySelector('#glyph-libraries .glyph-library')?.textContent.includes('测试手写'));
      assert.match(await page.locator('#glyph-coverage').textContent(),/全部由启用的字库覆盖/);
      // Strategy cycle: three occurrences use a, b, c.
      await page.locator('[data-select-id=glyph-strategy]').click();
      await page.getByRole('option',{name:'依次轮换'}).click();
      await closePanel();
      await page.locator('#gcode-tab').click();
      await page.locator('#generate-code').click();
      let program=await code();
      assert.match(program,/G0 X20.5 Y276.5\n/); // 永 #1 variant a at x=20 (5 mm font)
      assert.match(program,/G0 X27 Y276.5\n/);   // 永 #2 variant b at x=26 (5 mm + 1 gap)
      assert.match(program,/G0 X34.5 Y274.5\n/); // 永 #3 variant c at x=32
      // Pick a variant for the first 永 directly on the paper.
      await page.locator('#preview-tab').click();
      const box=await page.locator('#preview').boundingBox();
      const scale=box.width/210;
      await page.mouse.click(box.x+22.5*scale,box.y+22.5*scale);
      await page.locator('.glyph-picker').waitFor();
      assert.match(await page.locator('.glyph-picker-heading').textContent(),/「永」第 1 处/);
      await page.locator('.glyph-picker .glyph-choice').nth(2).click();
      await page.waitForFunction(()=>document.querySelector('#gcode').value.includes('G0 X22.5 Y274.5'));
      await openPanel();
      assert.equal(await page.locator('#glyph-pin-count').textContent(),'逐字指定 1 处');
      await closePanel();
      // Pins follow their character when text is inserted before them.
      await page.locator('#edit-tab').click();
      await page.locator('#content').press('Home');
      await page.locator('#content').type('A');
      await page.waitForFunction(()=>document.querySelector('#gcode').value.includes('G0 X27 Y274.5'));
      // Per-character default overrides the strategy (but not the pin).
      await openPanel();
      const row=page.locator('.glyph-prefer').filter({hasText:'永'});
      await row.locator('.glyph-choice').nth(1).click(); // variant a (index 0 is 自动)
      assert.equal(await row.locator('.glyph-choice').nth(1).getAttribute('aria-pressed'),'true');
      await closePanel();
      await page.waitForTimeout(500);
      program=await code();
      assert.match(program,/G0 X27 Y274.5\n/); // pinned c stays
      assert.match(program,/G0 X31 Y276.5\n/);assert.match(program,/G0 X37 Y276.5\n/); // others now default to a
      // Missing characters: shown as such and block generation.
      await page.locator('#edit-tab').click();
      await page.locator('#content').press('End');
      await page.locator('#content').type('水');
      await page.waitForFunction(()=>document.querySelector('#code-state').textContent.includes('无法自动更新'));
      await page.locator('#preview-tab').click();
      assert.match(await page.locator('#layout-status').textContent(),/缺字 1 个/);
      await page.locator('#edit-tab').click();
      await page.locator('#content').press('Backspace');
      // Persistence: selection in the workspace, library in IndexedDB.
      await page.waitForTimeout(400);
      await page.reload();
      await openPanel();
      await page.waitForFunction(()=>document.querySelector('#glyph-libraries')?.textContent.includes('测试手写'));
      assert.equal(await page.locator('#glyph-pin-count').textContent(),'逐字指定 1 处');
      assert.equal(await page.locator('#glyph-strategy').inputValue(),'cycle');
      // Server library loads on demand when enabled.
      await page.locator('.glyph-library').filter({hasText:'演示变体'}).locator('input').check();
      await page.waitForFunction(()=>[...document.querySelectorAll('.glyph-prefer-char')].some(el=>el.textContent==='B'));
      assert.equal(await page.locator('.glyph-prefer').filter({hasText:'B'}).locator('.glyph-choice').count(),6); // 自动 + builtin + 4 demo
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.deepEqual(errors,[]);
      console.log(`Glyphs ${width}px: import, coverage, cycle strategy, paper pick, pin shift, per-char default, missing glyphs, persistence and server library passed.`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
