# Propaganda on Reddit — NLP project

We classify Reddit comments by propaganda technique (inspired by SemEval-2020 Task 11):
**Name Calling / Ad Hominem**, **Appeal to Fear / Catastrophizing**, **Whataboutism / Distraction**, **Neutral**.

The repository includes a local web app (**Archive Viewer**) for browsing the Pushshift archives and for manually annotating comments.

## Setup

1. Clone the repository.
2. Put the `.zst` archives (the *subreddits24* torrent) in the `subreddits24/` folder. They are **not** in Git (~16 GB).
3. Create a virtual environment and install the dependencies:
   ```
   py -m venv .venv
   .venv\Scripts\activate          # macOS / Linux: source .venv/bin/activate
   pip install -r requirements.txt
   ```
   When you add a new library, install it in the venv and add it (with its version) to `requirements.txt`.
4. Start the app from the project folder:
   ```
   py app.py
   ```
   It opens <http://127.0.0.1:8000>. Stop the server with `Ctrl+C`.

## Annotating

1. **Labels** (top menu): set your **annotator name**. Labels are shared by everyone, in `annotations/labels.json`.
2. **Subreddits**: pick a subreddit and click **Index** (once), then open a post.
3. Next to each comment, click **🏷 Rate** and choose a label (or press `1`–`9`). You can tick *unsure* and add a note.
4. **Annotations**: class distribution, list of labelled comments, CSV export.

## Where annotations are stored (and what goes into Git)

```
annotations/
├── labels.json            the labels — shared by all annotators
└── annotators/
    ├── marcel.jsonl       Marcel's annotations (one line = one comment)
    ├── marcel.md          auto-generated summary: which .zst files, how many labels, which classes
    └── ...
```

Each annotator writes **only to their own files**, so there are no merge conflicts. Every annotation stores the comment text and its source `.zst` file, so you can see your teammates' annotations without having their archives.

```
git pull                                   # get your teammates' annotations (the server picks them up automatically)
git add annotations/                       # add your annotations
git commit -m "Annotations (Marcel): +40 comments"
git push
```

Rules:
- **Agree on the labels together at the start** and don't change them separately. Otherwise the annotations can't be compared (Cohen's Kappa).
- If `git pull` produces a conflict in a `.jsonl` file, the app refuses to write to that file until you fix it.

## Code structure

```
app.py          starts the server
backend/        Python: .zst reading, SQLite index (cache/), API, annotations
frontend/       HTML / CSS / JS: one file per page and per component
main.ipynb      data exploration
```
