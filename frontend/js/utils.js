// utils.js — helpers shared by all pages and components.

export const app = document.getElementById('app');      // main content area
export const crumb = document.getElementById('crumb');  // breadcrumb text in the header (r/sub / id)

/** Create an HTML element: h('div', {class: 'x', onclick: fn}, child1, child2, ...) */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** GET request to the backend; throws an error (with .status) if the response isn't OK. */
export async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!r.ok) {
    const err = new Error(j.error || r.statusText);
    err.status = r.status;
    throw err;
  }
  return j;
}

/** POST / PUT / DELETE request with a JSON body. */
export function send(method, path, body) {
  return api(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const enc = encodeURIComponent;

/* ---------- Markdown (Reddit text → safe HTML) ---------- */
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (href.startsWith('/')) node.setAttribute('href', 'https://www.reddit.com' + href);
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}
export function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || '', { gfm: true }));
  const d = document.createElement('div');       // offline: plain text
  d.textContent = text || '';
  return d.innerHTML.replace(/\n/g, '<br>');
}

/* ---------- formatting ---------- */
export function fmtDate(ts) {
  return ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '?';
}
export function fmtRel(ts, base) {
  if (!ts || !base) return '';
  const s = ts - base;
  if (s < 3600) return `+${Math.max(0, Math.round(s / 60))} min`;
  if (s < 86400) return `+${Math.round(s / 3600)} h`;
  return `+${Math.round(s / 86400)} days`;
}
export function fmtNum(n) {
  n = n || 0;
  return Math.abs(n) >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}
export function fmtSize(b) {
  if (!b) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return b.toFixed(i ? 1 : 0) + ' ' + u[i];
}
/** Same color for the same author. */
export function colorFor(name) {
  let x = 0;
  for (const ch of name || '') x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 55% 45%)`;
}

/* ---------- project rules (stage A filters) ---------- */
export const isBot = a => /bot|automoderator|autotldr/i.test(a || '');
export const isDeleted = t => t === '[deleted]' || t === '[removed]' || !t;
/** Word count excluding quoted lines (lines starting with ">"). */
export function wordsNoQuotes(text) {
  return (text || '').split('\n').filter(l => !l.trim().startsWith('>')).join(' ').split(/\s+/).filter(Boolean).length;
}
export function isUsable(c) {
  if (isDeleted(c.body) || isBot(c.author)) return false;
  const n = wordsNoQuotes(c.body);
  return n >= 25 && n <= 300;
}

/** Button handler that shows/hides the original JSON of a post/comment. */
export function rawToggle(sub, kind, id, mount) {
  let pre = null;
  return async () => {
    if (pre) { pre.remove(); pre = null; return; }
    pre = h('pre', { class: 'raw' }, 'Loading…');
    mount.append(pre);
    try {
      pre.textContent = JSON.stringify(await api(`/api/raw?sub=${enc(sub)}&kind=${kind}&id=${enc(id)}`), null, 2);
    } catch (e) {
      pre.textContent = 'Error: ' + e.message;
    }
  };
}

/* ---------- polling (one active timer, stopped when the page changes) ---------- */
let pollTimer = null;
export function startPolling(fn, ms = 1000) { stopPolling(); pollTimer = setInterval(fn, ms); }
export function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
