'use strict';
// Multi-page layout (one program per sheet) and the server-provided Hershey libraries.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const url=process.env.TEST_URL||'http://127.0.0.1:5173';
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  try {
    for(const width of [1280,390]) {
      const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true}),page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(url);
      await page.locator('#content').fill('HELLO WORLD\n'.repeat(80));
      await page.locator('#preview-tab').click();
      const pager=page.locator('#preview-view .pager');
      assert(await pager.isVisible());
      assert.match(await pager.locator('.pager-label').textContent(),/第 1 \/ 3 页/);
      assert.match(await page.locator('#layout-status').textContent(),/共 3 页/);
      await page.locator('#gcode-tab').click();
      await page.locator('#generate-code').click();
      assert.match(await page.locator('#gcode').inputValue(),/; Page 1 of 3/);
      // Switching page regenerates the (generated) program for that sheet.
      await page.locator('#gcode-view .pager-next').click();
      await page.waitForFunction(()=>document.querySelector('#gcode').value.includes('; Page 2 of 3'));
      assert.match(await page.locator('#code-state').textContent(),/第 2 \/ 3 页/);
      const download=page.waitForEvent('download');
      await page.locator('#download-gcode').click();
      assert.match((await download).suggestedFilename(),/-p2\.gcode$/);
      // Page choice is saved with the document; shrinking the text clamps it.
      await page.reload();
      await page.locator('#gcode-tab').click();
      assert.match(await page.locator('#gcode-view .pager-label').textContent(),/第 2 \/ 3 页/);
      await page.locator('#edit-tab').click();
      await page.locator('#content').fill('hello world');
      await page.locator('#preview-tab').click();
      assert(await page.locator('#preview-view .pager').isHidden());
      await page.waitForFunction(()=>document.querySelector('#gcode').value.includes('; Page 1 of 1'));
      // Lowercase is missing from nothing now: enable the Hershey script library from the server.
      if(width<=900)await page.locator('#sidebar-toggle').click();
      await page.locator('[data-panel=glyphs]').click();
      const script=page.locator('.glyph-library').filter({hasText:'Hershey 手写体'});
      await script.locator('input').check();
      await script.getByRole('button',{name:/提高优先级/}).click();
      await page.waitForFunction(()=>document.querySelector('.glyph-library')?.textContent.includes('Hershey 手写体')&&!document.querySelector('.glyph-library').textContent.includes('加载中'));
      await page.waitForFunction(()=>document.querySelector('#gcode').value.split('\n').length>200);
      assert.match(await page.locator('#glyph-coverage').textContent(),/全部由启用的字库覆盖/);
      assert.deepEqual(errors,[]);
      console.log(`Pages ${width}px: 3-page layout, per-page generation and download, persisted page, clamp, Hershey server library passed.`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
