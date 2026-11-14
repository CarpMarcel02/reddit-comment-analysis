"""Queries on the SQLite index (used by the API routes)."""

import json
import os
import sqlite3
import zlib

from .config import PAGE_SIZE
from .indexer import db_path
from .zst_reader import to_int

POST_COLS = ("id, author, title, selftext, url, domain, permalink, created, score, ratio, "
             "num_comments, is_self, nsfw, flair, video, image, thumb, found")
COMMENT_COLS = "id, parent, author, body, score, controv, created, distinguished, stickied, edited"

SORTS = {"comments": "found DESC", "score": "score DESC", "new": "created DESC", "old": "created ASC"}


def connect(sub):
    if not os.path.exists(db_path(sub)):
        raise LookupError("This subreddit hasn't been indexed yet.")
    con = sqlite3.connect(db_path(sub))
    con.row_factory = sqlite3.Row
    return con


def get_posts(sub, q):
    """Paginated list of posts, with search / sorting / filters."""
    sort = SORTS.get(q.get("sort", "comments"), SORTS["comments"])
    page = max(0, to_int(q.get("page"), 0))
    min_c = max(0, to_int(q.get("min"), 0))
    where, args = ["found >= ?"], [min_c]
    if q.get("q"):
        where.append("title LIKE ?")
        args.append(f"%{q['q']}%")
    if q.get("self") == "1":
        where.append("is_self = 1 AND selftext NOT IN ('', '[deleted]', '[removed]')")
    w = " AND ".join(where)
    con = connect(sub)
    try:
        total = con.execute(f"SELECT COUNT(*) FROM posts WHERE {w}", args).fetchone()[0]
        rows = con.execute(f"SELECT {POST_COLS} FROM posts WHERE {w} ORDER BY {sort} LIMIT ? OFFSET ?",
                           args + [PAGE_SIZE, page * PAGE_SIZE]).fetchall()
        return {"total": total, "page": page, "page_size": PAGE_SIZE, "posts": [dict(r) for r in rows]}
    finally:
        con.close()


def get_post(sub, pid):
    """One post + all its comments (flat list; the frontend builds the tree)."""
    con = connect(sub)
    try:
        post = con.execute(f"SELECT {POST_COLS} FROM posts WHERE id = ?", (pid,)).fetchone()
        comments = con.execute(f"SELECT {COMMENT_COLS} FROM comments WHERE link = ? ORDER BY created",
                               (pid,)).fetchall()
        if post is None and not comments:
            raise LookupError("This post isn't in the index.")
        return {"post": dict(post) if post else {"id": pid, "missing": True},
                "comments": [dict(c) for c in comments]}
    finally:
        con.close()


def get_raw(sub, kind, oid):
    """The original JSON (all fields) of a post or a comment."""
    table = "posts" if kind == "post" else "comments"
    con = connect(sub)
    try:
        row = con.execute(f"SELECT raw FROM {table} WHERE id = ?", (oid,)).fetchone()
        if row is None:
            raise LookupError("Object not found.")
        return json.loads(zlib.decompress(row["raw"]).decode("utf-8"))
    finally:
        con.close()
