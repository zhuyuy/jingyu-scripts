import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountDraggableLauncher } from '../src/ui/draggable-launcher.js';

async function fixture(data = new Map(), get) {
  const dom = new JSDOM('<button>分类库</button>', { pretendToBeVisual: true });
  const win = dom.window, button = win.document.querySelector('button');
  win.innerWidth = 1000; win.innerHeight = 800;
  Object.defineProperties(button, { offsetWidth: { value: 100 }, offsetHeight: { value: 40 } });
  button.getBoundingClientRect = () => ({ left: parseFloat(button.style.left || '880'), top: parseFloat(button.style.top || '736') });
  let capture, clicks = 0;
  button.setPointerCapture = id => { capture = id; };
  button.hasPointerCapture = id => capture === id;
  button.releasePointerCapture = () => { capture = undefined; };
  button.addEventListener('click', () => clicks++);
  const errors = [], writes = [];
  const storage = { get: get || (async key => data.get(key)), async set(key, value) { data.set(key, value); writes.push(value); } };
  const control = mountDraggableLauncher(button, storage, error => errors.push(error));
  const pointer = (type, x, y, extra = {}) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, ...extra });
    button.dispatchEvent(event);
  };
  const click = (detail = 1) => button.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail }));
  const key = (key, extra = {}) => button.dispatchEvent(new win.KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true, ...extra }));
  return { win, button, control, pointer, click, key, data, storage, writes, errors, clicks: () => clicks,
    settle: () => new Promise(resolve => setImmediate(resolve)), close() { control.destroy(); dom.window.close(); } };
}

test('small pointer jitter opens normally; dragging saves and suppresses only the release click', async () => {
  const f = await fixture(); await f.control.ready;
  try {
    f.pointer('pointerdown', 900, 750); f.pointer('pointermove', 902, 751); f.pointer('pointerup', 902, 751); f.click();
    assert.equal(f.clicks(), 1); assert.equal(f.writes.length, 0);
    f.pointer('pointerdown', 900, 750); f.pointer('pointermove', 250, 180); f.pointer('pointerup', 250, 180); f.click();
    await f.settle();
    assert.equal(f.clicks(), 1); assert.equal(f.writes.length, 1);
    assert.equal(f.button.style.left, '230px'); assert.equal(f.button.style.top, '166px');
    f.click(0); assert.equal(f.clicks(), 2); // Keyboard activation still works.
    f.pointer('pointerdown', 250, 180); f.pointer('pointerup', 250, 180); f.click();
    assert.equal(f.clicks(), 3);
    const reloaded = await fixture(f.data); await reloaded.control.ready;
    assert.equal(reloaded.button.style.left, '230px'); assert.equal(reloaded.button.style.top, '166px'); reloaded.close();
  } finally { f.close(); }
});

test('touch drag is bounded; resize stays visible and reset restores the CSS default', async () => {
  const f = await fixture(); await f.control.ready;
  try {
    f.pointer('pointerdown', 900, 750, { pointerType: 'touch' });
    f.pointer('pointermove', 2000, 3000, { pointerType: 'touch' }); f.pointer('pointerup', 2000, 3000);
    assert.equal(f.button.style.left, '888px'); assert.equal(f.button.style.top, '748px');
    f.win.innerWidth = 320; f.win.innerHeight = 480; f.win.dispatchEvent(new f.win.Event('resize'));
    assert.equal(f.button.style.left, '208px'); assert.equal(f.button.style.top, '428px');
    await f.control.reset();
    assert.equal(f.button.style.left, ''); assert.equal(f.data.get('pc:ui:launcher-position'), null);
  } finally { f.close(); }
});

test('cancel, lost capture and Escape undo unfinished drags; non-primary pointers do not move', async () => {
  const f = await fixture(); await f.control.ready;
  try {
    for (const end of ['pointercancel', 'lostpointercapture', 'Escape']) {
      f.pointer('pointerdown', 900, 750); f.pointer('pointermove', 200, 200);
      if (end === 'Escape') f.key('Escape', { altKey: false }); else f.pointer(end, 200, 200);
      assert.equal(f.button.style.left, ''); assert.equal(f.button.classList.contains('dragging'), false);
    }
    for (const extra of [{ button: 2 }, { isPrimary: false }]) {
      f.pointer('pointerdown', 900, 750, extra); f.pointer('pointermove', 200, 200); f.pointer('pointerup', 200, 200);
      assert.equal(f.button.style.left, '');
    }
    assert.equal(f.writes.length, 0);
  } finally { f.close(); }
});

test('keyboard moves persist in order; delayed preference load cannot undo a user move', async () => {
  let resolveLoad;
  const f = await fixture(new Map(), () => new Promise(resolve => { resolveLoad = resolve; }));
  try {
    await f.settle(); f.key('ArrowLeft'); f.key('ArrowUp', { shiftKey: true });
    resolveLoad({ x: 0, y: 0 }); await f.control.ready; await f.settle();
    assert.equal(f.button.style.left, '870px'); assert.equal(f.button.style.top, '696px');
    assert.equal(f.writes.length, 2);
    f.storage.set = async () => { throw new Error('disk full'); };
    f.key('ArrowLeft'); await f.settle(); assert.equal(f.errors.length, 1);
  } finally { f.close(); }
});
