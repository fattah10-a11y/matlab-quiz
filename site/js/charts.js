// Score-trend line, histogram columns and topic bars. Single series, one hue,
// hairline grid, values labeled sparingly, hover/focus tooltips on every mark.
import { esc, fmtPct, statusLabel } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

function tooltip(container) {
  let tip = container.querySelector('.tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    container.appendChild(tip);
  }
  return {
    show(x, y, value, label) {
      tip.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = value;
      const span = document.createElement('span');
      span.textContent = label;
      tip.append(strong, span);
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(x, half), container.clientWidth - half)}px`;
      tip.style.top = `${y}px`;
    },
    hide() { tip.hidden = true; }
  };
}

// Re-renders when the container width changes.
function responsive(container, draw) {
  let width = 0;
  const run = () => {
    const w = container.clientWidth;
    if (w && w !== width) { width = w; draw(w); }
  };
  new ResizeObserver(run).observe(container);
  run();
}

// points: [{ value: 0-100, label: 'Quiz 3 · Oct 21' }]
export function scoreTrend(container, points, { height = 220 } = {}) {
  container.classList.add('chart');
  if (!points.length) {
    container.innerHTML = '<p class="empty-chart">Your scores will appear here after your first quiz.</p>';
    return;
  }
  responsive(container, width => {
    container.querySelector('svg')?.remove();
    const pad = { top: 16, right: 44, bottom: 28, left: 44 };
    const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
    const x = i => pad.left + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
    const y = v => pad.top + h - (v / 100) * h;
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img',
      'aria-label': `Score trend over ${points.length} quizzes. Latest ${fmtPct(points.at(-1).value)}.` });
    svg.setAttribute('tabindex', '0');

    const grid = el('g', { class: 'grid' }, svg);
    for (const v of [0, 25, 50, 75, 100]) {
      el('line', { x1: pad.left, x2: pad.left + w, y1: y(v), y2: y(v) }, grid);
      el('text', { x: pad.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' }, svg).textContent = `${v}%`;
    }
    const step = Math.max(1, Math.ceil(points.length / 8));
    points.forEach((_, i) => {
      if (i % step === 0 || i === points.length - 1) {
        el('text', { x: x(i), y: height - 8, 'text-anchor': 'middle', class: 'axis-text' }, svg).textContent = `#${i + 1}`;
      }
    });

    if (points.length > 1) {
      const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('');
      el('path', { d: `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`, class: 'series-area' }, svg);
      el('path', { d: line, class: 'series-line' }, svg);
    }
    const crosshair = el('line', { y1: pad.top, y2: pad.top + h, class: 'crosshair', visibility: 'hidden' }, svg);
    const dots = points.map((p, i) => el('circle', { cx: x(i), cy: y(p.value), r: 4, class: 'dot' }, svg));
    const last = points.at(-1);
    el('text', { x: x(points.length - 1) + 10, y: y(last.value) + 4, class: 'value-text' }, svg).textContent = fmtPct(last.value);

    container.prepend(svg);
    const tip = tooltip(container);
    let active = -1;
    const activate = i => {
      active = i;
      dots.forEach((d, j) => d.setAttribute('r', j === i ? 6 : 4));
      if (i < 0) { crosshair.setAttribute('visibility', 'hidden'); tip.hide(); return; }
      crosshair.setAttribute('x1', x(i));
      crosshair.setAttribute('x2', x(i));
      crosshair.setAttribute('visibility', 'visible');
      tip.show(x(i), y(points[i].value), fmtPct(points[i].value), points[i].label);
    };
    svg.addEventListener('pointermove', event => {
      const rect = svg.getBoundingClientRect();
      const px = (event.clientX - rect.left) * (width / rect.width);
      let best = 0;
      points.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
      activate(best);
    });
    svg.addEventListener('pointerleave', () => activate(-1));
    svg.addEventListener('blur', () => activate(-1));
    svg.addEventListener('focus', () => activate(points.length - 1));
    svg.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft') { activate(Math.max(0, active - 1)); event.preventDefault(); }
      if (event.key === 'ArrowRight') { activate(Math.min(points.length - 1, active + 1)); event.preventDefault(); }
    });
  });
}

// bins: [{ label: '80–89%', count: 12 }]; edges: the bin boundaries, one more than bins.
export function histogram(container, bins, { edges, format = v => v, height = 220, unit = 'quizzes' } = {}) {
  container.classList.add('chart');
  const max = Math.max(...bins.map(b => b.count));
  if (!max) {
    container.innerHTML = '<p class="empty-chart">No submitted quizzes yet.</p>';
    return;
  }
  responsive(container, width => {
    container.querySelector('svg')?.remove();
    const pad = { top: 20, right: 8, bottom: 28, left: 36 };
    const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
    const top = Math.max(4, Math.ceil(max / 4) * 4);
    const y = v => pad.top + h - (v / top) * h;
    const slot = w / bins.length;
    const barW = Math.min(24, slot - 2);
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img',
      'aria-label': `Score distribution: ${bins.map(b => `${b.label} ${b.count}`).join(', ')}` });
    const grid = el('g', { class: 'grid' }, svg);
    for (let v = 0; v <= top; v += top / 4) {
      el('line', { x1: pad.left, x2: pad.left + w, y1: y(v), y2: y(v) }, grid);
      el('text', { x: pad.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-text' }, svg).textContent = v;
    }
    const tip = tooltip(container);
    bins.forEach((b, i) => {
      const cx = pad.left + slot * i + slot / 2;
      if (b.count) {
        const bh = y(0) - y(b.count), r = Math.min(4, bh);
        const x0 = cx - barW / 2, y0 = y(b.count);
        el('path', { class: 'bar', d: `M${x0},${y(0)}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + barW - r}Q${x0 + barW},${y0} ${x0 + barW},${y0 + r}V${y(0)}Z` }, svg);
        el('text', { x: cx, y: y0 - 6, 'text-anchor': 'middle', class: 'value-text' }, svg).textContent = b.count;
      }
      const hit = el('rect', { x: pad.left + slot * i, y: pad.top, width: slot, height: h, class: 'hit', tabindex: 0,
        'aria-label': `${b.label}: ${b.count} ${unit}` }, svg);
      const show = () => tip.show(cx, y(b.count), `${b.count} ${b.count === 1 ? unit.replace(/s$/, '') : unit}`, b.label);
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', () => tip.hide());
      hit.addEventListener('blur', () => tip.hide());
    });
    const every = bins.length > 6 && width < 560 ? 2 : 1;
    edges.forEach((edge, i) => {
      if (i % every === 0 || i === edges.length - 1) {
        el('text', { x: pad.left + slot * i, y: height - 8, 'text-anchor': 'middle', class: 'axis-text' }, svg).textContent = format(edge);
      }
    });
    container.prepend(svg);
  });
}

// topics: [{ title, week, answered, correct }]. Weak topics get an icon + label.
export function topicBars(container, topics, { weakBelow = 60, minAnswered = 3, twoColumns = false } = {}) {
  container.innerHTML = `<div class="bars ${twoColumns ? 'two-col' : ''}">${topics.map(t => {
    const value = t.answered ? Math.round((t.correct / t.answered) * 100) : null;
    const weak = value !== null && t.answered >= minAnswered && value < weakBelow;
    const width = value === null ? '0px' : `calc((100% - 9.5rem) * ${Math.max(value, 1) / 100})`;
    return `<div class="bar-row" data-tip="${esc(`${t.correct} of ${t.answered} correct`)}">
      <div class="bar-label">${esc(t.title)}<div class="bar-sub"><span>${esc(t.week)}</span>${weak ? statusLabel('warn', 'Needs review') : ''}</div></div>
      <div class="bar-track">
        <div class="bar-fill ${value === null ? 'empty' : ''}" style="width:${width}"></div>
        <span class="bar-value">${value === null ? '<span class="muted">Not answered yet</span>'
          : `${value}% <span class="muted">· ${t.answered} answered</span>`}</span>
      </div></div>`;
  }).join('')}</div>`;
  container.classList.add('chart');
  const tip = tooltip(container);
  for (const row of container.querySelectorAll('.bar-row')) {
    const fill = row.querySelector('.bar-fill');
    if (fill.classList.contains('empty')) continue;
    row.addEventListener('pointerenter', () => {
      const c = container.getBoundingClientRect(), f = fill.getBoundingClientRect();
      tip.show(f.right - c.left, f.top - c.top, row.dataset.tip, row.querySelector('.bar-label').firstChild.textContent);
    });
    row.addEventListener('pointerleave', () => tip.hide());
  }
}
