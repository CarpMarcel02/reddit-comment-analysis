// postCard.js — a post card.
//   full = false → short version in the list (click → post page)
//   full = true  → full version: text, video/image/link, raw JSON

import { h, enc, md, fmtDate, fmtNum, isDeleted, rawToggle } from '../utils.js';

function votes(score) {
  return h('div', { class: 'votes' },
    h('span', { class: 'arrow up' }), fmtNum(score), h('span', { class: 'arrow down' }));
}

function unavailable(what, url) {
  return e => e.target.replaceWith(h('div', { class: 'small muted' }, `${what} is no longer available: ${url}`));
}

function mediaBlock(p) {
  const out = [];
  if (p.video) {
    out.push(h('video', { class: 'media', src: p.video, controls: true, preload: 'metadata', onerror: unavailable('The video', p.video) }));
  } else if (p.image) {
    out.push(h('img', { class: 'media', src: p.image, loading: 'lazy', alt: '', onerror: unavailable('The image', p.image) }));
  }
  if (!p.is_self && p.url && !p.image) {
    out.push(h('a', { class: 'linkbox', href: p.url, target: '_blank', rel: 'noopener noreferrer' },
      p.thumb ? h('img', { src: p.thumb, alt: '', onerror: e => e.target.remove() }) : null,
      h('span', {}, p.url)));
  }
  return out;
}

export function postCard(sub, p, full) {
  const meta = h('div', { class: 'meta' },
    h('b', {}, 'r/' + sub), '•', 'Posted by', h('span', {}, 'u/' + (p.author || '?')), '•',
    h('span', {}, fmtDate(p.created)),
    p.flair ? h('span', { class: 'chip flair' }, p.flair) : null,
    p.nsfw ? h('span', { class: 'chip nsfw' }, 'NSFW') : null);

  const content = h('div', { class: 'content' }, meta,
    h('div', {},
      h('h2', {}, p.title || '(no title)'),
      !p.is_self && p.domain ? h('span', { class: 'domain' }, ' (' + p.domain + ')') : null));

  if (full) {
    if (p.selftext && !isDeleted(p.selftext)) content.append(h('div', { class: 'md', html: md(p.selftext) }));
    else if (p.selftext) content.append(h('div', { class: 'cbody deleted' }, p.selftext));
    content.append(...mediaBlock(p));
  }

  const rawMount = h('div', {});
  content.append(
    h('div', { class: 'actions' },
      h('span', {}, `💬 ${fmtNum(p.found)} comments in archive`),
      p.num_comments != null ? h('span', { title: 'num_comments stored in the post' }, `(num_comments: ${p.num_comments})`) : null,
      p.ratio != null ? h('span', {}, `${Math.round(p.ratio * 100)}% upvoted`) : null,
      full ? h('button', { onclick: rawToggle(sub, 'post', p.id, rawMount) }, '{ } Raw JSON') : null,
      full && p.permalink ? h('a', { href: 'https://www.reddit.com' + p.permalink, target: '_blank', rel: 'noopener noreferrer' }, '↗ reddit.com') : null,
      h('span', {}, 'id: ' + p.id)),
    rawMount);

  const card = h('div', { class: 'card post ' + (full ? 'full' : 'list') },
    votes(p.score), content,
    !full && p.thumb ? h('img', { class: 'thumb', src: p.thumb, alt: '', loading: 'lazy', onerror: e => e.target.remove() }) : null);

  if (!full) {
    card.addEventListener('click', (e) => {
      if (!e.target.closest('a,button')) location.hash = `#/r/${enc(sub)}/p/${enc(p.id)}`;
    });
  }
  return card;
}
