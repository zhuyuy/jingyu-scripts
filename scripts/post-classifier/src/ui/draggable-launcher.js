const POSITION_KEY = 'pc:ui:launcher-position';
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

// A device-local preference, separate from account data and the sync operation log.
export function mountDraggableLauncher(button, storage, onError) {
  const win = button.ownerDocument.defaultView;
  let position = null, drag = null, touched = false, destroyed = false, suppressClick = false;
  let clickTimer, saves = Promise.resolve();
  const listeners = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };
  function bounds() {
    const viewport = win.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width ?? win.innerWidth, height = viewport?.height ?? win.innerHeight;
    const minX = left + 12, minY = top + 12;
    return { minX, minY, maxX: Math.max(minX, left + width - button.offsetWidth - 12),
      maxY: Math.max(minY, top + height - button.offsetHeight - 12) };
  }
  function place(x, y) {
    const b = bounds();
    x = clamp(x, b.minX, b.maxX); y = clamp(y, b.minY, b.maxY);
    Object.assign(button.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    return { x: (x - b.minX) / (b.maxX - b.minX || 1), y: (y - b.minY) / (b.maxY - b.minY || 1) };
  }
  function restore() {
    if (!position || drag) return;
    const b = bounds();
    place(b.minX + position.x * (b.maxX - b.minX), b.minY + position.y * (b.maxY - b.minY));
  }
  function persist() {
    const value = position && { ...position };
    saves = saves.then(() => storage.set(POSITION_KEY, value)).catch(error => {
      if (!destroyed) onError(error);
    });
    return saves;
  }
  function finish(cancelled) {
    if (!drag) return;
    const previous = drag; drag = null;
    button.classList.remove('dragging');
    if (button.hasPointerCapture?.(previous.id)) button.releasePointerCapture(previous.id);
    if (!previous.moved) return;
    suppressClick = true;
    win.clearTimeout(clickTimer);
    clickTimer = win.setTimeout(() => { suppressClick = false; }, 500);
    if (cancelled) {
      if (position) restore();
      else for (const name of ['left', 'top', 'right', 'bottom']) button.style.removeProperty(name);
    } else {
      const rect = button.getBoundingClientRect();
      position = place(rect.left, rect.top); void persist();
    }
  }
  listen(button, 'pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    touched = true; suppressClick = false; win.clearTimeout(clickTimer);
    const rect = button.getBoundingClientRect();
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture(event.pointerId);
  });
  listen(button, 'pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true; button.classList.add('dragging');
    event.preventDefault(); event.stopPropagation();
    place(drag.left + dx, drag.top + dy);
  });
  listen(button, 'pointerup', event => { if (drag?.id === event.pointerId) finish(false); });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    listen(button, type, event => { if (drag?.id === event.pointerId) finish(true); });
  }
  listen(button, 'click', event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  listen(button, 'keydown', event => {
    if (event.key === 'Escape' && drag) {
      event.preventDefault(); event.stopPropagation(); finish(true); return;
    }
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta || !event.altKey || event.ctrlKey || event.metaKey || drag) return;
    event.preventDefault(); event.stopPropagation(); touched = true;
    const rect = button.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
    position = place(rect.left + delta[0] * step, rect.top + delta[1] * step); void persist();
  });
  listen(win, 'resize', restore);
  if (win.visualViewport) {
    listen(win.visualViewport, 'resize', restore);
    listen(win.visualViewport, 'scroll', restore);
  }
  const ready = Promise.resolve().then(() => storage.get(POSITION_KEY, null)).then(value => {
    if (destroyed || touched || !value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return;
    position = { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) }; restore();
  }).catch(error => { if (!destroyed) onError(error); });
  return {
    ready,
    reset() {
      touched = true; finish(true); position = null;
      for (const name of ['left', 'top', 'right', 'bottom']) button.style.removeProperty(name);
      return persist();
    },
    destroy() { destroyed = true; finish(true); win.clearTimeout(clickTimer); listeners.forEach(remove => remove()); }
  };
}
