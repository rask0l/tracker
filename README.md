# tracker

Personal gym + CWES study tracker. Split out from the writeup site so the
public security work stays clean and this stays personal.

- **study** (`/study/`) — CWES 30 day sprint: roadmap, hours, failure log
- **gym** (`/gym/`) — split, working weights with sparklines, session log

All progress data lives in the browser (localStorage), not in the repo.
Use the export/import panel on the gym page to back it up.

The whole site is `noindex` and unlinked from the writeup site. It builds as a
GitHub Pages **project site** at `/tracker`.

## Run locally

```bash
bundle install
bundle exec jekyll serve
# http://127.0.0.1:4000/tracker/
```

## Privacy note

GitHub Pages sites are publicly reachable by URL even with `noindex` (search
engines are discouraged, but anyone with the link can open it). To keep it
truly private, don't push to a Pages-enabled repo — just run it locally.
