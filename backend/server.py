"""HTTP server: API routes (/api/...) + static files from frontend/.

Routes:
  GET    /api/subreddits                 all subreddits + index state
  GET    /api/status?sub=                indexing state of one subreddit
  POST   /api/index?sub=                 start indexing
  GET    /api/posts?sub=&sort=&q=&...    list of posts
  GET    /api/post?sub=&id=              one post + its comments
  GET    /api/raw?sub=&kind=&id=         original JSON

  GET    /api/labels                     labels
  POST   /api/labels                     add a label             {name, description, color}
  PUT    /api/labels?id=                 edit a label            {name, description, color}
  DELETE /api/labels?id=&force=          delete a label
  POST   /api/labels/reorder             reorder                 {ids: [...]}
  POST   /api/labels/seed                add the proposed label set

  GET    /api/annotations?link=&annotator=          one annotator's labels for a post
  GET    /api/annotations?annotator=&label=&page=   list of annotations
  PUT    /api/annotations                           save     {sub, comment_id, annotator, label_id, unsure, note}
  DELETE /api/annotations?comment_id=&annotator=    delete
  GET    /api/annotations/stats?annotator=          per-label statistics
  GET    /api/annotations/export.csv?annotator=     CSV export
"""

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import annotations, indexer, queries
from .annotations import Conflict
from .config import FRONTEND_DIR
from .zst_reader import to_int

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
MAX_BODY = 1_000_000


def checked_sub(sub):
    """Only accept subreddits that exist in subreddits24/ (no arbitrary paths)."""
    if sub not in indexer.list_subreddits():
        raise ValueError("Unknown subreddit.")
    return sub


class Handler(BaseHTTPRequestHandler):
    # ------------------------------------------------------------ helpers

    def log_message(self, *args):
        pass  # don't log every request

    def send_body(self, body, ctype, code=200, extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        self.send_body(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8", code)

    def parsed(self):
        u = urlparse(self.path)
        return u.path, {k: v[0] for k, v in parse_qs(u.query).items()}

    def read_json(self):
        n = to_int(self.headers.get("Content-Length"), 0)
        if n > MAX_BODY:
            raise ValueError("Request too large.")
        if n <= 0:
            return {}
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            raise ValueError("Invalid JSON.") from None
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object.")
        return data

    def run_api(self, fn):
        try:
            result = fn()
            if isinstance(result, tuple) and result and result[0] == "csv":
                _, body, filename = result
                self.send_body(body, "text/csv; charset=utf-8", 200,
                               {"Content-Disposition": f'attachment; filename="{filename}"'})
            else:
                self.send_json(result)
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)
        except LookupError as e:
            self.send_json({"error": str(e)}, 404)
        except Conflict as e:
            self.send_json({"error": str(e)}, 409)
        except Exception as e:  # noqa: BLE001
            self.send_json({"error": repr(e)}, 500)

    # ------------------------------------------------------------ static files

    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        full = os.path.normpath(os.path.join(FRONTEND_DIR, path.lstrip("/")))
        if not full.startswith(FRONTEND_DIR + os.sep) or not os.path.isfile(full):
            self.send_json({"error": "Not found"}, 404)
            return
        ctype = CONTENT_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        with open(full, "rb") as f:
            self.send_body(f.read(), ctype)

    # ------------------------------------------------------------ routes

    def routes(self, method, q):
        """(method, path) → function returning the result."""
        return {
            # --- Reddit data
            ("GET", "/api/subreddits"): lambda: [
                {"name": n, "sizes": s, **indexer.status(n)}
                for n, s in sorted(indexer.list_subreddits().items(), key=lambda x: x[0].lower())
            ],
            ("GET", "/api/status"): lambda: indexer.status(checked_sub(q.get("sub", ""))),
            ("POST", "/api/index"): lambda: self.start_index(q),
            ("GET", "/api/posts"): lambda: queries.get_posts(checked_sub(q.get("sub", "")), q),
            ("GET", "/api/post"): lambda: queries.get_post(checked_sub(q.get("sub", "")), q.get("id", "")),
            ("GET", "/api/raw"): lambda: queries.get_raw(checked_sub(q.get("sub", "")), q.get("kind", ""), q.get("id", "")),

            # --- labels
            ("GET", "/api/labels"): annotations.list_labels,
            ("POST", "/api/labels"): lambda: annotations.create_label(self.read_json()),
            ("PUT", "/api/labels"): lambda: annotations.update_label(to_int(q.get("id"), -1), self.read_json()),
            ("DELETE", "/api/labels"): lambda: annotations.delete_label(to_int(q.get("id"), -1), q.get("force") == "1"),
            ("POST", "/api/labels/reorder"): lambda: annotations.reorder_labels(self.read_json().get("ids")),
            ("POST", "/api/labels/seed"): annotations.seed_labels,

            # --- annotations
            ("GET", "/api/annotations"): lambda: (
                annotations.annotations_for_post(q["link"], q.get("annotator", ""))
                if "link" in q else annotations.list_annotations(q)),
            ("PUT", "/api/annotations"): lambda: self.save_annotation(),
            ("DELETE", "/api/annotations"): lambda: annotations.delete_annotation(
                q.get("comment_id", ""), q.get("annotator", "")),
            ("GET", "/api/annotations/stats"): lambda: annotations.stats(q.get("annotator", "")),
            ("GET", "/api/annotations/export.csv"): lambda: (
                "csv", annotations.export_csv(q.get("annotator", "")),
                "annotations_" + (re.sub(r"[^\w-]+", "_", q.get("annotator", "")) or "all") + ".csv"),
        }.get((method, self.parsed()[0]))

    def start_index(self, q):
        sub = checked_sub(q.get("sub", ""))
        indexer.start_index(sub)
        return indexer.status(sub)

    def save_annotation(self):
        data = self.read_json()
        return annotations.save_annotation(checked_sub(str(data.get("sub", ""))), data)

    def dispatch(self, method):
        path, q = self.parsed()
        fn = self.routes(method, q)
        if fn:
            self.run_api(fn)
        elif path.startswith("/api/"):
            self.send_json({"error": "Not found"}, 404)
        elif method == "GET":
            self.serve_static(path)
        else:
            self.send_json({"error": "Method not allowed"}, 405)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")


def create_server(port):
    """Listen on 127.0.0.1 only → reachable from your own computer only."""
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
