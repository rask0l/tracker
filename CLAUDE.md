# tracker

A single-page **100-day tick-box tracker**. It replaced an older multi-page
progress dashboard (study/gym/notes/blog); that history was intentionally
wiped. Everything here is for the owner only. The site is `noindex` and is not
linked from anywhere.

## What it is

- `index.html` is the entire site: a self-contained static page with inline
  CSS and JS, no framework, no Jekyll layout. A 10x10 grid of 100 buttons plus
  a side column of note cards. Clicking a box toggles that day done and selects
  it into the Day card.
- **State is browser-only.** Everything saves to `localStorage` under key
  `hundred-v1` as `{ days: boolean[100], label, dayNotes, stickies, pos }`.
  `dayNotes` maps a day index to that day's body (a list of blocks). `stickies`
  is the list of added notes, each `{ id, title, pinned, done, blocks }`. A
  block is `{ id, type:'text'|'todo', text, done }`, so a note body is a mix of
  plain lines and checklist items (iPhone-Notes style: Enter adds a line,
  Backspace on an empty line removes it). `pos` maps a card's pid (`day` or
  `s:<id>`) to a dragged `{x,y}`. The repo holds no progress; clearing site
  data wipes it. There is no export/import yet.
- Note cards (the Day card and every added note) share one look: a `::` grip to
  drag the card anywhere (double-click it to dock), a checkbox to cross it off
  (the Day card's checkbox also ticks that grid day), an editable title, and
  the block body. Added notes also have a pin (pinned notes sort to the top,
  marked with a red left edge) and a delete.
- The first unticked box is highlighted as "today" (an inset border). The
  progress bar and `N / 100` count derive from how many boxes are ticked. A day
  with any note text shows a small red dot on its box.
- `reset all` is a two-click button (arm, then confirm within 3s) so a stray
  tap never clears the grid; it clears ticks and day notes but keeps the added
  notes. No native `confirm()` dialog is used.

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
