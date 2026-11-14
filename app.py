"""
Reddit Archive Viewer — entry point.

Usage:
    py app.py                      # starts on http://127.0.0.1:8000 and opens the browser
    py app.py --port 8080 --no-browser

Layout:
    app.py        ← this file: starts the server
    backend/      ← Python: .zst reading, SQLite index, API, annotations
    frontend/     ← HTML / CSS / JS: the page shown in the browser
"""

import argparse
import os
import threading
import webbrowser

from backend.config import DATA_DIR
from backend.server import create_server


def main():
    ap = argparse.ArgumentParser(description="Viewer and annotation tool for Reddit .zst archives")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    args = ap.parse_args()

    if not os.path.isdir(DATA_DIR):
        # e.g. right after `git clone`: the archives aren't in Git, so the folder doesn't exist yet
        os.makedirs(DATA_DIR, exist_ok=True)
        print(f"Created an empty archive folder: {DATA_DIR}")
        print("Put the .zst files from the subreddits24 torrent there (the home page shows which ones you need).")

    server = create_server(args.port)
    url = f"http://127.0.0.1:{args.port}"
    print(f"Reddit Archive Viewer running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
