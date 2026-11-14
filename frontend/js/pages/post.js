// post.js — post page (#/r/<sub>/p/<id>): the post on top, the comment tree below.
// Each comment has the "Rate" button on its right (components/rateMenu.js).

import { app, crumb, h, api, enc, isUsable } from '../utils.js';
import { getAnnotator } from '../store.js';
import { postCard } from '../components/postCard.js';
import { renderComment } from '../components/comment.js';

const SORTERS = {
  best: (a, b) => b.score - a.score,
  old: (a, b) => a.created - b.created,
  new: (a, b) => b.created - a.created,
};

/** Flat list of comments → tree, using parent_id.
 *  parent = "t3_..." → reply to the post (root)
 *  parent = "t1_..." → reply to another comment
 *  orphans = comments whose parent is missing from the archive */
function buildTree(comments) {
  const byId = new Map();
  comments.forEach(c => { c.kids = []; byId.set(c.id, c); });
  const roots = [], orphans = [];
  for (const c of comments) {
    const parent = c.parent || '';
    if (parent.startsWith('t3_')) roots.push(c);
    else {
      const p = byId.get(parent.slice(3));
      if (p) p.kids.push(c); else orphans.push(c);
    }
  }
  return { roots, orphans };
}

function sortTree(list, cmp) {
  list.sort(cmp);
  list.forEach(c => sortTree(c.kids, cmp));
}

/** The current annotator's labels for the comments of this post. */
async function loadAnnotations(postId) {
  const who = getAnnotator();
  const map = new Map();
  if (!who) return map;
  const list = await api(`/api/annotations?link=${enc(postId)}&annotator=${enc(who)}`);
  list.forEach(a => map.set(a.comment_id, a));
  return map;
}

export async function viewPost(sub, id) {
  crumb.replaceChildren('/ ', h('a', { href: `#/r/${enc(sub)}` }, 'r/' + sub), ' / ' + id);
  app.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));

  // if the labels can't be loaded, still show the post (with a warning)
  let annotWarning = null;
  const annotPromise = loadAnnotations(id).catch(e => {
    annotWarning = h('div', { class: 'card notice small error' },
      `Couldn't load your labels (${e.message}). If you updated the code, restart the server (Ctrl+C, then py app.py).`);
    return new Map();
  });

  let data, annotations;
  try {
    [data, annotations] = await Promise.all([api(`/api/post?sub=${enc(sub)}&id=${enc(id)}`), annotPromise]);
  } catch (e) {
    app.replaceChildren(h('div', { class: 'card empty error' }, e.message));
    return;
  }

  const post = data.post;
  const top = post.missing
    ? h('div', { class: 'card notice' }, `Post ${id} isn't in the submissions archive (maybe a partial index), but it has comments.`)
    : postCard(sub, post, true);

  const { roots, orphans } = buildTree(data.comments);
  const tree = h('div', {});
  const ratedInfo = h('span', { class: 'small rated-info' });

  const ctx = {
    sub, post, annotations,
    highlight: false,
    sort: 'best',
    onAnnotated: updateRatedInfo,
    onAnnotatorChange: async () => {          // annotator changed → reload their labels
      ctx.annotations = await loadAnnotations(id);
      renderTree();
      updateRatedInfo();
    },
  };

  function updateRatedInfo() {
    const who = getAnnotator();
    ratedInfo.textContent = who
      ? `🏷 ${ctx.annotations.size} labelled by ${who}`
      : '🏷 click "Rate" to start';
  }

  function renderTree() {
    sortTree(roots, SORTERS[ctx.sort]);
    sortTree(orphans, SORTERS[ctx.sort]);
    tree.replaceChildren(...roots.map(c => renderComment(c, ctx)));
    if (orphans.length) {
      tree.append(
        h('div', { class: 'small muted orphans-title' }, `Comments whose parent is missing from the archive (${orphans.length}):`),
        ...orphans.map(c => renderComment(c, ctx)));
    }
    if (!data.comments.length) tree.append(h('div', { class: 'empty' }, 'No comments in the archive.'));
  }

  const usableCount = data.comments.filter(isUsable).length;
  const sortSelect = h('select', { onchange: e => { ctx.sort = e.target.value; renderTree(); } },
    h('option', { value: 'best' }, 'Sort: score'),
    h('option', { value: 'old' }, 'Sort: oldest'),
    h('option', { value: 'new' }, 'Sort: newest'));
  const highlight = h('input', { type: 'checkbox', onchange: e => { ctx.highlight = e.target.checked; renderTree(); } });

  renderTree();
  updateRatedInfo();
  app.replaceChildren(...[annotWarning, top].filter(Boolean),
    h('div', { class: 'card comments-box' },
      h('div', { class: 'comments-head' },
        h('b', {}, `${data.comments.length} comments`),
        ratedInfo,
        h('label', { class: 'small', title: 'not deleted, not a bot, 25–300 words (excluding quotes)' },
          highlight, ` highlight usable for the project (${usableCount})`),
        sortSelect),
      tree));
}
