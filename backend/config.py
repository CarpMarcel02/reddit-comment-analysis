"""Global settings: folder paths and limits."""

import os

# project folder (parent of backend/)
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DATA_DIR = os.path.join(ROOT_DIR, "subreddits24")   # the .zst archives
CACHE_DIR = os.path.join(ROOT_DIR, "cache")         # generated SQLite indexes
FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")   # HTML / CSS / JS

BIG_FILE_BYTES = 1_000_000_000   # files > 1 GB compressed → partial indexing
BIG_FILE_LIMIT = 2_000_000       # how many lines to read from big files
PAGE_SIZE = 25                   # posts per page in the list

# Annotations live SEPARATELY from cache/ — the cache can be deleted at any time, annotations can't.
# They are TEXT files (committed to Git): shared labels + one file per annotator.
ANNOT_DIR = os.path.join(ROOT_DIR, "annotations")
LABELS_FILE = os.path.join(ANNOT_DIR, "labels.json")
ANNOTATORS_DIR = os.path.join(ANNOT_DIR, "annotators")
