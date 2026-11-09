'use strict';
// Browser-only API emulator. All /api requests are intercepted; no USB access.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const url=process.env.TEST_URL||'http://127.0.0.1:5173';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  try {
    for(const width of [1280,390]) {
      const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage(),errors=[],requests=[];
      let revision=1,offline=false,rejectWcs=false,delayAction=false;
      const coordinates={source:'controller',units:'mm',machineState:'Idle',ageMs:0,fresh:true,ready:true,idle:true,reason:'',mpos:[-100,-150,-5],wpos:[10,20,5],wco:[-110,-170,-10],wcs:'G54',token:'token-1',frameToken:'frame-1',operation:null};
      const state={connected:false,portOpen:false,state:'disconnected',ack:0,total:0,message:'未连接',port:'test-only',job_id:'',coordinates:null};
      function changed(){revision++;coordinates.token=`token-${revision}`;coordinates.frameToken=`frame-${revision}`;}
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/api/**',async route=>{
        const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON();
        requests.push({path,body});
        if(offline)return route.abort('failed');
        const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        if(path==='/api/ports')return reply({ports:[{path:'/test/serial',name:'Test-only controller'}]});
        if(path==='/api/connect'){Object.assign(state,{connected:true,portOpen:true,state:'idle',message:'Test controller',coordinates});return reply(state);}
        if(path==='/api/disconnect'){Object.assign(state,{connected:false,portOpen:false,state:'disconnected',coordinates:null});return reply(state);}
        if(path==='/api/status')return reply(state);
        if(path==='/api/coordinates/refresh')return reply(state);
        if(path.startsWith('/api/coordinates/')){
          assert.equal(body.expected,coordinates.token);assert.equal(body.reviewed,true);
          if(delayAction)await sleep(700);
          if(path.endsWith('/wcs')){
            if(rejectWcs){rejectWcs=false;return reply({error:'test rejection',status:state},400);}
            coordinates.wcs=body.wcs;coordinates.wco=[-80,-100,-10];
            coordinates.wpos=coordinates.mpos.map((v,i)=>v-coordinates.wco[i]);
          } else {
            assert(['X','Y','XY'].includes(body.axes));
            for(const axis of body.axes){const i='XYZ'.indexOf(axis);coordinates.wco[i]=coordinates.mpos[i];coordinates.wpos[i]=0;}
          }
          changed();return reply(state);
        }
        if(path==='/api/job'){
          assert.equal(body.expected,coordinates.token);
          assert.deepEqual(body.machine,{xmin:-300,xmax:0,ymin:-300,ymax:0,zmin:-30,zmax:0});
          Object.assign(state,{state:'complete',job_id:'test-job',message:'Test Idle',ack:body.lines.length,total:body.lines.length});
          return reply(state);
        }
        throw Error(`Unexpected endpoint ${path}`);
      });
      await page.goto(url);
      await page.locator('[data-panel=coordinates]').click();
      assert.equal(await page.locator('#position-x').textContent(),'—');
      assert(await page.locator('#zero-xy').isDisabled());
      if(width<=900)await page.locator('#sidebar-backdrop').click({position:{x:width-52,y:20}});
      await page.locator('#device-activity').click();
      await page.locator('#bridge-key').fill('test-only-key');
      await page.locator('#refresh-ports').click();
      await page.locator('#protocol-confirm').check();
      await page.locator('#serial-connect').click();
      await page.waitForFunction(()=>document.querySelector('#device-status').textContent.startsWith('已连接'));
      await page.locator('#connection-dialog .dialog-heading button').click();
      await page.locator('[data-panel=coordinates]').click();
      assert.equal(await page.locator('#position-x').textContent(),'10.000');
      assert.equal(await page.locator('#position-z').textContent(),'5.000');
      await page.locator('#frame-machine').click();
      assert.equal(await page.locator('#position-x').textContent(),'-100.000');
      assert.equal(requests.filter(r=>r.path.includes('/coordinates/')).length,0,'Display switch must not write to controller');
      await page.locator('#frame-work').click();
      await page.locator('[data-select-id=coordinate-wcs]').click();
      await page.getByRole('option',{name:'G55',exact:true}).click();
      await page.locator('#action-dialog').waitFor({state:'visible'});
      assert.equal(await page.locator('#coordinate-wcs').inputValue(),'G54','Do not optimistically claim new WCS');
      await page.locator('#action-accept').click();
      await page.waitForFunction(()=>document.querySelector('#coordinate-wcs').value==='G55');
      assert.equal(await page.locator('#position-x').textContent(),'-20.000');
      delayAction=true;
      await page.locator('#zero-xy').click();await page.locator('#action-accept').click();
      await page.waitForFunction(()=>document.querySelector('#zero-xy').disabled);
      assert(await page.locator('#new-document').isDisabled());
      await page.waitForFunction(()=>document.querySelector('#position-x').textContent==='0.000');
      assert.equal(await page.locator('#position-y').textContent(),'0.000');
      assert.equal(await page.locator('#position-z').textContent(),'5.000');
      assert.deepEqual(coordinates.mpos,[-100,-150,-5]);
      delayAction=false;rejectWcs=true;
      await page.locator('[data-select-id=coordinate-wcs]').click();await page.getByRole('option',{name:'G56',exact:true}).click();
      await page.locator('#action-accept').click();
      await page.waitForFunction(()=>document.querySelector('#coordinate-reason').textContent.includes('test rejection'));
      assert.equal(await page.locator('#coordinate-wcs').inputValue(),'G55');
      await page.locator('#refresh-coordinates').click();
      await page.waitForFunction(()=>!document.querySelector('#zero-xy').disabled);
      offline=true;
      await page.waitForFunction(()=>document.querySelector('#position-x').textContent==='—');
      assert(await page.locator('#zero-x').isDisabled());
      assert(await page.locator('[data-select-id=coordinate-wcs]').isDisabled());
      assert(await page.locator('#send-job').isDisabled());
      offline=false;
      await page.waitForFunction(()=>document.querySelector('#position-x').textContent==='0.000');
      // Sending requires a real current coordinate token and explicitly entered machine bounds.
      if(width<=900)await page.locator('#sidebar-backdrop').click({position:{x:width-52,y:20}});
      await page.locator('#device-activity').click();
      for(const [axis,low,high] of [['x',-300,0],['y',-300,0],['z',-30,0]])for(const [bound,value] of [['min',low],['max',high]])await page.locator(`#travel-${axis}-${bound}`).fill(String(value));
      await page.locator('#safety-confirm').check();
      await page.locator('#connection-dialog .dialog-heading button').click();
      await page.evaluate(()=>{document.querySelector('#gcode').value='G21\nG90\nG0 Z5\nG0 X10 Y10\nG1 X20 Y20 F500';parseProgram();selectView('gcode');});
      await page.locator('#send-job').click();await page.locator('#action-accept').click();
      await page.waitForFunction(()=>document.querySelector('#task-state').textContent==='设备已 Idle');
      assert.equal(requests.filter(r=>r.path==='/api/job').length,1);
      assert(!requests.some(r=>r.path==='/api/home'||r.body?.axes?.includes('Z')));
      assert.deepEqual(errors,[]);
      if(process.env.SCREENSHOT_DIR){await page.locator('[data-panel=coordinates]').click();await page.screenshot({path:`${process.env.SCREENSHOT_DIR}/coordinates-${width}.png`});}
      console.log(`Coordinates ${width}px: unknown/read-only display, real-source updates, WCS confirmation/readback, XY zero, Z preservation, busy locks, rejected writes, network loss and bound job submission passed (API emulator only).`);
      await context.close();
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
