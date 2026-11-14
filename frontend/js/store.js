// store.js — data shared between pages:
//   • the labels, loaded once and reused by every dropdown
//   • the annotator name (kept in the browser; it goes into the CSV and is needed for Cohen's Kappa)

import { api } from './utils.js';

let labelsPromise = null;

/** The list of labels. force = true → reload from the server. */
export function getLabels(force = false) {
  if (force || !labelsPromise) {
    labelsPromise = api('/api/labels').catch(e => { labelsPromise = null; throw e; });
  }
  return labelsPromise;
}

/** After the Labels page changes the list, store it directly (no extra request). */
export function setLabels(list) {
  labelsPromise = Promise.resolve(list);
}

let sessionName = '';   // fallback when the browser blocks localStorage

export function getAnnotator() {
  try { return localStorage.getItem('annotator') || sessionName; } catch { return sessionName; }
}

export function setAnnotator(name) {
  sessionName = name;
  try { localStorage.setItem('annotator', name); } catch { /* kept for this session only */ }
  window.dispatchEvent(new CustomEvent('annotator-change', { detail: name }));
}
