// Focus remains in the search input; keyboard focus and selection are independent.
export function mountTagPicker({ el, store, postId, onClose, onError, onResize }) {
  const normal = text => text.trim().normalize('NFKC').toLocaleLowerCase();
  const tone = text => [...text].reduce((n, ch) => (n * 31 + ch.codePointAt(0)) >>> 0, 0) % 6;
  const chip = name => el('span', { class: `tag-chip tone-${tone(name)}`, text: name });
  const picker = el('section', { id: 'picker', role: 'dialog', tabindex: '-1', 'aria-label': '帖子分类' });
  const count = el('span', { class: 'picker-count' });
  const selectedTags = el('div', { class: 'selected-tags', 'aria-label': '已选标签' });
  const search = el('input', {
    id: 'tag-search', type: 'text', role: 'combobox', placeholder: '搜索或创建标签…',
    'aria-labelledby': 'tag-picker-title', 'aria-controls': 'tag-options', 'aria-expanded': 'false',
    'aria-autocomplete': 'list', 'aria-haspopup': 'listbox', 'aria-describedby': 'tag-keyboard-help',
    maxlength: '60', autocomplete: 'off', spellcheck: 'false'
  });
  const choices = el('div', { id: 'tag-options', role: 'listbox', 'aria-label': '标签', 'aria-multiselectable': 'true' });
  const suggestions = el('div', { class: 'picker-suggestions' }, [el('p', { class: 'picker-list-label', text: '选择标签' }), choices]);
  suggestions.hidden = true;
  const status = el('span', { class: 'picker-status', role: 'status', 'aria-live': 'polite', text: '自动保存' });
  picker.append(
    el('div', { class: 'picker-heading' }, [el('h3', { id: 'tag-picker-title', text: '分类' }), count]),
    selectedTags, el('div', { class: 'picker-search' }, [search]),
    suggestions,
    el('div', { class: 'picker-footer' }, [el('span', { id: 'tag-keyboard-help', text: '↑↓ 选择 · ↵ 切换 · Esc 关闭' }), status])
  );
  let entries = [], active = -1, busy = false, composing = false, destroyed = false;
  const selected = () => store.state.posts.get(postId)?.categories || [];
  const categories = () => [...store.state.categories.values()].filter(c => c.name && !c.deleted).sort((a,b) => b.updated - a.updated);
  function highlight(index, scroll = false) {
    active = index;
    [...choices.children].forEach((node, i) => node.classList.toggle('active', i === active));
    if (!suggestions.hidden && active >= 0 && entries[active]) {
      search.setAttribute('aria-activedescendant', `tag-option-${active}`);
      if (scroll) choices.children[active]?.scrollIntoView?.({ block: 'nearest' });
    } else search.removeAttribute('aria-activedescendant');
  }
  function render(preferredId) {
    if (destroyed) return;
    const all = categories(), ids = selected(), query = normal(search.value);
    entries = all.filter(c => normal(c.name).includes(query)).map(c => ({ ...c, create: false }));
    if (query && !all.some(c => normal(c.name) === query)) entries.unshift({ id: '__create', name: search.value.trim().normalize('NFKC'), create: true });
    count.textContent = ids.length ? `已选 ${ids.length}` : '可多选';
    const restoreChipFocus = selectedTags.contains(picker.getRootNode().activeElement);
    selectedTags.replaceChildren(...all.filter(c => ids.includes(c.id)).map(c => {
      const tag = chip(c.name);
      tag.classList.add('selected-tag');
      const remove = el('button', { type: 'button', class: 'tag-remove', text: '×',
        'aria-label': `移除标签 ${c.name}`, title: `移除标签 ${c.name}` });
      remove.addEventListener('pointerdown', event => event.preventDefault());
      remove.addEventListener('click', event => {
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
      const row = el('div', {
        id: `tag-option-${index}`, role: 'option', class: `tag-option${entry.create ? ' create-option' : ''}`,
        'aria-label': entry.create ? `创建标签 ${entry.name}` : entry.name,
        'aria-selected': String(checked), 'aria-disabled': String(busy)
      }, entry.create
        ? [el('span', { class: 'create-symbol', text: '+', 'aria-hidden': 'true' }), el('span', { text: '创建标签', class: 'create-label' }), chip(entry.name)]
        : [chip(entry.name), el('span', { class: 'tag-check', text: checked ? '✓' : '', 'aria-hidden': 'true' })]);
      row.addEventListener('pointerdown', e => e.preventDefault());
      row.addEventListener('pointermove', () => highlight(index));
      row.addEventListener('click', () => { highlight(index); void activate(); });
      return row;
    }));
    if (!entries.length) choices.append(el('p', { class: 'picker-empty', text: '还没有标签，输入名称即可创建' }));
    const preferred = entries.findIndex(entry => entry.id === preferredId);
    highlight(entries.length ? (preferred >= 0 ? preferred : 0) : -1);
    onResize();
  }
  async function activate(entry = entries[active], value) {
    if (!entry || busy || destroyed) return;
    busy = true; picker.setAttribute('aria-busy', 'true'); status.textContent = '保存中…';
    let id = entry.id;
    try {
      if (entry.create) id = await store.category(entry.name);
      await store.tag(postId, id, value ?? (entry.create || !selected().includes(id)));
      status.textContent = '已保存';
    } catch (error) { status.textContent = '保存失败'; onError(error); }
    finally { busy = false; picker.removeAttribute('aria-busy'); render(id); }
  }
  search.addEventListener('focus', () => {
    suggestions.hidden = false;
    search.setAttribute('aria-expanded', 'true');
    render();
  });
  search.addEventListener('blur', () => {
    suggestions.hidden = true;
    search.setAttribute('aria-expanded', 'false');
    search.removeAttribute('aria-activedescendant');
    onResize();
  });
  search.addEventListener('input', () => render());
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; render(); });
  search.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      if (entries.length) highlight((active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length, true);
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) void activate();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onClose(true);
    } else if (event.key === 'Tab') onClose(false);
    // Keep Home/End, left/right and Space available for normal text editing.
  });
  render();
  return { element: picker, focus: () => picker.focus({ preventScroll: true }), destroy() { destroyed = true; } };
}
