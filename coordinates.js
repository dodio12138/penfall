'use strict';
(() => {
  let latest=null, received=0, online=false, frame='work', previousFrame=null, previousJob=false, operationError='';
  const states={Idle:'空闲',Run:'运行',Hold:'暂停',Jog:'点动',Alarm:'报警',Door:'门控',Home:'回零',Sleep:'休眠',Check:'检查'};
  function snapshot() {
    if(!latest||!online)return null;
    const age=(latest.ageMs??Infinity)+(performance.now()-received);
    const fresh=latest.fresh&&age<=2500;
    return {...latest,ageMs:age,fresh,ready:latest.ready&&fresh,token:latest.ready&&fresh?latest.token:null,mpos:fresh?latest.mpos:null,wpos:fresh?latest.wpos:null};
  }
  function canSend() {
    const data=snapshot();
    return Boolean(bridgeHealthy&&hardware.connected&&data?.ready&&data.idle&&!controllerBusy()&&!hardwareJob);
  }
  function canMutate() {
    return canSend()&&!['running','paused'].includes(simulation.state);
  }
  function render() {
    const data=snapshot(),position=data?.[frame==='work'?'wpos':'mpos'];
    for(const [i,axis] of [...'xyz'].entries()) {
      const value=position?.[i];
      $(`#position-${axis}`).value=Number.isFinite(value)?(Math.abs(value)<.0005?0:value).toFixed(3):'—';
    }
    $('#frame-work').classList.toggle('selected',frame==='work');
    $('#frame-machine').classList.toggle('selected',frame==='machine');
    $('#frame-work').setAttribute('aria-pressed',String(frame==='work'));
    $('#frame-machine').setAttribute('aria-pressed',String(frame==='machine'));
    $('#coordinate-state').textContent=!data?'—':!data.fresh?'过期':states[data.machineState?.split(':')[0]]||data.machineState||'—';
    $('#coordinate-units').textContent=data?.units||'—';
    const picker=$('#coordinate-wcs');
    const value=data?.wcs||'';
    if(picker.value!==value){picker.value=value;picker.dispatchEvent(new Event('input',{bubbles:true}));}
    picker.disabled=!canMutate();
    for(const id of ['zero-x','zero-y','zero-xy'])$(`#${id}`).disabled=!canMutate();
    $('#refresh-coordinates').disabled=!bridgeHealthy||!hardware.connected||hardwareJob||controllerBusy();
    const reason=coordinateBusy?'正在读回确认…':operationError||(!online?(hardware.portOpen?'数据未知，请重新读取或连接':'连接控制器后读取'):!data?.fresh?'位置未知或已过期':hardwareJob?'':controllerBusy()?'控制器正在同步':!data.ready?data.reason:!data.idle?'控制器非空闲':'');
    $('#coordinate-reason').textContent=reason;
    $('#coordinate-reason').hidden=!reason;
  }
  function machineLimits() {
    const result={};
    for(const axis of 'xyz')for(const bound of ['min','max']) {
      const input=$(`#travel-${axis}-${bound}`);
      if(input.value.trim()===''||!input.checkValidity()||!Number.isFinite(+input.value))return null;
      result[axis+bound]=+input.value;
    }
    return [...'xyz'].every(axis=>result[axis+'min']<result[axis+'max'])?result:null;
  }
  async function run(action,body={},expected) {
    if(coordinateBusy||hardwareJob||!bridgeHealthy||!hardware.connected)return;
    if(expected&&(!canMutate()||snapshot()?.token!==expected)){log('坐标或位置已变化，请重新读取并确认。');return;}
    coordinateBusy=true;operationError='';
    lockEditors(true);refreshSendButton();render();connectionButtons();
    if(action!=='refresh')$('#safety-confirm').checked=false;
    try {
      const result=await api(`coordinates/${action}`,{...body,...(expected?{expected,reviewed:true}:{})});
      applyHardware(result);
    } catch(error) {
      operationError=`上次操作未获确认：${error.message}`;
      if(error.bridgeState)applyHardware(error.bridgeState);
      else bridgeUnavailable(error);
      log(`坐标操作未获确认：${error.message}。未自动重发。`);
    } finally {
      coordinateBusy=false;
      lockEditors(hardwareJob||controllerBusy());refreshSendButton();render();connectionButtons();
    }
  }
  $('#coordinate-wcs').addEventListener('change',async event=>{
    const target=event.target.value,data=snapshot();
    event.target.value=data?.wcs||'';event.target.dispatchEvent(new Event('input',{bubbles:true}));
    if(!canMutate()||target===data.wcs)return;
    if(!await AppDialogs.confirm({title:'切换工件坐标系',message:`切换至 ${target} 将改变后续书写原点，不移动机器。`,confirmLabel:'切换'}))return;
    await run('wcs',{wcs:target},data.token);
  });
  for(const axes of ['X','Y','XY'])$(`#zero-${axes.toLowerCase()}`).addEventListener('click',async()=>{
    if(!canMutate())return;
    const data=snapshot();
    if(!await AppDialogs.confirm({title:`纸张 ${axes} 设零`,message:`将当前位置保存为 ${data.wcs} 的 ${axes} 零点，不修改 Z，不移动机器。`,confirmLabel:'设零',danger:true}))return;
    await run('zero',{axes},data.token);
  });
  $('#refresh-coordinates').addEventListener('click',()=>run('refresh'));
  $('#frame-work').addEventListener('click',()=>{frame='work';render();});
  $('#frame-machine').addEventListener('click',()=>{frame='machine';render();});
  window.addEventListener('bridge-state',event=>{
    const state=event.detail;
    online=Boolean(bridgeHealthy&&state.connected);
    latest=state.coordinates||null;received=performance.now();
    if(previousFrame&&latest?.frameToken!==previousFrame)$('#safety-confirm').checked=false;
    previousFrame=latest?.frameToken||null;
    if(previousJob&&!hardwareJob)$('#safety-confirm').checked=false;
    previousJob=hardwareJob;
    render();refreshSendButton();
  });
  window.addEventListener('bridge-unavailable',()=>{online=false;latest=null;$('#safety-confirm').checked=false;render();});
  for(const axis of 'xyz')for(const bound of ['min','max'])$(`#travel-${axis}-${bound}`).addEventListener('input',()=>{$('#safety-confirm').checked=false;});
  window.Coordinates={snapshot,canSend,machineLimits};
  setInterval(()=>{render();refreshSendButton();},500);
  render();refreshSendButton();
})();
