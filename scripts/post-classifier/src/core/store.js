import { materialize, makeOperation, validOperation } from './model.js';

// One immutable operation per GM key: simultaneous tabs cannot overwrite a whole database.
export class Store {
  constructor(api, scope = 'guest') { this.api = api; this.scope = scope; this.ops = []; this.clock = 0; }
  prefix() { return `pc:v1:${this.scope}:`; }
  async load() {
    const prefix = this.prefix() + 'op:';
    const keys = (await this.api.list()).filter(k => k.startsWith(prefix));
    this.ops = (await Promise.all(keys.map(k => this.api.get(k)))).filter(validOperation);
    this.clock = this.ops.reduce((clock, op) => Math.max(clock, op.clock), this.clock);
    this.state = materialize(this.ops);
    return this.state;
  }
  async put(entity, key, field, value) {
    this.clock = Math.max(Date.now(), this.clock + 1);
    const op = makeOperation(entity, key, field, value, this.clock);
    await this.api.set(this.prefix() + 'op:' + op.id, op);
    this.ops.push(op); this.state = materialize(this.ops);
    await this.api.set('pc:changed', crypto.randomUUID());
    this.onchange?.();
    return op;
  }
  async receive(ops) {
    if (!ops.every(validOperation)) throw new Error('同步数据格式不正确');
    for (const op of ops) {
      await this.api.set(this.prefix() + 'op:' + op.id, op);
      await this.api.set(this.prefix() + 'ack:' + op.id, true);
    }
    await this.load();
  }
  async pending() {
    const keys = new Set(await this.api.list());
    return this.ops.filter(op => !keys.has(this.prefix() + 'ack:' + op.id));
  }
  async acknowledge(ops) { for (const op of ops) await this.api.set(this.prefix() + 'ack:' + op.id, true); }
  async category(name) {
    name = name.trim().normalize('NFKC');
    if (!name || name.length > 60) throw new Error('分类名称需要 1–60 个字符');
    const match = [...this.state.categories.values()].find(c => !c.deleted && c.name?.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (match) return match.id;
    const id = crypto.randomUUID(); await this.put('category', id, 'name', name); return id;
  }
  async record(post) { await this.put('post', post.id, 'meta', { url: post.url, author: post.author, text: post.text }); }
  async tag(postId, categoryId, present) { await this.put('tag', `${postId}|${categoryId}`, 'present', present); }
  export() { return { format: 'jingyu-post-classifier', version: 1, operations: this.ops }; }
  async import(data) {
    if (data?.format !== 'jingyu-post-classifier' || data.version !== 1 || !Array.isArray(data.operations) || data.operations.length > 50000 || !data.operations.every(validOperation)) throw new Error('不是有效的分类库备份');
    // Preserve operation IDs and deletion markers; imported records remain queued for upload.
    for (const op of data.operations) await this.api.set(this.prefix() + 'op:' + op.id, op);
    await this.load(); this.onchange?.();
  }
}
