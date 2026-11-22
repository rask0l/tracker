# tracker

A single-page **100-day tick-box tracker**. It replaced an older multi-page
progress dashboard (study/gym/notes/blog); that history was intentionally
wiped. Everything here is for the owner only. The site is `noindex` and is not
linked from anywhere.

## What it is

- `index.html` is the entire site: a self-contained static page with inline
  CSS and JS, no framework, no Jekyll layout. It works like a small Notion: a
  left sidebar lists pages, the first being the tracker (home), and
  `+ new page` adds document pages. The tracker is a 10x10 grid of 100
  buttons plus a side column of note cards. Clicking a box opens that day in the Day card;
  double-clicking a box (or the Day card's checkbox) ticks it. Left/right
  arrow keys, or the `‹ ›` buttons on the Day card, step between days (the
  keys are ignored while typing in an input). On touch screens a long-press
  (450ms) on a box ticks it, and below 640px the Day card moves above the grid
  (the side column is `display:contents` so its cards can be reordered).
- **State is browser-only.** Everything saves to `localStorage` under key
  `hundred-v1` as
  `{ days: boolean[100], label, dayNotes, stickies, pos, start, lastExport, items, cover, icon, pages, sidebarHidden }`.
  `start` is an optional `YYYY-MM-DD` start date (empty string when unset).
  `dayNotes` maps a day index to that day's body (a list of blocks). `stickies`
  is the list of added notes, each `{ id, title, pinned, done, check, blocks }`. A
  block is `{ id, type, text, done }` with type `text`, `todo`, `h` (heading),
  `quote`, `callout` (tip box), `divider` or `image` (which adds `src`, a JPEG
  data URL). iPhone-Notes style: Enter adds a line, Backspace on an empty line
  removes it, and Backspace on an empty styled line first turns it back into
  text. Typing `/` at the start of a line opens a Notion-style slash menu
  (filter by typing, arrows and Enter to pick, Esc to close) that converts the
  line. Photos are shrunk to 720px JPEGs before saving because everything
  lives in localStorage (about 5MB); if a save ever fails, a red toast says so
  instead of losing changes silently. Block rows use `bt-<type>` classes;
  never `blk-<type>`, since `.blk-text` is the line's input. The `+ line` / `+ checklist` /
  `+ checkbox` button row under each card is hidden until you click the small
  `+` in the card's header (it turns red while open); choosing an option
  closes the row again. `pos` maps a card's pid (`day` or
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
- Pages: the tracker keeps its own `cover`, `icon` and `items` on the state
  itself; every other page is `{ id, title, icon, cover, blocks, items }` in
  `pages`, with `blocks` using the same block editor and slash menu as notes.
  The open page lives in the URL hash (`#p/<id>`, none for home) so back and
  forward work; `cur()` returns the open page (the state object for home) and
  `renderPage()` swaps `#homeView` / `#docView` and redraws cover, icon, page
  items and sidebar. Clicking the empty space under a document continues it.
  Deleting a page from the sidebar takes two clicks. The sidebar collapses
  with `«` (remembered as `sidebarHidden`); under 900px it is an overlay
  opened with the fixed `☰` button. Arrow-key day stepping only runs on the
  tracker page.
- Icons: every page can have an icon, `{ emoji }` or `{ src }` (a picture
  shrunk to 256px), picked from a popover (emoji grid, type/paste an emoji,
  upload, remove). Like Notion, the 110px icon overlaps the bottom edge of the
  cover and the title sits under it; the sidebar shows it small.
  `+ add icon` / `+ add cover` sit above the title and show on hover.
- `[hidden]{display:none !important}` is global on purpose: several elements
  set `display` in CSS, which would otherwise override the `hidden` attribute.
- Page cover, Notion style: `+ add cover` puts a full-width banner
  (`clamp(180px, 30vh, 340px)` tall) above the open page.
  Hovering the cover shows `change`, `reposition` (drag the picture up or
  down, then `done` or Esc), `b&w` and `remove` (two clicks: arm, then
  confirm within 3s). In reposition mode the other buttons are
  `visibility:hidden`, not removed, so `done` stays exactly where
  `reposition` was; when they collapsed, `remove` slid under the pointer and a
  double-click on `done` deleted the cover. It saves as
  `cover: { src, y, bw }` (y is the vertical crop in %) or `null`. Covers are
  stored as JPEGs up to 1800px wide (`pickPhoto(cb, maxPx)`); other photos use
  the 720px default. Everything below the cover sits in `.page`
  (`position:relative`), so page items keep their place when a cover is added.
- Free-floating page items: the `+` fixed in the bottom-right corner adds a
  text box, heading, quote box, tip box or photo straight onto the page (not
  inside a card). Each lives in `items` as `{ id, type, text, src?, x, y, w }`
  where `x` is px from the page's centre line (so items stay aligned with the
  centred layout at any width), `y` is px from the top of the page and `w` the
  width. They scroll with the page; hovering shows a grip to drag, a delete,
  and a corner handle to resize. Text boxes are auto-growing textareas.
  Photo items also get a `b&w` toggle (`bw: true`), a CSS grayscale filter,
  so the saved photo keeps its colour. Photos sit in a cropping `.pi-frame`:
  the corner handle sets width and frame height (`h`), `crop` enters a mode
  where dragging pans and scrolling zooms (`zoom` 1..4, `px`/`py` 0..1 pan),
  `fit` drops `h` and the crop to show the photo's own shape, and `done` or
  Esc leaves the mode. `layoutPhoto()` turns those into the img's size and
  offset. Like the cover, a quick second click on `done` is ignored. (The
  page once had two fixed side wallpapers; they were removed once photos could
  be added as page items.)
- `reset all` is a two-click button (arm, then confirm within 3s) so a stray
  tap never clears the grid; it clears ticks and day notes but keeps the added
  notes and page items. If a start date is set, reset moves it to today. No native `confirm()` dialog is used.

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
