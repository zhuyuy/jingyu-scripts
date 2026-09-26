import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { materialize, makeOperation, validOperation } from '../src/core/model.js';
import { synchronize, allowedServer } from '../src/core/sync.js';
const memory = () => { const data = new Map(); return { async get(k,d) { return data.has(k) ? structuredClone(data.get(k)) : d; }, async set(k,v) { data.set(k, structuredClone(v)); }, async list() { return [...data.keys()]; }, async remove(k) { data.delete(k); } }; };
const post = { id:'x:123', url:'https://x.com/a/status/123', author:'@a', text:'hello' };
test('multi-category survives independent like/bookmark updates and refresh', async () => {
  const api = memory(), a = new Store(api); await a.load(); await a.record(post);
  const ai = await a.category('AI'), read = await a.category('待阅读');
  await a.tag(post.id, ai, true); await a.tag(post.id, read, true);
  await a.put('post',post.id,'liked',true); await a.put('post',post.id,'bookmarked',true); await a.put('post',post.id,'liked',false);
  const b = new Store(api); await b.load(); assert.deepEqual(b.state.posts.get(post.id).categories.sort(), [ai,read].sort());
  assert.equal(b.state.posts.get(post.id).bookmarked,true); assert.equal(b.state.posts.get(post.id).liked,false);
});
test('simultaneous tabs append without lost updates, account namespaces are isolated', async () => {
  const api=memory(), a=new Store(api,'one'), b=new Store(api,'one'), other=new Store(api,'two');
  await Promise.all([a.load(),b.load(),other.load()]);
  await Promise.all([a.put('post',post.id,'liked',true),b.put('post',post.id,'bookmarked',true)]);
  await a.load(); assert.equal(a.ops.length,2); assert.equal(a.state.posts.get(post.id).bookmarked,true);
  assert.equal((await other.load()).posts.size,0);
});
test('deterministic merge keeps independent tag changes and deletion tombstones', () => {
  const cat=crypto.randomUUID();
  const ops=[makeOperation('category',cat,'name','AI',1),makeOperation('tag',post.id+'|'+cat,'present',true,2),makeOperation('post',post.id,'meta',post,3),makeOperation('tag',post.id+'|'+cat,'present',false,4),makeOperation('post',post.id,'deleted',true,5)];
  assert.deepEqual(materialize(ops),materialize([...ops].reverse()));
  assert.deepEqual(materialize(ops).posts.get(post.id).categories,[]); assert.equal(materialize(ops).posts.get(post.id).deleted,true);
});
test('interrupted upload is retried idempotently, cursor persists only after local save', async () => {
  const api=memory(), store=new Store(api,'one'); await store.load(); await store.record(post);
  const remote=new Map(); let fail=true;
  api.request=async opts=>{const body=JSON.parse(opts.data); if(opts.url.endsWith('push')) { for(const op of body.operations) remote.set(op.id,op); if(fail) { fail=false; throw new Error('offline'); } return {ok:true}; } return {operations:[...remote.values()],cursor:1,more:false};};
  const account={server:'https://tools.jingyu.dev',token:'test'};
  await assert.rejects(()=>synchronize(api,store,account),/offline/); assert.equal((await store.pending()).length,1);
  await synchronize(api,store,account); assert.equal(remote.size,1); assert.equal((await store.pending()).length,0);
  assert.equal(await api.get(store.prefix()+'cursor'),1);
});
test('export excludes credentials and invalid imports are atomic', async()=>{
  const api=memory(), store=new Store(api); await store.load(); await store.record(post); await api.set('pc:account',{token:'secret'});
  assert.ok(!JSON.stringify(store.export()).includes('secret'));
  await assert.rejects(()=>store.import({...store.export(),operations:[...store.ops,{invalid:true}]}));
  assert.equal((await store.load()).posts.size,1);
  assert.equal(validOperation({...store.ops[0],value:{url:'javascript:alert(1)',author:'x',text:''}}),false);
  assert.equal(allowedServer('https://evil.example'),null); assert.equal(allowedServer('http://127.0.0.1:8787'),'http://127.0.0.1:8787');
});
