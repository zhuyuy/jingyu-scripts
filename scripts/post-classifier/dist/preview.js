(() => {
  // src/core/model.js
  var order = (a, b) => a.clock - b.clock || a.id.localeCompare(b.id);
  function materialize(operations) {
    const registers = /* @__PURE__ */ new Map();
    for (const op of operations) {
      const key = JSON.stringify([op.entity, op.key, op.field]);
      const old = registers.get(key);
      if (!old || order(old, op) < 0) registers.set(key, op);
    }
    const posts = /* @__PURE__ */ new Map(), categories = /* @__PURE__ */ new Map(), tags = /* @__PURE__ */ new Map();
    for (const op of registers.values()) {
      const target = { post: posts, category: categories, tag: tags }[op.entity];
      if (!target) continue;
      const item = target.get(op.key) || { id: op.key, updated: 0 };
      item[op.field] = op.value;
      item.updated = Math.max(item.updated, op.clock);
      target.set(op.key, item);
    }
    for (const post of posts.values()) {
      post.categories = [...tags.values()].filter((t) => t.present && t.id.startsWith(post.id + "|")).map((t) => t.id.slice(post.id.length + 1)).filter((id) => categories.has(id) && !categories.get(id).deleted);
    }
    return { posts, categories };
  }
  function validOperation(op) {
    if (!op || typeof op !== "object" || !/^[a-f0-9-]{36}$/.test(op.id) || !Number.isSafeInteger(op.clock) || op.clock < 0 || op.clock > Date.now() + 864e5 || typeof op.key !== "string" || op.key.length > 180) return false;
    if (op.entity === "category" && /^[a-f0-9-]{36}$/.test(op.key)) {
      return op.field === "name" ? typeof op.value === "string" && op.value.trim().length > 0 && op.value.length <= 60 : op.field === "deleted" && typeof op.value === "boolean";
    }
    const postKey = /^[a-z][a-z0-9_-]{0,31}:[a-zA-Z0-9_-]{1,80}$/;
    if (op.entity === "tag") {
      const [post, category, extra] = op.key.split("|");
      return !extra && postKey.test(post) && /^[a-f0-9-]{36}$/.test(category || "") && op.field === "present" && typeof op.value === "boolean";
    }
    if (op.entity !== "post" || !postKey.test(op.key)) return false;
    if (["liked", "bookmarked", "deleted"].includes(op.field)) return typeof op.value === "boolean";
    if (op.field !== "meta" || !op.value || typeof op.value !== "object") return false;
    const { url, author, text } = op.value;
    if (typeof url !== "string" || url.length > 2048 || typeof author !== "string" || author.length > 200 || typeof text !== "string" || text.length > 1e4) return false;
    try {
      return new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  }
  function makeOperation(entity, key, field, value, clock) {
    const op = { id: crypto.randomUUID(), entity, key, field, value, clock };
    if (!validOperation(op)) throw new Error("\u6570\u636E\u683C\u5F0F\u4E0D\u6B63\u786E");
    return op;
  }

  // src/core/store.js
  var Store = class {
    constructor(api2, scope = "guest") {
      this.api = api2;
      this.scope = scope;
      this.ops = [];
      this.clock = 0;
    }
    prefix() {
      return `pc:v1:${this.scope}:`;
    }
    async load() {
      const prefix = this.prefix() + "op:";
      const keys = (await this.api.list()).filter((k) => k.startsWith(prefix));
      this.ops = (await Promise.all(keys.map((k) => this.api.get(k)))).filter(validOperation);
      this.clock = this.ops.reduce((clock, op) => Math.max(clock, op.clock), this.clock);
      this.state = materialize(this.ops);
      return this.state;
    }
    async put(entity, key, field, value) {
      this.clock = Math.max(Date.now(), this.clock + 1);
      const op = makeOperation(entity, key, field, value, this.clock);
      await this.api.set(this.prefix() + "op:" + op.id, op);
      this.ops.push(op);
      this.state = materialize(this.ops);
      await this.api.set("pc:changed", crypto.randomUUID());
      this.onchange?.();
      return op;
    }
    async receive(ops) {
      if (!ops.every(validOperation)) throw new Error("\u540C\u6B65\u6570\u636E\u683C\u5F0F\u4E0D\u6B63\u786E");
      for (const op of ops) {
        await this.api.set(this.prefix() + "op:" + op.id, op);
        await this.api.set(this.prefix() + "ack:" + op.id, true);
      }
      await this.load();
    }
    async pending() {
      const keys = new Set(await this.api.list());
      return this.ops.filter((op) => !keys.has(this.prefix() + "ack:" + op.id));
    }
    async acknowledge(ops) {
      for (const op of ops) await this.api.set(this.prefix() + "ack:" + op.id, true);
    }
    async category(name) {
      name = name.trim().normalize("NFKC");
      if (!name || name.length > 60) throw new Error("\u5206\u7C7B\u540D\u79F0\u9700\u8981 1\u201360 \u4E2A\u5B57\u7B26");
      const match = [...this.state.categories.values()].find((c) => !c.deleted && c.name?.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (match) return match.id;
      const id = crypto.randomUUID();
      await this.put("category", id, "name", name);
      return id;
    }
    async record(post) {
      await this.put("post", post.id, "meta", { url: post.url, author: post.author, text: post.text });
    }
    async tag(postId, categoryId, present) {
      await this.put("tag", `${postId}|${categoryId}`, "present", present);
    }
    export() {
      return { format: "jingyu-post-classifier", version: 1, operations: this.ops };
    }
    async import(data) {
      if (data?.format !== "jingyu-post-classifier" || data.version !== 1 || !Array.isArray(data.operations) || data.operations.length > 5e4 || !data.operations.every(validOperation)) throw new Error("\u4E0D\u662F\u6709\u6548\u7684\u5206\u7C7B\u5E93\u5907\u4EFD");
      for (const op of data.operations) await this.api.set(this.prefix() + "op:" + op.id, op);
      await this.load();
      this.onchange?.();
    }
  };

  // src/core/sync.js
  var DEFAULT_SERVER = "https://tools.jingyu.dev";
  function allowedServer(value) {
    try {
      const url = new URL(value);
      return url.origin === DEFAULT_SERVER || url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) ? url.origin : null;
    } catch {
      return null;
    }
  }
  function request(api2, base, path, body, token) {
    return api2.request({ url: base + path, method: "POST", headers: { "Content-Type": "application/json", ...token ? { Authorization: `Bearer ${token}` } : {} }, data: JSON.stringify(body), timeout: 15e3 });
  }
  async function synchronize(api2, store, account) {
    await store.load();
    const pending = await store.pending();
    for (let i = 0; i < pending.length; ) {
      const batch = [];
      let bytes = 0;
      while (i < pending.length && batch.length < 100) {
        const size = new TextEncoder().encode(JSON.stringify(pending[i])).byteLength;
        if (batch.length && bytes + size > 2e5) break;
        bytes += size;
        batch.push(pending[i++]);
      }
      await request(api2, account.server, "/api/post-classifier/push", { operations: batch }, account.token);
      await store.acknowledge(batch);
    }
    let cursor = await api2.get(store.prefix() + "cursor", 0), more = true;
    while (more) {
      const result = await request(api2, account.server, "/api/post-classifier/pull", { cursor }, account.token);
      await store.receive(result.operations);
      cursor = result.cursor;
      more = result.more;
      await api2.set(store.prefix() + "cursor", cursor);
    }
    await api2.set("pc:changed", crypto.randomUUID());
  }

  // src/ui/styles.js
  var styles = `
:host{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#292d32;color-scheme:light;--bg:#fff;--panel:#f7f8fa;--line:#e5e7eb;--accent:#1684cf}
*{box-sizing:border-box}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}button{cursor:pointer;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:inherit;min-height:36px;padding:7px 12px}button:hover{border-color:#c7d3df;background:#f3f6f9}button:disabled{opacity:.55;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}input,select{min-width:0;max-width:100%;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:inherit;padding:9px 11px}input[type=checkbox]{accent-color:var(--accent);width:18px;height:18px}a{color:#1479b8;text-decoration:none}h2,h3,p{margin:0}h2{font-size:19px}h3{font-size:15px}.muted{font-size:12px;color:#69717b}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.grow{flex:1}.primary{background:var(--accent);color:white;border-color:var(--accent)}.primary:hover{background:#0874bb}.danger{color:#b14040}.pill{border:1px solid var(--line);border-radius:6px;background:#f2f4f7;padding:3px 8px;font-size:12px}.empty{padding:28px 12px;text-align:center;color:#69717b}.stack{display:grid;gap:16px}.actions{display:flex;gap:8px;flex-wrap:wrap}.list{display:grid;gap:10px}.item{border:1px solid var(--line);border-radius:10px;padding:16px;display:grid;gap:12px}.text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow:auto}
#launcher{position:fixed;right:20px;bottom:24px;z-index:2147483645;border-radius:999px;box-shadow:0 3px 12px #172b4d20;background:var(--bg);color:#1479b8;font-weight:600;padding:9px 16px;border-color:#d9e5ee;display:flex;align-items:center;gap:6px;touch-action:none;user-select:none;cursor:grab}#launcher.dragging{cursor:grabbing;box-shadow:0 6px 20px #172b4d30}.launcher-grip{font-size:17px;line-height:1;color:#7998ad}
.overlay{position:fixed;inset:0;background:#15253638;z-index:2147483646;display:grid;place-items:center;padding:16px}.dialog{width:min(780px,100%);max-height:88vh;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:0 12px 48px #15253626}.header{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:20px}.tabs{display:flex;gap:8px;margin-bottom:20px}.tabs [aria-selected=true]{background:#edf6fd;border-color:#b9d9f0;color:#136ca6}
#picker{position:fixed;inset:auto;margin:0;width:min(344px,calc(100vw - 24px));max-height:min(540px,calc(100dvh - 24px));overflow:auto;background:var(--bg);color:inherit;border:1px solid #e4e7eb;border-radius:12px;padding:0;z-index:2147483647;box-shadow:0 12px 36px #1525361a,0 2px 8px #1525360d}#picker[hidden]{display:none}
.picker-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px 12px}.picker-heading h3{font-size:14px;font-weight:650;color:#32363c}.picker-count{font-size:12px;color:#7b818a}.selected-tags{display:flex;gap:6px;flex-wrap:wrap;padding:0 18px 14px;max-height:94px;overflow:auto}.selected-tags[hidden]{display:none}.picker-search{padding:0 14px 12px}#tag-search{display:block;width:100%;height:40px;font-size:14px;background:#fafbfc;border-color:#dfe3e8;border-radius:7px;padding:9px 11px}#tag-search::placeholder{color:#9399a2}#tag-search:focus{outline:none;border-color:#8dbde0;box-shadow:0 0 0 2px #1684cf12;background:white}.picker-list-label{border-top:1px solid #eef0f2;padding:12px 18px 6px;font-size:11px;color:#868c95}
#tag-options{padding:0 6px 8px;max-height:244px;overflow:auto;overscroll-behavior:contain;scroll-padding:4px}.tag-option{display:flex;align-items:center;gap:9px;min-height:40px;margin:2px 0;padding:8px 12px;border-radius:6px;cursor:pointer}.tag-option.active{background:#f0f3f6;box-shadow:inset 2px 0 #c5d5e3}.tag-option[aria-disabled=true]{cursor:progress}.tag-chip{display:inline-block;max-width:100%;font-size:13px;line-height:20px;padding:1px 7px;border-radius:4px;overflow-wrap:anywhere}.tone-0{background:#e6f0fa;color:#315d80}.tone-1{background:#e9e5f5;color:#69538c}.tone-2{background:#e4efe8;color:#3e7055}.tone-3{background:#f7ebda;color:#87652e}.tone-4{background:#f5e5e7;color:#985b65}.tone-5{background:#ecebea;color:#64615e}.tag-check{flex-shrink:0;margin-left:auto;color:#3e6f98;font-size:16px;font-weight:600}.create-symbol{color:#9399a2;font-size:19px;line-height:20px;flex-shrink:0}.create-label{color:#727984;font-size:13px;flex-shrink:0}.create-option .tag-chip{min-width:0}.picker-empty{padding:18px 12px 22px;text-align:center;font-size:13px;color:#8a9098}.picker-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;border-top:1px solid #eef0f2;background:#fcfcfd;font-size:10px;color:#8c929b}.picker-status{white-space:nowrap;color:#73897a}
.selected-tag{position:relative;padding-right:25px}.tag-remove{position:absolute;top:0;right:0;display:grid;place-items:center;width:22px;height:22px;min-height:0;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font-size:16px;line-height:1;opacity:.65}.tag-remove:hover{background:#0000000c;opacity:1}.tag-remove:focus-visible{outline-offset:0;opacity:1}
#toast{position:fixed;bottom:82px;right:20px;max-width:min(360px,90vw);background:white;color:#343a42;border:1px solid var(--line);box-shadow:0 4px 16px #15253614;padding:12px 16px;border-radius:9px;z-index:2147483647}#toast:empty{display:none}
@media(max-width:520px){.dialog{padding:16px;max-height:92vh}.overlay{padding:8px}#launcher{right:12px;bottom:16px}.row>input.grow{width:100%}}
@media(forced-colors:active){.tag-option.active{outline:1px solid Highlight}.tag-chip{border:1px solid CanvasText}.tag-check{color:Highlight}}
`;

  // src/ui/tag-picker.js
  function mountTagPicker({ el: el2, store, postId, onClose, onError, onResize }) {
    const normal = (text) => text.trim().normalize("NFKC").toLocaleLowerCase();
    const tone = (text) => [...text].reduce((n, ch) => n * 31 + ch.codePointAt(0) >>> 0, 0) % 6;
    const chip = (name) => el2("span", { class: `tag-chip tone-${tone(name)}`, text: name });
    const picker = el2("section", { id: "picker", role: "dialog", tabindex: "-1", "aria-label": "\u5E16\u5B50\u5206\u7C7B" });
    const count = el2("span", { class: "picker-count" });
    const selectedTags = el2("div", { class: "selected-tags", "aria-label": "\u5DF2\u9009\u6807\u7B7E" });
    const search = el2("input", {
      id: "tag-search",
      type: "text",
      role: "combobox",
      placeholder: "\u641C\u7D22\u6216\u521B\u5EFA\u6807\u7B7E\u2026",
      "aria-labelledby": "tag-picker-title",
      "aria-controls": "tag-options",
      "aria-expanded": "false",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-describedby": "tag-keyboard-help",
      maxlength: "60",
      autocomplete: "off",
      spellcheck: "false"
    });
    const choices = el2("div", { id: "tag-options", role: "listbox", "aria-label": "\u6807\u7B7E", "aria-multiselectable": "true" });
    const suggestions = el2("div", { class: "picker-suggestions" }, [el2("p", { class: "picker-list-label", text: "\u9009\u62E9\u6807\u7B7E" }), choices]);
    suggestions.hidden = true;
    const status = el2("span", { class: "picker-status", role: "status", "aria-live": "polite", text: "\u81EA\u52A8\u4FDD\u5B58" });
    picker.append(
      el2("div", { class: "picker-heading" }, [el2("h3", { id: "tag-picker-title", text: "\u5206\u7C7B" }), count]),
      selectedTags,
      el2("div", { class: "picker-search" }, [search]),
      suggestions,
      el2("div", { class: "picker-footer" }, [el2("span", { id: "tag-keyboard-help", text: "\u2191\u2193 \u9009\u62E9 \xB7 \u21B5 \u5207\u6362 \xB7 Esc \u5173\u95ED" }), status])
    );
    let entries = [], active = -1, busy = false, composing = false, destroyed = false;
    const selected = () => store.state.posts.get(postId)?.categories || [];
    const categories = () => [...store.state.categories.values()].filter((c) => c.name && !c.deleted).sort((a, b) => b.updated - a.updated);
    function highlight(index, scroll = false) {
      active = index;
      [...choices.children].forEach((node, i) => node.classList.toggle("active", i === active));
      if (!suggestions.hidden && active >= 0 && entries[active]) {
        search.setAttribute("aria-activedescendant", `tag-option-${active}`);
        if (scroll) choices.children[active]?.scrollIntoView?.({ block: "nearest" });
      } else search.removeAttribute("aria-activedescendant");
    }
    function render(preferredId) {
      if (destroyed) return;
      const all = categories(), ids = selected(), query = normal(search.value);
      entries = all.filter((c) => normal(c.name).includes(query)).map((c) => ({ ...c, create: false }));
      if (query && !all.some((c) => normal(c.name) === query)) entries.unshift({ id: "__create", name: search.value.trim().normalize("NFKC"), create: true });
      count.textContent = ids.length ? `\u5DF2\u9009 ${ids.length}` : "\u53EF\u591A\u9009";
      const restoreChipFocus = selectedTags.contains(picker.getRootNode().activeElement);
      selectedTags.replaceChildren(...all.filter((c) => ids.includes(c.id)).map((c) => {
        const tag = chip(c.name);
        tag.classList.add("selected-tag");
        const remove = el2("button", {
          type: "button",
          class: "tag-remove",
          text: "\xD7",
          "aria-label": `\u79FB\u9664\u6807\u7B7E ${c.name}`,
          title: `\u79FB\u9664\u6807\u7B7E ${c.name}`
        });
        remove.addEventListener("pointerdown", (event) => event.preventDefault());
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          void activate(c, false);
        });
        tag.append(remove);
        return tag;
      }));
      if (restoreChipFocus) picker.focus({ preventScroll: true });
      selectedTags.hidden = !selectedTags.childElementCount;
      choices.replaceChildren(...entries.map((entry, index) => {
        const checked = !entry.create && ids.includes(entry.id);
        const row = el2("div", {
          id: `tag-option-${index}`,
          role: "option",
          class: `tag-option${entry.create ? " create-option" : ""}`,
          "aria-label": entry.create ? `\u521B\u5EFA\u6807\u7B7E ${entry.name}` : entry.name,
          "aria-selected": String(checked),
          "aria-disabled": String(busy)
        }, entry.create ? [el2("span", { class: "create-symbol", text: "+", "aria-hidden": "true" }), el2("span", { text: "\u521B\u5EFA\u6807\u7B7E", class: "create-label" }), chip(entry.name)] : [chip(entry.name), el2("span", { class: "tag-check", text: checked ? "\u2713" : "", "aria-hidden": "true" })]);
        row.addEventListener("pointerdown", (e) => e.preventDefault());
        row.addEventListener("pointermove", () => highlight(index));
        row.addEventListener("click", () => {
          highlight(index);
          void activate();
        });
        return row;
      }));
      if (!entries.length) choices.append(el2("p", { class: "picker-empty", text: "\u8FD8\u6CA1\u6709\u6807\u7B7E\uFF0C\u8F93\u5165\u540D\u79F0\u5373\u53EF\u521B\u5EFA" }));
      const preferred = entries.findIndex((entry) => entry.id === preferredId);
      highlight(entries.length ? preferred >= 0 ? preferred : 0 : -1);
      onResize();
    }
    async function activate(entry = entries[active], value) {
      if (!entry || busy || destroyed) return;
      busy = true;
      picker.setAttribute("aria-busy", "true");
      status.textContent = "\u4FDD\u5B58\u4E2D\u2026";
      let id = entry.id;
      try {
        if (entry.create) id = await store.category(entry.name);
        await store.tag(postId, id, value ?? (entry.create || !selected().includes(id)));
        status.textContent = "\u5DF2\u4FDD\u5B58";
      } catch (error) {
        status.textContent = "\u4FDD\u5B58\u5931\u8D25";
        onError(error);
      } finally {
        busy = false;
        picker.removeAttribute("aria-busy");
        render(id);
      }
    }
    search.addEventListener("focus", () => {
      suggestions.hidden = false;
      search.setAttribute("aria-expanded", "true");
      render();
    });
    search.addEventListener("blur", () => {
      suggestions.hidden = true;
      search.setAttribute("aria-expanded", "false");
      search.removeAttribute("aria-activedescendant");
      onResize();
    });
    search.addEventListener("input", () => render());
    search.addEventListener("compositionstart", () => {
      composing = true;
    });
    search.addEventListener("compositionend", () => {
      composing = false;
      render();
    });
    search.addEventListener("keydown", (event) => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (entries.length) highlight((active + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length, true);
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) void activate();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      } else if (event.key === "Tab") onClose(false);
    });
    render();
    return { element: picker, focus: () => picker.focus({ preventScroll: true }), destroy() {
      destroyed = true;
    } };
  }

  // src/ui/draggable-launcher.js
  var POSITION_KEY = "pc:ui:launcher-position";
  var clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  function mountDraggableLauncher(button, storage, onError) {
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
      return {
        minX,
        minY,
        maxX: Math.max(minX, left + width - button.offsetWidth - 12),
        maxY: Math.max(minY, top + height - button.offsetHeight - 12)
      };
    }
    function place(x, y) {
      const b = bounds();
      x = clamp(x, b.minX, b.maxX);
      y = clamp(y, b.minY, b.maxY);
      Object.assign(button.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
      return { x: (x - b.minX) / (b.maxX - b.minX || 1), y: (y - b.minY) / (b.maxY - b.minY || 1) };
    }
    function restore() {
      if (!position || drag) return;
      const b = bounds();
      place(b.minX + position.x * (b.maxX - b.minX), b.minY + position.y * (b.maxY - b.minY));
    }
    function persist() {
      const value = position && { ...position };
      saves = saves.then(() => storage.set(POSITION_KEY, value)).catch((error) => {
        if (!destroyed) onError(error);
      });
      return saves;
    }
    function finish(cancelled) {
      if (!drag) return;
      const previous = drag;
      drag = null;
      button.classList.remove("dragging");
      if (button.hasPointerCapture?.(previous.id)) button.releasePointerCapture(previous.id);
      if (!previous.moved) return;
      suppressClick = true;
      win.clearTimeout(clickTimer);
      clickTimer = win.setTimeout(() => {
        suppressClick = false;
      }, 500);
      if (cancelled) {
        if (position) restore();
        else for (const name of ["left", "top", "right", "bottom"]) button.style.removeProperty(name);
      } else {
        const rect = button.getBoundingClientRect();
        position = place(rect.left, rect.top);
        void persist();
      }
    }
    listen(button, "pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false || drag) return;
      touched = true;
      suppressClick = false;
      win.clearTimeout(clickTimer);
      const rect = button.getBoundingClientRect();
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
      button.setPointerCapture(event.pointerId);
    });
    listen(button, "pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      button.classList.add("dragging");
      event.preventDefault();
      event.stopPropagation();
      place(drag.left + dx, drag.top + dy);
    });
    listen(button, "pointerup", (event) => {
      if (drag?.id === event.pointerId) finish(false);
    });
    for (const type of ["pointercancel", "lostpointercapture"]) {
      listen(button, type, (event) => {
        if (drag?.id === event.pointerId) finish(true);
      });
    }
    listen(button, "click", (event) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    listen(button, "keydown", (event) => {
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
        return;
      }
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!delta || !event.altKey || event.ctrlKey || event.metaKey || drag) return;
      event.preventDefault();
      event.stopPropagation();
      touched = true;
      const rect = button.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
      position = place(rect.left + delta[0] * step, rect.top + delta[1] * step);
      void persist();
    });
    listen(win, "resize", restore);
    if (win.visualViewport) {
      listen(win.visualViewport, "resize", restore);
      listen(win.visualViewport, "scroll", restore);
    }
    const ready = Promise.resolve().then(() => storage.get(POSITION_KEY, null)).then((value) => {
      if (destroyed || touched || !value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return;
      position = { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) };
      restore();
    }).catch((error) => {
      if (!destroyed) onError(error);
    });
    return {
      ready,
      reset() {
        touched = true;
        finish(true);
        position = null;
        for (const name of ["left", "top", "right", "bottom"]) button.style.removeProperty(name);
        return persist();
      },
      destroy() {
        destroyed = true;
        finish(true);
        win.clearTimeout(clickTimer);
        listeners.forEach((remove) => remove());
      }
    };
  }

  // src/ui/app.js
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== void 0) node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }
  var UI = class {
    constructor(app) {
      this.app = app;
      this.host = el("div", { id: "jingyu-post-classifier" });
      this.root = this.host.attachShadow({ mode: "open" });
      for (const event of ["keydown", "click", "pointerdown"]) this.root.addEventListener(event, (e) => {
        if (event === "keydown" && e.key === "Escape") {
          if (this.picker) this.closePicker();
          else this.closeManager();
        }
        e.stopPropagation();
      });
      this.root.append(el("style", { text: styles }));
      this.launcher = el(
        "button",
        {
          id: "launcher",
          type: "button",
          title: "\u70B9\u51FB\u6253\u5F00\u5206\u7C7B\u5E93\uFF1B\u6309\u4F4F\u62D6\u52A8\u8C03\u6574\u4F4D\u7F6E\uFF0CAlt + \u65B9\u5411\u952E\u5FAE\u8C03",
          "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight",
          onclick: () => this.manager()
        },
        [el("span", { class: "launcher-grip", text: "\u283F", "aria-hidden": "true" }), el("span", { text: "\u5206\u7C7B\u5E93" })]
      );
      this.toastNode = el("div", { id: "toast", role: "status" });
      this.root.append(this.launcher, this.toastNode);
      document.body.append(this.host);
      this.launcherDrag = mountDraggableLauncher(this.launcher, this.app.store.api, () => this.toast("\u5165\u53E3\u4F4D\u7F6E\u4FDD\u5B58\u5931\u8D25\uFF0C\u53EF\u7EE7\u7EED\u62D6\u52A8\u91CD\u8BD5"));
      this.outside = (e) => {
        if (this.picker && !e.composedPath().includes(this.picker) && !e.composedPath().includes(this.anchor)) this.closePicker();
      };
      document.addEventListener("pointerdown", this.outside, true);
      this.escape = (e) => {
        if (e.key === "Escape") {
          if (this.picker) this.closePicker();
          else this.closeManager();
        }
      };
      document.addEventListener("keydown", this.escape);
      this.reposition = () => this.position();
      window.addEventListener("resize", this.reposition);
      window.addEventListener("scroll", this.reposition, true);
    }
    run(fn) {
      return async () => {
        try {
          await fn();
        } catch (e) {
          this.toast(e.message);
        }
      };
    }
    button(text, fn, cls = "") {
      return el("button", { text, class: cls, onclick: this.run(fn) });
    }
    toast(text) {
      clearTimeout(this.toastTimer);
      this.toastNode.textContent = text;
      this.toastTimer = setTimeout(() => {
        this.toastNode.textContent = "";
      }, 5e3);
    }
    categories() {
      return [...this.app.store.state.categories.values()].filter((c) => !c.deleted && c.name).sort((a, b) => b.updated - a.updated);
    }
    label(id) {
      const names = (this.app.store.state.posts.get(id)?.categories || []).map((c) => this.app.store.state.categories.get(c)?.name).filter(Boolean);
      return names.length ? "\u5206\u7C7B \xB7 " + names.join(" / ") : "\uFF0B \u5206\u7C7B";
    }
    async pickerFor(post, anchor) {
      await this.app.store.record(post);
      for (const field of ["liked", "bookmarked"]) {
        if (typeof post[field] === "boolean" && this.app.store.state.posts.get(post.id)?.[field] !== post[field]) await this.app.store.put("post", post.id, field, post[field]);
      }
      if (this.app.store.state.posts.get(post.id)?.deleted) await this.app.store.put("post", post.id, "deleted", false);
      this.closePicker();
      this.anchor = anchor;
      this.post = post;
      this.tagPicker = mountTagPicker({
        el,
        store: this.app.store,
        postId: post.id,
        onClose: (restoreFocus) => {
          this.closePicker();
          if (restoreFocus) (anchor.shadowRoot?.querySelector("button") || anchor).focus?.();
        },
        onError: (error) => this.toast(error.message),
        onResize: () => requestAnimationFrame(() => this.position())
      });
      this.picker = this.tagPicker.element;
      if ("showPopover" in this.picker) this.picker.setAttribute("popover", "manual");
      this.root.append(this.picker);
      if (this.picker.showPopover) this.picker.showPopover();
      this.pickerResize = new ResizeObserver(() => this.position());
      this.pickerResize.observe(this.picker);
      this.position();
      this.tagPicker.focus();
    }
    position() {
      if (!this.picker) return;
      if (!this.anchor?.isConnected) return this.closePicker();
      const rect = this.anchor.getBoundingClientRect(), width = this.picker.offsetWidth, height = this.picker.offsetHeight;
      this.picker.style.left = Math.max(10, Math.min(rect.left, innerWidth - width - 10)) + "px";
      this.picker.style.top = Math.max(10, Math.min(rect.bottom + 8 + height <= innerHeight ? rect.bottom + 8 : rect.top - height - 8, innerHeight - height - 10)) + "px";
    }
    closePicker() {
      this.tagPicker?.destroy();
      this.tagPicker = null;
      this.pickerResize?.disconnect();
      this.picker?.remove();
      this.picker = null;
    }
    closeManager() {
      this.overlay?.remove();
      this.overlay = null;
      this.launcher.focus();
    }
    manager(view = "posts") {
      this.closePicker();
      this.overlay?.remove();
      const panel = el("section", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": "\u5E16\u5B50\u5206\u7C7B\u5E93", tabindex: "-1" });
      this.overlay = el("div", { class: "overlay" }, [panel]);
      this.overlay.addEventListener("click", (e) => {
        if (e.target === this.overlay) this.closeManager();
      });
      panel.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const nodes = [...panel.querySelectorAll("button,input,select,a[href]")].filter((n) => !n.disabled && n.offsetParent !== null);
        const first = nodes[0], last = nodes.at(-1);
        if (e.shiftKey && this.root.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && this.root.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      });
      panel.append(el("div", { class: "header" }, [el("div", {}, [el("h2", { text: "\u5E16\u5B50\u5206\u7C7B\u5E93" }), el("p", { class: "muted", text: this.app.status() })]), this.button("\u5173\u95ED", () => this.closeManager())]));
      const tabs = el("div", { class: "tabs" });
      for (const [id, name] of [["posts", "\u5E16\u5B50"], ["categories", "\u5206\u7C7B"], ["settings", "\u540C\u6B65\u4E0E\u5907\u4EFD"]]) {
        const b = this.button(name, () => this.manager(id));
        b.setAttribute("aria-selected", String(view === id));
        tabs.append(b);
      }
      panel.append(tabs);
      this.root.append(this.overlay);
      if (view === "posts") this.posts(panel);
      if (view === "categories") this.categoryManager(panel);
      if (view === "settings") this.settings(panel);
      panel.focus();
    }
    posts(panel) {
      const search = el("input", { placeholder: "\u641C\u7D22\u4F5C\u8005\u6216\u6B63\u6587", "aria-label": "\u641C\u7D22\u5E16\u5B50", class: "grow" });
      const category = el("select", { "aria-label": "\u7B5B\u9009\u5206\u7C7B" }, [el("option", { value: "", text: "\u5168\u90E8\u5206\u7C7B" }), el("option", { value: "__none", text: "\u672A\u5206\u7C7B" }), ...this.categories().map((c) => el("option", { value: c.id, text: c.name }))]);
      const action = el("select", { "aria-label": "\u7B5B\u9009\u64CD\u4F5C" }, ["\u5168\u90E8\u8BB0\u5F55", "\u5DF2\u70B9\u8D5E", "\u5DF2\u6536\u85CF"].map((v, i) => el("option", { value: String(i), text: v })));
      const list = el("div", { class: "list" }), count = el("p", { class: "muted" });
      const render = () => {
        const posts = [...this.app.store.state.posts.values()].filter((p) => !p.deleted && p.meta && (!action.value || action.value === "0" || (action.value === "1" ? p.liked : p.bookmarked)) && (!category.value || (category.value === "__none" ? !p.categories.length : p.categories.includes(category.value))) && `${p.meta.author} ${p.meta.text}`.toLowerCase().includes(search.value.toLowerCase())).sort((a, b) => b.updated - a.updated);
        count.textContent = `${posts.length} \u7BC7\u5E16\u5B50`;
        list.replaceChildren();
        let shown = 0;
        const more = this.button("\u52A0\u8F7D\u66F4\u591A", () => draw());
        const draw = () => {
          more.remove();
          for (const p of posts.slice(shown, shown + 50)) {
            const edit = this.button("\u7F16\u8F91\u5206\u7C7B", () => this.pickerFor({ id: p.id, ...p.meta }, edit));
            list.append(el("article", { class: "item" }, [el("div", { class: "row" }, [el("a", { text: p.meta.author || "\u67E5\u770B\u539F\u5E16", href: p.meta.url, target: "_blank", rel: "noopener noreferrer" }), el("span", { class: "muted", text: `${p.liked ? "\u5DF2\u70B9\u8D5E " : ""}${p.bookmarked ? "\u5DF2\u6536\u85CF" : ""}` })]), el("p", { class: "text", text: p.meta.text || "\uFF08\u56FE\u7247\u6216\u89C6\u9891\u5E16\u5B50\uFF09" }), el("div", { class: "row" }, p.categories.map((id) => el("span", { class: "pill", text: this.app.store.state.categories.get(id)?.name || "" }))), el("div", { class: "actions" }, [edit, this.button("\u5220\u9664\u8BB0\u5F55", async () => {
              await this.app.store.put("post", p.id, "deleted", true);
              render();
              this.toast("\u8BB0\u5F55\u5DF2\u5220\u9664\uFF1B\u4E0D\u4F1A\u53D6\u6D88 X \u4E0A\u7684\u70B9\u8D5E\u6216\u6536\u85CF");
            }, "danger")])]));
          }
          shown += 50;
          if (shown < posts.length) list.append(more);
        };
        draw();
        if (!posts.length) list.append(el("p", { class: "empty", text: "\u8FD8\u6CA1\u6709\u8BB0\u5F55\u3002\u5728\u5E16\u5B50\u4E0B\u65B9\u70B9\u300C\u5206\u7C7B\u300D\uFF0C\u6216\u70B9\u8D5E\u3001\u6536\u85CF\u540E\u6DFB\u52A0\u3002" }));
      };
      [search, category, action].forEach((n) => n.addEventListener("input", render));
      panel.append(el("div", { class: "stack" }, [el("div", { class: "row" }, [search, category, action]), count, list]));
      render();
    }
    categoryManager(panel) {
      const name = el("input", { placeholder: "\u65B0\u5206\u7C7B\u540D\u79F0", "aria-label": "\u65B0\u5206\u7C7B\u540D\u79F0", maxlength: "60", class: "grow" });
      const list = el("div", { class: "list" });
      const render = () => list.replaceChildren(...this.categories().map((c) => {
        const input = el("input", { value: c.name, "aria-label": `\u91CD\u547D\u540D ${c.name}`, maxlength: "60", class: "grow" });
        return el("div", { class: "row item" }, [input, this.button("\u91CD\u547D\u540D", async () => {
          const next = input.value.trim();
          if (!next) throw new Error("\u8BF7\u8F93\u5165\u5206\u7C7B\u540D\u79F0");
          if (this.categories().some((other) => other.id !== c.id && other.name.toLowerCase() === next.toLowerCase())) throw new Error("\u8BE5\u5206\u7C7B\u5DF2\u5B58\u5728");
          await this.app.store.put("category", c.id, "name", next);
          render();
        }), this.button("\u5220\u9664\u5206\u7C7B", async () => {
          await this.app.store.put("category", c.id, "deleted", true);
          render();
          this.toast("\u5206\u7C7B\u5DF2\u5220\u9664\uFF0C\u5E16\u5B50\u8BB0\u5F55\u4FDD\u7559");
        }, "danger")]);
      }));
      panel.append(el("div", { class: "stack" }, [el("div", { class: "row" }, [name, this.button("\u65B0\u5EFA\u5206\u7C7B", async () => {
        await this.app.store.category(name.value);
        name.value = "";
        render();
      }, "primary")]), list]));
      render();
    }
    settings(panel) {
      const server = el("input", { value: this.app.server, "aria-label": "\u540C\u6B65\u670D\u52A1\u5730\u5740", class: "grow" });
      const state = el("p", { class: "muted", role: "status", text: this.app.status() });
      const content = el("div", { class: "stack" }, [state]);
      if (this.app.preview) content.append(el("p", { text: "\u5F53\u524D\u4E3A\u9875\u9762\u9884\u89C8\uFF1A\u6570\u636E\u4EC5\u5B58\u672C\u6D4F\u89C8\u5668\uFF0C\u5237\u65B0\u540E\u9700\u91CD\u65B0\u52A0\u8F7D\u811A\u672C\u3002\u5B89\u88C5\u6CB9\u7334\u7248\u672C\u540E\u53EF\u767B\u5F55\u540C\u6B65\u3002" }));
      else {
        content.append(el("label", { text: "\u540C\u6B65\u670D\u52A1\uFF08\u6B63\u5F0F\u7AD9\u6216\u672C\u5730\u5F00\u53D1\u5730\u5740\uFF09" }), server);
        if (this.app.account) content.append(el("div", { class: "actions" }, [this.button("\u7ACB\u5373\u540C\u6B65", async () => {
          await this.app.sync();
          state.textContent = this.app.status();
        }), this.button("\u9000\u51FA\u540C\u6B65\u8D26\u53F7", async () => {
          await this.app.logout();
          this.manager("settings");
        })]));
        else content.append(this.button("\u767B\u5F55\u5E76\u540C\u6B65", async () => {
          await this.app.login(server.value);
          state.textContent = this.app.status();
        }, "primary"));
      }
      content.append(el("div", { class: "actions" }, [this.button("\u5BFC\u51FA\u5907\u4EFD", () => {
        const blob = new Blob([JSON.stringify(this.app.store.export(), null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob), link = el("a", { href: url, download: `post-classifier-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json` });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1e3);
      }), this.button("\u5BFC\u5165\u5907\u4EFD", () => input.click())]));
      const input = el("input", { type: "file", accept: "application/json,.json", hidden: "" });
      input.addEventListener("change", this.run(async () => {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) throw new Error("\u5907\u4EFD\u4E0D\u80FD\u8D85\u8FC7 20 MB");
        await this.app.store.import(JSON.parse(await file.text()));
        this.toast("\u5907\u4EFD\u5DF2\u5408\u5E76");
      }));
      content.append(
        input,
        el("p", { class: "muted", text: "\u672C\u5730\u64CD\u4F5C\u4F1A\u7ACB\u5373\u4FDD\u5B58\u3002\u540C\u6B65\u5931\u8D25\u65F6\u4FDD\u7559\u5F85\u540C\u6B65\u4FEE\u6539\uFF1B\u5BFC\u51FA\u6587\u4EF6\u4E0D\u5305\u542B\u767B\u5F55\u51ED\u636E\u3002" }),
        this.button("\u6062\u590D\u5206\u7C7B\u5E93\u9ED8\u8BA4\u4F4D\u7F6E", () => this.launcherDrag.reset())
      );
      panel.append(content);
    }
    destroy() {
      this.launcherDrag.destroy();
      this.closePicker();
      clearTimeout(this.toastTimer);
      document.removeEventListener("pointerdown", this.outside, true);
      document.removeEventListener("keydown", this.escape);
      window.removeEventListener("resize", this.reposition);
      window.removeEventListener("scroll", this.reposition, true);
      this.host.remove();
    }
  };

  // src/platforms/x.js
  function extractPost(article) {
    const time = [...article.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector("time") && a.closest("article") === article);
    const match = time?.getAttribute("href")?.match(/^\/([^/]+)\/status\/(\d+)$/);
    if (!match) return null;
    const text = article.querySelector('[data-testid="tweetText"]')?.textContent || "";
    const state = {};
    if (article.querySelector('[data-testid="like"], [data-testid="unlike"]')) state.liked = !!article.querySelector('[data-testid="unlike"]');
    if (article.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]')) state.bookmarked = !!article.querySelector('[data-testid="removeBookmark"]');
    return { id: `x:${match[2]}`, url: `https://x.com/${match[1]}/status/${match[2]}`, author: `@${match[1]}`, text: text.slice(0, 1e4), ...state };
  }
  function mountX({ openPicker, changedAction, label, onError }) {
    let scheduled = false;
    function decorate() {
      scheduled = false;
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const post = extractPost(article);
        if (!post) continue;
        const actions = article.querySelector('[data-testid="like"], [data-testid="unlike"]')?.closest('[role="group"]');
        if (!actions) continue;
        let host = article.querySelector("[data-jingyu-post]");
        if (!host) {
          host = document.createElement("div");
          host.dataset.jingyuPost = post.id;
          const shadow = host.attachShadow({ mode: "open" });
          shadow.innerHTML = '<style>button{font:12px system-ui;color:#1d9bf0;border:1px solid #53647166;border-radius:999px;background:transparent;padding:5px 10px;cursor:pointer;margin:6px 0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button:hover{background:#1d9bf018}button:focus-visible{outline:2px solid #1d9bf0}</style><button type="button" title="\u7F16\u8F91\u5E16\u5B50\u5206\u7C7B"></button>';
          shadow.querySelector("button").addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const current = extractPost(article);
            if (current) openPicker(current, host).catch(onError);
          });
          actions.insertAdjacentElement("afterend", host);
        }
        host.dataset.jingyuPost = post.id;
        const button = host.shadowRoot.querySelector("button");
        const next = label(post.id);
        if (button.textContent !== next) button.textContent = next;
      }
    }
    function schedule() {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(decorate);
      }
    }
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    const timers = /* @__PURE__ */ new Set();
    function later(fn, ms) {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    }
    const sequences = /* @__PURE__ */ new Map();
    function clicked(event) {
      const button = event.target.closest?.("button[data-testid]");
      const action = button?.dataset.testid;
      if (!["like", "unlike", "bookmark", "removeBookmark"].includes(action)) return;
      const article = button.closest('article[data-testid="tweet"]');
      const post = article && extractPost(article);
      if (!post) return;
      const field = ["like", "unlike"].includes(action) ? "liked" : "bookmarked";
      const activeId = field === "liked" ? "unlike" : "removeBookmark";
      const inactiveId = field === "liked" ? "like" : "bookmark";
      const wanted = ["like", "bookmark"].includes(action);
      const key = post.id + field, sequence = (sequences.get(key) || 0) + 1;
      sequences.set(key, sequence);
      let tries = 0;
      const check = () => {
        if (sequences.get(key) !== sequence) return;
        const currentArticle = [...document.querySelectorAll('article[data-testid="tweet"]')].find((a) => extractPost(a)?.id === post.id);
        if (!currentArticle) return;
        const currentButton = currentArticle.querySelector(`[data-testid="${activeId}"], [data-testid="${inactiveId}"]`);
        const active = currentButton?.dataset.testid === activeId;
        if (currentButton && active === wanted) {
          const currentPost = extractPost(currentArticle);
          changedAction(post, field, active).then(() => wanted && openPicker(currentPost, currentButton)).catch(onError);
          later(() => {
            if (sequences.get(key) !== sequence || !currentArticle.isConnected || extractPost(currentArticle)?.id !== post.id) return;
            const latest = currentArticle.querySelector(`[data-testid="${activeId}"], [data-testid="${inactiveId}"]`);
            if (latest && latest.dataset.testid === activeId !== active) changedAction(post, field, !active).catch(onError);
          }, 5e3);
        } else if (++tries < 20) later(check, 150);
      };
      later(check, 250);
    }
    document.addEventListener("click", clicked, true);
    decorate();
    return { refresh: schedule, destroy() {
      observer.disconnect();
      document.removeEventListener("click", clicked, true);
      for (const t of timers) clearTimeout(t);
      document.querySelectorAll("[data-jingyu-post]").forEach((x) => x.remove());
    } };
  }

  // src/main.js
  var preview = typeof GM_getValue !== "function";
  var api = preview ? {
    async get(k, fallback) {
      const v = localStorage.getItem("jingyu-preview:" + k);
      return v === null ? fallback : JSON.parse(v);
    },
    async set(k, v) {
      localStorage.setItem("jingyu-preview:" + k, JSON.stringify(v));
    },
    async list() {
      return Object.keys(localStorage).filter((k) => k.startsWith("jingyu-preview:")).map((k) => k.slice(15));
    },
    async remove(k) {
      localStorage.removeItem("jingyu-preview:" + k);
    }
  } : {
    async get(k, fallback) {
      return GM_getValue(k, fallback);
    },
    async set(k, v) {
      return GM_setValue(k, v);
    },
    async list() {
      return GM_listValues();
    },
    async remove(k) {
      return GM_deleteValue(k);
    },
    request(options) {
      return new Promise((resolve, reject) => GM_xmlhttpRequest({
        ...options,
        anonymous: true,
        onload(res) {
          let data;
          try {
            data = JSON.parse(res.responseText);
          } catch {
            return reject(new Error("\u540C\u6B65\u670D\u52A1\u5C1A\u672A\u5C31\u7EEA\u6216\u8FD4\u56DE\u683C\u5F0F\u4E0D\u6B63\u786E"));
          }
          if (res.status < 200 || res.status >= 300) {
            const err = new Error(res.status === 401 ? "\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55" : data.error || `\u540C\u6B65\u5931\u8D25\uFF08${res.status}\uFF09`);
            err.status = res.status;
            reject(err);
          } else resolve(data);
        },
        onerror() {
          reject(new Error("\u65E0\u6CD5\u8FDE\u63A5\u540C\u6B65\u670D\u52A1\uFF0C\u672C\u5730\u4FEE\u6539\u5DF2\u4FDD\u7559"));
        },
        ontimeout() {
          reject(new Error("\u540C\u6B65\u8D85\u65F6\uFF0C\u672C\u5730\u4FEE\u6539\u5DF2\u4FDD\u7559"));
        }
      }));
    }
  };
  async function start() {
    if (document.getElementById("jingyu-post-classifier")) return;
    const account = preview ? null : await api.get("pc:account", null);
    const app = {
      preview,
      account,
      server: account?.server || await api.get("pc:server", DEFAULT_SERVER),
      message: "",
      busy: false,
      status() {
        return this.message || (this.account ? `\u8D26\u53F7 ${this.account.user.name} \xB7 \u81EA\u52A8\u540C\u6B65\u5DF2\u5F00\u542F` : "\u672C\u5730\u6A21\u5F0F \xB7 \u672A\u767B\u5F55");
      },
      async changeScope(scope) {
        this.store = new Store(api, scope);
        await this.store.load();
        this.store.onchange = () => {
          adapter?.refresh();
          scheduleSync();
        };
        adapter?.refresh();
      },
      async sync() {
        if (this.busy || !this.account || preview) return;
        this.busy = true;
        const currentStore = this.store, currentAccount = this.account;
        try {
          const task = () => synchronize(api, currentStore, currentAccount);
          if (navigator.locks) await navigator.locks.request("jingyu-post-classifier-sync", task);
          else await task();
          this.message = `\u5DF2\u540C\u6B65 \xB7 ${(/* @__PURE__ */ new Date()).toLocaleTimeString()} \xB7 ${currentAccount.user.name}`;
          adapter.refresh();
        } catch (e) {
          this.message = e.message;
          if (e.status === 401) {
            this.account = null;
            await api.remove("pc:account");
            ui.toast("\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u672C\u5730\u6570\u636E\u4FDD\u7559\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
          }
        } finally {
          this.busy = false;
        }
      },
      async login(value) {
        if (this.loggingIn) throw new Error("\u6388\u6743\u7A97\u53E3\u5DF2\u6253\u5F00\uFF0C\u8BF7\u5148\u5B8C\u6210\u6388\u6743");
        const server = allowedServer(value);
        if (!server) throw new Error("\u4EC5\u652F\u6301 tools.jingyu.dev \u6216\u672C\u5730\u5F00\u53D1\u670D\u52A1");
        this.loggingIn = true;
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map((n) => n.toString(16).padStart(2, "0")).join("");
        try {
          const result = await request(api, server, "/api/post-classifier/connect", { token, label: "\u5E16\u5B50\u5206\u7C7B\u811A\u672C \xB7 " + (/* @__PURE__ */ new Date()).toLocaleDateString() });
          GM_openInTab(server + "/post-classifier/connect?request=" + encodeURIComponent(result.id), { active: true, insert: true });
          ui.toast("\u8BF7\u5728 tools \u9875\u9762\u767B\u5F55\u5E76\u6388\u6743\uFF0C\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u8FD4\u56DE\u540C\u6B65\u72B6\u6001");
          this.message = "\u7B49\u5F85 tools \u6388\u6743\u2026";
          const until = Date.now() + 10 * 60 * 1e3;
          while (Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 2e3));
            const state = await request(api, server, "/api/post-classifier/session", {}, token);
            if (state.pending) continue;
            const guest = this.store.scope === "guest" ? this.store.export() : null;
            this.account = { server, token, user: state.user };
            this.server = server;
            await api.set("pc:account", this.account);
            await api.set("pc:server", server);
            await this.changeScope(encodeURIComponent(server) + ":" + state.user.id);
            if (guest?.operations.length && confirm(`\u662F\u5426\u5C06 ${guest.operations.length} \u6761\u672C\u5730\u4FEE\u6539\u5408\u5E76\u5230 ${state.user.name} \u7684\u5206\u7C7B\u5E93\uFF1F`)) await this.store.import(guest);
            this.message = "";
            await this.sync();
            ui.manager("settings");
            ui.toast("\u5DF2\u767B\u5F55\uFF0C\u5206\u7C7B\u5E93\u5DF2\u5207\u6362\u5230\u5F53\u524D\u8D26\u53F7");
            return;
          }
          throw new Error("\u6388\u6743\u5DF2\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5");
        } finally {
          this.loggingIn = false;
        }
      },
      async logout() {
        if (this.busy) throw new Error("\u6B63\u5728\u540C\u6B65\uFF0C\u8BF7\u7A0D\u540E\u518D\u9000\u51FA");
        if (this.account) {
          try {
            await request(api, this.account.server, "/api/post-classifier/revoke", {}, this.account.token);
          } catch {
            ui.toast("\u5DF2\u9000\u51FA\u672C\u5730\u8D26\u53F7\uFF1B\u672A\u80FD\u64A4\u9500\u4E91\u7AEF\u51ED\u636E\uFF0C\u53EF\u5728 tools \u6388\u6743\u9875\u9762\u64A4\u9500");
          }
        }
        this.account = null;
        this.message = "";
        await api.remove("pc:account");
        await this.changeScope("guest");
      }
    };
    let adapter, syncTimer;
    function scheduleSync() {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        void app.sync();
      }, 1200);
    }
    await app.changeScope(account ? encodeURIComponent(account.server) + ":" + account.user.id : "guest");
    const ui = new UI(app);
    adapter = mountX({
      openPicker: (post, anchor) => ui.pickerFor(post, anchor),
      label: (id) => ui.label(id),
      onError: (e) => ui.toast(e.message),
      async changedAction(post, field, value) {
        await app.store.record(post);
        await app.store.put("post", post.id, field, value);
        if (value) await app.store.put("post", post.id, "deleted", false);
      }
    });
    const refresh = async () => {
      const latest = preview ? null : await api.get("pc:account", null);
      if ((latest?.token || "") !== (app.account?.token || "")) {
        app.account = latest;
        app.message = "";
        await app.changeScope(latest ? encodeURIComponent(latest.server) + ":" + latest.user.id : "guest");
        ui.closePicker();
        ui.overlay && ui.manager();
      } else await app.store.load();
      adapter.refresh();
    };
    if (!preview && typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener("pc:changed", (_key, _old, _new, remote) => {
        if (remote) void refresh().catch((e) => ui.toast(e.message));
      });
      GM_addValueChangeListener("pc:account", (_key, _old, _new, remote) => {
        if (remote) void refresh().catch((e) => ui.toast(e.message));
      });
    }
    window.addEventListener("online", scheduleSync);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        void refresh().catch((e) => ui.toast(e.message));
        scheduleSync();
      }
    });
    setInterval(() => {
      if (!document.hidden) scheduleSync();
    }, 3e4);
    if (!preview) GM_registerMenuCommand("\u6253\u5F00\u5E16\u5B50\u5206\u7C7B\u5E93", () => ui.manager());
    scheduleSync();
  }
  void start().catch((error) => console.error("[\u5E16\u5B50\u5206\u7C7B]", error.message));
})();
