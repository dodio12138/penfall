'use strict';
(() => {
  const bindings = new Map();
  let opened = null, serial = 0, typeBuffer = '', typeTimer;
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('ui-icon'); svg.setAttribute('aria-hidden','true');
    const use = document.createElementNS(svg.namespaceURI,'use'); use.setAttribute('href',`#icon-${name}`); svg.append(use);
    return svg;
  };
  function closeMenu(restoreFocus = false) {
    if (!opened) return;
    const { trigger, menu } = opened;
    trigger.setAttribute('aria-expanded','false'); trigger.removeAttribute('aria-activedescendant'); menu.remove();
    opened = null; typeBuffer = ''; clearTimeout(typeTimer);
    if (restoreFocus && !trigger.disabled) trigger.focus();
  }
  function enabled(source, index) {
    const option = source.options[index];
    return option && !option.disabled && !option.parentElement.disabled;
  }
  function positionMenu() {
    if (!opened) return;
    const { trigger, menu } = opened;
    const rect = trigger.getBoundingClientRect();
    if (!trigger.getClientRects().length || rect.bottom < 0 || rect.top > innerHeight) { closeMenu(); return; }
    const width = Math.min(innerWidth - 16, Math.max(150, Math.min(360, rect.width)));
    const below = innerHeight - rect.bottom - 8, above = rect.top - 8;
    const desired = Math.min(280, menu.scrollHeight);
    const flip = below < desired && above > below;
    const height = Math.max(32, Math.min(280, flip ? above : below));
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${height}px`;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left))}px`;
    menu.style.top = `${flip ? Math.max(8, rect.top - Math.min(height,menu.scrollHeight) - 4) : rect.bottom + 4}px`;
  }
  function focusOption(index) {
    if (!opened || !enabled(opened.source,index)) return;
    opened.index = index;
    const rows = opened.menu.querySelectorAll('[role=option]');
    rows.forEach(row => row.classList.toggle('focused',Number(row.dataset.index) === index));
    const row = [...rows].find(item => Number(item.dataset.index) === index);
    if (row) {
      opened.trigger.setAttribute('aria-activedescendant',row.id);
      if (row.offsetTop < opened.menu.scrollTop) opened.menu.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > opened.menu.scrollTop + opened.menu.clientHeight) opened.menu.scrollTop = row.offsetTop + row.offsetHeight - opened.menu.clientHeight;
    }
  }
  function choose(index) {
    if (!opened || !enabled(opened.source,index)) return;
    const { source, trigger } = opened;
    const changed = source.selectedIndex !== index;
    source.selectedIndex = index;
    closeMenu();
    sync(source); trigger.focus();
    if (changed) { source.dispatchEvent(new Event('input',{bubbles:true})); source.dispatchEvent(new Event('change',{bubbles:true})); }
  }
  function buildOptions() {
    if (!opened) return;
    const { source, menu, id } = opened;
    menu.replaceChildren();
    [...source.options].forEach((option,index) => {
      const row = document.createElement('div'); row.className='select-option'; row.setAttribute('role','option'); row.id=`${id}-option-${index}`; row.dataset.index=String(index);
      row.setAttribute('aria-selected',String(index===source.selectedIndex)); row.setAttribute('aria-disabled',String(!enabled(source,index)));
      const text = document.createElement('span'); text.textContent=option.label; row.title=option.label;
      row.append(icon('check'),text);
      row.addEventListener('pointermove',() => focusOption(index));
      row.addEventListener('pointerdown',event => event.preventDefault());
      row.addEventListener('click',() => choose(index)); menu.append(row);
    });
  }
  function openMenu(binding) {
    if (binding.trigger.disabled) return;
    closeMenu();
    const menu=document.createElement('div'); menu.className='select-menu'; menu.id=binding.id; menu.setAttribute('role','listbox'); menu.setAttribute('aria-label',binding.trigger.getAttribute('aria-label'));
    opened={...binding,menu,index:binding.source.selectedIndex};
    const dialog=binding.trigger.closest('dialog'); (dialog || document.body).append(menu);
    binding.trigger.setAttribute('aria-expanded','true');
    buildOptions(); positionMenu();
    const index=enabled(binding.source,binding.source.selectedIndex) ? binding.source.selectedIndex : [...binding.source.options].findIndex((_,i)=>enabled(binding.source,i));
    focusOption(index);
  }
  function stepOption(delta) {
    if (!opened) return;
    const { source, index }=opened, count=source.options.length;
    for(let distance=1;distance<=count;distance++) { const next=(index+delta*distance+count)%count; if(enabled(source,next)) {focusOption(next);return;} }
  }
  function sync(source) {
    const binding=bindings.get(source); if(!binding)return;
    binding.value.textContent=source.selectedOptions[0]?.label || '暂无选项';
    binding.trigger.title=binding.value.textContent;
    binding.trigger.disabled=source.disabled || ![...source.options].some((_,index)=>enabled(source,index));
    if(opened?.source===source) {
      if(binding.trigger.disabled) closeMenu();
      else {buildOptions();positionMenu();focusOption(source.selectedIndex);}
    }
  }
  function enhance(source) {
    if(bindings.has(source))return;
    const wrapper=document.createElement('span'); wrapper.className='ui-select';
    const trigger=document.createElement('button'); trigger.type='button'; trigger.className='select-trigger'; trigger.setAttribute('role','combobox'); trigger.setAttribute('aria-haspopup','listbox'); trigger.setAttribute('aria-expanded','false');
    const label=source.labels?.[0];
    const name=source.getAttribute('aria-label') || (label ? [...label.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim() : '') || '选择';
    trigger.setAttribute('aria-label',name);
    const value=document.createElement('span'); value.className='select-value'; trigger.append(value,icon('chevron'));
    const id=`select-menu-${++serial}`; trigger.setAttribute('aria-controls',id); trigger.dataset.selectId=source.id;
    const binding={source,trigger,value,id}; bindings.set(source,binding);
    source.before(wrapper);wrapper.append(source,trigger);source.classList.add('select-source');source.tabIndex=-1;source.setAttribute('aria-hidden','true');
    trigger.addEventListener('click',()=>opened?.source===source ? closeMenu() : openMenu(binding));
    trigger.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      const isOpen=opened?.source===source;
      if(['ArrowDown','ArrowUp'].includes(event.key)) {
        event.preventDefault(); if(!isOpen)openMenu(binding); stepOption(event.key==='ArrowDown'?1:-1);
      } else if(['Enter',' '].includes(event.key)) {
        event.preventDefault(); if(isOpen)choose(opened.index);else openMenu(binding);
      } else if(event.key==='Escape'&&isOpen) {event.preventDefault();event.stopPropagation();closeMenu(true);}
      else if(event.key==='Tab')closeMenu();
      else if(['Home','End'].includes(event.key)&&isOpen) {
        event.preventDefault(); const indexes=[...source.options].map((_,i)=>i).filter(i=>enabled(source,i));focusOption(event.key==='Home'?indexes[0]:indexes.at(-1));
      } else if(event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey) {
        event.preventDefault();if(!isOpen)openMenu(binding);typeBuffer+=event.key.toLocaleLowerCase();clearTimeout(typeTimer);typeTimer=setTimeout(()=>{typeBuffer='';},700);
        const index=[...source.options].findIndex((option,i)=>enabled(source,i)&&option.label.toLocaleLowerCase().startsWith(typeBuffer));if(index>=0)focusOption(index);
      }
    });
    source.addEventListener('input',()=>sync(source));source.addEventListener('change',()=>sync(source));
    new MutationObserver(()=>sync(source)).observe(source,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','label','value']});
    label?.addEventListener('click',event=>{if(event.target===label){event.preventDefault();trigger.focus();}});
    sync(source);
  }
  document.querySelectorAll('select').forEach(enhance);
  document.addEventListener('pointerdown',event=>{if(opened&&!opened.trigger.contains(event.target)&&!opened.menu.contains(event.target))closeMenu();});
  document.addEventListener('focusin',event=>{if(opened&&!opened.trigger.contains(event.target)&&!opened.menu.contains(event.target))closeMenu();});
  document.addEventListener('close',()=>closeMenu(),true);
  document.addEventListener('scroll',event=>{if(opened&&!opened.menu.contains(event.target))positionMenu();},true);
  window.addEventListener('resize',positionMenu);
  window.visualViewport?.addEventListener('resize',positionMenu);
  window.addEventListener('workspace-view',()=>{closeMenu();bindings.forEach((_,source)=>sync(source));});

  // No horizontal tab scrollbar: compact layouts use a full document picker.
  let tabsFrame=0;
  function updateTabs() {
    cancelAnimationFrame(tabsFrame);
    tabsFrame=requestAnimationFrame(()=>{
      const bar=$('.tabbar'),tabs=$('#document-tabs');
      const intrinsic=[...tabs.children].reduce((width,tab)=>width+tab.getBoundingClientRect().width,0);
      const actions=['save-document','save-indicator','export'].reduce((width,id)=>width+$(`#${id}`).getBoundingClientRect().width,0)+36;
      bar.classList.toggle('has-tab-overflow',intrinsic>bar.clientWidth-actions);
      const selected=tabs.querySelector('.active');
      if(selected&&tabs.clientWidth){const left=selected.offsetLeft-tabs.offsetLeft;if(left<tabs.scrollLeft)tabs.scrollLeft=left;else if(left+selected.offsetWidth>tabs.scrollLeft+tabs.clientWidth)tabs.scrollLeft=left+selected.offsetWidth-tabs.clientWidth;}
    });
  }
  new ResizeObserver(updateTabs).observe($('.tabbar'));
  new MutationObserver(updateTabs).observe($('#document-tabs'),{childList:true});
  updateTabs();

  const compact=matchMedia('(max-width: 900px)');
  compact.addEventListener('change',event=>{document.body.classList.toggle('sidebar-hidden',event.matches);closeMenu();});
  $('#sidebar-backdrop').addEventListener('click',()=>document.body.classList.add('sidebar-hidden'));
  const sidebarState=()=>{
    const hidden=document.body.classList.contains('sidebar-hidden');$('#sidebar-toggle').setAttribute('aria-expanded',String(!hidden));
    if(opened&&!opened.trigger.getClientRects().length)closeMenu();
  };
  new MutationObserver(sidebarState).observe(document.body,{attributes:true,attributeFilter:['class']});sidebarState();
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!opened&&compact.matches&&!document.body.classList.contains('sidebar-hidden')&&!event.target.closest('dialog')){document.body.classList.add('sidebar-hidden');$('#sidebar-toggle').focus();}});
  // Collapse real log state on first compact load, rather than hiding an expanded panel with CSS.
  if(innerWidth<=600||innerHeight<=500){$('#log').hidden=true;$('#log-resizer').hidden=true;$('#log-toggle').setAttribute('aria-expanded','false');$('#log-toggle').classList.remove('selected');}
  new ResizeObserver(()=>{if(!$('#preview-view').hidden&&$('#zoom').value==='fit')renderPreview();}).observe($('.paper-stage'));
})();
