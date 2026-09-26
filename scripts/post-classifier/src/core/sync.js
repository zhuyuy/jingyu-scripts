export const DEFAULT_SERVER = 'https://tools.jingyu.dev';
export function allowedServer(value) {
  try {
    const url = new URL(value);
    return url.origin === DEFAULT_SERVER || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) ? url.origin : null;
  } catch { return null; }
}
export function request(api, base, path, body, token) {
  return api.request({ url: base + path, method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, data: JSON.stringify(body), timeout: 15000 });
}
export async function synchronize(api, store, account) {
  await store.load();
  const pending = await store.pending();
  for (let i = 0; i < pending.length;) {
    const batch = []; let bytes = 0;
    while (i < pending.length && batch.length < 100) {
      const size = new TextEncoder().encode(JSON.stringify(pending[i])).byteLength;
      if (batch.length && bytes + size > 200000) break;
      bytes += size; batch.push(pending[i++]);
    }
    await request(api, account.server, '/api/post-classifier/push', { operations: batch }, account.token);
    await store.acknowledge(batch);
  }
  let cursor = await api.get(store.prefix() + 'cursor', 0), more = true;
  while (more) {
    const result = await request(api, account.server, '/api/post-classifier/pull', { cursor }, account.token);
    await store.receive(result.operations);
    cursor = result.cursor; more = result.more;
    await api.set(store.prefix() + 'cursor', cursor);
  }
  await api.set('pc:changed', crypto.randomUUID());
}
