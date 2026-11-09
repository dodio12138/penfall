'use strict';
// Pen origin: generated programs follow origin / text changes; manual programs are flagged and never sent stale.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const url=process.env.TEST_URL||'http://127.0.0.1:5173';
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  try {
    const page=await (await browser.newContext({viewport:{width:1280,height:800}})).newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);
    const set=(id,value)=>page.evaluate(([id,value])=>{const field=document.querySelector(`#${id}`);field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));},[id,value]);
    const firstMove=()=>page.evaluate(()=>document.querySelector('#gcode').value.split('\n').find(line=>/^G0 X/.test(line)));
    await page.locator('#content').fill('HI');
    await page.locator('#gcode-tab').click();
    await page.locator('#generate-code').click();
    assert.equal(await firstMove(),'G0 X20 Y277');
    // Pen zero 1 mm inside the top-left corner, +Y towards the bottom of the page: code follows automatically.
    await set('origin-corner','top-left');await set('origin-x','1');await set('origin-y','1');await set('y-dir','-1');
    await page.waitForFunction(()=>document.querySelector('#gcode').value.includes('G0 X19 Y19'));
    assert.equal(await firstMove(),'G0 X19 Y19');
    await page.locator('#path-tab').click();
    assert(await page.locator('#path-stale').isHidden());
    // Text edits regenerate too.
    await page.locator('#edit-tab').click();
    await page.locator('#content').fill('HIHI');
    await page.waitForFunction(()=>(document.querySelector('#gcode').value.match(/G1 Z0/g)||[]).length>8);
    // A hand-edited program is never rewritten: it becomes stale and is flagged on the toolpath.
    await page.locator('#gcode-tab').click();
    await page.locator('#gcode').press('End');await page.locator('#gcode').type(' ');
    await set('origin-x','5');
    await page.waitForTimeout(500);
    assert.equal(await firstMove(),'G0 X19 Y19');
    await page.locator('#path-tab').click();
    assert(await page.locator('#path-stale').isVisible());
    await page.locator('#path-regenerate').click();
    assert.equal(await firstMove(),'G0 X15 Y19');
    assert(await page.locator('#path-stale').isHidden());
    // Unsupported text keeps the old program but marks it stale instead of silently dropping characters.
    await page.locator('#edit-tab').click();
    await page.locator('#content').fill('龘'); // not in any enabled library
    await page.waitForFunction(()=>document.querySelector('#code-state').textContent.includes('无法自动更新'));
    assert.deepEqual(errors,[]);
    console.log('Origin checks passed: auto-regenerate on origin / text changes, manual programs flagged stale, unsupported text keeps stale flag.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
