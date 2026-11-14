// rateMenu.js — the "Rate" button on the right of a comment + the label dropdown.
//
// rateButton(comment, ctx):
//   comment = { id }                       the comment to label
//   ctx.sub                                the subreddit (the backend reads the text from its index)
//   ctx.annotations                        Map comment_id → current annotation
//   ctx.onAnnotated()                      called after save / delete
//   ctx.onAnnotatorChange()                called after the user sets their name
//
// In the dropdown: clicking a label (or keys 1–9) saves and closes.
// "unsure" and "note" are saved immediately if the comment already has a label.

import { h, send, enc } from '../utils.js';
import { getLabels, getAnnotator, setAnnotator } from '../store.js';

let current = null;   // the open dropdown (only one at a time)

export function rateButton(comment, ctx) {
  const btn = h('button', { type: 'button', class: 'rate-btn', title: 'Label this comment' });

  const paint = () => {
    const a = ctx.annotations.get(comment.id);
    btn.classList.toggle('rated', !!a);
    btn.replaceChildren();
    if (a) {
      btn.style.setProperty('--label-color', a.color);
      btn.append(h('span', { class: 'label-dot' }), a.label_name,
        a.unsure ? h('span', { class: 'unsure-mark', title: 'unsure' }, '?') : null);
    } else {
      btn.style.removeProperty('--label-color');
      btn.append('🏷 Rate ▾');
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (current && current.owner === btn) current.close();
    else openMenu(btn, comment, ctx, paint);
  });
  paint();
  return btn;
}

function openMenu(btn, comment, ctx, paint) {
  current?.close();

  const menu = h('div', { class: 'card rate-menu', role: 'dialog' });
  const errBox = h('div', { class: 'small error' });
  let labels = [];
  let unsureBox = null;
  let noteBox = null;

  // ---------- position below the button, right-aligned ----------
  const place = () => {
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth || 300;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - w - 8;
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.max(window.scrollX + 8, Math.min(r.right + window.scrollX - w, maxLeft))}px`;
  };

  // ---------- closing: click outside / Escape ----------
  const onDoc = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.target.matches('input, textarea')) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= Math.min(9, labels.length)) { e.preventDefault(); choose(labels[n - 1].id); }
  };
  function close() {
    menu.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    if (current?.menu === menu) current = null;
  }
  current = { menu, owner: btn, close };
  document.body.append(menu);
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);

  // ---------- actions ----------
  async function save(labelId) {
    errBox.textContent = '';
    try {
      const a = await send('PUT', '/api/annotations', {
        sub: ctx.sub, comment_id: comment.id, annotator: getAnnotator(),
        label_id: labelId, unsure: unsureBox?.checked || false, note: noteBox?.value || '',
      });
      ctx.annotations.set(comment.id, a);
      paint();
      ctx.onAnnotated?.();
      return true;
    } catch (e) {
      errBox.textContent = e.message;
      return false;
    }
  }
  async function choose(labelId) {
    if (await save(labelId)) close();
  }
  async function remove() {
    try {
      await send('DELETE', `/api/annotations?comment_id=${enc(comment.id)}&annotator=${enc(getAnnotator())}`);
      ctx.annotations.delete(comment.id);
      paint();
      ctx.onAnnotated?.();
      close();
    } catch (e) {
      errBox.textContent = e.message;
    }
  }
  const saveExtras = () => {
    const cur = ctx.annotations.get(comment.id);
    if (cur) save(cur.label_id);
  };

  // ---------- content ----------
  function askName() {
    const input = h('input', { type: 'text', class: 'rm-input', placeholder: 'your name, e.g. ana', maxlength: 40 });
    const go = () => {
      const v = input.value.trim();
      if (!v) return;
      setAnnotator(v);
      close();
      ctx.onAnnotatorChange?.();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    menu.replaceChildren(
      h('div', { class: 'rm-title' }, 'Who is annotating?'),
      h('div', { class: 'small muted' }, 'Your name goes into the CSV and is needed for Cohen\'s Kappa (each teammate uses their own name).'),
      input,
      h('button', { type: 'button', class: 'btn primary', onclick: go }, 'Continue'));
    place();
    setTimeout(() => input.focus());
  }

  async function render() {
    menu.replaceChildren(h('div', { class: 'small muted' }, 'Loading…'));
    place();
    const who = getAnnotator();
    if (!who) return askName();

    try {
      labels = await getLabels();
    } catch (e) {
      menu.replaceChildren(h('div', { class: 'small error' }, e.message));
      return;
    }
    if (!labels.length) {
      menu.replaceChildren(
        h('div', { class: 'rm-title' }, 'You have no labels yet'),
        h('div', { class: 'small muted' }, 'First define the labels that will appear here.'),
        h('a', { class: 'btn primary rm-cta', href: '#/labels', onclick: close }, '⚙ Go to Labels'));
      place();
      return;
    }

    const cur = ctx.annotations.get(comment.id);
    unsureBox = h('input', { type: 'checkbox', checked: !!cur?.unsure, onchange: saveExtras });
    noteBox = h('textarea', { class: 'rm-input', rows: 2, maxlength: 1000, placeholder: 'Note (optional) — why this label?', onchange: saveExtras });
    noteBox.value = cur?.note || '';

    menu.replaceChildren(
      h('div', { class: 'rm-title' }, 'Labelling as ', h('b', {}, who)),
      ...labels.map((l, i) => h('button', {
        type: 'button',
        class: 'rm-option' + (cur?.label_id === l.id ? ' selected' : ''),
        style: `--label-color:${l.color}`,
        onclick: () => choose(l.id),
      },
        h('span', { class: 'label-dot' }),
        h('span', { class: 'rm-text' },
          h('span', { class: 'rm-name' }, l.name),
          l.description ? h('span', { class: 'rm-desc' }, l.description) : null),
        i < 9 ? h('kbd', { class: 'rm-key' }, String(i + 1)) : null)),
      h('div', { class: 'rm-extra' },
        h('label', { class: 'small rm-check' }, unsureBox, 'unsure (discuss with your teammate)'),
        noteBox,
        cur ? h('button', { type: 'button', class: 'rm-remove', onclick: remove }, '✕ Remove label') : null,
        errBox),
      h('a', { class: 'small rm-manage', href: '#/labels', onclick: close }, '⚙ Manage labels'));
    place();
  }

  render();
}
