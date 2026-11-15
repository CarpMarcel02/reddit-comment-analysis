// labels.js — the "Labels" page (#/labels):
//   1. your annotator name
//   2. the labels shown in the "Rate" dropdown: add / edit / delete / reorder
//   3. a button that loads the proposed label set (the 4 classes from the project brief)

import { app, crumb, h, send, currentNav } from '../utils.js';
import { getLabels, setLabels, getAnnotator, setAnnotator } from '../store.js';

const PALETTE = ['#e5484d', '#f76b15', '#ffb224', '#30a46c', '#12a594', '#0090ff', '#8e4ec6', '#d6409f', '#6f6e77'];

/** Form for a label (used both for adding and editing). */
function labelForm({ initial = {}, submitText, onSubmit, onCancel }) {
  const name = h('input', { type: 'text', class: 'lf-input', placeholder: 'Name, e.g. Name Calling', maxlength: 80, value: initial.name || '' });
  const desc = h('textarea', { class: 'lf-input', rows: 2, maxlength: 500, placeholder: 'Short description / definition (shown in the dropdown)' });
  desc.value = initial.description || '';
  let color = initial.color || PALETTE[0];
  const picker = h('input', { type: 'color', value: color, title: 'Custom color' });
  const err = h('div', { class: 'small error' });

  const swatches = h('div', { class: 'lf-swatches' });
  const paintSwatches = () => swatches.replaceChildren(...PALETTE.map(c => h('button', {
    type: 'button', class: 'lf-swatch' + (c === color ? ' selected' : ''), style: `background:${c}`, title: c,
    onclick: () => { color = c; picker.value = c; paintSwatches(); },
  })), picker);
  picker.addEventListener('input', () => { color = picker.value; paintSwatches(); });
  paintSwatches();

  const form = h('form', { class: 'label-form' },
    name, desc,
    h('div', { class: 'lf-row' }, h('span', { class: 'small muted' }, 'Color:'), swatches),
    err,
    h('div', { class: 'lf-row' },
      h('button', { type: 'submit', class: 'btn primary' }, submitText),
      onCancel ? h('button', { type: 'button', class: 'btn', onclick: onCancel }, 'Cancel') : null));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await onSubmit({ name: name.value.trim(), description: desc.value.trim(), color });
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  return form;
}

export async function viewLabels() {
  const nav = currentNav();
  crumb.textContent = '/ Labels';
  app.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));

  // ---------- 1. annotator ----------
  const nameInput = h('input', { type: 'text', class: 'lf-input', placeholder: 'e.g. ana', maxlength: 40, value: getAnnotator() });
  const nameMsg = h('span', { class: 'small muted' });
  const saveName = () => {
    const v = nameInput.value.trim();
    if (!v) { nameMsg.textContent = 'The name can\'t be empty.'; return; }
    setAnnotator(v);
    nameMsg.textContent = '✓ saved';
  };
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });

  const annotatorCard = h('div', { class: 'card section' },
    h('h2', {}, 'Annotator'),
    h('p', { class: 'small muted' },
      'Your name is attached to every label and goes into the CSV. If you work in a team, each person uses ' +
      'their own name — that\'s how we compute Cohen\'s Kappa on the comments you both labelled.'),
    h('div', { class: 'lf-row' }, nameInput, h('button', { class: 'btn primary', onclick: saveName }, 'Save'), nameMsg));

  // ---------- 2. labels ----------
  const listBox = h('div', { class: 'label-list' });
  const listErr = h('div', { class: 'small error' });
  let labels = [];

  const apply = (list) => { labels = list; setLabels(list); renderList(); };

  async function move(i, dir) {
    const ids = labels.map(l => l.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    apply(await send('POST', '/api/labels/reorder', { ids }));
  }

  async function remove(l) {
    listErr.textContent = '';
    if (!confirm(`Delete the label "${l.name}"?`)) return;
    try {
      apply(await send('DELETE', `/api/labels?id=${l.id}`));
    } catch (e) {
      const inUse = e.status === 409 && e.message.includes('used in');
      if (inUse && confirm(`${e.message}\nDelete the label AND all these annotations, for ALL annotators? (this can't be undone)`)) {
        apply(await send('DELETE', `/api/labels?id=${l.id}&force=1`));
      } else if (!inUse) {
        listErr.textContent = e.message;
      }
    }
  }

  function row(l, i) {
    const el = h('div', { class: 'label-row', style: `--label-color:${l.color}` });
    const view = () => el.replaceChildren(
      h('kbd', { class: 'rm-key', title: 'shortcut key in the dropdown' }, i < 9 ? String(i + 1) : '–'),
      h('span', { class: 'label-dot big' }),
      h('div', { class: 'label-info' },
        h('div', { class: 'label-name' }, l.name),
        l.description ? h('div', { class: 'small muted' }, l.description) : null),
      h('span', { class: 'small muted label-used' }, `${l.used} annotations`),
      h('div', { class: 'label-actions' },
        h('button', { title: 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button', { title: 'Move down', disabled: i === labels.length - 1, onclick: () => move(i, 1) }, '↓'),
        h('button', { title: 'Edit', onclick: edit }, '✎'),
        h('button', { title: 'Delete', class: 'danger', onclick: () => remove(l) }, '🗑')));
    const edit = () => el.replaceChildren(labelForm({
      initial: l, submitText: 'Save',
      onSubmit: async (data) => apply(await send('PUT', `/api/labels?id=${l.id}`, data)),
      onCancel: view,
    }));
    view();
    return el;
  }

  function renderList() {
    listBox.replaceChildren(...labels.map(row));
    if (!labels.length) {
      listBox.append(h('div', { class: 'empty small' }, 'No labels yet. Add one below or load the proposed set.'));
    }
  }

  const seedBtn = h('button', {
    class: 'btn',
    onclick: async () => apply(await send('POST', '/api/labels/seed')),
  }, '＋ Add the proposed set (4 classes from the brief)');

  const labelsCard = h('div', { class: 'card section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Labels'), seedBtn),
    h('p', { class: 'small muted' },
      'These appear in the "Rate" dropdown next to each comment, in this order. ' +
      'In the dropdown you can press keys 1–9 to pick quickly.'),
    h('p', { class: 'small muted' },
      '⚠ Labels are SHARED by all annotators (the file annotations/labels.json, committed to Git). ' +
      'Agree on them together at the start and don\'t change them separately — otherwise the annotations can\'t be compared (Cohen\'s Kappa).'),
    listErr,
    listBox);

  // ---------- 3. add ----------
  let addForm;
  const resetAdd = () => {
    const fresh = labelForm({
      initial: { color: PALETTE[labels.length % PALETTE.length] },
      submitText: '＋ Add label',
      onSubmit: async (data) => { apply(await send('POST', '/api/labels', data)); resetAdd(); },
    });
    addForm ? addForm.replaceWith(fresh) : null;
    addForm = fresh;
  };
  resetAdd();
  const addCard = h('div', { class: 'card section' }, h('h2', {}, 'New label'), addForm);

  try {
    labels = await getLabels(true);
  } catch (e) {
    if (nav !== currentNav()) return;
    app.replaceChildren(h('div', { class: 'card empty error' }, e.message));
    return;
  }
  if (nav !== currentNav()) return;
  renderList();
  app.replaceChildren(annotatorCard, labelsCard, addCard);
}
