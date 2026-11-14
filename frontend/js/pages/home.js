// home.js — home page (#/):
//   1. "Annotations in this repository": what you and your teammates labelled (from Git),
//      and whether this computer has the archives / index needed to open those threads
//   2. all subreddits found locally in subreddits24/

import { app, crumb, h, api, enc, fmtSize } from '../utils.js';
import { getAnnotator } from '../store.js';
import { indexPanel } from '../components/indexPanel.js';

const sameName = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

function whoList(annotators, me) {
  return annotators.map(a => `${a.annotator}${sameName(a.annotator, me) ? ' (you)' : ''}: ${a.count}`).join(' · ');
}

/** One subreddit that has annotations: who labelled what, and what's missing locally. */
function coverageItem(s, me) {
  let status;
  if (s.missing_files.length) {
    status = h('div', { class: 'cov-status missing' },
      h('div', {}, '✗ Missing on this computer: ',
        ...s.missing_files.flatMap((f, i) => [i ? ', ' : '', h('code', {}, f)])),
      h('div', { class: 'small muted' },
        'Download them from the subreddits24 torrent into the subreddits24/ folder, then reload this page.'));
  } else if (!s.indexed) {
    status = h('div', { class: 'cov-status todo' },
      h('div', {}, '⚠ Archives found, but not indexed yet:'),
      indexPanel(s.subreddit, s.status, viewHome));
  } else {
    status = h('div', { class: 'cov-status ok' }, '✓ Ready — click a thread to see the labelled comments');
  }

  const posts = h('ul', { class: 'cov-posts' },
    ...s.posts.map(p => h('li', {},
      s.indexed
        ? h('a', { href: `#/r/${enc(s.subreddit)}/p/${enc(p.link_id)}` }, p.title || p.link_id)
        : h('span', {}, p.title || p.link_id),
      h('span', { class: 'small muted' }, ' — ' + whoList(p.annotators, me)))),
    s.more_posts ? h('li', { class: 'small muted' }, `+ ${s.more_posts} more threads`) : null);

  return h('div', { class: 'cov-sub' },
    h('div', { class: 'cov-head' },
      s.indexed ? h('a', { href: `#/r/${enc(s.subreddit)}` }, h('b', {}, 'r/' + s.subreddit)) : h('b', {}, 'r/' + s.subreddit),
      h('span', { class: 'small muted' }, `${s.count} labels · ${whoList(s.annotators, me)}`)),
    status,
    posts);
}

function coverageSection(cov, me) {
  if (!cov.length) return null;
  return h('div', { class: 'card section coverage' },
    h('h2', {}, 'Annotations in this repository'),
    h('p', { class: 'small muted' },
      'What you and your teammates have labelled (annotations/annotators/*.jsonl, synced with git pull). ' +
      'To open these threads you need the same .zst archives on this computer.'),
    ...cov.map(s => coverageItem(s, me)));
}

export async function viewHome() {
  crumb.textContent = '';
  app.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));

  const [subs, cov] = await Promise.all([
    api('/api/subreddits'),
    api('/api/annotations/coverage').catch(() => []),
  ]);
  const me = getAnnotator();

  const grid = h('div', { class: 'grid' });
  for (const s of subs) {
    const big = (s.sizes.comments || 0) > 1e9 || (s.sizes.submissions || 0) > 1e9;
    grid.append(h('div', { class: 'card sub-card' },
      h('h3', {}, h('a', { href: `#/r/${enc(s.name)}` }, 'r/' + s.name)),
      h('div', { class: 'small muted' }, `posts: ${fmtSize(s.sizes.submissions)} · comments: ${fmtSize(s.sizes.comments)}`),
      big ? h('div', { class: 'small muted' }, '⚠ very large file: only the first 2M lines are indexed') : null,
      indexPanel(s.name, s, viewHome)));
  }

  app.replaceChildren(...[
    h('div', { class: 'card intro' },
      h('h1', {}, 'Reddit archives (Pushshift)'),
      h('div', { class: 'muted' },
        'Pick a subreddit. Opening it the first time builds a local index (cache/*.sqlite) — ' +
        'for small subreddits this takes a few seconds to a minute.')),
    coverageSection(cov, me),
    subs.length
      ? h('h2', { class: 'home-title' }, 'Subreddits on this computer')
      : h('div', { class: 'card notice' },
          h('b', {}, 'No archives found in subreddits24/. '),
          'Download the .zst files you need from the subreddits24 torrent (e.g. freeworldnews_comments.zst and ' +
          'freeworldnews_submissions.zst), put them in the subreddits24/ folder, then reload this page.'),
    subs.length ? grid : null,
  ].filter(Boolean));
}
