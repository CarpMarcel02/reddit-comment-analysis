# Project context

Everything we know and have decided so far: the assignment, the data, the method, the app, and what's next.
Last updated: 2026-11-15.

---

## 1. The assignment

- **Course:** NLP2 (Master, year 2, semester 1).
- **Deliverable:** a research paper in **ACL format**, 6–8 pages (+ unlimited appendices, no slides). Worth **70%** of the final grade.
- **Deadlines:**
  - **1 December:** preliminary results on the "Project" channel (class distributions, first plots, architecture ideas).
  - **Exam session:** the final paper.
- **Topic:** must be picked **from the professor's list** (custom topics are not allowed). Most topics are "research about X from Reddit posts" (anxiety, climate change, propaganda, scams/manipulation, ADHD/autism, sleep disorders, substance abuse, postpartum depression, …). Several teams can share a topic.
- **Our status:** **the topic is not final yet.** Propaganda was used as a test topic to build the tooling. Everything below (data pipeline, app) works for any Reddit topic; only the subreddits and the labels change.
- **Hard requirement from the brief:** go beyond simple sentiment analysis (positive/negative).

### What the professor expects (summary of the project brief)

> The data is not annotated — the hard part of any ML project is the data and asking the right questions.
> Everyone must manually annotate samples, and they must be **good** annotations, because the whole project is built on them.

Then scale the annotations with one of three strategies:

1. **LLM annotation** (e.g. Gemini Flash): first test the LLM **on your own manual annotations**; only if accuracy is good, use it to annotate more. LLMs are often bad — validate, don't waste budget.
2. **Active learning** (no budget): train a model on your annotations, run it on an unlabelled batch, manually check the most uncertain / highest-loss examples (batches ≤ 100), add them, retrain, repeat.
3. **Local LLM** (Mac / GPU): e.g. Qwen ~7B, optionally with a LoRA fine-tuned on your annotations.

Goal: as close as possible to a real job task and to publishable research with results.

---

## 2. The data

### Source

- **Pushshift Reddit archives**, from the *subreddits24* torrent (Academic Torrents). One pair of files per subreddit:
  - `<subreddit>_submissions.zst` — **posts** (title + link/text)
  - `<subreddit>_comments.zst` — **comments** on those posts
- **`.zst`** = Zstandard compression. Inside is **JSONL**: one JSON object per line. Files are read as a **stream** (line by line, never fully decompressed — `worldnews_comments.zst` is 15.6 GB compressed).
- The archives are **not in Git**. Each person downloads the ones they need into `subreddits24/`.

### The torrent

~40,000 subreddits, 3.3 TB in total. The full list with sizes is in [`torrent_subreddits.csv`](torrent_subreddits.csv) — download only the files you need (qBittorrent lets you select individual files).

### What we use (chosen 2026-11-15)

Eight subreddits about the Russia–Ukraine war (`_comments.zst` + `_submissions.zst` each, ~5 GB in total) — see section 3b.

### Structure

- A **submissions** file contains **all posts of that subreddit, all years**. A **comments** file contains **all comments of all those posts, mixed**, in chronological order. They are **not grouped** — you join them yourself.
- On news subreddits almost all posts are **link posts**: `title` + `url`, empty `selftext`. The article text is **not** in the archive.

### Key fields

| Field | Where | Meaning |
|---|---|---|
| `id` | both | unique id (`jzsgkm`) |
| `title`, `selftext`, `url`, `domain` | submissions | title, body text (text posts only), link, source site |
| `body` | comments | **the comment text — what we classify** |
| `link_id` | comments | the parent **post**: `t3_<post id>` |
| `parent_id` | comments | what it replies to: `t3_…` = the post, `t1_…` = another comment |
| `author` | both | `[deleted]` = deleted account; bots: `AutoModerator`, `autotldr`, names containing `bot` |
| `score`, `controversiality` | both | upvotes − downvotes; `1` = heavily split votes (good signal for polarizing content) |
| `created_utc` | both | Unix timestamp |
| `permalink` | both | link to the original on reddit.com |

Reddit id prefixes: **`t1_` comment, `t2_` user, `t3_` post, `t5_` subreddit.**
Field sets differ by year (a 2016 comment has ~18 fields, a 2020 one ~45); the important ones exist in all years.

### Cleaning (stage A)

- Drop bots, `[deleted]` / `[removed]` texts, and texts outside **25–300 words**.
- `&gt;`, `&amp;`, `&amp;#039;` are HTML entities → `html.unescape` (twice for double-escaped text).
- Lines starting with `>` are **quotes** of someone else (another comment, the article) → exclude them, they aren't the author's words.
- Expect very few usable comments per thread (in one 13-comment thread only ~3–4 passed the filters), and a random sample will be mostly **Neutral** → sample from polarizing subreddits/topics and prefer `controversiality = 1` (and report the sampling strategy in the paper).

---

## 3. Method (what we agreed on)

```
0. topic + label scheme (codebook)  →  pilot (20–30 comments, both annotators, discuss)
1. GOLD SET: ~200 comments annotated MANUALLY  (50 shared, labelled independently → Cohen's Kappa)
2. LLM via API labels the SAME 200, blind  →  tune the prompt on ~50, measure ONCE on ~150 (target > 80%)
3. if good: LLM labels a few thousand new comments (we spot-check a sample)   — else: active learning
4. train our own models on those thousands: TF-IDF + Logistic Regression (baseline), RoBERTa
5. evaluate on the human gold set: Precision, Recall, Macro-F1, confusion matrix  →  error analysis  →  paper
```

### Rules that make the results valid

- **The gold set is made by humans, from scratch.** Never by "reviewing" AI suggestions — seeing a proposed label biases you toward it (*anchoring bias*) and inflates the AI's measured accuracy.
- **The LLM labels blind**: it gets only the comment + the label definitions, never our labels.
- **"Improving" the LLM = improving the prompt** (clearer definitions, rules for hard cases, a few examples). The LLM doesn't learn between API calls.
- **Dev/test split for the prompt:** tune only on ~50 dev examples; few-shot examples come only from dev; run the ~150 test examples **once** with the final prompt. No rules that fix one specific comment.
- **The gold set is never used for training** — it's the exam.
- **The API is only a labelling tool.** The final classifier is our own model, running locally. The LLM can also appear in the results table as a baseline (zero/few-shot LLM vs. RoBERTa trained on LLM labels).
- **100% agreement is not the target.** Human–human agreement (Kappa) is the natural ceiling; an LLM close to it is "as good as a third annotator".

### Cohen's Kappa

Agreement between two annotators **corrected for chance**: κ = (p_observed − p_chance) / (1 − p_chance).
Example: agree on 40/50 = 0.8, chance agreement 0.5 → κ = 0.6.
Rough scale: < 0.2 poor · 0.2–0.4 fair · 0.4–0.6 moderate (normal for propaganda) · 0.6–0.8 good · > 0.8 very good.
Required in the paper if we work as a team of two.

### Which LLM / API

- Use the **API, not a chat window**: thousands of items, identical prompt, structured JSON output, reproducible (model + prompt + outputs logged).
- Plan: compare a **cheap** model (Gemini Flash or Claude Haiku 5.5) and a **stronger** one (Claude Sonnet 5.5 / Opus 5.5) on the gold set; use the cheapest one that passes. The comparison itself is a result.
- Rough cost for 200 test + 5,000 comments: ~$1 (Haiku 5.5), ~$15 (Sonnet 5.5), ~$30 (Opus 5.5); less with prompt caching / Batch API (−50%). Check whether the faculty provides credits.

### 3b. Study design (proposed 2026-11-15)

The paper has two parts:

- **RQ1 — models:** how well do different models detect propaganda techniques in Reddit comments (TF-IDF + LR, RoBERTa, small LLM + LoRA, ~7B LLM + QLoRA, API LLMs), compared with human annotators?
- **RQ2 — Reddit:** using the best model, how do techniques differ across communities and over time?

All subreddits share one topic (the Russia–Ukraine war), so differences come from the community, not the subject:

| Subreddit | Role |
|---|---|
| r/CredibleDefense, r/geopolitics | controls: strict moderation, analytical discussion |
| r/UkrainianConflict, r/ukraine | pro-Ukraine perspective |
| r/UkraineRussiaReport | often described as more Russia-leaning (verify its rules/description) |
| r/AskARussian, r/russia | Russian perspective (check their activity in 2021–2023) |
| r/NonCredibleDefense | humour/sarcasm on the same topic (hard case for models) |

Study period: **2021-02-24 → 2023-02-24**, split at **2022-02-24** (full-scale invasion).

Hypotheses (to be finalized after the pilot, before looking at model results):

| # | Hypothesis | Comparison |
|---|---|---|
| H1 | The share of propaganda grows from strictly moderated communities to partisan ones | moderation gradient |
| H2 | The two sides differ in their *profile* of techniques (e.g. Name Calling vs. Whataboutism / discrediting sources) | pro-Ukraine vs. Russia-leaning |
| H3 | Appeal to Fear and Name Calling increase after 2022-02-24 | before vs. after |
| H4 | Comments with techniques are more controversial than neutral ones | `controversiality`, `score` |
| H5 | Models perform worse on sarcastic communities (r/NonCredibleDefense) | per-community model accuracy |

Report every planned comparison (confirmed or not), with statistical tests (e.g. chi-square for proportions) and a note that model-labelled proportions are estimates. Unplanned findings go in a separate, clearly marked exploratory section.

---

## 4. Label scheme

### Current (from the project brief, used for testing)

| # | Label | Definition |
|---|---|---|
| 1 | Name Calling / Ad Hominem | attacks the person or group instead of the argument; derogatory labels; "us vs. them" |
| 2 | Appeal to Fear / Catastrophizing | induces panic, apocalyptic scenarios, exaggerated urgency |
| 3 | Whataboutism / Distraction | changes the subject by pointing at others, or sows doubt without evidence |
| 4 | Neutral / Non-propaganda | information, reasoned opinion, sincere question, joke without an attack |

### How to design the final scheme

1. **Start from a published scheme** so it can be cited:
   - Da San Martino et al. (2019), *Fine-Grained Analysis of Propaganda in News Articles*, EMNLP — PTC corpus, 18 techniques.
   - SemEval-2020 Task 11 — 14 techniques (news articles).
   - SemEval-2023 Task 3 (Piskorski et al.) — 23 persuasion techniques grouped into 6 categories: Attack on Reputation, Justification, Simplification, Distraction, Call, Manipulative Wording.
   - For mental-health topics: CLPsych shared tasks, Dreaddit (stress), etc.
2. **Match the number of classes to the data:** with ~200 examples, 3–5 classes (group fine-grained techniques).
3. **Always include a "none / neutral" class.**
4. **Non-overlapping classes + a rule for multiple techniques** (e.g. "pick the dominant one"; multi-label is possible but complicates the models).
5. **Pilot first** to see what actually occurs on Reddit, then fix the scheme.
6. **The scheme must serve the research question.**

Decide upfront: insults without a political target? sarcasm (label by intent)? use the post title as context (yes)? an "unsure" flag for later discussion (yes, the app has it).

---

## 5. The app (Archive Viewer)

A local web app to browse the archives like Reddit and to annotate comments.

### Run

```
py -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt        # only dependency: zstandard
py app.py                              # http://127.0.0.1:8000
```

Restart the server after changing `backend/`; refresh (Ctrl+F5) after changing `frontend/`.

### Pages

| Page | What it does |
|---|---|
| **Subreddits** (home) | "Annotations in this repository": per subreddit, who labelled how much and in which threads, plus what's missing on this computer (missing `.zst` files → download; not indexed → Index button; ✓ ready → links to the threads). Below: all local subreddits, each with an **Index…** button: options *Study period* (on by default, 2021-02-24 → 2023-02-24 — keeps only that period, small index, big files read completely) and *Keep raw JSON of comments* (off by default, ≈3× bigger index). "↻ re-index" rebuilds with other options. |
| **Sample** | the annotation sample (see below): settings with on-by-default toggles (*No bots*, *No deleted/removed*, *25–300 words*, *Study period*, *Balance before/after the event*), sizes (per subreddit, shared, pilot), seed, annotators → **Generate sample**. Then: counts per subreddit/period, everyone's progress, and **your queue** — one comment at a time with the post title and the parent comment as context, big label buttons (keys 1–9), *unsure*, note, ← → navigation, "next unlabelled". Tabs: Pilot → Shared (Kappa) → Mine. |
| **Subreddit** | posts like on Reddit: search titles, sort (most comments / top / newest / oldest), min. comments, toggles *Text posts only* and *Study period* (on), pagination |
| **Post** | the post (text / video / image / link, raw JSON) + the comment tree (collapsible threads, OP/bot badges, word counts, "25–300 ✓" badge). Toggles: *Hide bots* and *Hide deleted* (on by default), *Highlight usable*, *Teammates' labels* (off — turn it on only **after** labelling a thread; Kappa needs independent labels). Each comment has a **🏷 Rate** dropdown with the labels (keys 1–9), an *unsure* flag and a note. |
| **Labels** | your annotator name + the shared labels (add / edit / reorder / delete; "add the proposed set") |
| **Annotations** | class distribution, list of labelled comments (filter by annotator / label / unsure), CSV export |

### Storage

| Folder | Content | In Git? |
|---|---|---|
| `subreddits24/` | the `.zst` archives | no |
| `cache/` | SQLite index per subreddit (rebuildable) | no |
| `annotations/labels.json` | the labels — **shared by everyone** | yes |
| `annotations/sample.json` | the annotation sample: settings + items (comment text, post title, parent comment, subreddit, period, group: pilot / shared / annotator) | yes |
| `annotations/annotators/<name>.jsonl` | one person's labels; each line keeps the comment text, post title and source `.zst` file | yes |
| `annotations/annotators/<name>.md` | auto-generated summary tables (source files, per-label counts, last 30 labels) | yes |

**The sample.** Per subreddit (and per half of the period), comments are pre-filtered in SQL, ordered by `hash(seed + comment id)` (same seed → same sample) and checked in Python (no bots, word range excluding quotes). Groups: *pilot* (everyone; calibrates the rules, not in the gold set), *shared* (everyone, independently → Kappa), and one part per annotator. Shared and per-annotator parts are interleaved across subreddits, so each is stratified. Because each item stores its text, a teammate can label sample items even without indexing that subreddit.

Each annotator writes only to their own files → no merge conflicts. The server reloads files changed by `git pull`. A `.jsonl` with an unresolved Git conflict is detected and the app refuses to write to it.

### Code structure

```
app.py                  entry point (creates subreddits24/ if missing, starts the server)
backend/
  config.py             paths and limits
  zst_reader.py         streaming .zst reader, HTML unescaping
  indexer.py            builds the SQLite index (optional study period, background thread + progress)
  queries.py            post list / post + comments / raw JSON
  annotations.py        labels + annotations as text files, summaries, stats, CSV, coverage
  sampling.py           the annotation sample (stratified, seeded, filtered) + progress
  server.py             HTTP server (stdlib http.server): /api/... routes + static files
frontend/
  index.html            page skeleton + top menu
  css/                  base.css, components/*.css, pages/*.css
  js/main.js            router (#/, #/r/<sub>, #/r/<sub>/p/<id>, #/labels, #/annotations)
  js/utils.js, store.js helpers, shared state (labels, annotator name)
  js/components/        postCard, comment, rateMenu, indexPanel, toggleChip
  js/pages/             home, sample, subreddit, post, labels, annotations
main.ipynb              data exploration notebook
```

Only external frontend libraries: `marked` + `DOMPurify` from a CDN (Markdown rendering); without internet, text is shown unformatted.

---

## 6. Git workflow

- Repository: `reddit-comment-analysis` on GitHub (private recommended). Neutral name because the topic may change.
- Daily: `git pull` → work / annotate → `git add .` → `git commit -m "..."` → `git push`.
- Teammate onboarding: added as collaborator → `git clone` → venv + `pip install -r requirements.txt` → `py app.py` → the home page lists the `.zst` files to download → set annotator name in **Labels** → annotate.
- New Python library → install in the venv and add it with its version to `requirements.txt` (don't paste a global `pip freeze`).
- Agree on the labels together at the start; don't edit `labels.json` separately.

---

## 7. Status and next steps

**Done**
- Data understanding (formats, fields, joins, cleaning rules).
- Archive viewer + annotation tool, Git-friendly annotation storage, teammate coverage view.
- Repository on GitHub, README, requirements.
- Topic direction (propaganda, Russia–Ukraine war), 8 subreddits downloaded, study period, proposed hypotheses.
- Period-based indexing and the annotation sample + queue in the app.

**Next**
1. **Index the 8 subreddits** with the study period, **generate the sample** (8 × 25 = 200 gold, 50 shared, 20 pilot), commit `annotations/sample.json`.
2. **Write the codebook** (definitions, examples, decision rules) for the 4 labels.
3. **Pilot** (both annotators) → discuss disagreements → refine the rules → finalize the hypotheses (commit them).
4. **Gold set** → Cohen's Kappa, class distribution → **1 December** update.
5. **LLM via API** on the gold set (dev/test split) — the app can add the LLM as an extra "annotator" and compute its agreement with us.
6. Scale, train TF-IDF + LR and RoBERTa, evaluate on the gold set, error analysis, write the paper.

**Possible app additions:** Cohen's Kappa page (shared comments, score, disagreements), LLM-annotator integration, "Rate" button on posts (for topics where the post text matters more than comments).

---

## Glossary

| Term | Meaning |
|---|---|
| Gold set | the human-annotated examples used as ground truth (and as the test set) |
| Codebook | the written labelling rules: definitions, examples, counter-examples, decision rules |
| Cohen's Kappa | inter-annotator agreement corrected for chance |
| Few-shot | giving the LLM a few labelled examples inside the prompt |
| Anchoring bias | tendency to agree with a label you've already seen |
| Active learning | iteratively labelling the examples the model is least sure about |
| Macro-F1 | F1 averaged over classes equally (fair under class imbalance) |
| Pushshift | the project that archived Reddit (2005–2023) into the `.zst` dumps |
