"""Reading Pushshift archives (.zst = JSONL compressed with Zstandard)."""

import html
import io
import json
import os

import zstandard as zstd


def stream_zst(path, limit=None, on_progress=None):
    """Read a .zst file line by line, without decompressing it to disk.

    Each line is one JSON object (a post or a comment).
    on_progress(fraction_read, n_lines) is called every 20,000 lines.
    """
    size = os.path.getsize(path) or 1
    with open(path, "rb") as fh:
        reader = zstd.ZstdDecompressor(max_window_size=2**31).stream_reader(fh)
        n = 0
        for line in io.TextIOWrapper(reader, encoding="utf-8", errors="replace"):
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            yield obj
            n += 1
            if on_progress and n % 20000 == 0:
                on_progress(fh.tell() / size, n)
            if limit and n >= limit:
                break


def unesc(text):
    """&gt; → >, &amp;#039; → ' (twice, because some texts are double-escaped)."""
    if not text:
        return ""
    return html.unescape(html.unescape(text))


def to_int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default
