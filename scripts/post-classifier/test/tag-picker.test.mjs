import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Store } from '../src/core/store.js';
import { el } from '../src/ui/app.js';
import { mountTagPicker } from '../src/ui/tag-picker.js';

async function fixture(focusSearch = true) {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  globalThis.document = dom.window.document;
  const data = new Map();
  const store = new Store({ async get(k) { return data.get(k); }, async set(k,v) { data.set(k,v); }, async list() { return [...data.keys()]; } });
  await store.load();
  await store.record({ id: 'x:123', url: 'https://x.com/test/status/123', author: '@test', text: 'test post' });
  const ai = await store.category('AI'), tools = await store.category('AI 工具');
  const errors = [], closed = [];
  const picker = mountTagPicker({ el, store, postId: 'x:123', onClose: focus => closed.push(focus), onError: e => errors.push(e), onResize() {} });
  document.body.append(picker.element); picker.focus();
  const input = document.querySelector('input');
  if (focusSearch) input.focus();
  const query = text => { input.value = text; input.dispatchEvent(new dom.window.Event('input')); };
  const key = (key, opts = {}) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles:true, cancelable:true, ...opts }));
  const options = () => [...document.querySelectorAll('[role=option]')];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { dom, store, ai, tools, picker, input, query, key, options, settle, errors, closed, close() { picker.destroy(); dom.window.close(); } };
}
test('suggestions start collapsed and follow search focus without clearing selections', async () => {
  const f = await fixture(false);
  try {
    const suggestions = f.picker.element.querySelector('.picker-suggestions');
    assert.equal(document.activeElement, f.picker.element);
    assert.equal(suggestions.hidden, true);
    assert.equal(f.input.getAttribute('aria-expanded'), 'false');
    assert.equal(f.input.hasAttribute('aria-activedescendant'), false);
    f.input.focus();
    assert.equal(suggestions.hidden, false);
    assert.equal(f.input.getAttribute('aria-expanded'), 'true');
    f.key('Enter'); await f.settle();
    assert.equal(suggestions.hidden, false);
    f.picker.focus();
    assert.equal(suggestions.hidden, true);
    assert.equal(f.input.hasAttribute('aria-activedescendant'), false);
    assert.equal(f.store.state.posts.get('x:123').categories.length, 1);
    f.input.focus();
    assert.equal(suggestions.hidden, false);
    assert.equal(f.options().filter(n => n.getAttribute('aria-selected') === 'true').length, 1);
  } finally { f.close(); }
});

test('search, exact match and first-row creation; Enter creates once then toggles', async () => {
  const f = await fixture();
  try {
    f.query(' ai '); assert.equal(f.options().length,2); assert.ok(f.options().every(n => !n.textContent.includes('创建标签')));
    f.query('ＡＩ'); assert.ok(f.options().every(n => !n.textContent.includes('创建标签')));
    f.query('AI 新工具'); assert.equal(f.options()[0].getAttribute('aria-label'),'创建标签 AI 新工具');
    f.key('Enter'); await f.settle();
    const created = [...f.store.state.categories.values()].find(c => c.name === 'AI 新工具');
    assert.ok(created); assert.deepEqual(f.store.state.posts.get('x:123').categories,[created.id]);
    assert.equal(f.options()[0].getAttribute('aria-selected'),'true');
    f.key('Enter'); await f.settle(); assert.deepEqual(f.store.state.posts.get('x:123').categories,[]);
    assert.equal(f.store.state.categories.size,3); assert.equal(f.errors.length,0);
    assert.equal(f.picker.element.querySelectorAll('button').length,0);
  } finally { f.close(); }
});
test('arrow navigation never changes selection; Enter toggles active row and preserves multi-select', async () => {
  const f = await fixture();
  try {
    const first = f.input.getAttribute('aria-activedescendant');
    f.key('ArrowDown'); assert.notEqual(f.input.getAttribute('aria-activedescendant'),first);
    assert.deepEqual(f.store.state.posts.get('x:123').categories,[]);
    f.key('Enter'); await f.settle(); assert.equal(f.store.state.posts.get('x:123').categories.length,1);
    f.key('ArrowUp'); f.key('Enter'); await f.settle(); assert.equal(f.store.state.posts.get('x:123').categories.length,2);
    f.key('Enter'); await f.settle(); assert.equal(f.store.state.posts.get('x:123').categories.length,1);
    f.key('Escape'); assert.deepEqual(f.closed,[true]);
  } finally { f.close(); }
});

test('selected chip remove saves only this association and keeps the list collapsed', async () => {
  const f = await fixture();
  try {
    f.options().find(n => n.getAttribute('aria-label') === 'AI').click(); await f.settle();
    f.options().find(n => n.getAttribute('aria-label') === 'AI 工具').click(); await f.settle();
    await f.store.record({ id: 'x:456', url: 'https://x.com/test/status/456', author: '@test', text: 'another post' });
    await f.store.tag('x:456', f.ai, true);
    f.picker.focus();
    const remove = f.picker.element.querySelector('[aria-label="移除标签 AI"]');
    remove.focus(); remove.click(); await f.settle();
    assert.deepEqual(f.store.state.posts.get('x:123').categories, [f.tools]);
    assert.deepEqual(f.store.state.posts.get('x:456').categories, [f.ai]);
    assert.ok(f.store.state.categories.get(f.ai));
    assert.equal(f.picker.element.querySelector('[aria-label="移除标签 AI"]'), null);
    assert.equal(f.picker.element.querySelector('.picker-suggestions').hidden, true);
    assert.equal(document.activeElement, f.picker.element);
    await f.store.load();
    assert.deepEqual(f.store.state.posts.get('x:123').categories, [f.tools]);
    f.store.tag = async () => { throw new Error('disk full'); };
    f.picker.element.querySelector('.tag-remove').click(); await f.settle();
    assert.equal(f.picker.element.querySelectorAll('.tag-remove').length, 1);
    assert.equal(f.picker.element.querySelector('[role=status]').textContent, '保存失败');
  } finally { f.close(); }
});
test('IME confirmation does not create a category; failed save is not reported as selected', async () => {
  const f = await fixture();
  try {
    f.query('中文'); f.key('Enter',{isComposing:true}); await f.settle(); assert.equal(f.store.state.categories.size,2);
    f.input.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart'));
    f.key('Enter'); await f.settle(); assert.equal(f.store.state.categories.size,2);
    f.input.dispatchEvent(new f.dom.window.CompositionEvent('compositionend'));
    f.query('AI'); f.store.tag = async () => { throw new Error('disk full'); };
    f.options()[0].click(); await f.settle();
    assert.equal(f.errors.length,1); assert.equal(f.options()[0].getAttribute('aria-selected'),'false');
    assert.equal(f.picker.element.querySelector('[role=status]').textContent,'保存失败');
  } finally { f.close(); }
});
