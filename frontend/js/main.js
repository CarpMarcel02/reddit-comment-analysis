// main.js — frontend entry point: the router + the top menu.
//
// The URL hash decides which page is shown:
//   #/                   → pages/home.js         (list of subreddits)
//   #/r/<sub>            → pages/subreddit.js    (list of posts)
//   #/r/<sub>/p/<id>     → pages/post.js         (post + comments, with the "Rate" button)
//   #/labels             → pages/labels.js       (dropdown labels + annotator name)
//   #/annotations        → pages/annotations.js  (what you labelled, statistics, CSV export)

import { stopPolling } from './utils.js';
import { getAnnotator } from './store.js';
import { viewHome } from './pages/home.js';
import { viewSub } from './pages/subreddit.js';
import { viewPost } from './pages/post.js';
import { viewLabels } from './pages/labels.js';
import { viewAnnotations } from './pages/annotations.js';

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
}

function route() {
  stopPolling();
  window.scrollTo(0, 0);
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (p[0] === 'labels') { setActiveNav('labels'); return viewLabels(); }
  if (p[0] === 'annotations') { setActiveNav('annotations'); return viewAnnotations(); }
  setActiveNav('home');
  if (p[0] === 'r' && p[1] && p[2] === 'p' && p[3]) return viewPost(p[1], p[3]);
  if (p[0] === 'r' && p[1]) return viewSub(p[1]);
  return viewHome();
}

function paintAnnotator() {
  const who = getAnnotator();
  const badge = document.getElementById('annotator-badge');
  badge.textContent = who ? `👤 ${who}` : '👤 set your name';
  badge.classList.toggle('missing', !who);
}

window.addEventListener('hashchange', route);
window.addEventListener('annotator-change', paintAnnotator);
paintAnnotator();
route();
