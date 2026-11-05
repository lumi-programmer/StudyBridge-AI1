// Small SVG charts drawn from recorded rows. No chart library, no remote fonts.
import { h, svg } from './ui.js';

export function barChart(series, { height = 150, unit = '', color = 'var(--indigo)', label = 'Chart' } = {}) {
  const width = Math.max(260, series.length * 34);
  const max = Math.max(1, ...series.map(item => item.value));
  const pad = { top: 14, bottom: 26, left: 6, right: 6 };
  const inner = height - pad.top - pad.bottom;
  const step = (width - pad.left - pad.right) / Math.max(1, series.length);
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img', 'aria-label': label, preserveAspectRatio: 'none' });
  root.appendChild(svg('line', { x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom, class: 'chart-axis' }));
  series.forEach((item, index) => {
    const barH = item.value ? Math.max(3, (item.value / max) * inner) : 0;
    const x = pad.left + index * step + step * 0.18;
    const w = step * 0.64;
    const y = height - pad.bottom - barH;
    const bar = svg('rect', { x, y, width: w, height: barH, rx: 4, fill: item.color || color, class: 'chart-bar' });
    const title = svg('title');
    title.textContent = `${item.label}: ${item.value}${unit ? ` ${unit}` : ''}`;
    bar.appendChild(title);
    root.appendChild(bar);
    if (item.value) {
      const t = svg('text', { x: x + w / 2, y: y - 4, 'text-anchor': 'middle', class: 'chart-val' });
      t.textContent = String(item.value);
      root.appendChild(t);
    }
    const lab = svg('text', { x: x + w / 2, y: height - 8, 'text-anchor': 'middle', class: 'chart-lab' });
    lab.textContent = item.short || item.label;
    root.appendChild(lab);
  });
  return h('div', { class: 'chart-wrap scroll-x' }, root);
}

// Activity calendar: one square per recorded day, shaded by study minutes.
export function heatmap(days, { valueFn = d => d.minutes, title = d => `${d.day}: ${d.minutes} min` } = {}) {
  const max = Math.max(1, ...days.map(item => valueFn(item)));
  const grid = h('div', { class: 'heat', role: 'img', 'aria-label': 'Study calendar' });
  const first = new Date(`${days[0]?.day}T00:00:00`);
  const offset = Number.isNaN(first.getTime()) ? 0 : (first.getDay() + 6) % 7;
  for (let i = 0; i < offset; i += 1) grid.appendChild(h('span', { class: 'heat-cell pad' }));
  for (const day of days) {
    const value = valueFn(day);
    const level = value ? Math.min(4, 1 + Math.floor((value / max) * 3.999)) : 0;
    const active = value > 0 || day.login || day.answered || day.sessions > 0;
    grid.appendChild(h('span', {
      class: `heat-cell l${level}${active && !value ? ' touched' : ''}${day.goalDone ? ' goal' : ''}`,
      title: title(day),
    }));
  }
  return h('div', { class: 'heat-wrap' },
    h('div', { class: 'heat-days tiny muted' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => h('span', { text: d }))),
    grid);
}

export function ring(value, max, { size = 112, label = '', sub = '' } = {}) {
  const r = (size - 14) / 2;
  const c = 2 * Math.PI * r;
  const share = max ? Math.min(1, value / max) : 0;
  const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'ring', role: 'img', 'aria-label': `${label} ${Math.round(share * 100)}%` });
  root.appendChild(svg('circle', { cx: size / 2, cy: size / 2, r, class: 'ring-bg' }));
  root.appendChild(svg('circle', {
    cx: size / 2, cy: size / 2, r, class: 'ring-fg',
    'stroke-dasharray': `${c * share} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})`,
  }));
  return h('div', { class: 'ring-wrap', style: { width: `${size}px`, height: `${size}px` } }, root,
    h('div', { class: 'ring-center' }, h('b', { text: label }), sub ? h('small', { text: sub }) : null));
}

export function meter(value, max, { tone = '' } = {}) {
  const share = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return h('div', { class: `meter ${tone}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value) },
    h('span', { style: { width: `${share}%` } }));
}
