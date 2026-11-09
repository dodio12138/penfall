'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Store,KEY,normalize,ConflictError} = require('../workspace-store.js');
const sample = () => ({version:3,revision:'',documents:[{id:'a',name:'first.txt',title:'First',content:'正文',gcode:'G21\nG90',settings:{paper:'a4'},motion:{feed:'900'},programDirty:true,view:'gcode',updatedAt:'2026-01-01'}],openIds:['a'],activeId:'a'});
const memory = () => { const values=new Map(); return {getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,value)}; };
test('documents, settings, G-code, tabs, and dirty marker round-trip',()=>{
 const storage=memory(), store=new Store(storage), data=sample();
 assert.equal(store.load(),null);store.write(data);
 const restored=new Store(storage).load();
 assert.equal(restored.documents[0].content,'正文');assert.equal(restored.documents[0].motion.feed,'900');assert(restored.documents[0].programDirty);assert.equal(restored.activeId,'a');assert.equal(restored.revision,data.revision);
});
test('two tabs cannot silently overwrite the newer revision',()=>{
 const storage=memory(), first=new Store(storage);first.load();first.write(sample());
 const second=new Store(storage);const next=second.load();first.write(first.load());
 assert.throws(()=>second.write(next),ConflictError);
 second.load();assert.doesNotThrow(()=>second.write(next));
});
test('bad JSON or schema is not overwritten during a write',()=>{
 const storage=memory();storage.setItem(KEY,'{bad');const store=new Store(storage);
 assert.throws(()=>store.load());assert.throws(()=>store.write(sample()));assert.equal(storage.getItem(KEY),'{bad');
});
test('quota failure does not advance revision or claim persisted data',()=>{
 const storage=memory(), store=new Store(storage);store.load();store.write(sample());
 const before=store.revision, raw=storage.getItem(KEY);
 storage.setItem=()=>{throw Error('QuotaExceededError');};
 assert.throws(()=>store.write(sample()),/Quota/);assert.equal(store.revision,before);assert.equal(storage.getItem(KEY),raw);
});
test('invalid backups, duplicate IDs, paths and oversize programs rejected',()=>{
 assert.throws(()=>normalize({version:2,documents:[]}));
 const duplicate=sample();duplicate.documents.push({...duplicate.documents[0]});assert.throws(()=>normalize(duplicate),/重复/);
 const badName=sample();badName.documents[0].name='../path.txt';assert.throws(()=>normalize(badName),/名称/);
 const huge=sample();huge.documents[0].gcode='A'.repeat(500001);assert.throws(()=>normalize(huge),/500000/);
});
test('closed tabs retain documents and broken tab references are removed',()=>{
 const data=sample();data.activeId=null;data.openIds=['missing'];const clean=normalize(data);
 assert.equal(clean.documents.length,1);assert.deepEqual(clean.openIds,[]);assert.equal(clean.activeId,null);
});
