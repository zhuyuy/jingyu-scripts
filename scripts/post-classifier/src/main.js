import { Store } from './core/store.js';
import { allowedServer, DEFAULT_SERVER, request, synchronize } from './core/sync.js';
import { UI } from './ui/app.js';
import { mountX } from './platforms/x.js';

const preview = typeof GM_getValue !== 'function';
const api = preview ? {
  async get(k, fallback) { const v = localStorage.getItem('jingyu-preview:' + k); return v === null ? fallback : JSON.parse(v); },
  async set(k, v) { localStorage.setItem('jingyu-preview:' + k, JSON.stringify(v)); },
  async list() { return Object.keys(localStorage).filter(k => k.startsWith('jingyu-preview:')).map(k => k.slice(15)); },
  async remove(k) { localStorage.removeItem('jingyu-preview:' + k); }
} : {
  async get(k, fallback) { return GM_getValue(k, fallback); },
  async set(k, v) { return GM_setValue(k, v); },
  async list() { return GM_listValues(); },
  async remove(k) { return GM_deleteValue(k); },
  request(options) { return new Promise((resolve, reject) => GM_xmlhttpRequest({ ...options, anonymous: true,
    onload(res) { let data; try { data = JSON.parse(res.responseText); } catch { return reject(new Error('同步服务尚未就绪或返回格式不正确')); }
      if (res.status < 200 || res.status >= 300) { const err = new Error(res.status === 401 ? '登录已过期，请重新登录' : data.error || `同步失败（${res.status}）`); err.status = res.status; reject(err); } else resolve(data); },
    onerror() { reject(new Error('无法连接同步服务，本地修改已保留')); }, ontimeout() { reject(new Error('同步超时，本地修改已保留')); }
  })); }
};

async function start() {
  if (document.getElementById('jingyu-post-classifier')) return;
  const account = preview ? null : await api.get('pc:account', null);
  const app = {
    preview, account, server: account?.server || await api.get('pc:server', DEFAULT_SERVER), message: '', busy: false,
    status() { return this.message || (this.account ? `账号 ${this.account.user.name} · 自动同步已开启` : '本地模式 · 未登录'); },
    async changeScope(scope) {
      this.store = new Store(api, scope); await this.store.load();
      this.store.onchange = () => { adapter?.refresh(); scheduleSync(); };
      adapter?.refresh();
    },
    async sync() {
      if (this.busy || !this.account || preview) return;
      this.busy = true; const currentStore = this.store, currentAccount = this.account;
      try {
        const task = () => synchronize(api, currentStore, currentAccount);
        if (navigator.locks) await navigator.locks.request('jingyu-post-classifier-sync', task); else await task();
        this.message = `已同步 · ${new Date().toLocaleTimeString()} · ${currentAccount.user.name}`; adapter.refresh();
      } catch (e) {
        this.message = e.message;
        if (e.status === 401) { this.account = null; await api.remove('pc:account'); ui.toast('登录已过期，本地数据保留，请重新登录'); }
      } finally { this.busy = false; }
    },
    async login(value) {
      if (this.loggingIn) throw new Error('授权窗口已打开，请先完成授权');
      const server = allowedServer(value); if (!server) throw new Error('仅支持 tools.jingyu.dev 或本地开发服务');
      this.loggingIn = true;
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
      try {
        const result = await request(api, server, '/api/post-classifier/connect', { token, label: '帖子分类脚本 · ' + new Date().toLocaleDateString() });
        GM_openInTab(server + '/post-classifier/connect?request=' + encodeURIComponent(result.id), { active: true, insert: true });
        ui.toast('请在 tools 页面登录并授权，完成后会自动返回同步状态');
        this.message = '等待 tools 授权…';
        const until = Date.now() + 10 * 60 * 1000;
        while (Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const state = await request(api, server, '/api/post-classifier/session', {}, token);
          if (state.pending) continue;
          const guest = this.store.scope === 'guest' ? this.store.export() : null;
          this.account = { server, token, user: state.user }; this.server = server;
          await api.set('pc:account', this.account); await api.set('pc:server', server);
          await this.changeScope(encodeURIComponent(server) + ':' + state.user.id);
          if (guest?.operations.length && confirm(`是否将 ${guest.operations.length} 条本地修改合并到 ${state.user.name} 的分类库？`)) await this.store.import(guest);
          this.message = ''; await this.sync(); ui.manager('settings'); ui.toast('已登录，分类库已切换到当前账号'); return;
        }
        throw new Error('授权已超时，请重试');
      } finally { this.loggingIn = false; }
    },
    async logout() {
      if (this.busy) throw new Error('正在同步，请稍后再退出');
      if (this.account) {
        try { await request(api, this.account.server, '/api/post-classifier/revoke', {}, this.account.token); }
        catch { ui.toast('已退出本地账号；未能撤销云端凭据，可在 tools 授权页面撤销'); }
      }
      this.account = null; this.message = ''; await api.remove('pc:account'); await this.changeScope('guest');
    }
  };
  let adapter, syncTimer;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => { void app.sync(); }, 1200); }
  await app.changeScope(account ? encodeURIComponent(account.server) + ':' + account.user.id : 'guest');
  const ui = new UI(app);
  adapter = mountX({
    openPicker: (post, anchor) => ui.pickerFor(post, anchor),
    label: id => ui.label(id), onError: e => ui.toast(e.message),
    async changedAction(post, field, value) { await app.store.record(post); await app.store.put('post', post.id, field, value); if (value) await app.store.put('post', post.id, 'deleted', false); }
  });
  const refresh = async () => {
    const latest = preview ? null : await api.get('pc:account', null);
    if ((latest?.token || '') !== (app.account?.token || '')) {
      app.account = latest; app.message = '';
      await app.changeScope(latest ? encodeURIComponent(latest.server) + ':' + latest.user.id : 'guest');
      ui.closePicker(); ui.overlay && ui.manager();
    } else await app.store.load();
    adapter.refresh();
  };
  if (!preview && typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener('pc:changed', (_key, _old, _new, remote) => { if (remote) void refresh().catch(e => ui.toast(e.message)); });
    GM_addValueChangeListener('pc:account', (_key, _old, _new, remote) => { if (remote) void refresh().catch(e => ui.toast(e.message)); });
  }
  window.addEventListener('online', scheduleSync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refresh().catch(e => ui.toast(e.message)); scheduleSync(); } });
  setInterval(() => { if (!document.hidden) scheduleSync(); }, 30000);
  if (!preview) GM_registerMenuCommand('打开帖子分类库', () => ui.manager());
  scheduleSync();
}
void start().catch(error => console.error('[帖子分类]', error.message));
