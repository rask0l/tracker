# tracker

Personal progress dashboard. It was split out of the writeup site
(`rask0l.github.io`) so the public security work stays clean and this stays
personal. Everything here is for the owner only. The whole site is `noindex`
and is not linked from the writeup site.

Two pages, driven by two data files:

| Page | URL | Data source | What it is |
|------|-----|-------------|------------|
| Study | `/study/` | `_data/cwes.yml` | HTB CWES exam prep, a 30 day sprint |
| Gym | `/gym/` | `_data/gym.yml` | Lifting progress: split, working weights, sessions |

Built with plain Jekyll (no theme). Deploys as a GitHub Pages project site at
`rask0l.github.io/tracker`, so `baseurl` is `/tracker`.

## Where the data actually lives (important)

The two pages behave differently, so be careful about the source of truth:

- **Study (`/study/`) is fully YAML driven.** Everything the page shows
  (roadmap, log, failure log, pace) comes from `_data/cwes.yml`. To change
  study progress, edit that file. The only computed value is the day counter,
  derived from `start:` versus today's date.
- **Gym (`/gym/`) is YAML seed plus browser state.** `_data/gym.yml` only
  seeds the *initial* weights and split. Once the owner edits weights, logs a
  session, or reorders exercises in the browser, those changes save to
  `localStorage` (key `gym-tracker-v1`), which then wins over the YAML. So the
  repo is not the source of truth for live gym data; the owner's browser is.
  The export/import panel on the page is how that data gets backed up.

Do not assume the gym YAML reflects current weights. It is a starting point.

## Updating study progress (`_data/cwes.yml`)

The rituals, in the owner's words:

1. Each study day, append an entry to `log` (copy the last line, fill in
   `hours` when the day ends so the counter stays honest).
2. When a module is finished, flip its `roadmap` item to `done: true`.
3. When an `exam_prep` gate is cleared, flip its `done: true`.
4. When a lab or box wins, add one line to `failures` with the single thing
   that was missed. Reviewed every Sunday.

`by:` on a roadmap item is the planned finish day. If today is past that day
and the item is not done, the page flags it red as behind schedule.

The 20 modules are the HTB CWES path in order. The first 6 were done before
the sprint started (no `by`), the remaining 14 carry planned finish days.
Days 24 to 30 are reserved for review, a practice report, and buffer.

Key insight baked into the file: the hacking rarely fails people on this exam,
the report and the clock do. That is why `exam_prep` centers on writing a full
practice report and building the methodology checklist from memory.

## Updating gym progress (`_data/gym.yml`)

Note the localStorage caveat above first. Editing the YAML only changes the
seed for a fresh browser. The rituals:

1. Progressed on a lift? Bump its `kg` in `workouts`.
2. After a session, append a line to `log` (date, which split day, hours slept
   the night before, bodyweight, and any PR or note in `lifts`).

Split is Upper A / Upper B. The two seeded workouts came from the owner's old
Notion tables. Days and exercises can be renamed or swapped freely; the page
just renders whatever the YAML holds.

## Current progress (snapshot, update as it moves)

- **Study:** sprint started 2026-07-30. 6 of 20 modules done (the pre-sprint
  set through JavaScript Deobfuscation). Currently on Cross-Site Scripting.
  No exam-prep gates cleared yet, failure log empty.
- **Gym:** Upper A / Upper B split, two sessions a week seeded (Tue/Fri and
  Wed/Sat). Real weights recorded so far are on Upper B (tricep extension,
  lateral raise, recline curl); Upper A weights not filled in yet.

## Run locally

```bash
bundle exec jekyll serve
# http://127.0.0.1:4000/tracker/
```

## Conventions

- Prose here avoids dashes as sentence separators or spacers; only use a dash
  where grammar needs it.
- Keep both pages `noindex`. This site is not meant to be discovered.
- The page layouts (`_layouts/tracker.html`, `_layouts/gym.html`) hold the
  render logic and the gym's localStorage JavaScript. Touch them only for
  behavior changes, not for progress updates.
