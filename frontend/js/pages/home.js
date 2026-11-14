// home.js — home page (#/): all subreddits found in subreddits24/.

import { app, crumb, h, api, enc, fmtSize } from '../utils.js';
import { indexPanel } from '../components/indexPanel.js';

export async function viewHome() {
  crumb.textContent = '';
  app.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));

  const subs = await api('/api/subreddits');
  const grid = h('div', { class: 'grid' });
  for (const s of subs) {
    const big = (s.sizes.comments || 0) > 1e9 || (s.sizes.submissions || 0) > 1e9;
    grid.append(h('div', { class: 'card sub-card' },
      h('h3', {}, h('a', { href: `#/r/${enc(s.name)}` }, 'r/' + s.name)),
      h('div', { class: 'small muted' }, `posts: ${fmtSize(s.sizes.submissions)} · comments: ${fmtSize(s.sizes.comments)}`),
      big ? h('div', { class: 'small muted' }, '⚠ very large file: only the first 2M lines are indexed') : null,
      indexPanel(s.name, s, viewHome)));
  }

  app.replaceChildren(
    h('div', { class: 'card intro' },
      h('h1', {}, 'Reddit archives (Pushshift)'),
      h('div', { class: 'muted' },
        'Pick a subreddit. Opening it the first time builds a local index (cache/*.sqlite) — ' +
        'for small subreddits this takes a few seconds to a minute.')),
    grid);
}
