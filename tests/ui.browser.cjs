'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const sizes=[[320,568],[360,640],[390,844],[600,800],[768,1024],[844,390],[1024,768],[1280,800],[1920,1080],[2560,1440]];
const url=process.env.TEST_URL||'http://127.0.0.1:5173';
async function assertSquareUI(page) {
  const rounded = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => {
    if (!element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].some(key => parseFloat(style[key]) > 0);
  }).map(element => element.id || element.className?.baseVal || element.className || element.tagName));
  assert.deepEqual(rounded, [], 'Visible UI must use square corners');
}
async function bounds(page,selector) {
  return page.locator(selector).evaluate(element=>{
    const r=element.getBoundingClientRect();
    return {inside:r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
  });
}
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  try {
    for(const [width,height] of sizes) {
      const context=await browser.newContext({viewport:{width,height}});
      const page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(url);
      const files=Array.from({length:8},(_,i)=>({name:`${i+1}-用于检查长文件名称与多文稿布局的实际文稿.txt`,mimeType:'text/plain',buffer:Buffer.from('HELLO 123')}));
      await page.locator('#content:not([disabled])').waitFor(); // workspace opened
      await page.locator('#document-file').setInputFiles(files);
      await page.waitForFunction(()=>document.querySelectorAll('#file-tree .tree-row.type-link').length===9);
      if(width<=900) assert(await page.locator('#sidebar-backdrop').isHidden());
      await page.locator('[data-panel=files]').click();
      const originalTitle=await page.title();
      await page.locator('#file-tree .tree-row.selected').focus();await page.keyboard.press('F2');
      await page.locator('#action-dialog').waitFor({state:'visible'});
      assert((await bounds(page,'#action-dialog')).inside);
      await assertSquareUI(page);
      await page.locator('#action-name').fill('');
      await page.locator('#action-accept').click();
      assert(await page.locator('#action-error').isVisible());
      await page.keyboard.press('Escape');
      await page.locator('#action-dialog').waitFor({state:'hidden'});
      assert.equal(await page.title(),originalTitle);
      for(let index=0;index<9;index++) {
        await page.locator('[data-panel=files]').click();
        await page.locator('#file-tree .tree-row.type-link').nth(index).click();
      }
      for(const id of ['edit-tab','gcode-tab','preview-tab','path-tab']) {
        await page.locator(`#${id}`).click();
        const metrics=await page.evaluate(()=>({
          root:document.documentElement.scrollWidth<=innerWidth,
          viewTabs:document.querySelector('.view-tabs').scrollWidth<=document.querySelector('.view-tabs').clientWidth,
          viewOverflow:getComputedStyle(document.querySelector('.view-tabs')).overflowX,
          fileOverflow:getComputedStyle(document.querySelector('#document-tabs')).overflowX,
          toolbar:document.querySelector('.editor-toolbar').scrollWidth<=document.querySelector('.editor-toolbar').clientWidth
        }));
        assert(metrics.root&&metrics.viewTabs&&metrics.toolbar,`${width}x${height}: ${JSON.stringify(metrics)}`);
        await assertSquareUI(page);
        assert.equal(metrics.fileOverflow,'hidden');
        assert(!['auto','scroll'].includes(metrics.viewOverflow));
      }
      // All files remain reachable without a horizontal tab scrollbar.
      const picker=page.locator('[data-select-id=document-switcher]');
      if(await picker.isVisible()) {
        await picker.click();
        assert((await bounds(page,'.select-menu')).inside,`${width}: document menu escaped viewport`);
        await page.getByRole('option').filter({hasText:'4-用于检查'}).click();
      } else await page.locator('#document-tabs .document-tab-name').filter({hasText:'4-用于检查'}).click();
      await page.waitForFunction(()=>document.title.startsWith('4-'));
      assert.equal(await page.locator('#content').inputValue(),'HELLO 123');
      await page.locator('[data-panel=settings]').click();
      const paper=page.locator('[data-select-id=paper]');
      await paper.click();await assertSquareUI(page);await page.getByRole('option',{name:'A5',exact:true}).click();
      assert.equal(await page.locator('#paper').inputValue(),'a5');
      await paper.focus();await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
      assert.equal(await page.locator('#paper').inputValue(),'a4');
      const font=page.locator('[data-select-id=orientation]');
      await font.click();await page.keyboard.press('Escape');assert.equal(await font.getAttribute('aria-expanded'),'false');
      assert(await page.locator('#settings-section').isVisible()); // Escape closed the menu, not the drawer.
      if(width<=900) await page.locator('#sidebar-backdrop').click({position:{x:width-52,y:20}});
      await page.locator('#preview-tab').click();
      assert(await page.locator('.paper-stage').evaluate(el=>el.scrollWidth<=el.clientWidth),`${width}: default paper preview scrolls horizontally`);
      await page.locator('[data-panel=machine]').click();
      assert.equal(await page.locator('#position-x').textContent(),'—');
      assert(await page.locator('#zero-xy').isDisabled());
      assert(await page.locator('[data-select-id=coordinate-wcs]').isDisabled());
      await assertSquareUI(page);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      if(width<=900) await page.locator('#sidebar-backdrop').click({position:{x:width-52,y:20}});
      await page.locator('#device-activity').click();
      const baud=page.locator('[data-select-id=baud]');await baud.scrollIntoViewIfNeeded();await baud.click();
      assert((await bounds(page,'.select-menu')).inside,`${width}: modal menu escaped viewport`);
      await assertSquareUI(page);
      await page.getByRole('option',{name:'57600',exact:true}).click();assert.equal(await page.locator('#baud').inputValue(),'57600');
      await baud.click();await page.keyboard.press('Tab');assert.equal(await page.locator('.select-menu').count(),0);
      if(width<=900) await page.locator('#sidebar-backdrop').click({position:{x:width-52,y:20}});
      assert.equal(await page.locator('.select-menu').count(),0);
      const enhanced=await page.evaluate(()=>document.querySelectorAll('select').length===document.querySelectorAll('.select-trigger').length);
      assert(enhanced);
      assert.deepEqual(errors,[]);
      if(process.env.SCREENSHOT_DIR) await page.screenshot({path:`${process.env.SCREENSHOT_DIR}/ui-${width}x${height}.png`});
      console.log(`UI ${width}x${height}: four views, long document picker, uniform menus, keyboard, modal bounds, paper fit passed`);
      await context.close();
    }
    // Real disabled state is mirrored; type-ahead uses the same control implementation.
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const page=await context.newPage();await page.goto(url);await page.locator('#device-activity').click();
    await page.evaluate(()=>{const select=document.querySelector('#serial-port');select.replaceChildren(new Option('USB / 超长串口描述 '.repeat(8),'/fake/only'));});
    const port=page.locator('[data-select-id=serial-port]');await port.scrollIntoViewIfNeeded();await port.click();
    assert((await bounds(page,'.select-menu')).inside);assert(await page.locator('.select-menu').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.keyboard.press('Escape');
    await page.evaluate(()=>document.querySelector('#serial-port').disabled=true);
    await page.waitForFunction(()=>document.querySelector('[data-select-id=serial-port]').disabled);
    await context.close();
    console.log('Touch layout, square corners, long menu labels and disabled-state synchronization passed. No device commands sent.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
