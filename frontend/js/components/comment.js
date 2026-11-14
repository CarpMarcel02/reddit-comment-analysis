// comment.js — one comment in the tree (recursive: it also renders its replies).
//
// ctx = { sub, post, highlight, annotations, ... } — data shared by the whole tree.
// c.kids = replies to this comment (built in pages/post.js from parent_id).

import { h, md, fmtDate, fmtRel, fmtNum, colorFor, isBot, isDeleted, isUsable, wordsNoQuotes, rawToggle } from '../utils.js';
import { rateButton } from './rateMenu.js';

export function countAll(c) {
  return 1 + c.kids.reduce((s, k) => s + countAll(k), 0);
}

function avatar(c) {
  const gone = c.author === '[deleted]';
  const letter = (c.author || '?').replace(/^\W+/, '')[0]?.toUpperCase() || '?';
  return h('div', { class: 'avatar', style: `background:${gone ? 'var(--deleted)' : colorFor(c.author)}` }, letter);
}

export function renderComment(c, ctx) {
  const deleted = isDeleted(c.body);
  const words = deleted ? 0 : wordsNoQuotes(c.body);
  const bot = isBot(c.author);
  const usable = isUsable(c);
  const isOP = ctx.post && !ctx.post.missing && c.author && c.author !== '[deleted]' && c.author === ctx.post.author;
  const isRoot = (c.parent || '').startsWith('t3_');

  const el = h('div', { class: 'comment' + (ctx.highlight && usable ? ' ok' : '') });
  const toggle = h('span', { class: 'toggle' });
  const rawMount = h('div', {});
  const collapse = () => {
    el.classList.toggle('collapsed');
    toggle.textContent = el.classList.contains('collapsed') ? `[+] ${countAll(c)}` : '';
  };

  // header: author, badges, points, date
  const head = h('div', { class: 'chead', onclick: e => { if (!e.target.closest('a,button')) collapse(); } },
    h('span', { class: 'author' }, c.author || '?'),
    isOP ? h('span', { class: 'op' }, 'OP') : null,
    c.distinguished ? h('span', { class: 'mod' }, c.distinguished.toUpperCase()) : null,
    bot ? h('span', { class: 'chip bot' }, 'bot') : null,
    h('span', { class: 'muted' }, '•'),
    h('span', { class: 'muted' }, `${fmtNum(c.score)} points`),
    c.controv ? h('span', { title: 'controversiality = 1', style: 'color:var(--accent)' }, '†') : null,
    h('span', { class: 'muted' }, '•'),
    h('span', { class: 'muted' }, fmtDate(c.created)),
    ctx.post?.created ? h('span', { class: 'muted' }, `(${fmtRel(c.created, ctx.post.created)} after post)`) : null,
    c.edited ? h('span', { class: 'muted' }, '• edited') : null,
    toggle,
    // the "Rate" button on the right (not for deleted comments)
    !deleted && ctx.annotations ? rateButton(c, ctx) : null);

  // text
  const body = deleted
    ? h('div', { class: 'cbody deleted' }, c.body || '[empty]')
    : h('div', { class: 'cbody md', html: md(c.body) });

  // footer
  const foot = h('div', { class: 'cfoot' },
    h('span', { title: 'words, excluding quoted lines (>)' }, `${words} words`),
    usable ? h('span', { class: 'chip ok' }, '25–300 ✓') : null,
    h('span', {}, 'id: ' + c.id),
    h('span', { title: 'parent_id' }, isRoot ? '↳ reply to the post' : '↳ reply to ' + (c.parent || '').slice(3)),
    h('button', { onclick: rawToggle(ctx.sub, 'comment', c.id, rawMount) }, '{ } JSON'));

  // teammates' labels (only when "show teammates' labels" is on)
  const otherList = ctx.showOthers ? ctx.others?.get(c.id) : null;
  const others = otherList?.length
    ? h('div', { class: 'others' },
        ...otherList.map(a => h('span', {
          class: 'other-chip', style: `--label-color:${a.color}`, title: a.note ? 'Note: ' + a.note : '',
        }, h('span', { class: 'label-dot' }), `${a.annotator}: ${a.label_name}`, a.unsure ? ' ?' : '')))
    : null;

  // replies (recursive)
  const kids = h('div', {}, ...c.kids.map(k => renderComment(k, ctx)));

  el.append(
    h('div', { class: 'rail' }, avatar(c), h('button', { class: 'line', title: 'Collapse thread', onclick: collapse })),
    h('div', { class: 'body-wrap' }, ...[head, body, foot, others, rawMount, kids].filter(Boolean)));
  return el;
}
