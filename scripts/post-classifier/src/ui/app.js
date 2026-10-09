import { styles } from './styles.js';
import { mountTagPicker } from './tag-picker.js';
import { mountDraggableLauncher } from './draggable-launcher.js';
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children); return node;
}
export class UI {
  constructor(app) {
    this.app = app; this.host = el('div', { id: 'jingyu-post-classifier' });
    this.root = this.host.attachShadow({ mode: 'open' });
    // Do not let X keyboard shortcuts or delegated click handlers consume our controls.
    for (const event of ['keydown', 'click', 'pointerdown']) this.root.addEventListener(event, e => {
      if (event === 'keydown' && e.key === 'Escape') { if (this.picker) this.closePicker(); else this.closeManager(); }
      e.stopPropagation();
    });
    this.root.append(el('style', { text: styles }));
    this.launcher = el('button', { id: 'launcher', type: 'button', title: '点击打开分类库；按住拖动调整位置，Alt + 方向键微调',
      'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight', onclick: () => this.manager() },
    [el('span', { class: 'launcher-grip', text: '⠿', 'aria-hidden': 'true' }), el('span', { text: '分类库' })]);
    this.toastNode = el('div', { id: 'toast', role: 'status' });
    this.root.append(this.launcher, this.toastNode); document.body.append(this.host);
    this.launcherDrag = mountDraggableLauncher(this.launcher, this.app.store.api, () => this.toast('入口位置保存失败，可继续拖动重试'));
    this.outside = e => { if (this.picker && !e.composedPath().includes(this.picker) && !e.composedPath().includes(this.anchor)) this.closePicker(); };
    document.addEventListener('pointerdown', this.outside, true);
    this.escape = e => { if (e.key === 'Escape') { if (this.picker) this.closePicker(); else this.closeManager(); } };
    document.addEventListener('keydown', this.escape);
    this.reposition = () => this.position(); window.addEventListener('resize', this.reposition); window.addEventListener('scroll', this.reposition, true);
  }
  run(fn) { return async () => { try { await fn(); } catch (e) { this.toast(e.message); } }; }
  button(text, fn, cls = '') { return el('button', { text, class: cls, onclick: this.run(fn) }); }
  toast(text) { clearTimeout(this.toastTimer); this.toastNode.textContent = text; this.toastTimer = setTimeout(() => { this.toastNode.textContent = ''; }, 5000); }
  categories() { return [...this.app.store.state.categories.values()].filter(c => !c.deleted && c.name).sort((a,b) => b.updated - a.updated); }
  label(id) { const names = (this.app.store.state.posts.get(id)?.categories || []).map(c => this.app.store.state.categories.get(c)?.name).filter(Boolean); return names.length ? '分类 · ' + names.join(' / ') : '＋ 分类'; }
  async pickerFor(post, anchor) {
    await this.app.store.record(post);
    for (const field of ['liked', 'bookmarked']) {
      if (typeof post[field] === 'boolean' && this.app.store.state.posts.get(post.id)?.[field] !== post[field]) await this.app.store.put('post', post.id, field, post[field]);
    }
    if (this.app.store.state.posts.get(post.id)?.deleted) await this.app.store.put('post', post.id, 'deleted', false);
    this.closePicker(); this.anchor = anchor; this.post = post;
    this.tagPicker = mountTagPicker({ el, store: this.app.store, postId: post.id,
      onClose: restoreFocus => { this.closePicker(); if (restoreFocus) (anchor.shadowRoot?.querySelector('button') || anchor).focus?.(); },
      onError: error => this.toast(error.message), onResize: () => requestAnimationFrame(() => this.position())
    });
    this.picker = this.tagPicker.element;
    if ('showPopover' in this.picker) this.picker.setAttribute('popover', 'manual');
    this.root.append(this.picker); if (this.picker.showPopover) this.picker.showPopover();
    this.pickerResize = new ResizeObserver(() => this.position()); this.pickerResize.observe(this.picker);
    this.position(); this.tagPicker.focus();
  }
  position() {
    if (!this.picker) return;
    if (!this.anchor?.isConnected) return this.closePicker();
    const rect = this.anchor.getBoundingClientRect(), width = this.picker.offsetWidth, height = this.picker.offsetHeight;
    this.picker.style.left = Math.max(10, Math.min(rect.left, innerWidth - width - 10)) + 'px';
    this.picker.style.top = Math.max(10, Math.min(rect.bottom + 8 + height <= innerHeight ? rect.bottom + 8 : rect.top - height - 8, innerHeight - height - 10)) + 'px';
  }
  closePicker() { this.tagPicker?.destroy(); this.tagPicker = null; this.pickerResize?.disconnect(); this.picker?.remove(); this.picker = null; }
  closeManager() { this.overlay?.remove(); this.overlay = null; this.launcher.focus(); }
  manager(view = 'posts') {
    this.closePicker(); this.overlay?.remove();
    const panel = el('section', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '帖子分类库', tabindex: '-1' });
    this.overlay = el('div', { class: 'overlay' }, [panel]);
    this.overlay.addEventListener('click', e => { if (e.target === this.overlay) this.closeManager(); });
    panel.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const nodes = [...panel.querySelectorAll('button,input,select,a[href]')].filter(n => !n.disabled && n.offsetParent !== null);
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && this.root.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && this.root.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    panel.append(el('div', { class: 'header' }, [el('div', {}, [el('h2', { text: '帖子分类库' }), el('p', { class: 'muted', text: this.app.status() })]), this.button('关闭', () => this.closeManager())]));
    const tabs = el('div', { class: 'tabs' });
    for (const [id, name] of [['posts', '帖子'], ['categories', '分类'], ['settings', '同步与备份']]) { const b = this.button(name, () => this.manager(id)); b.setAttribute('aria-selected', String(view === id)); tabs.append(b); }
    panel.append(tabs); this.root.append(this.overlay);
    if (view === 'posts') this.posts(panel);
    if (view === 'categories') this.categoryManager(panel);
    if (view === 'settings') this.settings(panel);
    panel.focus();
  }
  posts(panel) {
    const search = el('input', { placeholder: '搜索作者或正文', 'aria-label': '搜索帖子', class: 'grow' });
    const category = el('select', { 'aria-label': '筛选分类' }, [el('option', { value: '', text: '全部分类' }), el('option', { value: '__none', text: '未分类' }), ...this.categories().map(c => el('option', { value: c.id, text: c.name }))]);
    const action = el('select', { 'aria-label': '筛选操作' }, ['全部记录', '已点赞', '已收藏'].map((v,i) => el('option', { value: String(i), text: v })));
    const list = el('div', { class: 'list' }), count = el('p', { class: 'muted' });
    const render = () => {
      const posts = [...this.app.store.state.posts.values()].filter(p => !p.deleted && p.meta && (!action.value || action.value === '0' || (action.value === '1' ? p.liked : p.bookmarked)) &&
        (!category.value || (category.value === '__none' ? !p.categories.length : p.categories.includes(category.value))) &&
        `${p.meta.author} ${p.meta.text}`.toLowerCase().includes(search.value.toLowerCase())).sort((a,b) => b.updated-a.updated);
      count.textContent = `${posts.length} 篇帖子`; list.replaceChildren();
      let shown = 0;
      const more = this.button('加载更多', () => draw());
      const draw = () => {
        more.remove();
        for (const p of posts.slice(shown, shown + 50)) {
          const edit = this.button('编辑分类', () => this.pickerFor({ id:p.id, ...p.meta }, edit));
          list.append(el('article', { class: 'item' }, [el('div', { class: 'row' }, [el('a', { text: p.meta.author || '查看原帖', href: p.meta.url, target: '_blank', rel: 'noopener noreferrer' }), el('span', { class: 'muted', text: `${p.liked ? '已点赞 ' : ''}${p.bookmarked ? '已收藏' : ''}` })]), el('p', { class: 'text', text: p.meta.text || '（图片或视频帖子）' }), el('div', { class: 'row' }, p.categories.map(id => el('span', { class: 'pill', text: this.app.store.state.categories.get(id)?.name || '' }))), el('div', { class: 'actions' }, [edit, this.button('删除记录', async () => { await this.app.store.put('post', p.id, 'deleted', true); render(); this.toast('记录已删除；不会取消 X 上的点赞或收藏'); }, 'danger')])]));
        }
        shown += 50; if (shown < posts.length) list.append(more);
      };
      draw(); if (!posts.length) list.append(el('p', { class: 'empty', text: '还没有记录。在帖子下方点「分类」，或点赞、收藏后添加。' }));
    };
    [search, category, action].forEach(n => n.addEventListener('input', render));
    panel.append(el('div', { class: 'stack' }, [el('div', { class: 'row' }, [search, category, action]), count, list])); render();
  }
  categoryManager(panel) {
    const name = el('input', { placeholder: '新分类名称', 'aria-label': '新分类名称', maxlength: '60', class: 'grow' });
    const list = el('div', { class: 'list' });
    const render = () => list.replaceChildren(...this.categories().map(c => {
      const input = el('input', { value: c.name, 'aria-label': `重命名 ${c.name}`, maxlength: '60', class: 'grow' });
      return el('div', { class: 'row item' }, [input, this.button('重命名', async () => {
        const next = input.value.trim(); if (!next) throw new Error('请输入分类名称');
        if (this.categories().some(other => other.id !== c.id && other.name.toLowerCase() === next.toLowerCase())) throw new Error('该分类已存在');
        await this.app.store.put('category', c.id, 'name', next); render();
      }), this.button('删除分类', async () => { await this.app.store.put('category', c.id, 'deleted', true); render(); this.toast('分类已删除，帖子记录保留'); }, 'danger')]);
    }));
    panel.append(el('div', { class: 'stack' }, [el('div', { class: 'row' }, [name, this.button('新建分类', async () => { await this.app.store.category(name.value); name.value = ''; render(); }, 'primary')]), list])); render();
  }
  settings(panel) {
    const server = el('input', { value: this.app.server, 'aria-label': '同步服务地址', class: 'grow' });
    const state = el('p', { class: 'muted', role: 'status', text: this.app.status() });
    const content = el('div', { class: 'stack' }, [state]);
    if (this.app.preview) content.append(el('p', { text: '当前为页面预览：数据仅存本浏览器，刷新后需重新加载脚本。安装油猴版本后可登录同步。' }));
    else {
      content.append(el('label', { text: '同步服务（正式站或本地开发地址）' }), server);
      if (this.app.account) content.append(el('div', { class: 'actions' }, [this.button('立即同步', async () => { await this.app.sync(); state.textContent = this.app.status(); }), this.button('退出同步账号', async () => { await this.app.logout(); this.manager('settings'); })]));
      else content.append(this.button('登录并同步', async () => { await this.app.login(server.value); state.textContent = this.app.status(); }, 'primary'));
    }
    content.append(el('div', { class: 'actions' }, [this.button('导出备份', () => {
      const blob = new Blob([JSON.stringify(this.app.store.export(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = el('a', { href: url, download: `post-classifier-${new Date().toISOString().slice(0,10)}.json` });
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }), this.button('导入备份', () => input.click())]));
    const input = el('input', { type: 'file', accept: 'application/json,.json', hidden: '' });
    input.addEventListener('change', this.run(async () => { const file = input.files[0]; if (!file) return; if (file.size > 20 * 1024 * 1024) throw new Error('备份不能超过 20 MB'); await this.app.store.import(JSON.parse(await file.text())); this.toast('备份已合并'); }));
    content.append(input, el('p', { class: 'muted', text: '本地操作会立即保存。同步失败时保留待同步修改；导出文件不包含登录凭据。' }),
      this.button('恢复分类库默认位置', () => this.launcherDrag.reset())); panel.append(content);
  }
  destroy() { this.launcherDrag.destroy(); this.closePicker(); clearTimeout(this.toastTimer); document.removeEventListener('pointerdown', this.outside, true); document.removeEventListener('keydown', this.escape); window.removeEventListener('resize', this.reposition); window.removeEventListener('scroll', this.reposition, true); this.host.remove(); }
}
