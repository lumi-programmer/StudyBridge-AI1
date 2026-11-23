// DOM helpers. Every string — book text, model output, names — goes through
// textContent, and there is no innerHTML sink anywhere in the app, so untrusted
// text can never become markup.
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value') node.value = value;
      else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') node[key] = Boolean(value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === undefined || child === null || child === false || child === true) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const svg = (name, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

// ---------- feedback ----------
const toastHost = () => document.getElementById('toasts');

export function toast(message, tone = '', ms = 5200) {
  const node = h('div', { class: `toast ${tone}` },
    h('span', {}, message),
    h('button', { class: 'x link-btn', type: 'button', 'aria-label': 'Dismiss', onClick: () => node.remove() }, '×'));
  toastHost().appendChild(node);
  setTimeout(() => node.remove(), ms);
  return node;
}

export function errorToast(error) {
  const text = error?.hint || error?.message || 'The request failed.';
  return toast(`${text}${error?.code && !error.hint ? ` (${error.code})` : ''}`, 'bad');
}

const sheetHost = () => document.getElementById('sheet');
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// One dialog at a time. The host element stays in the document; `hidden` plus the
// global [hidden] rule takes it out of layout and out of the a11y tree completely.
export function openSheet(content, { onClose } = {}) {
  const host = sheetHost();
  const panel = document.getElementById('sheetPanel');
  const previouslyFocused = document.activeElement;
  clear(panel);
  panel.appendChild(content);
  panel.tabIndex = -1;
  host.hidden = false;
  host.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    host.hidden = true;
    host.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onKey, true);
    clear(panel);
    if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    if (onClose) onClose();
  };
  const onKey = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter(node => node.type !== 'hidden');
    if (!items.length) { event.preventDefault(); panel.focus({ preventScroll: true }); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) { event.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
  };
  document.addEventListener('keydown', onKey, true);
  host.onclick = event => { if (event.target === host) close(); };
  (panel.querySelector('[data-autofocus]') || panel).focus({ preventScroll: true });
  return close;
}

export function sheetTitle(title, subtitle, actions) {
  return h('div', { class: 'sheet-head' },
    h('div', {}, h('h3', { text: title }), subtitle ? h('p', { class: 'tiny muted', style: { margin: '2px 0 0' }, text: subtitle }) : null),
    h('span', { class: 'spacer', style: { marginLeft: 'auto' } }),
    actions || null);
}

export function confirmSheet({ title, body, confirmLabel = 'Confirm', tone = '', requireTyped = null, onConfirm }) {
  let busy = false;
  const input = requireTyped ? h('input', { type: 'text', placeholder: `Type ${requireTyped}`, 'aria-label': `Type ${requireTyped}`, dataset: { autofocus: '1' } }) : null;
  const button = h('button', { class: `btn ${tone || ''}`, type: 'button', text: confirmLabel, onClick: async () => {
    if (busy) return;
    if (requireTyped && input.value.trim().toLowerCase() !== requireTyped.toLowerCase()) {
      toast(`Type “${requireTyped}” to confirm.`, 'bad');
      return;
    }
    busy = true;
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      await onConfirm();
      close();
    } catch (error) {
      busy = false;
      button.disabled = false;
      button.textContent = confirmLabel;
      errorToast(error);
    }
  } });
  const close = openSheet(h('div', {},
    sheetTitle(title),
    h('p', { class: 'muted', text: body }),
    input ? h('div', { class: 'field', style: { margin: '12px 0' } }, h('label', { text: 'Confirmation' }), input) : null,
    h('div', { class: 'row end', style: { marginTop: '16px' } },
      h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }),
      button)));
  return close;
}

// ---------- formatting ----------
export const nf = new Intl.NumberFormat('en');
export function num(value) { return nf.format(Number(value || 0)); }
export function pct(value) { return `${Math.round(Number(value || 0))}%`; }

export function minutesLabel(total) {
  const value = Number(total || 0);
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} h ${rest} m` : `${hours} h`;
}

export function dayLabel(iso) {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(iso || '');
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function timeAgo(iso) {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return '';
  const diff = Math.max(0, Date.now() - stamp);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(stamp).toLocaleDateString();
}

export function clock(seconds) {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const s = Math.floor(Math.max(0, seconds) % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// How long until the next daily reset. The instant itself comes from the
// server, so the device clock only ever decides how long to say it is.
export function untilLabel(iso) {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return '';
  const mins = Math.round((stamp - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

// Rates are entered by the student in their provider's billing unit, so no
// currency is claimed here.
export function microToText(micro) {
  const value = Number(micro || 0);
  if (!value) return '0 (unpriced)';
  return `≈ ${(value / 1000000).toFixed(value >= 1000000 ? 2 : 6)}`;
}

export const COLORS = ['indigo', 'teal', 'amber', 'rose', 'violet', 'emerald', 'sky', 'slate'];

export function spinner(label = 'Working…') {
  return h('div', { class: 'row muted tiny' }, h('span', { class: 'focus-dock-ring', 'aria-hidden': 'true' }), label);
}

export function debounce(fn, ms = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- layout pieces ----------
export function pageHead(eyebrow, title, lede, actions) {
  return h('header', { class: 'page-head' },
    h('div', {},
      eyebrow ? h('div', { class: 'eyebrow', text: eyebrow }) : null,
      h('h1', { text: title }),
      lede ? h('p', { class: 'lede', text: lede }) : null),
    actions ? h('div', { class: 'page-head-actions' }, actions) : null);
}

export function emptyState(title, body, action) {
  return h('div', { class: 'empty' }, h('h3', { text: title }), body ? h('p', { text: body }) : null, action || null);
}

export function field(label, control, hint) {
  const id = control.id || `f${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, hint ? h('span', { class: 'hint', text: hint }) : null);
}

export function select(options, value, props = {}) {
  return h('select', props, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
}

export function loadingCard(label = 'Loading…') {
  return h('div', { class: 'card' }, spinner(label));
}

export function errorCard(error, retry) {
  return h('div', { class: 'banner bad' },
    h('div', {}, h('b', { text: 'This section could not load.' }), h('span', { text: error?.hint || error?.message || 'Request failed.' })),
    retry ? h('button', { class: 'btn sm secondary', type: 'button', onClick: retry, style: { marginLeft: 'auto' } }, 'Retry') : null);
}

// Model output rendered as structure with textContent only: headings, bullets,
// numbered lines and paragraphs. No HTML from the model ever reaches the DOM.
export function richText(text, { dir } = {}) {
  const root = h('div', { class: 'rich', dir: dir || null });
  let list = null;
  let listTag = '';
  const inline = line => {
    const parts = String(line).split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.filter(Boolean).map(part => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return h('code', { text: part.slice(1, -1) });
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
        return h('strong', { text: part.slice(2, -2) });
      return document.createTextNode(part);
    });
  };
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { list = null; continue; }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    const bullet = line.match(/^\s*(?:[-*•])\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) { list = null; root.appendChild(h('h4', {}, inline(heading[1]))); continue; }
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      if (!list || listTag !== tag) { list = h(tag); listTag = tag; root.appendChild(list); }
      list.appendChild(h('li', {}, inline((bullet || numbered)[1])));
      continue;
    }
    list = null;
    root.appendChild(h('p', {}, inline(line)));
  }
  return root;
}

export function citationList(citations) {
  if (!citations?.length) return null;
  return h('div', { class: 'citations' },
    h('span', { class: 'stat-label', text: 'Your scanned sources' }),
    h('div', { class: 'row wrap-gap' }, citations.map(c => h('span', { class: 'tag teal', title: c.extraction === 'text_layer' ? 'Exact PDF text' : 'Vision transcription' },
      `${c.book ? `${c.book} · ` : ''}${c.chapter ? `${c.chapter} · ` : ''}p. ${c.page}`))));
}

export function modelTag(provider, model) {
  if (!model && !provider) return null;
  const name = model?.model_name || model?.model_id || '';
  const via = provider?.api_name || provider?.provider_key || '';
  return h('span', { class: 'tag grey', title: 'The model that wrote this' }, `${name}${via ? ` via ${via}` : ''}`);
}

export function colorDot(color) {
  return h('span', { class: `dot dot-${color || 'indigo'}`, 'aria-hidden': 'true' });
}
