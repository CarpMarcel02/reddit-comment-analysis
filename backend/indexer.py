"""Building the SQLite index for a subreddit.

Why: a .zst file has no random access — finding one post would mean reading the
whole file on every click. So we read it ONCE and store the posts + comments in
cache/<subreddit>.sqlite, with indexes on link_id and on the creation time.

Optional study period: only comments created in [start, end) are kept (and posts
from POST_LOOKBACK_DAYS before start), which keeps the index small and makes big
files usable (no "first 2M lines" cut-off). The raw JSON of comments is optional
too — it roughly triples the index size.

Indexing runs on a background thread; progress is kept in `jobs`.
"""

import json
import os
import re
import sqlite3
import threading
import time
import zlib
from datetime import datetime, timezone

from .config import BIG_FILE_BYTES, BIG_FILE_LIMIT, CACHE_DIR, DATA_DIR, POST_LOOKBACK_DAYS
from .zst_reader import stream_zst, to_int, unesc

IMAGE_RE = re.compile(r"\.(jpe?g|png|gif|webp)(\?.*)?$", re.I)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SCHEMA = """
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE posts (
    id TEXT PRIMARY KEY, author TEXT, title TEXT, selftext TEXT, url TEXT,
    domain TEXT, permalink TEXT, created INTEGER, score INTEGER, ratio REAL,
    num_comments INTEGER, is_self INTEGER, nsfw INTEGER, flair TEXT,
    video TEXT, image TEXT, thumb TEXT, found INTEGER DEFAULT 0, raw BLOB
);
CREATE TABLE comments (
    id TEXT, link TEXT, parent TEXT, author TEXT, body TEXT, score INTEGER,
    controv INTEGER, created INTEGER, distinguished TEXT, stickied INTEGER,
    edited INTEGER, raw BLOB
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
"""

FINALIZE = """
CREATE INDEX idx_c_link ON comments(link);
CREATE INDEX idx_c_id ON comments(id);
CREATE INDEX idx_c_created ON comments(created);
UPDATE posts SET found = (SELECT COUNT(*) FROM comments WHERE comments.link = posts.id);
CREATE INDEX idx_p_found ON posts(found);
CREATE INDEX idx_p_score ON posts(score);
CREATE INDEX idx_p_created ON posts(created);
"""

POST_SQL = "INSERT OR REPLACE INTO posts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)"
COMMENT_SQL = "INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"

jobs = {}            # subreddit → {state, phase, progress, rows, kept, error}
jobs_lock = threading.Lock()


# ---------------------------------------------------------------- dates

def parse_date(value):
    """"2021-02-24" → Unix timestamp (UTC midnight). Raises ValueError on bad input."""
    s = str(value or "").strip()
    try:
        if not DATE_RE.match(s):
            raise ValueError
        return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        raise ValueError(f"Invalid date “{s}” (expected YYYY-MM-DD).") from None


# ---------------------------------------------------------------- files

def db_path(sub):
    return os.path.join(CACHE_DIR, f"{sub}.sqlite")


def list_subreddits():
    """{subreddit_name: {"submissions": bytes, "comments": bytes}} found in subreddits24/."""
    subs = {}
    if not os.path.isdir(DATA_DIR):
        return subs
    for f in os.listdir(DATA_DIR):
        for kind in ("submissions", "comments"):
            suffix = f"_{kind}.zst"
            if f.endswith(suffix):
                name = f[: -len(suffix)]
                subs.setdefault(name, {})[kind] = os.path.getsize(os.path.join(DATA_DIR, f))
    return subs


# ---------------------------------------------------------------- rows

def pack(obj):
    """The original JSON, compressed (for the "Raw JSON" button in the UI)."""
    return zlib.compress(json.dumps(obj, ensure_ascii=False).encode("utf-8"), 3)


def post_row(s, keep_raw=True):
    pid = s.get("id")
    if not pid:
        return None
    media = s.get("secure_media") or s.get("media") or {}
    video = None
    if isinstance(media, dict):
        video = (media.get("reddit_video") or {}).get("fallback_url")
    url = s.get("url") or ""
    image = None
    if IMAGE_RE.search(url):
        image = url
    elif s.get("post_hint") == "image":
        try:
            image = unesc(s["preview"]["images"][0]["source"]["url"])
        except (KeyError, IndexError, TypeError):
            image = None
    thumb = s.get("thumbnail") or ""
    if not thumb.startswith("http"):
        thumb = None
    return (
        pid, s.get("author"), unesc(s.get("title")), unesc(s.get("selftext")), url,
        s.get("domain"), s.get("permalink"), to_int(s.get("created_utc")),
        to_int(s.get("score")), s.get("upvote_ratio"), to_int(s.get("num_comments")),
        1 if s.get("is_self") else 0, 1 if s.get("over_18") else 0,
        unesc(s.get("link_flair_text")), video, image, thumb, pack(s) if keep_raw else None,
    )


def comment_row(c, keep_raw=True):
    cid = c.get("id")
    link = c.get("link_id") or ""
    if not cid or not link:
        return None
    return (
        cid, link[3:] if link.startswith("t3_") else link, c.get("parent_id") or "",
        c.get("author"), unesc(c.get("body")), to_int(c.get("score")),
        to_int(c.get("controversiality")), to_int(c.get("created_utc")),
        c.get("distinguished"), 1 if c.get("stickied") else 0,
        1 if c.get("edited") else 0, pack(c) if keep_raw else None,
    )


# ---------------------------------------------------------------- indexing

def build_index(sub, start=None, end=None, raw_comments=False):
    """Read both .zst files of a subreddit into cache/<sub>.sqlite.

    start / end: "YYYY-MM-DD" strings (or None for the whole history).
    """
    def update(**kw):
        with jobs_lock:
            jobs[sub].update(kw)

    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = db_path(sub) + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = None
    try:
        start_ts = parse_date(start) if start else None
        end_ts = parse_date(end) if end else None
        post_from = start_ts - POST_LOOKBACK_DAYS * 86400 if start_ts else None

        con = sqlite3.connect(tmp)
        con.executescript(SCHEMA)
        partial = False
        kept = {}
        for kind, sql in (("submissions", POST_SQL), ("comments", COMMENT_SQL)):
            path = os.path.join(DATA_DIR, f"{sub}_{kind}.zst")
            if not os.path.exists(path):
                continue
            # without a period, huge files are cut to their first lines (= the oldest period)
            limit = BIG_FILE_LIMIT if (start_ts is None and os.path.getsize(path) > BIG_FILE_BYTES) else None
            lower = post_from if kind == "submissions" else start_ts
            update(phase=kind, progress=0.0, rows=0, kept=0)
            batch, n, k = [], 0, 0
            for obj in stream_zst(path, limit,
                                  lambda frac, rows, kd=kind: update(phase=kd, progress=frac, rows=rows,
                                                                     kept=k)):
                n += 1
                created = to_int(obj.get("created_utc"))
                if (lower is not None and created < lower) or (end_ts is not None and created >= end_ts):
                    continue
                row = (post_row(obj) if kind == "submissions" else comment_row(obj, raw_comments))
                if row:
                    batch.append(row)
                    k += 1
                if len(batch) >= 5000:
                    con.executemany(sql, batch)
                    batch.clear()
            if batch:
                con.executemany(sql, batch)
            kept[kind] = k
            if limit and n >= limit:
                partial = True
        update(phase="finalize", progress=1.0)
        con.executescript(FINALIZE)
        con.executemany("INSERT INTO meta VALUES (?,?)", [
            ("posts", str(kept.get("submissions", 0))),
            ("comments", str(kept.get("comments", 0))),
            ("partial", "1" if partial else "0"),
            ("built", str(int(time.time()))),
            ("period_start", start or ""),
            ("period_end", end or ""),
            ("raw_comments", "1" if raw_comments else "0"),
        ])
        con.commit()
        con.close()
        con = None
        os.replace(tmp, db_path(sub))      # only now does the index become visible
        update(state="done")
    except Exception as e:  # noqa: BLE001 - report any error in the UI
        update(state="error", error=str(e) if isinstance(e, ValueError) else repr(e))
        if con:
            con.close()
        if os.path.exists(tmp):
            os.remove(tmp)


def start_index(sub, start=None, end=None, raw_comments=False):
    """Start indexing on a background thread (unless it's already running)."""
    if start:
        parse_date(start)          # validate early → HTTP 400 instead of a failed job
    if end:
        parse_date(end)
    if start and end and parse_date(start) >= parse_date(end):
        raise ValueError("The period start must be before its end.")
    with jobs_lock:
        if jobs.get(sub, {}).get("state") == "building":
            return
        jobs[sub] = {"state": "building", "phase": "start", "progress": 0.0, "rows": 0, "kept": 0, "error": None}
    threading.Thread(target=build_index, args=(sub, start, end, raw_comments), daemon=True).start()


def read_meta(sub):
    con = sqlite3.connect(db_path(sub))
    try:
        return dict(con.execute("SELECT k, v FROM meta").fetchall())
    finally:
        con.close()


def status(sub):
    """Index state: ready / building (with progress) / not indexed."""
    with jobs_lock:
        job = dict(jobs.get(sub, {}))
    ready = os.path.exists(db_path(sub))
    out = {"ready": ready, "building": job.get("state") == "building", "job": job}
    if ready:
        meta = read_meta(sub)
        out["meta"] = {"posts": int(meta.get("posts", 0)), "comments": int(meta.get("comments", 0)),
                       "partial": meta.get("partial") == "1", "built": int(meta.get("built", 0)),
                       "period_start": meta.get("period_start", ""), "period_end": meta.get("period_end", ""),
                       "raw_comments": meta.get("raw_comments", "1") == "1"}
    return out
