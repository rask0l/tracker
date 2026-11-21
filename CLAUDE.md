# tracker

A single-page **100-day tick-box tracker**. It replaced an older multi-page
progress dashboard (study/gym/notes/blog); that history was intentionally
wiped. Everything here is for the owner only. The site is `noindex` and is not
linked from anywhere.

## What it is

- `index.html` is the entire site: a self-contained static page with inline
  CSS and JS, no framework, no Jekyll layout. A 10x10 grid of 100 buttons plus
  a side column of note cards. Clicking a box opens that day in the Day card;
  double-clicking a box (or the Day card's checkbox) ticks it. Left/right
  arrow keys, or the `‹ ›` buttons on the Day card, step between days (the
  keys are ignored while typing in an input). On touch screens a long-press
  (450ms) on a box ticks it, and below 640px the Day card moves above the grid
  (the side column is `display:contents` so its cards can be reordered).
- **State is browser-only.** Everything saves to `localStorage` under key
  `hundred-v1` as
  `{ days: boolean[100], label, dayNotes, stickies, pos, start, lastExport }`.
  `start` is an optional `YYYY-MM-DD` start date (empty string when unset).
  `dayNotes` maps a day index to that day's body (a list of blocks). `stickies`
  is the list of added notes, each `{ id, title, pinned, done, check, blocks }`. A
  block is `{ id, type:'text'|'todo', text, done }`, so a note body is a mix of
  plain lines and checklist items (iPhone-Notes style: Enter adds a line,
  Backspace on an empty line removes it). `pos` maps a card's pid (`day` or
  `s:<id>`) to a dragged `{x,y}`. The repo holds no progress; clearing site
  data wipes it, so the footer has `export` (downloads the state as
  `100days-<date>.json`) and `import` (loads such a file back, validated by
  the same `normalize()` that `load()` uses, then reloads the page). There is
  deliberately no database: the JSON file is the backup. `lastExport` is the
  date of the last export; the footer shows `last backup N days ago` and turns
  it red once there is data and no export in over 7 days.
- Note cards (the Day card and every added note) share one look: a `::` grip to
  drag the card anywhere (double-click it to dock), a checkbox to cross it off
  (the Day card's checkbox also ticks that grid day), an editable title, and
  the block body. On added notes the cross-off checkbox is opt-in per note
  (`check`, off for new notes): a `+ checkbox` / `- checkbox` button in the
  note's button bar adds or removes it, and removing it also clears the
  cross-off. Added notes also have a pin (pinned notes sort to the top,
  marked with a red left edge) and a delete.
- Ticking the last checklist item in a day's note ticks the day itself, but
  unchecking an item never unticks it. The Day card header shows checklist
  progress like `2/3`. (A daily template card that pre-filled every day was
  tried and removed at the owner's request; don't bring it back unasked.)
- With a start date set, box `i` is the date `start + i`: today's box is the
  one for today's calendar date, each box shows its date on hover, the Day
  card shows `SAT 21 NOV` under its title, and a status line says `day n of 100`
  plus how many past days were missed. Without a start date, the first
  unticked box is "today". Either way "today" gets an inset border.
- The progress bar and `N / 100` count derive from how many boxes are ticked.
  `streak` is the run of ticked boxes ending at today (an unticked today does
  not break it; undated, it ends at the last ticked box) and `best` is the
  longest run anywhere. A day with any note text shows a small red dot on its
  box.
- Two decorative wallpapers sit in the side gutters, Notion style:
  `assets/wall_1.jpg` on the left and `assets/wall_2.jpg` on the right
  (shown black and white with a CSS `grayscale` filter; the file itself is in
  colour). They are `position:fixed`, sized to fit the gutter (max 340px), and
  only appear at 1400px wide and up so they never crowd the grid.
- `reset all` is a two-click button (arm, then confirm within 3s) so a stray
  tap never clears the grid; it clears ticks and day notes but keeps the added
  notes. If a start date is set, reset moves it to today. No native `confirm()` dialog is used.

## Deploy

Built with plain Jekyll purely so GitHub Pages serves it at
`rask0l.github.io/tracker`. `index.html` has no front matter, so Jekyll copies
it verbatim as a static file. `_config.yml` sets `baseurl: /tracker` and
`noindex`. The Actions workflow in `.github/workflows/` builds and deploys on
push to `main`.

```bash
bundle exec jekyll serve
# http://127.0.0.1:4000/tracker/
```

## Conventions

- Visual language is brutalist mono: flat, hard 2px borders, no rounded
  corners, monospace, one red accent (`--accent: #e5484b`) on a dark
  background. All tokens are CSS variables at the top of `index.html`.
- Prose in docs avoids dashes as sentence separators; only use a dash where
  grammar needs it.
- Keep the page `noindex`. This site is not meant to be discovered.
