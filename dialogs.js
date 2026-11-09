'use strict';
// One page-owned dialog for text entry and confirmations; never browser prompt/confirm.
(() => {
  const dialog=document.querySelector('#action-dialog');
  const input=document.querySelector('#action-name');
  const error=document.querySelector('#action-error');
  const accept=document.querySelector('#action-accept');
  const pending=[];
  let current=null;
  function next() {
    if(current||!pending.length)return;
    current=pending.shift();
    const options=current.options;
    dialog.returnValue='';
    document.querySelector('#action-title').textContent=options.title;
    const message=document.querySelector('#action-message');
    message.textContent=options.message||'';message.hidden=!options.message;
    document.querySelector('#action-field').hidden=current.mode!=='text';
    input.value=options.value||'';input.removeAttribute('aria-invalid');
    error.hidden=true;error.textContent='';
    accept.textContent=options.confirmLabel||'确定';
    accept.classList.toggle('danger-button',Boolean(options.danger));
    accept.classList.toggle('primary',!options.danger);
    dialog.showModal();
    if(current.mode==='text') {
      input.focus();
      const dot=input.value.lastIndexOf('.');input.setSelectionRange(0,dot>0?dot:input.value.length);
    } else document.querySelector('#action-cancel').focus();
  }
  function request(mode,options) {
    return new Promise(resolve=>{pending.push({mode,options,resolve});next();});
  }
  document.querySelector('#action-form').addEventListener('submit',event=>{
    event.preventDefault();
    if(!current)return;
    if(current.mode==='text') {
      const value=input.value.trim();
      const issue=!value?'请输入名称':(/[\\/\u0000-\u001f]/.test(value)?'名称不能包含斜杠或控制字符':'');
      if(issue){error.textContent=issue;error.hidden=false;input.setAttribute('aria-invalid','true');input.focus();return;}
    }
    dialog.close('accept');
  });
  document.querySelector('#action-cancel').addEventListener('click',()=>dialog.close('cancel'));
  input.addEventListener('input',()=>{input.removeAttribute('aria-invalid');error.hidden=true;});
  dialog.addEventListener('close',()=>{
    if(!current)return;
    const action=current;current=null;
    action.resolve(dialog.returnValue==='accept'?(action.mode==='text'?input.value.trim():true):(action.mode==='text'?null:false));
    queueMicrotask(next);
  });
  window.AppDialogs={askText:options=>request('text',options),confirm:options=>request('confirm',options)};
})();
