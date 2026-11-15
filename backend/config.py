"""Global settings: folder paths and limits."""

import os

# project folder (parent of backend/)
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DATA_DIR = os.path.join(ROOT_DIR, "subreddits24")   # the .zst archives
CACHE_DIR = os.path.join(ROOT_DIR, "cache")         # generated SQLite indexes
FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")   # HTML / CSS / JS

BIG_FILE_BYTES = 1_000_000_000   # files > 1 GB compressed → partial indexing (only when no period is given)
BIG_FILE_LIMIT = 2_000_000       # how many lines to read from big files in that case
PAGE_SIZE = 25                   # posts per page in the list

# Study period (start inclusive, end exclusive, UTC) and the event that splits it in two halves.
DEFAULT_PERIOD_START = "2021-02-24"
DEFAULT_PERIOD_END = "2023-02-24"
DEFAULT_EVENT_DATE = "2022-02-24"   # Russia's full-scale invasion of Ukraine
POST_LOOKBACK_DAYS = 31             # also keep posts up to a month older (their comments can fall inside the period)

# Annotations live SEPARATELY from cache/ — the cache can be deleted at any time, annotations can't.
# They are TEXT files (committed to Git): shared labels + one file per annotator.
ANNOT_DIR = os.path.join(ROOT_DIR, "annotations")
LABELS_FILE = os.path.join(ANNOT_DIR, "labels.json")
ANNOTATORS_DIR = os.path.join(ANNOT_DIR, "annotators")
SAMPLE_FILE = os.path.join(ANNOT_DIR, "sample.json")   # the shared annotation sample (gold set + pilot)
