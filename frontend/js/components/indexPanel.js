// indexPanel.js — indexing a subreddit: options, progress bar, stats once indexed.
// Used on the home page (each card) and on the page of a subreddit that isn't indexed yet.
//
// Options (shown when you click "Index…" or "re-index"):
//   [✓ Study period] 2021-02-24 → 2023-02-24     keep only comments from this period (default ON)
//   [  Keep raw JSON of comments]                 ≈3× bigger index (default OFF)

import { h, api, enc, fmtNum, startPolling, stopPolling } from '../utils.js';
import { getConfig } from '../store.js';
import { toggleChip } from './toggleChip.js';

const PHASES = {
  start: 'starting',
  submissions: 'reading posts',
  comments: 'reading comments',
  finalize: 'building the index',
};

export function indexPanel(sub, initialStatus, onReady) {
  const box = h('div', { class: 'index-panel' });
  let current = initialStatus;

  async function showForm() {
    const cfg = await getConfig();
    const meta = current.meta || {};
    const start = h('input', { type: 'date', value: meta.period_start || cfg.period_start });
    const end = h('input', { type: 'date', value: meta.period_end || cfg.period_end });
    const dates = h('span', { class: 'chip-row' }, start, '→', end);
    const period = toggleChip('Study period', true, on => { dates.hidden = !on; },
      'Keep only comments from this period: smaller index, and big files are read completely');
    const raw = toggleChip('Keep raw JSON of comments', false, null,
      'Makes the index ≈3× bigger; only needed for the "{ } JSON" button on comments');
    const err = h('div', { class: 'small error' });
    const go = h('button', {
      class: 'btn primary',
      onclick: async (e) => {
        e.stopPropagation();
        err.textContent = '';
        const qs = new URLSearchParams({ sub });
        if (period.isOn()) { qs.set('start', start.value); qs.set('end', end.value); }
        if (raw.isOn()) qs.set('raw', '1');
        try {
          render(await api('/api/index?' + qs, { method: 'POST' }));
          poll();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    }, current.ready ? 'Re-index' : 'Start indexing');
    box.replaceChildren(h('div', { class: 'ip-form', onclick: e => e.stopPropagation() },
      h('div', { class: 'chip-row' }, period, dates),
      h('div', { class: 'chip-row' }, raw),
      err,
      h('div', { class: 'chip-row' }, go, h('button', { class: 'btn', onclick: () => render(current) }, 'Cancel'))));
  }

  function render(st) {
    current = st;
    box.replaceChildren();
    const job = st.job || {};
    if (st.building) {
      const pct = Math.round((job.progress || 0) * 100);
      box.append(
        h('div', { class: 'small muted' },
          `Indexing: ${PHASES[job.phase] || job.phase} — ${fmtNum(job.rows)} lines read` +
          (job.kept != null && job.phase !== 'finalize' ? `, ${fmtNum(job.kept)} kept` : '') + ` (${pct}%)`),
        h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })));
    } else if (st.ready) {
      const m = st.meta;
      box.append(
        h('div', { class: 'small muted' },
          `${fmtNum(m.posts)} posts · ${fmtNum(m.comments)} comments`,
          m.partial ? ' · ' : '', m.partial ? h('span', { class: 'chip nsfw' }, 'partial') : null),
        h('div', { class: 'small muted' },
          m.period_start ? `period ${m.period_start} → ${m.period_end}` : 'whole history',
          ' · ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); showForm(); } }, '↻ re-index')));
    } else {
      if (job.state === 'error') box.append(h('div', { class: 'small error' }, 'Error: ' + job.error));
      box.append(h('button', {
        class: 'btn primary',
        onclick: (e) => { e.stopPropagation(); showForm(); },
      }, 'Index…'));
    }
  }

  function poll() {
    startPolling('index:' + sub, async () => {
      const s = await api(`/api/status?sub=${enc(sub)}`);
      render(s);
      if (!s.building) {
        stopPolling('index:' + sub);
        if (s.ready && onReady) onReady();
      }
    });
  }

  render(initialStatus);
  if (initialStatus.building) poll();
  return box;
}
