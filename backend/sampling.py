"""The annotation sample: a random, stratified, reproducible list of comments to label.

Saved to annotations/sample.json (committed to Git), so every annotator works on the
same list. Each item belongs to one group:
    "pilot"          labelled by everyone, used to calibrate the rules (not part of the gold set)
    "shared"         labelled by everyone, independently → Cohen's Kappa
    <annotator name> labelled by that annotator only

How items are drawn, per subreddit (and per half of the period when "balance" is on):
    1. SQL pre-filter: inside the period, not deleted/removed, plausible length
    2. deterministic pseudo-random order: hash(seed + comment id)  → same seed = same sample
    3. Python filters: no bots, 25–300 words (excluding quoted lines), English only (mostly Latin letters)
"""

import hashlib
import json
import os
import re
import sqlite3
import time

from .annotations import Conflict, _write_text, labelled_ids, slugify, views_for
from .config import SAMPLE_FILE
from .indexer import db_path, list_subreddits, parse_date, read_meta
from .zst_reader import to_int

BOT_RE = re.compile(r"bot|automoderator|autotldr", re.I)
LATIN_RE = re.compile(r"[A-Za-z]")
CYRILLIC_RE = re.compile(r"[Ѐ-ӿ]")
MAX_CYRILLIC_SHARE = 0.2      # "English only": at most 20% of the letters may be Cyrillic (a quoted word is fine)


def is_mostly_latin(text):
    lat, cyr = len(LATIN_RE.findall(text or "")), len(CYRILLIC_RE.findall(text or ""))
    return lat > 0 and cyr / (lat + cyr) <= MAX_CYRILLIC_SHARE
DELETED = ("[deleted]", "[removed]", "")
POST_MEDIA_KEYS = ("url", "domain", "image", "video", "thumb", "is_self")
MAX_CONTEXT_CHARS = 1500    # per comment in the context chain / for the post body
MAX_CONTEXT_DEPTH = 20      # how many ancestor comments to keep (top-level → direct parent)


def _clip(text, n=MAX_CONTEXT_CHARS):
    text = text or ""
    return text if len(text) <= n else text[:n] + "…"


def _context_chain(con, parent):
    """Ancestor comments of a comment, from the top-level one down to its direct parent."""
    chain = []
    while parent and parent.startswith("t1_") and len(chain) < MAX_CONTEXT_DEPTH:
        row = con.execute("SELECT id, author, body, parent FROM comments WHERE id = ?", (parent[3:],)).fetchone()
        if not row:
            chain.append({"id": parent[3:], "author": None, "text": None})   # parent missing from the archive
            break
        cid, author, body, parent = row
        chain.append({"id": cid, "author": author, "text": _clip(body)})
    chain.reverse()
    return chain


def words_no_quotes(text):
    return len(" ".join(l for l in (text or "").split("\n") if not l.strip().startswith(">")).split())


def _rank(seed, key):
    return int(hashlib.sha1(f"{seed}:{key}".encode()).hexdigest()[:12], 16)


def _load():
    if not os.path.exists(SAMPLE_FILE):
        return None
    with open(SAMPLE_FILE, encoding="utf-8") as f:
        return json.load(f)


def find_item(comment_id):
    """The sample item for a comment (used when the annotator hasn't indexed that subreddit)."""
    s = _load()
    if not s:
        return None
    return next((it for it in s["items"] if it["comment_id"] == comment_id), None)


# ============================================================ settings

def _clean_settings(data):
    f = data.get("filters") or {}
    annotators = [" ".join(str(a or "").split()) for a in (data.get("annotators") or [])]
    annotators = [a for a in annotators if a]
    if not annotators:
        raise ValueError("Add at least one annotator name.")
    if len({a.casefold() for a in annotators}) != len(annotators):
        raise ValueError("Annotator names must be different.")
    if any(a.casefold() in ("pilot", "shared") for a in annotators):
        raise ValueError("“pilot” and “shared” can't be used as annotator names.")
    subs = [str(s) for s in (data.get("subreddits") or [])]
    local = list_subreddits()
    unknown = [s for s in subs if s not in local]
    if unknown:
        raise ValueError(f"Unknown subreddit(s): {', '.join(unknown)}.")
    if not subs:
        raise ValueError("Pick at least one subreddit.")
    s = {
        "subreddits": subs,
        "per_subreddit": max(1, min(500, to_int(data.get("per_subreddit"), 25))),
        "shared": max(0, to_int(data.get("shared"), 50)),
        "pilot": max(0, min(200, to_int(data.get("pilot"), 20))),
        "seed": str(data.get("seed") if data.get("seed") not in (None, "") else "42"),
        "annotators": annotators,
        "filters": {
            "no_bots": bool(f.get("no_bots", True)),
            "no_deleted": bool(f.get("no_deleted", True)),
            "english_only": bool(f.get("english_only", True)),
            "word_range": bool(f.get("word_range", True)),
            "min_words": max(1, to_int(f.get("min_words"), 25)),
            "max_words": max(1, to_int(f.get("max_words"), 300)),
            "period": bool(f.get("period", True)),
            "period_start": str(f.get("period_start") or ""),
            "period_end": str(f.get("period_end") or ""),
            "balance": bool(f.get("balance", True)),
            "event_date": str(f.get("event_date") or ""),
        },
    }
    fl = s["filters"]
    if fl["min_words"] > fl["max_words"]:
        raise ValueError("Min. words must be ≤ max. words.")
    if fl["period"]:
        if parse_date(fl["period_start"]) >= parse_date(fl["period_end"]):
            raise ValueError("The period start must be before its end.")
    if fl["balance"]:
        ev = parse_date(fl["event_date"])
        if fl["period"] and not (parse_date(fl["period_start"]) < ev < parse_date(fl["period_end"])):
            raise ValueError("The event date must be inside the period.")
    if s["shared"] > s["per_subreddit"] * len(subs):
        raise ValueError("More shared items than items in the gold set.")
    return s


# ============================================================ drawing

def _windows(s):
    """[(label, start_ts | None, end_ts | None)] — one window, or two halves split at the event date."""
    fl = s["filters"]
    start = parse_date(fl["period_start"]) if fl["period"] else None
    end = parse_date(fl["period_end"]) if fl["period"] else None
    if fl["balance"]:
        ev = parse_date(fl["event_date"])
        return [("before", start, ev), ("after", ev, end)]
    return [("all", start, end)]


def _draw(con, sub, s, label, start, end, n):
    """Draw n valid comments from one subreddit and one time window, in seeded random order."""
    fl = s["filters"]
    where, args = [], []
    if start is not None:
        where.append("c.created >= ?")
        args.append(start)
    if end is not None:
        where.append("c.created < ?")
        args.append(end)
    if fl["no_deleted"]:
        where.append("c.body NOT IN ('[deleted]', '[removed]', '')")
    if fl["word_range"]:   # cheap pre-filter on characters; the exact word count is checked below
        where.append("length(c.body) BETWEEN ? AND ?")
        args += [fl["min_words"] * 2, fl["max_words"] * 30]
    seed = s["seed"]
    con.create_function("rnk", 1, lambda cid: _rank(seed, cid), deterministic=True)
    sql = ("SELECT c.id, c.link, c.parent, c.author, c.body, c.score, c.controv, c.created, p.title, p.selftext, "
           "p.url, p.domain, p.image, p.video, p.thumb, p.is_self "
           "FROM comments c LEFT JOIN posts p ON p.id = c.link "
           + ("WHERE " + " AND ".join(where) if where else "") + " ORDER BY rnk(c.id)")
    out, scanned = [], 0
    for row in con.execute(sql, args):
        scanned += 1
        cid, link, parent, author, body, score, controv, created, title, selftext = row[:10]
        media = dict(zip(POST_MEDIA_KEYS, row[10:]))
        if fl["no_bots"] and (not author or BOT_RE.search(author)):
            continue
        if fl["no_deleted"] and (body or "").strip() in DELETED:
            continue
        if fl["word_range"] and not (fl["min_words"] <= words_no_quotes(body) <= fl["max_words"]):
            continue
        if fl.get("english_only") and not is_mostly_latin(body):
            continue
        body_text = (selftext or "").strip()
        out.append({
            "comment_id": cid, "subreddit": sub, "source_file": f"{sub}_comments.zst",
            "link_id": link, "post_title": title or "",
            "post_text": _clip(body_text) if body_text not in DELETED else None,
            "post_media": media,                       # link / image / video of the post
            "parent_id": parent,
            "context": _context_chain(con, parent),    # the thread above this comment, top-level first
            "author": author, "text": body, "score": score, "controversiality": controv,
            "created": created, "period": label,
        })
        if len(out) >= n:
            break
    return out


def create_sample(data, force=False):
    s = _clean_settings(data)
    existing = _load()
    if existing and not force:
        raise Conflict("A sample already exists. Regenerating replaces it (labels already given are kept, "
                       "but items that drop out of the sample won't be in the queue anymore).")
    fl = s["filters"]
    windows = _windows(s)
    n_subs = len(s["subreddits"])
    pilot_per_sub = -(-s["pilot"] // n_subs) if s["pilot"] else 0     # ceil
    warnings = []
    gold_by_sub, pilot_pool = {}, []

    for sub in s["subreddits"]:
        if not os.path.exists(db_path(sub)):
            raise ValueError(f"r/{sub} isn't indexed yet — index it first.")
        meta = read_meta(sub)
        if fl["period"] and meta.get("period_start"):
            if parse_date(meta["period_start"]) > parse_date(fl["period_start"]) or \
               parse_date(meta.get("period_end") or "9999-12-31") < parse_date(fl["period_end"]):
                warnings.append(f"r/{sub}: its index covers {meta['period_start']} → {meta['period_end']}, "
                                f"narrower than the sample period.")
        con = sqlite3.connect(db_path(sub))
        try:
            # indexes built by older versions of the app lack these (needed for speed)
            con.execute("CREATE INDEX IF NOT EXISTS idx_c_id ON comments(id)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_c_created ON comments(created)")
            gold, extra = [], []
            for wi, (label, start, end) in enumerate(windows):
                # split the per-subreddit counts across the windows (the first window gets the remainder)
                n_gold = s["per_subreddit"] // len(windows) + (1 if wi < s["per_subreddit"] % len(windows) else 0)
                n_pil = pilot_per_sub // len(windows) + (1 if wi < pilot_per_sub % len(windows) else 0)
                got = _draw(con, sub, s, label, start, end, n_gold + n_pil)
                if len(got) < n_gold + n_pil:
                    warnings.append(f"r/{sub} ({label}): only {len(got)} valid comments, wanted {n_gold + n_pil}.")
                gold += got[:n_gold]
                extra += got[n_gold:]
            gold_by_sub[sub] = gold
            pilot_pool += extra
        finally:
            con.close()

    seed = s["seed"]
    # pilot: spread across subreddits, trimmed to the requested size
    pilot_pool.sort(key=lambda it: _rank(seed, "pilot:" + it["comment_id"]))
    pilot = pilot_pool[: s["pilot"]]

    # gold set: interleave subreddits so "shared" and each annotator's part are stratified
    for items in gold_by_sub.values():
        items.sort(key=lambda it: _rank(seed, "order:" + it["comment_id"]))
    interleaved, i = [], 0
    while any(i < len(v) for v in gold_by_sub.values()):
        for sub in s["subreddits"]:
            if i < len(gold_by_sub[sub]):
                interleaved.append(gold_by_sub[sub][i])
        i += 1
    for it in pilot:
        it["group"] = "pilot"
    for k, it in enumerate(interleaved):
        it["group"] = "shared" if k < s["shared"] else s["annotators"][(k - s["shared"]) % len(s["annotators"])]

    items = pilot + interleaved
    for k, it in enumerate(items):
        it["order"] = k
    sample = {"version": 1, "created": int(time.time()), "settings": s, "warnings": warnings, "items": items}
    _write_text(SAMPLE_FILE, json.dumps(sample, ensure_ascii=False, indent=1) + "\n")
    return get_sample(data.get("me", ""))


# ============================================================ reading

def _enrich_post_media(items):
    """Older samples don't store the post's link/image/video: fill them from the local index when it exists."""
    missing = {}
    for it in items:
        if "post_media" not in it:
            missing.setdefault(it["subreddit"], []).append(it)
    for sub, its in missing.items():
        if not os.path.exists(db_path(sub)):
            continue
        con = sqlite3.connect(db_path(sub))
        try:
            for it in its:
                row = con.execute("SELECT selftext, " + ", ".join(POST_MEDIA_KEYS) + " FROM posts WHERE id = ?",
                                  (it["link_id"],)).fetchone()
                if row:
                    it["post_media"] = dict(zip(POST_MEDIA_KEYS, row[1:]))
                    text = (row[0] or "").strip()
                    if "post_text" not in it:
                        it["post_text"] = _clip(text) if text not in DELETED else None
        finally:
            con.close()


def get_sample(annotator=""):
    """The sample + each annotator's progress per group (+ `annotator`'s own labels on sample items)."""
    s = _load()
    if not s:
        return None
    _enrich_post_media(s["items"])
    mine = {}
    if annotator:
        ids = {it["comment_id"] for it in s["items"]}
        mine = {cid: a for cid, a in views_for(annotator).items() if cid in ids}
        s["me"] = next((a for a in s["settings"]["annotators"] if slugify(a) == slugify(annotator)), None)
    progress = []
    for name in s["settings"]["annotators"]:
        done = labelled_ids(name)
        groups = {}
        for it in s["items"]:
            if it["group"] in ("pilot", "shared") or it["group"] == name:
                g = it["group"] if it["group"] in ("pilot", "shared") else "own"
                d = groups.setdefault(g, {"done": 0, "total": 0})
                d["total"] += 1
                d["done"] += it["comment_id"] in done
        progress.append({"annotator": name, "groups": groups})
    return {**s, "progress": progress, "mine": mine}
