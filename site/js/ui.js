// Small DOM, formatting and text-rendering helpers shared by every page.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Inline text: escapes HTML, then turns `code` into <code>.
export function inline(text) {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

const KEYWORDS = new Set(['if', 'elseif', 'else', 'end', 'for', 'while', 'switch', 'case', 'otherwise', 'try', 'catch',
  'function', 'return', 'break', 'continue', 'global', 'persistent']);

// Light MATLAB highlighting: keywords, strings and % comments. A quote after a
// name, number, closing bracket, dot or another quote is a transpose, not a string.
export function highlightMatlab(code) {
  let out = '', i = 0;
  const prevSignificant = () => out.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, 'x').slice(-1);
  while (i < code.length) {
    const c = code[i];
    if (c === '%') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      out += `<span class="tk-com">${esc(code.slice(i, stop))}</span>`;
      i = stop;
    } else if (c === '"' || (c === "'" && !/[\w)\]}.']/.test(prevSignificant()))) {
      let j = i + 1;
      while (j < code.length && code[j] !== '\n') {
        if (code[j] === c && code[j + 1] === c) { j += 2; continue; }
        if (code[j] === c) { j++; break; }
        j++;
      }
      out += `<span class="tk-str">${esc(code.slice(i, j))}</span>`;
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      const word = code.slice(i).match(/^[A-Za-z_]\w*/)[0];
      const isField = out.endsWith('.');
      out += KEYWORDS.has(word) && !isField ? `<span class="tk-kw">${word}</span>` : esc(word);
      i += word.length;
    } else {
      out += esc(c);
      i++;
    }
  }
  return out;
}

// Question text: paragraphs, inline `code`, and ```fenced``` MATLAB blocks.
export function richText(markdown) {
  const parts = String(markdown ?? '').split(/^```[a-z]*\n([\s\S]*?)^```\s*$/m);
  return parts.map((part, i) => {
    if (i % 2) return `<pre class="code"><code>${highlightMatlab(part.replace(/\n$/, ''))}</code></pre>`;
    return part.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${inline(p)}</p>`).join('');
  }).join('');
}

export const LETTERS = ['A', 'B', 'C', 'D'];

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtDate = value => value ? dateFormat.format(new Date(value)) : '—';
export const fmtDateTime = value => value ? dateTimeFormat.format(new Date(value)) : '—';

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const pct = (part, whole) => whole ? Math.round((part / whole) * 1000) / 10 : null;
export const fmtPct = value => value === null || value === undefined ? '—' : `${Number(value).toFixed(Number(value) % 1 ? 1 : 0)}%`;

export function relativeTime(value) {
  if (!value) return 'never';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : fmtDate(value);
}

let toastTimer;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// A modal with buttons; resolves with the value of the button pressed (or null).
export function dialog({ title, body, buttons }) {
  const el = $('#dialog');
  el.innerHTML = `<div class="dialog-body"><h2 id="dialog-title">${esc(title)}</h2>${body}
    <div class="dialog-actions">${buttons.map((b, i) =>
      `<button type="button" class="btn ${b.style || ''}" data-index="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
  return new Promise(resolve => {
    let result = null;
    el.onclick = event => {
      const button = event.target.closest('button[data-index]');
      if (button) { result = buttons[button.dataset.index].value; el.close(); }
      else if (event.target === el) el.close();
    };
    el.onclose = () => resolve(result);
    el.showModal();
    $$('button', el).at(-1).focus();
  });
}

export function statusLabel(kind, text) {
  const icon = { good: '✓', bad: '✗', warn: '⚠', neutral: '•' }[kind];
  return `<span class="status status-${kind}"><span aria-hidden="true">${icon}</span>${esc(text)}</span>`;
}

export function avatar(person) {
  const name = person?.full_name || person?.github_login || person?.email || '?';
  const initial = esc(name.trim()[0]?.toUpperCase() || '?');
  const url = person?.avatar_url;
  const img = url && /^https:\/\//.test(url) ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : '';
  return `<span class="avatar" aria-hidden="true">${initial}${img}</span>`;
}

export function displayName(person) {
  return person?.full_name || person?.github_login || person?.email || 'Student';
}
