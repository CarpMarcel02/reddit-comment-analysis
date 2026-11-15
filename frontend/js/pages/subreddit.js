// subreddit.js — subreddit page (#/r/<sub>): list of posts with filters and pagination.

import { app, crumb, h, api, enc, fmtNum, currentNav } from '../utils.js';
import { indexPanel } from '../components/indexPanel.js';
import { postCard } from '../components/postCard.js';
import { toggleChip } from '../components/toggleChip.js';

const SORT_OPTIONS = [
  ['comments', 'Most comments'],
  ['score', 'Top (score)'],
  ['new', 'Newest'],
  ['old', 'Oldest'],
];

// filters are kept while the tab is open (e.g. when you come back from a post)
const filters = {};

function banner(sub) {
  return h('div', { class: 'card' },
    h('div', { class: 'sub-banner' }),
    h('div', { class: 'sub-head' },
      h('div', { class: 'icon' }, sub[0].toUpperCase()),
      h('div', {}, h('h1', {}, 'r/' + sub), h('div', { class: 'muted small' }, 'Pushshift archive'))));
}

export async function viewSub(sub) {
  const nav = currentNav();
  crumb.textContent = '/ r/' + sub;
  const st = await api(`/api/status?sub=${enc(sub)}`);
  if (nav !== currentNav()) return;      // navigated away while loading

  if (!st.ready) {
    app.replaceChildren(banner(sub), h('div', { class: 'card notice' },
      h('p', {}, 'This subreddit hasn\'t been indexed yet.'),
      indexPanel(sub, st, () => viewSub(sub))));
    return;
  }

  const F = filters[sub] ||= { sort: 'comments', q: '', min: 1, page: 0, self: false, period: true };
  const hasPeriod = !!st.meta.period_start;

  // controls
  const search = h('input', { type: 'search', placeholder: 'Search titles…', value: F.q });
  const sort = h('select', {}, ...SORT_OPTIONS.map(([v, t]) => h('option', { value: v, selected: F.sort === v }, t)));
  const min = h('input', { type: 'number', min: 0, value: F.min, style: 'width:70px' });
  const self = toggleChip('Text posts only', F.self, () => applyFilters());
  const period = hasPeriod
    ? toggleChip(`Study period (${st.meta.period_start} → ${st.meta.period_end})`, F.period, () => applyFilters(),
        'Only posts created inside the period this subreddit was indexed for')
    : null;
  const info = h('span', { class: 'small muted' });
  const list = h('div', {});
  const pager = h('div', { class: 'pager' });

  const applyFilters = () => {
    F.q = search.value.trim(); F.sort = sort.value; F.min = +min.value || 0; F.self = self.isOn();
    F.period = period ? period.isOn() : false;
    F.page = 0;
    load();
  };
  let debounce = null;
  search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(applyFilters, 350); });
  [sort, min].forEach(el => el.addEventListener('change', applyFilters));

  const goTo = (page) => { F.page = page; load(); window.scrollTo(0, 0); };

  async function load() {
    list.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    const qs = `sub=${enc(sub)}&sort=${F.sort}&q=${enc(F.q)}&min=${F.min}&page=${F.page}&self=${F.self ? 1 : 0}` +
      `&period=${hasPeriod && F.period ? 1 : 0}`;
    const data = await api('/api/posts?' + qs);
    if (nav !== currentNav()) return;

    info.textContent = `${fmtNum(data.total)} posts`;
    list.replaceChildren(...data.posts.map(p => postCard(sub, p, false)));
    if (!data.posts.length) list.append(h('div', { class: 'card empty' }, 'No posts match these filters.'));

    const pages = Math.max(1, Math.ceil(data.total / data.page_size));
    pager.replaceChildren(
      h('button', { class: 'btn', disabled: F.page === 0, onclick: () => goTo(F.page - 1) }, '‹ Previous'),
      h('span', { class: 'muted' }, `page ${F.page + 1} of ${pages}`),
      h('button', { class: 'btn', disabled: F.page + 1 >= pages, onclick: () => goTo(F.page + 1) }, 'Next ›'));
  }

  app.replaceChildren(...[
    banner(sub),
    st.meta.partial
      ? h('div', { class: 'card notice small' }, 'Partial index: the file is very large, so only the first 2,000,000 lines were read (the oldest period).')
      : null,
    h('div', { class: 'card controls' },
      search, sort,
      h('label', { class: 'small' }, 'min. comments', min),
      self, period,
      info),
    list, pager,
  ].filter(Boolean));   // replaceChildren(null) would render the text "null"
  load();
}
