export const VERSION = 1;
export const order = (a, b) => a.clock - b.clock || a.id.localeCompare(b.id);
export function materialize(operations) {
  const registers = new Map();
  for (const op of operations) {
    const key = JSON.stringify([op.entity, op.key, op.field]);
    const old = registers.get(key);
    if (!old || order(old, op) < 0) registers.set(key, op);
  }
  const posts = new Map(), categories = new Map(), tags = new Map();
  for (const op of registers.values()) {
    const target = { post: posts, category: categories, tag: tags }[op.entity];
    if (!target) continue;
    const item = target.get(op.key) || { id: op.key, updated: 0 };
    item[op.field] = op.value;
    item.updated = Math.max(item.updated, op.clock);
    target.set(op.key, item);
  }
  for (const post of posts.values()) {
    post.categories = [...tags.values()].filter(t => t.present && t.id.startsWith(post.id + '|'))
      .map(t => t.id.slice(post.id.length + 1)).filter(id => categories.has(id) && !categories.get(id).deleted);
  }
  return { posts, categories };
}
export function validOperation(op) {
  if (!op || typeof op !== 'object' || !/^[a-f0-9-]{36}$/.test(op.id) ||
      !Number.isSafeInteger(op.clock) || op.clock < 0 || op.clock > Date.now() + 86400000 ||
      typeof op.key !== 'string' || op.key.length > 180) return false;
  if (op.entity === 'category' && /^[a-f0-9-]{36}$/.test(op.key)) {
    return op.field === 'name' ? typeof op.value === 'string' && op.value.trim().length > 0 && op.value.length <= 60
      : op.field === 'deleted' && typeof op.value === 'boolean';
  }
  const postKey = /^[a-z][a-z0-9_-]{0,31}:[a-zA-Z0-9_-]{1,80}$/;
  if (op.entity === 'tag') {
    const [post, category, extra] = op.key.split('|');
    return !extra && postKey.test(post) && /^[a-f0-9-]{36}$/.test(category || '') && op.field === 'present' && typeof op.value === 'boolean';
  }
  if (op.entity !== 'post' || !postKey.test(op.key)) return false;
  if (['liked', 'bookmarked', 'deleted'].includes(op.field)) return typeof op.value === 'boolean';
  if (op.field !== 'meta' || !op.value || typeof op.value !== 'object') return false;
  const { url, author, text } = op.value;
  if (typeof url !== 'string' || url.length > 2048 || typeof author !== 'string' || author.length > 200 || typeof text !== 'string' || text.length > 10000) return false;
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}
export function makeOperation(entity, key, field, value, clock) {
  const op = { id: crypto.randomUUID(), entity, key, field, value, clock };
  if (!validOperation(op)) throw new Error('数据格式不正确');
  return op;
}
