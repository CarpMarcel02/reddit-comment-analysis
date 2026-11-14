// annotations.js — the "Annotations" page (#/annotations):
//   per-label statistics, list of labelled comments, CSV export.

import { app, crumb, h, api, enc, md, fmtDate, fmtNum } from '../utils.js';
import { getLabels, getAnnotator } from '../store.js';
import { rateButton } from '../components/rateMenu.js';

const filters = { annotator: null, label: '', unsure: false, page: 0 };

function statsBlock(s) {
  const total = s.total || 0;
  const bar = h('div', { class: 'stats-bar' },
    ...s.by_label.filter(l => l.count).map(l => h('div', {
      style: `width:${(100 * l.count / total).toFixed(2)}%;background:${l.color}`,
      title: `${l.name}: ${l.count}`,
    })));
  const legend = h('div', { class: 'stats-legend' },
    ...s.by_label.map(l => h('div', { class: 'stats-item', style: `--label-color:${l.color}` },
      h('span', { class: 'label-dot' }),
      h('span', {}, l.name),
      h('b', {}, String(l.count)),
      h('span', { class: 'muted' }, total ? `${Math.round(100 * l.count / total)}%` : '0%'),
      l.unsure ? h('span', { class: 'muted small' }, `(${l.unsure} unsure)`) : null)));
  return [
    h('div', { class: 'stats-total' }, h('b', {}, fmtNum(total)), ' labelled comments'),
    total ? bar : null,
    legend,
  ].filter(Boolean);
}

export async function viewAnnotations() {
  crumb.textContent = '/ Annotations';
  app.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));

  const me = getAnnotator();
  if (filters.annotator === null) filters.annotator = me;   // default: my annotations
  const F = filters;

  let labels;
  try { labels = await getLabels(true); }
  catch (e) { app.replaceChildren(h('div', { class: 'card empty error' }, e.message)); return; }

  const statsBox = h('div', { class: 'card section' });
  const listBox = h('div', {});
  const pager = h('div', { class: 'pager' });
  const info = h('span', { class: 'small muted' });

  const annotSel = h('select', {});
  const labelSel = h('select', {},
    h('option', { value: '' }, 'All labels'),
    ...labels.map(l => h('option', { value: l.id, selected: String(F.label) === String(l.id) }, l.name)));
  const unsureChk = h('input', { type: 'checkbox', checked: F.unsure });
  const exportLink = h('a', { class: 'btn primary', download: '' }, '⬇ Export CSV');

  const refreshExport = () => {
    exportLink.href = `/api/annotations/export.csv?annotator=${enc(F.annotator)}`;
    exportLink.textContent = F.annotator ? `⬇ Export CSV (${F.annotator})` : '⬇ Export CSV (everyone)';
  };

  async function loadStats() {
    const s = await api(`/api/annotations/stats?annotator=${enc(F.annotator)}`);
    statsBox.replaceChildren(
      ...s.errors.map(msg => h('div', { class: 'notice small error' }, '⚠ ' + msg)),
      h('h2', {}, 'Class distribution'),
      ...statsBlock(s),
      s.annotators.length
        ? h('div', { class: 'small muted files-info' },
            'Files (committed to Git): ',
            ...s.annotators.flatMap((a, i) => [i ? ' · ' : '', h('code', {}, a.file), ` (${a.count})`]))
        : h('div', { class: 'small muted files-info' }, 'Labels are saved to annotations/annotators/<your name>.jsonl'));
    const names = new Set(s.annotators.map(a => a.annotator));
    if (me) names.add(me);
    annotSel.replaceChildren(
      h('option', { value: '' }, 'All annotators'),
      ...[...names].map(n => {
        const cnt = s.annotators.find(a => a.annotator === n)?.count || 0;
        return h('option', { value: n, selected: n === F.annotator }, `${n}${n === me ? ' (me)' : ''} — ${cnt}`);
      }));
    annotSel.value = F.annotator;
  }

  function row(a) {
    const mine = me && a.annotator.trim().toLowerCase() === me.trim().toLowerCase();
    const map = new Map([[a.comment_id, a]]);
    const noteEl = h('div', { class: 'small muted' }, a.note ? '📝 ' + a.note : '');
    const el = h('div', { class: 'card annot-row' });
    const ctx = {
      sub: a.subreddit, annotations: map,
      onAnnotated: () => {
        const cur = map.get(a.comment_id);
        if (!cur) el.remove(); else noteEl.textContent = cur.note ? '📝 ' + cur.note : '';
        loadStats();
      },
    };
    const label = mine
      ? rateButton({ id: a.comment_id }, ctx)
      : h('span', { class: 'rate-btn rated', style: `--label-color:${a.color}` },
          h('span', { class: 'label-dot' }), a.label_name, a.unsure ? h('span', { class: 'unsure-mark' }, '?') : null);
    el.append(
      h('div', { class: 'annot-head' },
        h('a', { class: 'small annot-post', href: `#/r/${enc(a.subreddit)}/p/${enc(a.link_id)}` },
          `r/${a.subreddit} · ${a.post_title || a.link_id}`),
        label),
      h('div', { class: 'md annot-text', html: md(a.text) }),
      h('div', { class: 'small muted annot-meta' },
        `u/${a.author} · id: ${a.comment_id} · from ${a.source_file || a.subreddit} · labelled by ${a.annotator} · ${fmtDate(a.updated)}`),
      noteEl);
    return el;
  }

  async function loadList() {
    listBox.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    const d = await api(`/api/annotations?annotator=${enc(F.annotator)}&label=${F.label}&unsure=${F.unsure ? 1 : 0}&page=${F.page}`);
    info.textContent = `${fmtNum(d.total)} results`;
    listBox.replaceChildren(...d.items.map(row));
    if (!d.items.length) {
      listBox.append(h('div', { class: 'card empty' },
        'No annotations yet. Open a post and click "🏷 Rate" next to a comment.'));
    }
    const pages = Math.max(1, Math.ceil(d.total / d.page_size));
    pager.replaceChildren(
      h('button', { class: 'btn', disabled: F.page === 0, onclick: () => { F.page--; loadList(); window.scrollTo(0, 0); } }, '‹ Previous'),
      h('span', { class: 'muted' }, `page ${F.page + 1} of ${pages}`),
      h('button', { class: 'btn', disabled: F.page + 1 >= pages, onclick: () => { F.page++; loadList(); window.scrollTo(0, 0); } }, 'Next ›'));
  }

  const reload = () => { F.page = 0; refreshExport(); loadStats(); loadList(); };
  annotSel.addEventListener('change', () => { F.annotator = annotSel.value; reload(); });
  labelSel.addEventListener('change', () => { F.label = labelSel.value; F.page = 0; loadList(); });
  unsureChk.addEventListener('change', () => { F.unsure = unsureChk.checked; F.page = 0; loadList(); });

  refreshExport();
  app.replaceChildren(
    statsBox,
    h('div', { class: 'card controls' }, annotSel, labelSel,
      h('label', { class: 'small' }, unsureChk, 'unsure only'), info, exportLink),
    listBox, pager);
  await loadStats();
  loadList();
}
