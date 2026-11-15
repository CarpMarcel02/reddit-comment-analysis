// sample.js — the "Sample" page (#/sample):
//   1. settings: which subreddits, filters (on by default: no bots, no deleted, 25–300 words,
//      study period, balance before/after the event), sizes, seed, annotators → "Generate sample"
//   2. the sample: per subreddit/period counts, everyone's progress
//   3. your queue: one comment at a time (pilot → shared → mine), label with buttons or keys 1–9

import { app, crumb, h, api, send, enc, md, fmtDate, fmtNum, onLeave, currentNav } from '../utils.js';
import { getConfig, getLabels, getAnnotator } from '../store.js';
import { toggleChip } from '../components/toggleChip.js';
import { mediaBlock } from '../components/postCard.js';

const GROUP_TITLES = { pilot: 'Pilot', shared: 'Shared (Kappa)', own: 'Mine' };
const state = { group: null, index: null, settingsOpen: false };

export async function viewSample() {
  const nav = currentNav();
  crumb.textContent = '/ Sample';
  app.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  const me = getAnnotator();
  let sample, subs, cfg, labels;
  try {
    [sample, subs, cfg, labels] = await Promise.all([
      api(`/api/sample?annotator=${enc(me)}`), api('/api/subreddits'), getConfig(), getLabels(true),
    ]);
  } catch (e) {
    if (nav === currentNav()) app.replaceChildren(h('div', { class: 'card empty error' }, e.message));
    return;
  }
  if (nav !== currentNav()) return;      // you navigated away while it was loading
  if (!sample || state.settingsOpen) renderSettings(sample, subs, cfg, me);
  else renderSample(sample, subs, labels, me);
}

/* ============================================================ settings */

function numberInput(value, min = 0) {
  return h('input', { type: 'number', min, value });
}

function renderSettings(sample, subs, cfg, me) {
  const prev = sample?.settings;
  const pf = prev?.filters || {};
  const indexed = subs.filter(s => s.ready);
  const err = h('div', { class: 'small error' });
  const summary = h('div', { class: 'small sample-summary' });

  // --- subreddits (indexed ones are on by default)
  const subChips = subs.map(s => {
    const chip = toggleChip('r/' + s.name, s.ready && (prev ? prev.subreddits.includes(s.name) : true), update,
      s.ready ? null : 'Not indexed yet — index it on the home page first');
    chip.disabled = !s.ready;
    chip.dataset.sub = s.name;
    return chip;
  });

  // --- filters (all on by default)
  const minW = numberInput(pf.min_words ?? 25, 1);
  const maxW = numberInput(pf.max_words ?? 300, 1);
  const wordInputs = h('span', { class: 'chip-row' }, minW, '–', maxW, 'words');
  const pStart = h('input', { type: 'date', value: pf.period_start || cfg.period_start });
  const pEnd = h('input', { type: 'date', value: pf.period_end || cfg.period_end });
  const periodInputs = h('span', { class: 'chip-row' }, pStart, '→', pEnd);
  const ev = h('input', { type: 'date', value: pf.event_date || cfg.event_date });
  const evInputs = h('span', { class: 'chip-row' }, 'split at', ev);

  const noBots = toggleChip('No bots', pf.no_bots ?? true, null, 'Skip AutoModerator, autotldr and accounts with "bot" in the name');
  const noDeleted = toggleChip('No deleted / removed', pf.no_deleted ?? true);
  const english = toggleChip('English only', pf.english_only ?? true, null,
    'Skip comments written mostly in Cyrillic (Russian, Ukrainian); a quoted Russian word is fine');
  const words = toggleChip('Word range', pf.word_range ?? true, on => { wordInputs.hidden = !on; },
    'Word count excluding quoted lines (">")');
  const period = toggleChip('Study period', pf.period ?? true, on => { periodInputs.hidden = !on; });
  const balance = toggleChip('Balance before / after', pf.balance ?? true, on => { evInputs.hidden = !on; },
    'Half of each subreddit\'s comments from before the event, half from after');
  wordInputs.hidden = !words.isOn();
  periodInputs.hidden = !period.isOn();
  evInputs.hidden = !balance.isOn();

  // --- sizes
  const perSub = numberInput(prev?.per_subreddit ?? 25, 1);
  const shared = numberInput(prev?.shared ?? 50, 0);
  const pilot = numberInput(prev?.pilot ?? 20, 0);
  const seed = h('input', { type: 'text', value: prev?.seed ?? '42', style: 'width:80px' });
  const a1 = h('input', { type: 'text', value: prev?.annotators?.[0] ?? me, placeholder: 'annotator 1' });
  const a2 = h('input', { type: 'text', value: prev?.annotators?.[1] ?? '', placeholder: 'annotator 2 (optional)' });
  [perSub, shared, pilot, a1, a2].forEach(el => el.addEventListener('input', update));

  function chosenSubs() { return subChips.filter(c => c.isOn()).map(c => c.dataset.sub); }
  function annotators() { return [a1.value, a2.value].map(s => s.trim()).filter(Boolean); }

  function update() {
    const n = chosenSubs().length;
    const gold = n * (+perSub.value || 0);
    const k = Math.max(1, annotators().length);
    const own = Math.ceil(Math.max(0, gold - (+shared.value || 0)) / k);
    summary.replaceChildren(
      h('b', {}, `Gold set: ${n} subreddits × ${perSub.value} = ${gold} comments`),
      ` · shared (labelled by everyone, for Kappa): ${shared.value}`,
      ` · pilot (extra, not in the gold set): ${pilot.value}`,
      h('br'),
      `Each annotator labels ${+pilot.value + +shared.value + own}: ${pilot.value} pilot + ${shared.value} shared + ~${own} own.`);
  }

  async function generate() {
    err.textContent = '';
    if (sample && !confirm('Replace the current sample? Labels already given are kept, but the queue will change.')) return;
    const body = {
      subreddits: chosenSubs(),
      per_subreddit: +perSub.value, shared: +shared.value, pilot: +pilot.value, seed: seed.value,
      annotators: annotators(), me,
      filters: {
        no_bots: noBots.isOn(), no_deleted: noDeleted.isOn(), english_only: english.isOn(),
        word_range: words.isOn(), min_words: +minW.value, max_words: +maxW.value,
        period: period.isOn(), period_start: pStart.value, period_end: pEnd.value,
        balance: balance.isOn(), event_date: ev.value,
      },
    };
    genBtn.disabled = true;
    genBtn.textContent = 'Drawing comments…';
    const nav = currentNav();
    try {
      await send('POST', '/api/sample' + (sample ? '?force=1' : ''), body);
      state.settingsOpen = false;
      state.group = null;
      state.index = null;
      if (nav === currentNav()) viewSample();
    } catch (e) {
      err.textContent = e.message;
      genBtn.disabled = false;
      genBtn.textContent = sample ? 'Regenerate sample' : 'Generate sample';
    }
  }

  const genBtn = h('button', { class: 'btn primary', onclick: generate }, sample ? 'Regenerate sample' : 'Generate sample');
  update();

  app.replaceChildren(...[
    h('div', { class: 'card section' },
      h('h2', {}, sample ? 'Sample settings' : 'Create the annotation sample'),
      h('p', { class: 'small muted' },
        'Draws a random, reproducible sample of valid comments from the chosen subreddits — the same list for ' +
        'every annotator (saved to annotations/sample.json, commit it to Git). Same settings + same seed = same sample.'),
      indexed.length ? null : h('div', { class: 'notice small' }, 'No subreddit is indexed yet. Index them on the home page first (with the study period).'),

      h('h3', {}, 'Subreddits'),
      h('div', { class: 'chip-row' }, ...subChips),

      h('h3', {}, 'Filters'),
      h('div', { class: 'chip-row' }, noBots, noDeleted, english),
      h('div', { class: 'chip-row' }, words, wordInputs),
      h('div', { class: 'chip-row' }, period, periodInputs),
      h('div', { class: 'chip-row' }, balance, evInputs),

      h('h3', {}, 'Size'),
      h('div', { class: 'chip-row' },
        h('label', { class: 'small' }, 'per subreddit ', perSub),
        h('label', { class: 'small' }, 'shared ', shared),
        h('label', { class: 'small' }, 'pilot ', pilot),
        h('label', { class: 'small' }, 'seed ', seed)),

      h('h3', {}, 'Annotators'),
      h('div', { class: 'chip-row' }, a1, a2),

      summary,
      err,
      h('div', { class: 'chip-row' }, genBtn,
        sample ? h('button', { class: 'btn', onclick: () => { state.settingsOpen = false; viewSample(); } }, 'Cancel') : null)),
  ].filter(Boolean));
}

/* ============================================================ thread context */

const VISIBLE_CONTEXT = 4;     // ancestor comments shown by default; earlier ones behind a button
const MAX_INDENT = 6;

/** The post, then the chain of comments above the item (top-level first), then the item itself. */
function threadView(it, canLink) {
  // samples made before the context chain existed only have parent_text
  const chain = it.context || (it.parent_text ? [{ author: null, text: it.parent_text }] : []);
  const indent = d => `margin-left:${Math.min(d, MAX_INDENT) * 18}px`;

  const post = h('div', { class: 'sq-post' },
    h('div', { class: 'small muted' }, `Post in r/${it.subreddit}`),
    h('div', { class: 'sq-post-title' },
      canLink
        ? h('a', { href: `#/r/${enc(it.subreddit)}/p/${enc(it.link_id)}`, target: '_blank', title: 'Open the whole thread in a new tab' },
            it.post_title || it.link_id)
        : (it.post_title || it.link_id)),
    it.post_text ? h('div', { class: 'md sq-post-text', html: md(it.post_text) }) : null,
    it.post_media ? h('div', { class: 'sq-post-media' }, ...mediaBlock(it.post_media)) : null);

  const ctxNode = (c, depth) => h('div', { class: 'sq-ctx', style: indent(depth) },
    h('div', { class: 'small muted' }, c.text == null ? '[comment missing from the archive]' : `u/${c.author || '?'}`),
    c.text == null ? null : h('div', { class: 'md', html: md(c.text) }));

  const chainBox = h('div', {});
  const hiddenCount = Math.max(0, chain.length - VISIBLE_CONTEXT);
  const showFrom = (from) => {
    chainBox.replaceChildren(...[       // .filter(Boolean): replaceChildren(null) would print "null"
      from > 0 ? h('button', { type: 'button', class: 'more-btn', onclick: () => showFrom(0) },
        `＋ Show ${from} earlier comment${from === 1 ? '' : 's'} in this thread`) : null,
      ...chain.slice(from).map((c, k) => ctxNode(c, from + k)),
    ].filter(Boolean));
  };
  showFrom(hiddenCount);

  const target = h('div', { class: 'sq-target', style: indent(chain.length) },
    h('div', { class: 'sq-target-head small' },
      h('b', {}, '▶ Label this comment'),
      ` · u/${it.author} · score ${it.score}${it.controversiality ? ' · controversial' : ''} · id ${it.comment_id}`,
      chain.length ? '' : ' · direct reply to the post'),
    h('div', { class: 'sq-text md', html: md(it.text) }));

  return h('div', { class: 'sq-thread' }, post, chainBox, target);
}

/* ============================================================ the sample */

function bar(done, total) {
  const pct = total ? Math.round(100 * done / total) : 0;
  return h('div', { class: 'sq-bar' },
    h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })),
    h('span', { class: 'small muted' }, `${done} / ${total}`));
}

function summaryCard(sample) {
  const s = sample.settings;
  const f = s.filters;
  const gold = sample.items.filter(i => i.group !== 'pilot');
  const periods = [...new Set(gold.map(i => i.period))];
  const table = h('table', { class: 'sq-table' },
    h('tr', {}, h('th', {}, 'Subreddit'), ...periods.map(p => h('th', {}, p)), h('th', {}, 'pilot')),
    ...s.subreddits.map(sub => h('tr', {},
      h('td', {}, 'r/' + sub),
      ...periods.map(p => h('td', {}, String(gold.filter(i => i.subreddit === sub && i.period === p).length))),
      h('td', {}, String(sample.items.filter(i => i.group === 'pilot' && i.subreddit === sub).length)))));
  const filters = [
    f.no_bots && 'no bots', f.no_deleted && 'no deleted/removed', f.english_only && 'English only',
    f.word_range && `${f.min_words}–${f.max_words} words`,
    f.period && `${f.period_start} → ${f.period_end}`,
    f.balance && `balanced before/after ${f.event_date}`,
  ].filter(Boolean);
  return h('div', { class: 'card section' },
    h('div', { class: 'section-head' },
      h('h2', {}, 'Annotation sample'),
      h('button', { class: 'btn', onclick: () => { state.settingsOpen = true; viewSample(); } }, '⚙ Settings / regenerate')),
    h('div', { class: 'small muted' },
      `${fmtNum(gold.length)} gold + ${sample.items.length - gold.length} pilot · seed ${s.seed} · created ${fmtDate(sample.created)} · ` +
      `annotators: ${s.annotators.join(', ')}`),
    h('div', { class: 'chip-row sq-filters' }, ...filters.map(t => h('span', { class: 'chip' }, '✓ ' + t))),
    ...(sample.warnings || []).map(w => h('div', { class: 'small error' }, '⚠ ' + w)),
    table);
}

function progressCard(sample, myName, mineCount) {
  return h('div', { class: 'card section' },
    h('h2', {}, 'Progress'),
    h('div', { class: 'sq-progress' },
      ...sample.progress.map(p => {
        const live = p.annotator === myName ? mineCount : null;    // my own numbers update live
        return h('div', { class: 'sq-prow' },
          h('b', {}, p.annotator + (p.annotator === myName ? ' (you)' : '')),
          ...['pilot', 'shared', 'own'].filter(g => p.groups[g]).map(g => h('div', { class: 'sq-pcell' },
            h('span', { class: 'small' }, GROUP_TITLES[g]),
            bar(live ? live[g] : p.groups[g].done, p.groups[g].total))));
      })));
}

function renderSample(sample, subs, labels, me) {
  const indexed = new Set(subs.filter(s => s.ready).map(s => s.name));
  const mine = new Map(Object.entries(sample.mine || {}));
  const myName = sample.me;

  if (!me || !myName) {
    app.replaceChildren(summaryCard(sample), progressCard(sample, null, null),
      h('div', { class: 'card notice' },
        !me ? 'Set your annotator name first (Labels page).'
            : `Your annotator name “${me}” isn't in this sample (annotators: ${sample.settings.annotators.join(', ')}). ` +
              'Change your name on the Labels page, or regenerate the sample with your name.',
        ' ', h('a', { href: '#/labels' }, 'Go to Labels')));
    return;
  }
  if (!labels.length) {
    app.replaceChildren(summaryCard(sample),
      h('div', { class: 'card notice' }, 'There are no labels yet. ', h('a', { href: '#/labels' }, 'Add them on the Labels page.')));
    return;
  }

  // my queue, per group, in sample order
  const groups = {
    pilot: sample.items.filter(i => i.group === 'pilot'),
    shared: sample.items.filter(i => i.group === 'shared'),
    own: sample.items.filter(i => i.group === myName),
  };
  const order = ['pilot', 'shared', 'own'].filter(g => groups[g].length);
  const doneIn = g => groups[g].filter(i => mine.has(i.comment_id)).length;
  const mineCount = () => Object.fromEntries(order.map(g => [g, doneIn(g)]));
  const firstOpen = (g, from = 0) => {
    const list = groups[g];
    for (let k = 0; k < list.length; k++) {
      const j = (from + k) % list.length;
      if (!mine.has(list[j].comment_id)) return j;
    }
    return -1;
  };

  if (!order.includes(state.group)) state.group = order.find(g => firstOpen(g) !== -1) || order[0];
  if (state.index == null || state.index >= groups[state.group].length) state.index = Math.max(0, firstOpen(state.group));

  const progressBox = h('div', {});
  const tabs = h('div', { class: 'sq-tabs' });
  const itemBox = h('div', {});

  function paintProgress() {
    progressBox.replaceChildren(progressCard(sample, myName, mineCount()));
    tabs.replaceChildren(...order.map(g => h('button', {
      class: 'sq-tab' + (g === state.group ? ' active' : ''),
      onclick: () => { state.group = g; state.index = Math.max(0, firstOpen(g)); paintAll(); },
    }, `${GROUP_TITLES[g]} · ${doneIn(g)}/${groups[g].length}`)));
  }

  async function save(it, labelId, extras) {
    const a = await send('PUT', '/api/annotations', {
      sub: it.subreddit, comment_id: it.comment_id, annotator: me, label_id: labelId, ...extras,
    });
    mine.set(it.comment_id, a);
  }

  function paintItem() {
    const list = groups[state.group];
    const it = list[state.index];
    const cur = mine.get(it.comment_id);
    const err = h('div', { class: 'small error' });
    const unsure = toggleChip('Unsure (discuss later)', !!cur?.unsure, async (on) => {
      const c = mine.get(it.comment_id);
      if (c) { try { await save(it, c.label_id, { unsure: on, note: note.value }); } catch (e) { err.textContent = e.message; } }
    });
    const note = h('input', { type: 'text', class: 'sq-note', placeholder: 'Note (optional) — why this label?', value: cur?.note || '' });
    note.addEventListener('change', async () => {
      const c = mine.get(it.comment_id);
      if (c) { try { await save(it, c.label_id, { unsure: unsure.isOn(), note: note.value }); } catch (e) { err.textContent = e.message; } }
    });

    async function choose(labelId) {
      try {
        await save(it, labelId, { unsure: unsure.isOn(), note: note.value });
        const next = firstOpen(state.group, state.index + 1);
        if (next !== -1) state.index = next;
        paintAll();
      } catch (e) {
        err.textContent = e.message;
      }
    }
    async function removeLabel() {
      try {
        await send('DELETE', `/api/annotations?comment_id=${enc(it.comment_id)}&annotator=${enc(me)}`);
        mine.delete(it.comment_id);
        paintAll();
      } catch (e) {
        err.textContent = e.message;
      }
    }
    const go = (k) => { state.index = (k + list.length) % list.length; paintAll(); };
    keyHandler.choose = (n) => { if (labels[n - 1]) choose(labels[n - 1].id); };
    keyHandler.go = (d) => go(state.index + d);

    const allDone = firstOpen(state.group) === -1;
    itemBox.replaceChildren(h('div', { class: 'card section sq-item' },
      allDone ? h('div', { class: 'notice small' }, `✓ All ${list.length} comments in “${GROUP_TITLES[state.group]}” are labelled. You can still review and change them.`) : null,
      h('div', { class: 'chip-row sq-meta' },
        h('span', { class: 'chip' }, 'r/' + it.subreddit),
        h('span', { class: 'chip' }, fmtDate(it.created)),
        it.period !== 'all' ? h('span', { class: 'chip' }, it.period === 'before' ? 'before the event' : 'after the event') : null,
        h('span', { class: 'chip' }, GROUP_TITLES[state.group]),
        h('span', { class: 'small muted' }, `${state.index + 1} / ${list.length}`),
        h('span', { class: 'small ' + (cur ? 'sq-done' : 'muted') }, cur ? '● labelled' : '○ not labelled')),
      threadView(it, indexed.has(it.subreddit)),
      h('div', { class: 'sq-labels' },
        ...labels.map((l, i) => h('button', {
          type: 'button',
          class: 'sq-label' + (cur?.label_id === l.id ? ' selected' : ''),
          style: `--label-color:${l.color}`,
          title: l.description || '',
          onclick: () => choose(l.id),
        }, h('span', { class: 'label-dot' }), h('span', { class: 'sq-lname' }, l.name), i < 9 ? h('kbd', { class: 'rm-key' }, String(i + 1)) : null))),
      h('div', { class: 'chip-row' }, unsure, note,
        cur ? h('button', { class: 'btn', onclick: removeLabel }, '✕ Remove label') : null),
      err,
      h('div', { class: 'sq-nav' },
        h('button', { class: 'btn', onclick: () => go(state.index - 1) }, '‹ Prev'),
        h('button', { class: 'btn', onclick: () => go(state.index + 1) }, 'Next ›'),
        allDone ? null : h('button', { class: 'btn primary', onclick: () => go(firstOpen(state.group, state.index + 1)) }, 'Next unlabelled ⏭'),
        h('span', { class: 'small muted' }, 'Keys: 1–9 label · ← → navigate'))));
  }

  function paintAll() {
    paintProgress();
    paintItem();
  }

  // keyboard shortcuts (removed when leaving the page)
  const keyHandler = {};
  const onKey = (e) => {
    if (e.target?.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); keyHandler.choose?.(+e.key); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); keyHandler.go?.(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); keyHandler.go?.(-1); }
  };
  document.addEventListener('keydown', onKey);
  onLeave(() => document.removeEventListener('keydown', onKey));

  app.replaceChildren(summaryCard(sample), progressBox,
    h('div', { class: 'card section' },
      h('h2', {}, `Your queue — ${myName}`),
      h('p', { class: 'small muted' },
        'Label independently: don\'t look at your teammate\'s labels for pilot/shared items until you\'ve both finished. ' +
        'Start with the pilot, then discuss your disagreements and refine the rules before the shared items.'),
      tabs),
    itemBox);
  paintAll();
}
