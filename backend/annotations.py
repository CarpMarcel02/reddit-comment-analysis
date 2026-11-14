"""Annotations stored as TEXT files, designed for Git.

annotations/
├── labels.json            the labels — SHARED by all annotators
└── annotators/
    ├── marcel.jsonl       Marcel's annotations (one JSON line = one labelled comment)
    ├── marcel.md          auto-generated summary: which .zst files, how many labels, which classes
    └── <teammate>.jsonl/.md  same for teammates

Why this layout:
  • each annotator writes ONLY to their own files → no conflicts on git push / pull;
  • every annotation keeps the comment text + the source .zst file, so teammates can
    see your annotations without having (or reading) that archive;
  • the server notices when files change on disk (e.g. after `git pull`) and reloads them.

Note: the proposed label set (DEFAULT_LABELS) and the generated .md summaries are in Romanian.
"""

import csv
import io
import json
import os
import re
import sqlite3
import threading
import time
import unicodedata
from datetime import datetime, timezone

from .config import ANNOTATORS_DIR, LABELS_FILE
from .indexer import db_path
from .zst_reader import to_int


class Conflict(Exception):
    """The operation conflicts with existing data (→ HTTP 409)."""


COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
PAGE_SIZE = 50

# field order of a .jsonl line (fixed → clean diffs in Git)
RECORD_KEYS = ["comment_id", "annotator", "label_id", "label", "unsure", "note",
               "subreddit", "source_file", "link_id", "post_title", "author", "text",
               "created", "updated"]

# the label set proposed in the project brief (inspired by SemEval-2020 Task 11)
DEFAULT_LABELS = [
    ("Name Calling / Ad Hominem",
     "Atacă persoana sau grupul în loc de argument; etichete disprețuitoare; „noi vs. ei”.", "#e5484d"),
    ("Apel la frică / Catastrofizare",
     "Induce panică, scenarii apocaliptice sau urgență exagerată.", "#f76b15"),
    ("Whataboutism / Distragere",
     "Schimbă subiectul arătând spre alții („dar ce zici de X?”) sau sădește îndoială fără dovezi.", "#8e4ec6"),
    ("Neutru / Non-propagandă",
     "Informație, opinie argumentată, întrebare sinceră, glumă fără atac.", "#30a46c"),
]

# ============================================================ in-memory state

_lock = threading.RLock()
_labels = []      # [{"id", "name", "description", "color"}] in dropdown order
_next_id = 1      # ids are never reused (old annotations can't end up on a different label)
_ann = {}         # annotator slug → {comment_id: record}
_broken = {}      # slug / "labels" → message (file with invalid lines, e.g. unresolved Git conflict)
_sigs = {}        # file path → (mtime, size), to detect changes on disk


def slugify(name):
    """"Mărcel Pop" → "marcel_pop" (the annotator's file name)."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9_-]+", "_", ascii_name.lower()).strip("_")
    return slug or "anonymous"


def _jsonl_path(slug):
    return os.path.join(ANNOTATORS_DIR, f"{slug}.jsonl")


def _md_path(slug):
    return os.path.join(ANNOTATORS_DIR, f"{slug}.md")


def _sig(path):
    st = os.stat(path)
    return (st.st_mtime_ns, st.st_size)


def _write_text(path, text):
    """Atomic write with LF line endings (same on Windows and Linux → no spurious Git diffs)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def _read_jsonl(path, slug):
    records, bad = {}, 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                records[r["comment_id"]] = r
            except (ValueError, KeyError, TypeError):
                bad += 1
    if bad:
        _broken[slug] = (f"annotators/{slug}.jsonl has {bad} invalid line(s) "
                         f"(maybe an unresolved Git conflict). Fix it before saving again.")
    else:
        _broken.pop(slug, None)
    return records


def _refresh():
    """Reload files that changed on disk (e.g. after git pull)."""
    global _next_id
    # --- labels
    if os.path.exists(LABELS_FILE):
        sig = _sig(LABELS_FILE)
        if _sigs.get(LABELS_FILE) != sig:
            try:
                with open(LABELS_FILE, encoding="utf-8") as f:
                    data = json.load(f)
                _labels[:] = [{"id": int(l["id"]), "name": str(l["name"]),
                               "description": str(l.get("description", "")), "color": str(l.get("color", "#888888"))}
                              for l in data.get("labels", [])]
                _next_id = max([int(data.get("next_id", 1))] + [l["id"] + 1 for l in _labels])
                _broken.pop("labels", None)
            except (ValueError, KeyError, TypeError) as e:
                _broken["labels"] = f"labels.json is invalid ({e}). Fix it (maybe a Git conflict)."
            _sigs[LABELS_FILE] = sig
    elif _sigs.pop(LABELS_FILE, None) is not None:
        _labels.clear()

    # --- annotators
    seen = set()
    if os.path.isdir(ANNOTATORS_DIR):
        for entry in os.scandir(ANNOTATORS_DIR):
            if not entry.name.endswith(".jsonl"):
                continue
            slug = entry.name[:-len(".jsonl")]
            path = _jsonl_path(slug)
            seen.add(slug)
            sig = _sig(path)
            if _sigs.get(path) != sig:
                _ann[slug] = _read_jsonl(path, slug)
                _sigs[path] = sig
    for slug in list(_ann):
        if slug not in seen:
            del _ann[slug]
            _sigs.pop(_jsonl_path(slug), None)


def _check_writable(slug=None):
    if "labels" in _broken:
        raise Conflict(_broken["labels"])
    if slug and slug in _broken:
        raise Conflict(_broken[slug])


def _label_map():
    return {l["id"]: l for l in _labels}


def _all_records():
    for recs in _ann.values():
        yield from recs.values()


def _view(r):
    """The record + the label's current name and color (for the UI)."""
    lab = _label_map().get(r.get("label_id"))
    return {**r,
            "label_name": lab["name"] if lab else (r.get("label") or "?"),
            "color": lab["color"] if lab else "#888888"}


# ============================================================ saving

def _save_labels():
    _write_text(LABELS_FILE, json.dumps({"next_id": _next_id, "labels": _labels},
                                        ensure_ascii=False, indent=2) + "\n")
    _sigs[LABELS_FILE] = _sig(LABELS_FILE)


def _save_annotator(slug):
    recs = sorted(_ann.get(slug, {}).values(),
                  key=lambda r: (r.get("subreddit") or "", r.get("link_id") or "", r["comment_id"]))
    path = _jsonl_path(slug)
    if not recs:                                   # no annotations left → remove the files
        for p in (path, _md_path(slug)):
            if os.path.exists(p):
                os.remove(p)
        _sigs.pop(path, None)
        _ann.pop(slug, None)
        return
    _write_text(path, "".join(json.dumps({k: r.get(k) for k in RECORD_KEYS}, ensure_ascii=False) + "\n"
                              for r in recs))
    _sigs[path] = _sig(path)
    _write_summary(slug)


# ============================================================ .md summary (content in Romanian)

def _md(value, limit=None):
    s = " ".join(str(value if value is not None else "").split())
    if limit and len(s) > limit:
        s = s[: limit - 1] + "…"
    return s.replace("\\", "\\\\").replace("|", "\\|")


def _fmt_ts(ts):
    return datetime.fromtimestamp(ts or 0, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _write_summary(slug):
    """Markdown tables summarizing one annotator's work (GitHub renders them)."""
    recs = list(_ann.get(slug, {}).values())
    if not recs:
        return
    name = recs[0].get("annotator") or slug
    labels = _labels
    lab_name = lambda lid: _label_map().get(lid, {}).get("name") or next(
        (r.get("label") for r in recs if r.get("label_id") == lid), f"#{lid}")
    total = len(recs)
    unsure = sum(1 for r in recs if r.get("unsure"))
    posts = len({(r.get("subreddit"), r.get("link_id")) for r in recs})
    last = max(r.get("updated") or 0 for r in recs)
    used_ids = [l["id"] for l in labels] + sorted({r.get("label_id") for r in recs} - {l["id"] for l in labels})

    out = [
        f"# Adnotările lui {_md(name)}",
        "",
        f"> Generat automat de `app.py` la fiecare etichetare — nu edita manual. "
        f"Datele brute: [`{slug}.jsonl`]({slug}.jsonl).",
        "",
        f"**{total}** comentarii etichetate · **{unsure}** nesigure · **{posts}** postări · "
        f"ultima modificare: {_fmt_ts(last)}",
        "",
        "## Pe ce fișiere .zst am lucrat",
        "",
        "| Fișier sursă | Subreddit | Comentarii | " + " | ".join(_md(lab_name(i)) for i in used_ids) + " | Nesigure |",
        "|---|---|---:|" + "---:|" * len(used_ids) + "---:|",
    ]
    by_file = {}
    for r in recs:
        by_file.setdefault((r.get("source_file") or "?", r.get("subreddit") or "?"), []).append(r)
    for (src, sub), rs in sorted(by_file.items()):
        counts = [sum(1 for r in rs if r.get("label_id") == i) for i in used_ids]
        out.append(f"| `{_md(src)}` | r/{_md(sub)} | {len(rs)} | " + " | ".join(map(str, counts))
                   + f" | {sum(1 for r in rs if r.get('unsure'))} |")

    out += ["", "## Pe categorie", "", "| Categorie | Comentarii | % |", "|---|---:|---:|"]
    for i in used_ids:
        n = sum(1 for r in recs if r.get("label_id") == i)
        out.append(f"| {_md(lab_name(i))} | {n} | {100 * n / total:.0f}% |")

    out += ["", "## Ultimele 30 de etichete", "",
            "| Data | Subreddit | Comentariu | Etichetă | Nesigur | Notă |", "|---|---|---|---|:-:|---|"]
    for r in sorted(recs, key=lambda r: r.get("updated") or 0, reverse=True)[:30]:
        out.append(f"| {_fmt_ts(r.get('updated'))[:10]} | r/{_md(r.get('subreddit'))} | "
                   f"{_md(r.get('text'), 90)} | {_md(lab_name(r.get('label_id')))} | "
                   f"{'?' if r.get('unsure') else ''} | {_md(r.get('note'), 60)} |")
    _write_text(_md_path(slug), "\n".join(out) + "\n")


def _rewrite_all_summaries():
    for slug in list(_ann):
        if slug not in _broken:
            _write_summary(slug)


# ============================================================ LABELS

def _clean_label(data):
    name = str(data.get("name") or "").strip()
    if not name:
        raise ValueError("The label name can't be empty.")
    if len(name) > 80:
        raise ValueError("The label name is too long (max. 80).")
    desc = str(data.get("description") or "").strip()[:500]
    color = str(data.get("color") or "#0079d3")
    if not COLOR_RE.match(color):
        raise ValueError("Invalid color (expected #rrggbb).")
    return name, desc, color


def _name_taken(name, except_id=None):
    return any(l["name"].casefold() == name.casefold() and l["id"] != except_id for l in _labels)


def list_labels():
    with _lock:
        _refresh()
        used = {}
        for r in _all_records():
            used[r.get("label_id")] = used.get(r.get("label_id"), 0) + 1
        return [{**l, "position": i, "used": used.get(l["id"], 0)} for i, l in enumerate(_labels)]


def create_label(data):
    global _next_id
    name, desc, color = _clean_label(data)
    with _lock:
        _refresh()
        _check_writable()
        if _name_taken(name):
            raise Conflict(f"A label named “{name}” already exists.")
        _labels.append({"id": _next_id, "name": name, "description": desc, "color": color})
        _next_id += 1
        _save_labels()
    return list_labels()


def update_label(label_id, data):
    name, desc, color = _clean_label(data)
    with _lock:
        _refresh()
        _check_writable()
        lab = _label_map().get(label_id)
        if lab is None:
            raise LookupError("Label not found.")
        if _name_taken(name, except_id=label_id):
            raise Conflict(f"A label named “{name}” already exists.")
        renamed = lab["name"] != name
        lab.update(name=name, description=desc, color=color)
        _save_labels()
        if renamed:   # update the name stored in the annotations (only for readability of the .jsonl)
            for slug, recs in _ann.items():
                hits = [r for r in recs.values() if r.get("label_id") == label_id]
                for r in hits:
                    r["label"] = name
                if hits and slug not in _broken:
                    _save_annotator(slug)
        _rewrite_all_summaries()
    return list_labels()


def delete_label(label_id, force=False):
    """Delete a label. If it's in use, force=True is required (also deletes its annotations, for ALL annotators)."""
    with _lock:
        _refresh()
        _check_writable()
        if label_id not in _label_map():
            raise LookupError("Label not found.")
        affected = {slug: [cid for cid, r in recs.items() if r.get("label_id") == label_id]
                    for slug, recs in _ann.items()}
        used = sum(len(v) for v in affected.values())
        if used and not force:
            raise Conflict(f"This label is used in {used} annotation(s).")
        for slug, cids in affected.items():
            if cids:
                _check_writable(slug)
                for cid in cids:
                    del _ann[slug][cid]
                _save_annotator(slug)
        _labels[:] = [l for l in _labels if l["id"] != label_id]
        _save_labels()
        _rewrite_all_summaries()
    return list_labels()


def reorder_labels(ids):
    if not isinstance(ids, list):
        raise ValueError("Expected a list of ids.")
    with _lock:
        _refresh()
        _check_writable()
        order = {to_int(lid, -1): i for i, lid in enumerate(ids)}
        _labels.sort(key=lambda l: order.get(l["id"], len(order)))
        _save_labels()
        _rewrite_all_summaries()
    return list_labels()


def seed_labels():
    """Add the proposed labels that are missing (existing ones are not duplicated)."""
    global _next_id
    with _lock:
        _refresh()
        _check_writable()
        for name, desc, color in DEFAULT_LABELS:
            if not _name_taken(name):
                _labels.append({"id": _next_id, "name": name, "description": desc, "color": color})
                _next_id += 1
        _save_labels()
    return list_labels()


# ============================================================ ANNOTATIONS

def _clean_annotator(value):
    name = " ".join(str(value or "").split())
    if not name:
        raise ValueError("Missing annotator name.")
    if len(name) > 40:
        raise ValueError("The annotator name is too long (max. 40).")
    return name


def _comment_context(sub, comment_id):
    """Get the comment text + the post title from the subreddit's index."""
    path = db_path(sub)
    if not os.path.exists(path):
        raise LookupError("This subreddit hasn't been indexed.")
    con = sqlite3.connect(path)
    try:
        row = con.execute(
            "SELECT c.link, c.author, c.body, p.title FROM comments c "
            "LEFT JOIN posts p ON p.id = c.link WHERE c.id = ?", (comment_id,)).fetchone()
    finally:
        con.close()
    if row is None:
        raise LookupError("Comment not found in the index.")
    return row


def save_annotation(sub, data):
    """Create or update one annotator's label for a comment."""
    comment_id = str(data.get("comment_id") or "").strip()
    if not comment_id:
        raise ValueError("Missing comment_id.")
    annotator = _clean_annotator(data.get("annotator"))
    slug = slugify(annotator)
    label_id = to_int(data.get("label_id"), -1)
    link, author, body, title = _comment_context(sub, comment_id)
    now = int(time.time())
    with _lock:
        _refresh()
        _check_writable(slug)
        lab = _label_map().get(label_id)
        if lab is None:
            raise ValueError("The selected label doesn't exist.")
        recs = _ann.setdefault(slug, {})
        old = recs.get(comment_id)
        recs[comment_id] = {
            "comment_id": comment_id, "annotator": annotator,
            "label_id": label_id, "label": lab["name"],
            "unsure": bool(data.get("unsure")), "note": str(data.get("note") or "").strip()[:1000],
            "subreddit": sub, "source_file": f"{sub}_comments.zst",
            "link_id": link, "post_title": title, "author": author, "text": body,
            "created": old["created"] if old else now, "updated": now,
        }
        _save_annotator(slug)
        return _view(recs[comment_id])


def delete_annotation(comment_id, annotator):
    slug = slugify(_clean_annotator(annotator))
    with _lock:
        _refresh()
        _check_writable(slug)
        if comment_id not in _ann.get(slug, {}):
            raise LookupError("Annotation not found.")
        del _ann[slug][comment_id]
        _save_annotator(slug)
    return {"deleted": True}


def annotations_for_post(link_id, annotator):
    """One annotator's labels for the comments of a post."""
    if not annotator:
        return []
    with _lock:
        _refresh()
        recs = _ann.get(slugify(annotator), {}).values()
        return [_view(r) for r in recs if r.get("link_id") == link_id]


def post_annotations_all(link_id):
    """Every annotator's labels for the comments of a post."""
    with _lock:
        _refresh()
        return [_view(r) for r in _all_records() if r.get("link_id") == link_id]


def coverage():
    """What the annotations in the repo refer to: per subreddit, who labelled how much, and in which threads."""
    with _lock:
        _refresh()
        subs = {}
        for r in _all_records():
            name = r.get("subreddit") or "?"
            who = r.get("annotator") or "?"
            s = subs.setdefault(name, {"count": 0, "annotators": {}, "posts": {}})
            s["count"] += 1
            s["annotators"][who] = s["annotators"].get(who, 0) + 1
            p = s["posts"].setdefault(r.get("link_id") or "?", {
                "link_id": r.get("link_id"), "title": r.get("post_title") or "", "count": 0, "annotators": {}})
            p["count"] += 1
            p["annotators"][who] = p["annotators"].get(who, 0) + 1

    def as_list(counts):
        return [{"annotator": a, "count": n} for a, n in sorted(counts.items(), key=lambda x: -x[1])]

    out = []
    for name, s in sorted(subs.items(), key=lambda x: -x[1]["count"]):
        posts = sorted(s["posts"].values(), key=lambda p: -p["count"])
        out.append({
            "subreddit": name,
            "count": s["count"],
            "annotators": as_list(s["annotators"]),
            "posts": [{**p, "annotators": as_list(p["annotators"])} for p in posts[:10]],
            "more_posts": max(0, len(posts) - 10),
            "files": {"comments": f"{name}_comments.zst", "submissions": f"{name}_submissions.zst"},
        })
    return out


def _filtered(annotator="", label="", unsure=""):
    slug = slugify(annotator) if annotator else None
    label_id = to_int(label, -1) if label else None
    for s, recs in _ann.items():
        if slug and s != slug:
            continue
        for r in recs.values():
            if label_id is not None and r.get("label_id") != label_id:
                continue
            if unsure == "1" and not r.get("unsure"):
                continue
            yield r


def list_annotations(q):
    page = max(0, to_int(q.get("page"), 0))
    with _lock:
        _refresh()
        items = sorted(_filtered(q.get("annotator", ""), q.get("label", ""), q.get("unsure", "")),
                       key=lambda r: r.get("updated") or 0, reverse=True)
        return {"total": len(items), "page": page, "page_size": PAGE_SIZE,
                "items": [_view(r) for r in items[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]]}


def stats(annotator=""):
    """Count per label (+ the list of annotators and their files)."""
    with _lock:
        _refresh()
        recs = list(_filtered(annotator))
        by_label = [{"id": l["id"], "name": l["name"], "color": l["color"],
                     "count": sum(1 for r in recs if r.get("label_id") == l["id"]),
                     "unsure": sum(1 for r in recs if r.get("label_id") == l["id"] and r.get("unsure"))}
                    for l in _labels]
        annotators = sorted(
            ({"annotator": next(iter(rs.values())).get("annotator") or s, "slug": s, "count": len(rs),
              "file": f"annotations/annotators/{s}.jsonl", "error": _broken.get(s)}
             for s, rs in _ann.items() if rs),
            key=lambda a: -a["count"])
        return {"total": len(recs), "by_label": by_label, "annotators": annotators,
                "errors": [m for m in _broken.values()]}


def export_csv(annotator=""):
    """CSV with all annotations (UTF-8 with BOM, so Excel opens it correctly)."""
    with _lock:
        _refresh()
        rows = sorted((_view(r) for r in _filtered(annotator)),
                      key=lambda r: (r.get("annotator") or "", r.get("created") or 0))
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["comment_id", "subreddit", "source_file", "link_id", "post_title", "author", "text",
                     "label", "unsure", "note", "annotator", "created_utc", "updated_utc"])
    iso = lambda ts: datetime.fromtimestamp(ts or 0, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    for r in rows:
        writer.writerow([r["comment_id"], r.get("subreddit"), r.get("source_file"), r.get("link_id"),
                         r.get("post_title"), r.get("author"), r.get("text"), r["label_name"],
                         int(bool(r.get("unsure"))), r.get("note"), r.get("annotator"),
                         iso(r.get("created")), iso(r.get("updated"))])
    return buf.getvalue().encode("utf-8-sig")
