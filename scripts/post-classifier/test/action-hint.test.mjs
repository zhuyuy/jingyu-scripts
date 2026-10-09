import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountActionHint } from '../src/ui/action-hint.js';

function fixture() {
  const dom = new JSDOM('<button id="anchor">Like</button>', { pretendToBeVisual: true });
  globalThis.document = dom.window.document;
  const win = dom.window, anchor = document.querySelector('button'), opened = [];
  let now = 0, id = 0, valid = true;
  const timers = new Map();
  win.setTimeout = (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.performance.now = () => now;
  anchor.getBoundingClientRect = () => ({ left: 50, right: 90, top: 80, bottom: 110 });
  const hint = mountActionHint({ openPicker: async (...args) => opened.push(args), onError: e => { throw e; } });
  const show = () => hint.show({ post: { id: 'x:1' }, anchor, field: 'liked', valid: () => valid });
  const button = () => document.querySelector('#jingyu-classify-hint')?.shadowRoot.querySelector('button');
  const tick = ms => { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); } };
  return { win, anchor, opened, hint, show, button, tick, invalidate() { valid = false; }, close() { hint.destroy(); dom.window.close(); } };
}
test('hint lasts two seconds without stealing focus; hover pauses the remaining countdown', () => {
  const f = fixture();
  try {
    f.anchor.focus(); f.show(); assert.equal(document.activeElement, f.anchor); assert.equal(f.opened.length, 0);
    f.tick(1999); assert.ok(f.button()); f.tick(1); assert.equal(f.button(), undefined);
    f.show(); f.tick(600); f.button().dispatchEvent(new f.win.Event('pointerenter'));
    f.tick(5000); assert.ok(f.button()); f.button().dispatchEvent(new f.win.Event('pointerleave'));
    f.tick(1399); assert.ok(f.button()); f.tick(1); assert.equal(f.button(), undefined);
  } finally { f.close(); }
});
test('click opens once; cancellation, invalidation and scroll out dismiss the hint', async () => {
  const f = fixture();
  try {
    f.show(); f.button().click(); await Promise.resolve(); assert.equal(f.opened.length, 1); assert.equal(f.button(), undefined);
    f.show(); f.hint.dismiss('x:1', 'bookmarked'); assert.ok(f.button()); f.hint.dismiss('x:1', 'liked'); assert.equal(f.button(), undefined);
    f.show(); f.anchor.getBoundingClientRect = () => ({ left: 50, right: 90, top: -100, bottom: -60 });
    f.win.dispatchEvent(new f.win.Event('scroll')); assert.equal(f.button(), undefined);
    f.anchor.getBoundingClientRect = () => ({ left: 50, right: 90, top: 80, bottom: 110 });
    f.show(); f.invalidate(); f.hint.refresh(); assert.equal(f.button(), undefined);
  } finally { f.close(); }
});
