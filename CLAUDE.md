# tracker

Personal progress dashboard. It was split out of the writeup site
(`rask0l.github.io`) so the public security work stays clean and this stays
personal. Everything here is for the owner only. The whole site is `noindex`
and is not linked from the writeup site.

Pages in the nav, plus one hidden page:

| Page | URL | Data source | What it is |
|------|-----|-------------|------------|
| Study | `/study/` | `_data/cwes.yml` seed + browser | HTB CWES roadmap, a clickable module checklist |
| Loop | `/loop/` | none (static layout) | the weekly study rhythm, a reference card |
| Notes | `/notes/` | browser `localStorage` | the Playbook, a rich note editor |
| Gym | `/gym/` | `_data/gym.yml` | lifting progress: split, weights, sessions |
| project-fuckable | `/project-fuckable/` | `_data/project.yml` | the private north-star goal, unlinked and reachable only by URL |

Built with plain Jekyll (no theme). Deploys as a GitHub Pages project site at
`rask0l.github.io/tracker`, so `baseurl` is `/tracker`.

## Where the data actually lives (important)

The pages behave differently, so be careful about the source of truth:

- **Study (`/study/`) is YAML seed plus browser state.** The page renders the
  `roadmap` from `_data/cwes.yml` as a done/next/todo checklist, but the
  modules are now clickable: toggling one saves to `localStorage` (key
  `study-v1`), which then wins over the YAML per module (same pattern as gym).
  The `reset` link in the footer clears the browser state back to the file's
  defaults. The file still holds `log`, `failures`, `exam_prep`, and
  `methodology`, unrendered. Editing `cwes.yml` only changes the seed, so flip
  a `roadmap` item's `done` there too if you want the repo to reflect reality.
- **Gym (`/gym/`) is YAML seed plus browser state.** `_data/gym.yml` only
  seeds the *initial* weights and split. Once the owner edits weights, logs a
  session, or reorders exercises in the browser, those changes save to
  `localStorage` (key `gym-tracker-v1`), which then wins over the YAML. So the
  repo is not the source of truth for live gym data; the owner's browser is.
  The export/import panel on the page is how that data gets backed up.
- **Notes (`/notes/`) is browser only.** Nothing in the repo. Notes save to
  `localStorage` (key `playbook-v1`) as records of `{id, type, title, html,
  created, updated}`, where `html` is rich text from a `contenteditable`
  editor and photos are embedded inline as downscaled JPEG data URLs. Export
  and import (JSON) are the only backup. Clearing site data wipes it.
- **Loop (`/loop/`) is static.** The weekly plan is content in
  `_layouts/schedule.html`, not a data file. Edit the layout to change it.
- **project-fuckable** renders `_data/project.yml` but only the header block;
  the phases, math, and rules in the YAML are unrendered. It is hidden from
  the nav on purpose.

Do not assume the gym YAML reflects current weights, or that the cwes.yml log
reflects the page. Both are starting points or partial.

## Updating study progress (`_data/cwes.yml`)

Only step 2 changes the page now (roadmap only). The rest still live in the
file for the owner's own reference:

1. Each study day, append an entry to `log` (copy the last line).
2. When a module is finished, flip its `roadmap` item to `done: true`. This is
   what the page shows.
3. When an `exam_prep` gate is cleared, flip its `done: true`.
4. When a lab or box wins, add one line to `failures` with the single thing
   that was missed.

The 20 items are the HTB CWES path in order. The owner is learning for
**long-term mastery, not a deadline**: the 30-day sprint framing was dropped.
Do not reintroduce deadline pressure. The `by:` planned-finish days and the
red overdue flag were removed from the page.

Key insight still baked into the file: the hacking rarely fails people on this
exam, the report and the clock do. That is why `exam_prep` centers on writing a
full practice report and building the methodology checklist from memory.

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

- **Study:** learning HTB CWES for the long term, no deadline. 7 of 20 modules
  marked done in `cwes.yml` (through Cross-Site Scripting). The chosen weekly
  rhythm is the "Loop": two bugs a week, learn Mon/Tue, write it up (Feynman)
  Wed, repeat Thu to Sat, Sunday is catch-up and rest.
- **Gym:** Upper A / Upper B split, two sessions a week seeded (Tue/Fri and
  Wed/Sat). Real weights recorded so far are on Upper B; Upper A not filled in.

## Run locally

```bash
bundle exec jekyll serve
# http://127.0.0.1:4000/tracker/
```

## Conventions

- Prose here avoids dashes as sentence separators or spacers; only use a dash
  where grammar needs it.
- Keep every page `noindex`. This site is not meant to be discovered.
- Layouts hold render logic and JavaScript; touch them for behavior, not for
  progress updates. The heavy ones: `_layouts/gym.html` (gym localStorage),
  `_layouts/notes.html` (the Playbook editor: rich text, inline photos,
  drag/resize, export/import), `_layouts/schedule.html` (the Loop),
  `_layouts/tracker.html` (study roadmap).
- Visual language on the newer pages (`/loop/`, `/notes/`) is brutalist mono:
  flat, hard 2px borders, no rounded corners, monospace, one red accent. The
  notes document surface is a fixed dark editor.
- `habits.yml` and `_layouts/habits.html` are orphaned (the habits page was
  removed) but left in place so the data is not destroyed.
