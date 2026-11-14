// indexPanel.js — the "Index" button + progress bar + stats once indexed.
// Used on the home page (each card) and on the page of a subreddit that isn't indexed yet.

import { h, api, enc, fmtNum, startPolling, stopPolling } from '../utils.js';

const PHASES = {
  start: 'starting',
  submissions: 'reading posts',
  comments: 'reading comments',
  finalize: 'building the index',
};

export function indexPanel(sub, initialStatus, onReady) {
  const box = h('div', {});

  function render(st) {
    box.replaceChildren();
    const job = st.job || {};
    if (st.building) {
      const pct = Math.round((job.progress || 0) * 100);
      box.append(
        h('div', { class: 'small muted' }, `Indexing: ${PHASES[job.phase] || job.phase} — ${fmtNum(job.rows)} lines (${pct}%)`),
        h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })));
    } else if (st.ready) {
      const m = st.meta;
      box.append(h('div', { class: 'small muted' },
        `${fmtNum(m.posts)} posts · ${fmtNum(m.comments)} comments`,
        m.partial ? ' · ' : '', m.partial ? h('span', { class: 'chip nsfw' }, 'partial') : null));
    } else {
      if (job.state === 'error') box.append(h('div', { class: 'small error' }, 'Error: ' + job.error));
      box.append(h('button', {
        class: 'btn primary',
        onclick: async (e) => {
          e.stopPropagation();
          e.target.disabled = true;
          render(await api(`/api/index?sub=${enc(sub)}`, { method: 'POST' }));
          poll();
        },
      }, 'Index'));
    }
  }

  function poll() {
    startPolling(async () => {
      const s = await api(`/api/status?sub=${enc(sub)}`);
      render(s);
      if (!s.building) {
        stopPolling();
        if (s.ready && onReady) onReady();
      }
    });
  }

  render(initialStatus);
  if (initialStatus.building) poll();
  return box;
}
