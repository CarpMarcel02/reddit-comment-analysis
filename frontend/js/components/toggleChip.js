// toggleChip.js — an on/off button ("chip"), e.g. [✓ No bots].
//
// toggleChip(label, on, onChange, title) → <button>; btn.isOn() returns the current state.

import { h } from '../utils.js';

export function toggleChip(label, on, onChange, title) {
  const btn = h('button', { type: 'button', class: 'toggle-chip', title: title || null });
  const paint = () => {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.replaceChildren(h('span', { class: 'tc-box' }, on ? '✓' : ''), label);
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    on = !on;
    paint();
    onChange?.(on);
  });
  btn.isOn = () => on;
  paint();
  return btn;
}
