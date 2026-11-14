"""Building the SQLite index for a subreddit.

Why: a .zst file has no random access — finding one post would mean reading the
whole file on every click. So we read it ONCE and store the posts + comments in
cache/<subreddit>.sqlite, with an index on link_id.

Indexing runs on a background thread; progress is kept in `jobs`.
"""

import json
import os
import re
import sqlite3
import threading
import time
import zlib

from .config import BIG_FILE_BYTES, BIG_FILE_LIMIT, CACHE_DIR, DATA_DIR
from .zst_reader import stream_zst, to_int, unesc

IMAGE_RE = re.compile(r"\.(jpe?g|png|gif|webp)(\?.*)?$", re.I)

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
UPDATE posts SET found = (SELECT COUNT(*) FROM comments WHERE comments.link = posts.id);
CREATE INDEX idx_p_found ON posts(found);
CREATE INDEX idx_p_score ON posts(score);
CREATE INDEX idx_p_created ON posts(created);
"""

POST_SQL = "INSERT OR REPLACE INTO posts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)"
COMMENT_SQL = "INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"

jobs = {}            # subreddit → {state, phase, progress, rows, error}
jobs_lock = threading.Lock()


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


def post_row(s):
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
        unesc(s.get("link_flair_text")), video, image, thumb, pack(s),
    )


def comment_row(c):
    cid = c.get("id")
    link = c.get("link_id") or ""
    if not cid or not link:
        return None
    return (
        cid, link[3:] if link.startswith("t3_") else link, c.get("parent_id") or "",
        c.get("author"), unesc(c.get("body")), to_int(c.get("score")),
        to_int(c.get("controversiality")), to_int(c.get("created_utc")),
        c.get("distinguished"), 1 if c.get("stickied") else 0,
        1 if c.get("edited") else 0, pack(c),
    )


# ---------------------------------------------------------------- indexing

def build_index(sub):
    def update(**kw):
        with jobs_lock:
            jobs[sub].update(kw)

    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = db_path(sub) + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = None
    try:
        con = sqlite3.connect(tmp)
        con.executescript(SCHEMA)
        partial = False
        counts = {}
        for kind, sql, rowf in (("submissions", POST_SQL, post_row),
                                ("comments", COMMENT_SQL, comment_row)):
            path = os.path.join(DATA_DIR, f"{sub}_{kind}.zst")
            if not os.path.exists(path):
                continue
            limit = BIG_FILE_LIMIT if os.path.getsize(path) > BIG_FILE_BYTES else None
            update(phase=kind, progress=0.0, rows=0)
            batch, n = [], 0
            for obj in stream_zst(path, limit,
                                  lambda frac, rows, k=kind: update(phase=k, progress=frac, rows=rows)):
                row = rowf(obj)
                if row:
                    batch.append(row)
                if len(batch) >= 5000:
                    con.executemany(sql, batch)
                    batch.clear()
                n += 1
            if batch:
                con.executemany(sql, batch)
            counts[kind] = n
            if limit and n >= limit:
                partial = True
        update(phase="finalize", progress=1.0)
        con.executescript(FINALIZE)
        con.executemany("INSERT INTO meta VALUES (?,?)", [
            ("posts", str(counts.get("submissions", 0))),
            ("comments", str(counts.get("comments", 0))),
            ("partial", "1" if partial else "0"),
            ("built", str(int(time.time()))),
        ])
        con.commit()
        con.close()
        con = None
        os.replace(tmp, db_path(sub))      # only now does the index become visible
        update(state="done")
    except Exception as e:  # noqa: BLE001 - report any error in the UI
        update(state="error", error=repr(e))
        if con:
            con.close()
        if os.path.exists(tmp):
            os.remove(tmp)


def start_index(sub):
    """Start indexing on a background thread (unless it's already running)."""
    with jobs_lock:
        if jobs.get(sub, {}).get("state") == "building":
            return
        jobs[sub] = {"state": "building", "phase": "start", "progress": 0.0, "rows": 0, "error": None}
    threading.Thread(target=build_index, args=(sub,), daemon=True).start()


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
                       "partial": meta.get("partial") == "1", "built": int(meta.get("built", 0))}
    return out
