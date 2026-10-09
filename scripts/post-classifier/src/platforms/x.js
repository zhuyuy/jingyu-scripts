import { mountActionHint } from '../ui/action-hint.js';

export function extractPost(article) {
  // A timestamp permalink identifies the outer post, never a quoted post or video source.
  const time = [...article.querySelectorAll('a[href*="/status/"]')].find(a => a.querySelector('time') && a.closest('article') === article);
  const match = time?.getAttribute('href')?.match(/^\/([^/]+)\/status\/(\d+)$/);
  if (!match) return null;
  const text = article.querySelector('[data-testid="tweetText"]')?.textContent || '';
  const state = {};
  if (article.querySelector('[data-testid="like"], [data-testid="unlike"]')) state.liked = !!article.querySelector('[data-testid="unlike"]');
  if (article.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]')) state.bookmarked = !!article.querySelector('[data-testid="removeBookmark"]');
  return { id: `x:${match[2]}`, url: `https://x.com/${match[1]}/status/${match[2]}`, author: `@${match[1]}`, text: text.slice(0, 10000), ...state };
}
export function mountX({ openPicker, changedAction, label, onError }) {
  let scheduled = false, destroyed = false, interaction = 0;
  const hint = mountActionHint({ openPicker, onError });
  function decorate() {
    scheduled = false;
    if (destroyed) return;
    hint.refresh();
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const post = extractPost(article);
      if (!post) continue;
      const actions = article.querySelector('[data-testid="like"], [data-testid="unlike"]')?.closest('[role="group"]');
      if (!actions) continue;
      let host = article.querySelector('[data-jingyu-post]');
      if (!host) {
        host = document.createElement('div'); host.dataset.jingyuPost = post.id;
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<style>button{font:12px system-ui;color:#1d9bf0;border:1px solid #53647166;border-radius:999px;background:transparent;padding:5px 10px;cursor:pointer;margin:6px 0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button:hover{background:#1d9bf018}button:focus-visible{outline:2px solid #1d9bf0}</style><button type="button" title="编辑帖子分类"></button>';
        shadow.querySelector('button').addEventListener('click', e => {
          e.preventDefault(); e.stopPropagation();
          const current = extractPost(article);
          hint.hide();
          if (current) openPicker(current, host).catch(onError);
        });
        actions.insertAdjacentElement('afterend', host);
      }
      host.dataset.jingyuPost = post.id;
      const button = host.shadowRoot.querySelector('button');
      const next = label(post.id);
      if (button.textContent !== next) button.textContent = next;
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(decorate); } }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid', 'href'] });
  const timers = new Set();
  function later(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); }
  const sequences = new Map();
  function clicked(event) {
    const button = event.target.closest?.('button[data-testid]');
    const action = button?.dataset.testid;
    if (!['like', 'unlike', 'bookmark', 'removeBookmark'].includes(action)) return;
    const article = button.closest('article[data-testid="tweet"]');
    const post = article && extractPost(article);
    if (!post) return;
    const field = ['like', 'unlike'].includes(action) ? 'liked' : 'bookmarked';
    const activeId = field === 'liked' ? 'unlike' : 'removeBookmark';
    const inactiveId = field === 'liked' ? 'like' : 'bookmark';
    const wanted = ['like', 'bookmark'].includes(action);
    const request = ++interaction;
    if (!wanted) hint.dismiss(post.id, field);
    const key = post.id + field, sequence = (sequences.get(key) || 0) + 1;
    sequences.set(key, sequence);
    let tries = 0;
    const check = () => {
      if (destroyed || sequences.get(key) !== sequence) return;
      const currentArticle = [...document.querySelectorAll('article[data-testid="tweet"]')].find(a => extractPost(a)?.id === post.id);
      if (!currentArticle) return;
      const currentButton = currentArticle.querySelector(`[data-testid="${activeId}"], [data-testid="${inactiveId}"]`);
      const active = currentButton?.dataset.testid === activeId;
      if (currentButton && active === wanted) {
        const currentPost = extractPost(currentArticle);
        changedAction(currentPost, field, active).then(() => {
          if (!wanted || destroyed || request !== interaction || sequences.get(key) !== sequence) return;
          hint.show({ post: currentPost, anchor: currentButton, field,
            valid: () => currentArticle.isConnected && extractPost(currentArticle)?.id === post.id && currentButton.dataset.testid === activeId });
        }).catch(onError);
        // Reconcile a late optimistic UI rollback without deleting the user's categories.
        later(() => {
          if (sequences.get(key) !== sequence || !currentArticle.isConnected || extractPost(currentArticle)?.id !== post.id) return;
          const latest = currentArticle.querySelector(`[data-testid="${activeId}"], [data-testid="${inactiveId}"]`);
          if (latest && (latest.dataset.testid === activeId) !== active) changedAction(post, field, !active).catch(onError);
        }, 5000);
      } else if (++tries < 20) later(check, 150);
    };
    later(check, 250);
  }
  document.addEventListener('click', clicked, true); decorate();
  return { refresh: schedule, destroy() { destroyed = true; hint.destroy(); observer.disconnect(); document.removeEventListener('click', clicked, true); for (const t of timers) clearTimeout(t); document.querySelectorAll('[data-jingyu-post]').forEach(x => x.remove()); } };
}
