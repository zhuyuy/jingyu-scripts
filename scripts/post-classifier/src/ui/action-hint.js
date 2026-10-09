// A short-lived invitation; only an explicit click opens the category editor.
export function mountActionHint({ openPicker, onError }) {
  const win = document.defaultView;
  let current = null;
  function hide() {
    if (!current) return;
    win.clearTimeout(current.timer); current.host.remove(); current = null;
  }
  function refresh() {
    if (!current) return;
    const { anchor, valid, host } = current;
    if (!anchor.isConnected || !valid()) return hide();
    const r = anchor.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= win.innerHeight || r.right <= 0 || r.left >= win.innerWidth) return hide();
    host.style.left = Math.max(8, Math.min(r.left, win.innerWidth - host.offsetWidth - 8)) + 'px';
    host.style.top = Math.max(8, r.bottom + host.offsetHeight + 8 <= win.innerHeight ? r.bottom + 6 : r.top - host.offsetHeight - 6) + 'px';
  }
  function show({ post, anchor, field, valid }) {
    hide();
    if (!anchor.isConnected || !valid()) return;
    const host = document.createElement('div');
    host.id = 'jingyu-classify-hint';
    Object.assign(host.style, { position: 'fixed', zIndex: '2147483645', inset: 'auto', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible' });
    if ('showPopover' in host) host.setAttribute('popover', 'manual');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{color-scheme:light}button{font:13px/1.5 system-ui;color:#1479b8;background:#fff;border:1px solid #d9e5ee;border-radius:999px;padding:5px 11px;box-shadow:0 2px 8px #15253614;cursor:pointer;white-space:nowrap;animation:hint-life 2s linear forwards}
      button:hover{background:#f2f8fc}button:focus-visible{outline:2px solid #1684cf;outline-offset:2px}
      @keyframes hint-life{0%,92%{opacity:1}100%{opacity:0}}
      @media(prefers-reduced-motion:reduce){button{animation:none}}
      </style><button type="button" aria-label="添加帖子分类">＋ 分类</button>`;
    const button = root.querySelector('button');
    const state = { host, anchor, post, field, valid, remaining: 2000, started: win.performance.now(), timer: null, hover: false, focus: false };
    current = state;
    const resume = () => {
      if (current !== state || state.hover || state.focus || state.timer !== null) return;
      state.started = win.performance.now(); button.style.animationPlayState = 'running';
      state.timer = win.setTimeout(() => { if (current === state) hide(); }, state.remaining);
    };
    const pause = () => {
      if (current !== state || state.timer === null) return;
      win.clearTimeout(state.timer); state.timer = null;
      state.remaining = Math.max(0, state.remaining - (win.performance.now() - state.started));
      button.style.animationPlayState = 'paused';
    };
    button.addEventListener('pointerenter', () => { state.hover = true; pause(); });
    button.addEventListener('pointerleave', () => { state.hover = false; resume(); });
    button.addEventListener('focus', () => { state.focus = true; pause(); });
    button.addEventListener('blur', () => { state.focus = false; resume(); });
    for (const type of ['pointerdown', 'keydown']) root.addEventListener(type, event => {
      event.stopPropagation(); if (type === 'keydown' && event.key === 'Escape') hide();
    });
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      const usable = anchor.isConnected && valid(); hide();
      if (usable) Promise.resolve().then(() => openPicker(post, anchor)).catch(onError);
    });
    document.body.append(host); host.showPopover?.(); refresh(); if (current === state) resume();
  }
  const outside = event => { if (current && !event.composedPath().includes(current.host)) hide(); };
  const visibility = () => { if (document.hidden) hide(); };
  win.addEventListener('scroll', refresh, true); win.addEventListener('resize', refresh);
  document.addEventListener('pointerdown', outside, true); document.addEventListener('visibilitychange', visibility);
  return { show, refresh, hide,
    dismiss(postId, field) { if (current?.post.id === postId && current.field === field) hide(); },
    destroy() { hide(); win.removeEventListener('scroll', refresh, true); win.removeEventListener('resize', refresh);
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('visibilitychange', visibility); }
  };
}
