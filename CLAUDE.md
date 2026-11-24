# tracker

A single-page, Notion-style **day tracker**: tick-box grids of any length
plus document pages. It started as one 100-day tracker and replaced an older
multi-page progress dashboard (study/gym/notes/blog); that history was
intentionally wiped. Everything here is for the owner only. The site is `noindex` and is not
linked from anywhere.

## What it is

- `index.html` is the site: a static page with inline CSS and JS, no
  framework, no Jekyll layout. The Finance page type lives in `finance.js`
  and the Command Center (planner) in `planner.js`, each loaded by a plain
  script tag before the app; bump its `?v=` when it changes so browsers
  don't keep an old copy. It works like a small Notion: a
  left sidebar lists pages, the first being the home tracker, and
  `+ new page` adds either a document page or a day tracker of any length
  (presets 7 to 365, or a custom number up to 1000). A tracker is a grid of
  `n` day buttons (10 wide up to 100 days, 14 up to 196, then 20) plus a side
  column of note cards, under an editable title (`title`, shown in the
  sidebar) and a subtitle (`label`). A `days` field next to `start` changes
  the length; both fields are invisible until you hover their row or edit
  them (class `len-field`). Shrinking only hides days (the `days` array keeps
  them). Clicking a box opens that day in the Day card;
  double-clicking a box (or the Day card's checkbox) ticks it. Left/right
  arrow keys, or the `‹ ›` buttons on the Day card, step between days (the
  keys are ignored while typing in an input). On touch screens a long-press
  (450ms) on a box ticks it, and below 640px the Day card moves above the grid
  (the side column is `display:contents` so its cards can be reordered).
- **State is browser-only.** Everything saves to IndexedDB (database
  `hundred`, store `kv`, key `hundred-v1`) as a JSON string; `STORE` wraps it.
  localStorage (same key) only mirrors states under 2M characters, so a
  refresh that lands mid-write still finds the latest copy; on load the copy
  with the newest `savedAt` wins, and data from before IndexedDB moves over on
  the first save. localStorage alone used to be the store, but it gives the
  whole rask0l.github.io origin only about 5M characters: photos filled it,
  saves failed, and refreshing brought back old or default data. The app is
  `app(BOOT)`, started once IndexedDB has been read (it falls back to
  localStorage only if IndexedDB fails or takes over 5s, and then never
  writes to IndexedDB that session); it fires `app-ready` when done. `save()`
  queues writes in order and returns a promise (import waits on it before
  reloading). If saved data exists but nothing readable loads, the page
  shows a blank tracker but sets `storageLocked`, never saves over the
  data, keeps an `unreadable-<time>` copy in IndexedDB, and says so in a
  toast; importing a backup lifts the lock. `safeMap()` drops a single bad
  page, item or note instead of failing the whole load. The saved shape is
  `{ n, title, days, label, dayNotes, stickies, start, lastExport, items, cover, icon, pages, sidebarHidden }`.
  The root holds the home tracker's own fields (`normTracker()` validates
  the per-tracker part for home and tracker pages alike); `T` is the tracker
  on screen and all tracker code reads `T.days`, `T.n` and so on, never
  `state.days`. `loadTracker(t)` rebuilds the grid, note cards and fields
  when a different tracker is shown.
  `start` is an optional `YYYY-MM-DD` start date (empty string when unset).
  `dayNotes` maps a day index to that day's body (a list of blocks). `stickies`
  is the list of added notes, each `{ id, title, pinned, done, check, blocks }`. A
  block is `{ id, type, text, done }` with type `text`, `todo`, `h` (heading),
  `quote`, `callout` (tip box), `divider` or `image` (which adds `src`, a JPEG
  data URL). iPhone-Notes style: Enter adds a line, Backspace on an empty line
  removes it, and Backspace on an empty styled line first turns it back into
  text. Typing `/` at the start of a line opens a Notion-style slash menu
  (filter by typing, arrows and Enter to pick, Esc to close) that converts the
  line, and typing `[]` at the start of a plain line makes it a checklist
  item. There are no add-line buttons: Enter, `/` and `[]` cover it. Photos
  are shrunk to 720px JPEGs before saving to keep the saved state small; if
  a save ever fails, a red toast says so instead of losing changes silently. Block rows use `bt-<type>` classes;
  never `blk-<type>`, since `.blk-text` is the line's input. The repo holds
  no progress; clearing site data wipes it, so the bottom of the sidebar has
  `export` (downloads the whole state as `100days-<date>.json`) and `import`
  (loads such a file back, validated by the same `normalize()` that `load()`
  uses, then reloads the page). There is deliberately no database: the JSON
  file is the backup. `lastExport` is the date of the last export; under the
  buttons the sidebar shows `last backup N days ago` and turns it red once
  there is data and no export in over 7 days.
- Cloud sync (optional): `sync/` holds a Cloudflare Worker (`worker.js`,
  `wrangler.toml`, setup steps in `sync/README.md`) that stores the state in
  an R2 bucket behind a bearer `SYNC_TOKEN` secret. The site's sidebar `sync`
  button saves the worker address and key in this browser's localStorage
  (`hundred-sync`, never in the state, the export or the repo). Photos are
  uploaded once as `blob:<sha256>` refs (`dehydrate`/`rehydrate`), so the
  synced state stays small; the worker keeps one snapshot per day under
  `history/`. On open (`syncCheck`) the newer copy wins by `savedAt`: a newer
  cloud copy replaces the local one after saving a `before-sync-<time>` copy
  in IndexedDB, then reloads; a newer local copy uploads. Each change uploads
  about 2.5s after editing pauses (`schedulePush`), failures retry every
  30s, and hard limits keep it inside R2's free tier even if a bug loops: at
  most one sync per 10s and 1000 per day per device (`SYNC_GAP`,
  `SYNC_DAILY`, counted in localStorage `hundred-sync-count`), and the
  sidebar shows `synced N ago` instead of the backup reminder. `save()` skips
  writes when nothing changed, so loading the page never counts as an edit.
  `sync/` is excluded from the Jekyll build; local `.dev.vars` is git-ignored.
  `navigator.storage.persist()` is requested so the browser doesn't evict data.
- Note cards (the Day card and every added note) sit in the tracker's side
  column and share one look: a checkbox to cross it off (the Day card's
  checkbox also ticks that grid day), a title, and the block body. They do
  not drag or float; the old grip and saved `pos` were removed once floating
  checklist page items existed. On added notes the cross-off checkbox is
  opt-in per note (`check`, off for new notes), switched from the note's `⋯`
  menu; removing it also clears the cross-off. Added notes also have a pin
  (pinned notes sort to the top, marked with a red left edge) and a delete.
- Ticking the last checklist item in a day's note ticks the day itself, but
  unchecking an item never unticks it. The Day card header shows checklist
  progress like `2/3`. (A daily template card that pre-filled every day was
  tried and removed at the owner's request; don't bring it back unasked.)
- With a start date set, box `i` is the date `start + i`: today's box is the
  one for today's calendar date, each box shows its date on hover, the Day
  card shows `SAT 21 NOV` under its title, and a status line says `day n of 100`
  plus how many past days were missed. Without a start date, the first
  unticked box is "today" and the status line stays empty. Either way
  "today" gets an inset border.
- The progress bar and `N / 100` count derive from how many boxes are ticked.
  `streak` is the run of ticked boxes ending at today (an unticked today does
  not break it; undated, it ends at the last ticked box) and `best` is the
  longest run anywhere. A day with any note text shows a small red dot on its
  box.
- Pages: the home tracker keeps its own `cover`, `icon` and `items` on the
  state itself. Every other page in `pages` has `{ id, kind, icon, cover,
  items }` plus either document fields (`kind:"doc"`, `title`, `label` (the
  subtitle under the title, same style as a tracker's), `blocks`, using the
  same block editor and slash menu as notes) or the tracker fields
  above (`kind:"tracker"`), or `kind:"finance"` with a `finance` object, or
  `kind:"planner"` with a `planner` object.
  Pages saved before trackers existed have no `kind` and load as documents.
  A page whose kind this copy can't read (an older copy of the site, or its
  script failed to load) is kept exactly as saved and shows a "refresh"
  notice; it must never be turned into a document, or the next save would
  wipe its data.
  The open page lives in the URL hash (`#p/<id>`, none for home) so back and
  forward work; `cur()` returns the open page (the state object for home) and
  `renderPage()` shows `#homeView` (any tracker) or `#docView`, calls
  `loadTracker()` when the tracker changes, and redraws cover, icon, page
  items and sidebar. Clicking the empty space under a document continues it.
  Deleting a page from the sidebar takes two clicks. The sidebar collapses
  with `«` (remembered as `sidebarHidden`); under 900px it is an overlay
  opened with the fixed `☰` button. Arrow-key day stepping only runs on
  tracker pages.
- Finance pages (`finance.js`): a personal finance system with five tabs,
  overview (default), transactions, budgets, analytics, settings, under a
  month switcher and `+ income` / `+ expense`. `finance` is `{ v:2, currency,
  categories, methods, rates, txns, budgets, goals, recurring, accounts }`
  (the last three are reserved for later features and passed through as is).
  - Money is integers in a currency's minor unit (cents for USD, riel for
    KHR), so sums are exact. `parseMoney()` turns typed text into minor units
    rounding half up and rejects anything with a minus sign; display uses
    `Intl.NumberFormat`. Amounts must be above zero.
  - A transaction is `{ id, createdAt, type, date, amount, currency, desc,
    notes, method }` plus `categoryId` for income/expense or `to` for a
    transfer. Transfers move money between your own payment methods and are
    never counted as income or spending. `id` and `createdAt` never change.
    Step 1 records (description in `note`, no currency/createdAt) migrate on
    load; `normalize()` drops duplicate ids so import and sync can't double
    a transaction.
  - `currency` is the primary currency; all totals and budgets are in it,
    and it locks once transactions exist. A transaction in another currency
    keeps its own amount; if you typed a rate ("1 primary = rate units") it
    also stores `rate` and `base`, its primary value, computed once with
    BigInt in `convert()` and never recomputed, so history never shifts.
    Without a rate it is listed separately ("not counted"), never added to
    primary totals. `rates` remembers the last rate per currency as a
    suggestion for new entries. There is no exchange-rate API on purpose.
  - Totals (`sum()`/`monthSum()`): income, expenses, net cash flow = income
    minus expenses, savings rate = net / income (none when income is 0).
    Everything is for the selected month and compared with the previous one.
  - `budgets` is `{ "YYYY-MM": { limit?, cats:{ categoryId: amount } } }`. A
    month without its own entry uses the latest earlier month
    (`budgetFor()`); editing an inherited budget saves a copy for that month
    first. Over budget shows in the accent red; 80%+ is called out in the
    overview's "what stands out" list.
  - Categories are `{ id, name, kind }` with editable defaults (new pages get
    Food, Transportation, Housing, Bills & Utilities, Internet & Phone,
    Shopping, Entertainment, Health, Education, Subscriptions, Personal Care,
    Other Expenses; Salary, Freelance, Business, Other Income). Renaming keeps
    the id. Deleting a used category asks where its transactions (and budget
    amounts) should move; it never deletes transactions.
  - Charts are hand-built, no library: grouped income (light ink) vs
    expense (accent red) bars with a legend and hover tooltips, a separate
    savings-rate line (percent never shares an axis with money), category
    bars, and a month-by-month table with the same numbers.
  - index.html only calls `Finance.normalize()` when loading,
    `Finance.fresh()` for a new page and `Finance.mount({ root, page, save })`
    from `renderPage()`; finance pages reuse the document title block. Saves
    go through the app's `save()`, so IndexedDB, sync, export/import and undo
    cover finance too. Undo groups typing only when the save happens inside
    an `input` event (`window.event`), so clicks and form submits are always
    their own step.
- Command Center pages (`planner.js`): a day and week planner around four
  focus areas (work, gym, cwes study, side hustle) plus personal. Its header
  is the tracker's own (it reuses the global `.stats`, `.count`, `.bar` and
  `.cell` classes): today's `done / total`, gym/cwes/side against weekly
  targets and the streak inline, a red bar, the week as seven boxes that
  fill red once a day is done, and what's next. Keep it that plain: one
  red accent for progress and done, area colors only as a thin left edge,
  no tiles, legends or explanatory copy. Rows show only time, title,
  priority and due date; area, type and "repeats" live in the tooltip
  (`tip()`), and week columns leave out flex windows. One toolbar row holds
  the day/week nav, the tabs (day, week, areas, settings) and `+ add`. `planner` is `{ v:1, areas, settings, acts, rules,
  streak, timer, reflect, reviews, rest, templates }`.
  - Dates are local `YYYY-MM-DD` strings and times are minutes from
    midnight (`start`/`end`, both null for a task with no time), so nothing
    shifts with timezones. The week starts on the day picked in settings
    (`settings.weekStart`, 0 = Monday to 6 = Sunday, via `wkStart()`); it
    decides the week view, the dashboard boxes, weekly targets and the
    scorecard. Rule `days` and week templates stay indexed Monday first,
    so they keep their weekdays whatever the start.
  - An activity (`acts`) is `{ id, date, done, createdAt, title, area, sub,
    start, end, prio (0..3), notes, due? }`. `sub` is the type within the
    area (work: core, meeting, flex; cwes: theory, lab, revision; side:
    idea, build, research, marketing, monetize; gym: strength, cardio,
    mobility).
  - All-day items (`allDay: true`, no times, optionally `to`: a last date
    up to 60 days on, e.g. a trip) sit as a bar above the day and on top of
    each week column. Like flex windows they are context, not tasks
    (`notTask()`): no checkbox, never counted as done, overdue or for the
    streak. Dragging one in the week view moves both ends.
  - "plan day" (day view) opens a box for planning a whole day at once: one
    line per activity, read by `parseQuick()` in plan mode (never marked
    done unless the line says `done`; a bare length like `cwes 2h` starts
    where the line before it ended), previewed with clashes in red, added in
    one save so one Ctrl+Z removes the whole plan.
  - Work `flex` blocks are windows "if work allows": drawn hatched behind
    other blocks, never counted as work, as done or as a task, and study or
    side hustle blocks can sit inside them. Work inside work (a meeting
    during core work) is not an overlap; any other overlap is flagged.
  - Repeating activities are stored once in `rules` (`days` is 7 booleans
    from Monday, `from`, optional `until`, `skip` dates) and expanded when
    drawn. Ticking, moving or editing one occurrence saves an activity with
    `ruleId` + `ruleDate` (an override), so finished history never changes
    when the series is edited. "This day only" edits make an override;
    deleting one day adds a `skip`; "delete series from here" sets `until`
    and drops unfinished overrides after it; deleting a rule keeps ticked
    days. `normalize()` drops duplicate ids and duplicate overrides.
  - Actual numbers count only ticked work: hours from finished timed blocks,
    gym as days with a finished session. Filling the calendar earns nothing.
    A target of 0 means none.
  - Quick log: one line on every tab (`parseQuick()`, no AI) turns text
    like `gym 1h`, `cwes lab 18:00-19:30 sqli`, `side 45m landing page`,
    `6-7pm` (1 to 6 without am/pm read as pm) or `email boss` into an
    activity, with a live preview of what will be saved. Area keys (work,
    gym, cwes, side, personal, an area's own name) leave the title; hint
    words (study, run, client...) pick the area but stay in it. A length
    alone means "just did it" (done, ending now); a range that has started
    is a log, a future one a plan, no time a task; `done`/`plan` force it.
    Logging something done ticks an unticked planned block of the same
    area that day (`matchPlanned()`: overlapping when a time was typed)
    instead of adding a copy, so the streak still counts.
  - Timer: `▶ timer` starts `planner.timer` (`{ title, area, sub, at }`, so
    it survives a refresh and syncs); `stop & log` saves the real minutes
    through the same matching, `discard` takes two clicks.
  - Day view: a timeline or list toggle (`settings.dayMode`), tasks without
    a time, a 15 minute snapping timeline (drag a
    block to move it, its bottom edge to resize; on touch only the `≡` grip
    and the edge drag; times typed in the form can be any minute), warnings (over `maxHours`, overlaps), free time,
    overdue one-offs (move to today), deadlines in the next 7 days, carry
    unfinished to tomorrow (two clicks), day templates and an optional
    daily reflection. Week view: 7 columns (drag between days), rest days,
    copy last week's one-off activities (skips ones already there), week
    templates, the weekly scorecard and an optional weekly review.
  - `streak` is `{ page, rule, pct }`: `page` is "home" or a tracker page id.
    On every planner save index.html's `linkStreaks()` ticks that tracker's
    box for each day up to today that counts (`Planner.countDays`: something
    was planned and everything, or `pct`%, of it is done; flex excluded),
    in the same save so undo and sync treat it as one change. It never
    unticks a box. Linking gives a tracker without a start date today's
    date. The tracker's status line says "kept by <page>" and its Day card
    shows `Planner.daySummary()` with an "open in planner" link
    (`Planner.show()`).
  - index.html calls `Planner.normalize()` when loading, `Planner.fresh()` for
    a new page and `Planner.mount({ root, page, save, trackers, streakOf })`
    from `renderPage()`; like finance, everything saves through the app's
    `save()`.
- Icons: every page can have an icon, `{ emoji }` or `{ src }` (a picture
  shrunk to 256px), plus `bw: true` for black and white (a grayscale filter
  on the page icon and the sidebar; a new icon keeps the setting), picked
  from a popover (emoji grid, type/paste an emoji, upload, b&w, remove). Like Notion, the 110px icon overlaps the bottom edge of the
  cover and the title sits under it; the sidebar shows it small.
  `+ add icon` / `+ add cover` / `+ add subtitle` sit above the title and
  show on hover. An empty subtitle (tracker `label` or document `label`)
  takes no space at all; `+ add subtitle` reveals it, and clearing it then
  clicking away hides it again (`paintSub()`).
- Undo/redo: Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes, anywhere
  on the page (app-level, so the browser's own text undo is replaced, except
  inside the sync/icon/font/new-page popups). `save()` compares snapshots
  (`snapOf()`: the state as JSON without `savedAt`, photos swapped for
  `\u0000img:<n>` tokens kept once in `imgById`), which is also how it skips
  no-op saves. Each real change pushes the previous snapshot onto an undo
  stack (max 80, this session only); typing groups into one step until a 1s
  pause, any other change is its own step, and a new change clears redo.
  `restoreSnap()` replaces the state, saves (so it syncs), and rebuilds the
  tracker and page; the text cursor is not kept.
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
  `cover: { src, y, bw, h? }` (y is the vertical crop in %, h a dragged
  banner height in px, 120 to 900) or `null`. Dragging the cover's bottom
  edge sets `h` so less of the photo is cropped; double-clicking the edge
  resets it. Covers are stored up to 2400px (`pickPhoto(cb, maxPx)`); other
  photos use the 720px default. `pickPhoto` keeps an already-small JPEG/WebP
  exactly as uploaded (no re-encoding), otherwise halves the image in steps
  with high-quality smoothing before the final resize and saves a JPEG
  (quality 0.86 for covers, 0.8 otherwise). Everything below the cover sits in `.page`
  (`position:relative`), so page items keep their place when a cover is added.
- Free-floating page items: the `+` fixed in the bottom-right corner adds a
  text box, heading, quote box, tip box, checklist, countdown or photo
  straight onto the page (not inside a card). Typing `/` anywhere that isn't
  a text field opens the same menu at the pointer: typing filters it, arrows
  and Enter pick, Backspace on an empty filter or Esc closes, and the new
  item's top-left lands where the pointer was. `/` inside a text line is
  still the block slash menu. A checklist (`type:"note"`)
  has a title in `text` and a body in `blocks` using the note editor (slash
  menu included), shows `done/total`, and gets a red border when every item
  is ticked. A countdown keeps its label in `text` and a `date`; it shows
  days left, `today`, or days ago, and the date picker only appears on hover
  or before a date is set. Each lives in `items` as `{ id, type, text, src?, x, y, w }`
  where `x` is px from the page's centre line (so items stay aligned with the
  centred layout at any width), `y` is px from the top of the page and `w` the
  width. They scroll with the page; hovering shows a grip to drag, a delete,
  and a resize handle on every corner (a left or top corner keeps the
  opposite edge fixed; text items only change width). Text boxes are auto-growing textareas.
  Every text item (text, heading, quote, tip box, checklist, countdown) has
  an `Aa` button in its controls: a menu to pick a font (`font` is `sans` or
  `serif`, absent means mono; stacks are the `--mono`/`--sans`/`--serif`
  variables, all built-in fonts, nothing downloads) and a text size (`size`,
  one of `SIZES` from 0.75 to 3, absent means 1). Text inside page items is
  sized in `em` off the item's own `font-size`, so `applyFont()` scales it
  all; the item's controls stay rem and mono. Document pages get the same
  `Aa` above the title (`font`/`size` on the page): the font covers title,
  subtitle and body, the size only the body.
  If an item hangs past the window edge, `fitCtl()` slides its grip and
  delete back on screen whenever it is hovered or focused, and Backspace in
  an empty text box removes the item.
  Photo items also get a `b&w` toggle (`bw: true`), a CSS grayscale filter,
  so the saved photo keeps its colour. Photos sit in a cropping `.pi-frame`:
  the corner handles set width and frame height (`h`), `crop` enters a mode
  where dragging pans and scrolling zooms (`zoom` 1..4, `px`/`py` 0..1 pan),
  `fit` drops `h` and the crop to show the photo's own shape, and `done` or
  Esc leaves the mode. `layoutPhoto()` turns those into the img's size and
  offset. Like the cover, a quick second click on `done` is ignored. (The
  page once had two fixed side wallpapers; they were removed once photos could
  be added as page items.)
- `reset all` is a two-click button (arm, then confirm within 3s) so a stray
  tap never clears the grid; it clears the open tracker's ticks and day notes
  but keeps its note cards and page items. If a start date is set, reset moves it to today. No native `confirm()` dialog is used.

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
