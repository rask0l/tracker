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
  writes to IndexedDB that session); it fires `app-ready` when done. If
  IndexedDB answers after the 5s, the page reloads once to use it (a
  `hundred-late` sessionStorage flag stops a page that is always slow from
  reloading forever). localStorage `hundred-idb` marks a browser where
  IndexedDB has held the data: there, a session that can't open IndexedDB
  is read-only (`storageLocked`, `lockWhy = "idb"`, a toast says to
  reload), because its localStorage copy may be old and saving it would
  replace the real data. `save()`
  queues writes in order and returns a promise (import waits on it before
  reloading). If saved data exists but nothing readable loads, the page
  shows a blank tracker but sets `storageLocked`, never saves over the
  data, keeps an `unreadable-<time>` copy in IndexedDB (only when it differs
  from the last one), and says so in a toast; importing a backup lifts the
  lock. Safety copies are full states kept in IndexedDB as `<kind>-<time>`
  (`before-sync`, `cloud-before-upload`, `before-restore`, `unreadable`,
  see `COPY_KINDS`) by `safetyCopy()`, which keeps only the newest
  `COPY_KEEP` (6) of each kind so they never fill the storage. When any
  exist, the sidebar shows `safety copies (N)`: a list to download one as
  JSON or restore it (two clicks; what is there now becomes a
  `before-restore` copy first).
  Other tabs: each tab holds the whole state, so after every stored save a
  tab announces its `savedAt` (`BroadcastChannel("hundred-tabs")`, or a
  `hundred-ping` localStorage key where that is missing). A tab that hears
  a newer one sets `staleTab`, stops saving and syncing, and reloads (at
  once if on screen, otherwise when you come back to it). `safeMap()` drops a single bad
  page, item or note instead of failing the whole load. The saved shape is
  `{ n, title, days, label, dayNotes, stickies, start, lastExport, items, cover, icon, pages, sidebarHidden, game }`
  (`game` is the site-wide game record, see Command Center below).
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
  there is data and no export in over 7 days. "Data" (`hasData()`) is any
  tracker tick or day note, written document, transaction, planner activity,
  repeat or reflection, or page item; the line refreshes after every save.
- Cloud sync (optional): `sync/` holds a Cloudflare Worker (`worker.js`,
  `wrangler.toml`, setup steps in `sync/README.md`) that stores the state in
  an R2 bucket behind a bearer `SYNC_TOKEN` secret. The site's sidebar `sync`
  button saves the worker address and key in this browser's localStorage
  (`hundred-sync`, never in the state, the export or the repo). Photos are
  uploaded once as `blob:<sha256>` refs (`dehydrate`/`rehydrate`), so the
  synced state stays small; the worker keeps one snapshot per day under
  `history/`. localStorage `hundred-sync-base` is `sync.base`: the cloud's
  `savedAt` this browser's copy last matched (set after an upload, a
  download, or a check that found them equal). On open and whenever the tab
  comes back (`syncCheck`): if only the cloud changed since `base`, the
  cloud copy replaces the local one after a `before-sync` safety copy, then
  reloads; if only this copy changed, it uploads; if both changed, nothing
  is replaced: `sync.conflict` pauses syncing and the status line says so,
  and the sync popover asks which copy stays ("use the cloud copy", or
  "upload this browser's copy", which first keeps the cloud's data as a
  `cloud-before-upload` safety copy and then uploads with `push(true)`).
  Without a `base` (synced before this existed) the newer `savedAt` wins.
  Uploads send `?base=` (a query string, so older workers ignore it and no
  CORS preflight changes); the worker answers 409 if the cloud moved on,
  which also pauses syncing. `adoptRemote()` reloads only once the cloud copy
  is really stored, and `adoptOnce()` never downloads the same cloud copy
  twice in a session (sessionStorage `hundred-adopt`), so a copy too big for
  the storage can't cause a reload loop. Each change uploads
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
  streak, timer, game, reflect, reviews, rest, templates }`.
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
  - The edit form has `duplicate` (`duplicate()`): a one-off copy (never
    part of a series, not done; title, area, type, priority, notes and
    deadline kept) placed right after the original when it fits before
    midnight, otherwise at the same time, then opened as "copy made:
    adjust it". One save, so one Ctrl+Z removes it.
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
    through the same matching, `discard` takes two clicks. A session that
    runs past midnight is saved as two blocks: the part before midnight on
    the day it started, the rest on today.
  - Day view: under the timeline/list toggle, one line per area with time
    planned that day, done / planned (`cwes study 2h / 4h 45m`, `hm2()`
    for exact hours and minutes; `1h ✓` in red once all of it is done;
    flex windows, all-day items and untimed tasks left out). A timeline or list toggle (`settings.dayMode`), tasks without
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
    (`Planner.show()`), then that day's plan from `Planner.dayItems()`
    (all-day items first, flex windows left out), each with a checkbox:
    `Planner.tick()` ticks it in the planner (a repeating occurrence is
    saved as its own activity first), then `linkStreaks()` and `save()`.
  - One game for the whole site: the game record lives on the root state
    (`state.game`, cleaned by `Planner.normGame()`; the first time it is
    made, `Planner.mergeGames()` folds together the old per-page records:
    highest level, earliest badge dates, rewards by name, every claim).
    Old `planner.game` copies stay in the pages but are no longer used.
    `Planner.score(gameSources(), state.game)` adds up every planner page
    (the first in the sidebar is the main one: daily quests, the weekly
    boss and the cleared-day streak come from it; the others add XP and
    hours), trackers no planner keeps (+20 xp a ticked, dated box) and
    Finance pages (+15 xp a day with money logged, a "log today's money"
    quest, and the "money & trackers" badges). It scores other planners by
    mounting them headless (`mount({ page, headless:true, game })` returns
    `{ parts, finish }` before drawing anything). Each planner page gets
    `ctx.game` and `ctx.score`.
  - The game has its own page (`kind:"game"`: title, subtitle, icon,
    cover and items only; the game itself is `state.game`). It is made
    once, right after the first Command Center (`makeGamePage()`, then
    `game.pageMade`, so deleting it sticks; "+ new page" offers it again).
    It draws the main planner in game-only mode
    (`Planner.mountGame({ root, page:mainPlanner, ... })`): a hero (rank
    medallion, level, XP bar, next rank, XP/coins/badges/run/bosses),
    ranks, next badge, this week's boss, today's quests, rewards, badges,
    the 12-month heatmap, recent XP, game settings (on/off, loud/subtle,
    sound) and the icon credit. With no Command Center it offers to make
    one. The planner itself has no game tab: its header keeps the level,
    XP bar and quests, and `g` opens the game page (`ctx.openGame`).
    A player card at the bottom of the sidebar
    (`#sbGame`, `renderProfile()`, refreshed 600ms after the last save) shows
    the rank medallion, level, coins and XP bar, flashes "+N xp" when XP
    goes up, and opens the game page.
  - Game (subtle, switchable in settings as `game.off`): XP, levels, three
    daily quests, a weekly boss and the badges below, all worked out by
    `computeGame()` from what was finished, so undo, sync and backups stay
    consistent and nothing new is logged. XP only for finished work
    (CWES/side hustle 60 an hour, first gym session of a day 50, work 20
    an hour, personal 10, `!!!` +15, about 1 in 7 a ×2 "crit" by a hash
    of the id), +50 a cleared day, +30 a quest, +200 a beaten boss. Level
    L starts at 50*(L-1)*L XP. Quests are picked from the day's own plan
    (seeded by date) and stored in `game.quests[date]` on the first change
    of the day; the boss's HP is 100 per weekly target. `game.level` and
    `game.seen` (badge unlock dates) only decide what to toast, and the
    first change after the game appears records them silently. "run" is
    cleared days in a row; rest days never break it.
  - NOW panel (header): the block happening now in big type with a live
    countdown (refreshed every 30s), a progress bar, `✓ done`, `▶ timer`
    and what's next; with nothing on, it counts down to the next block
    (with its checkbox), or falls back to tomorrow's first items.
  - "suggest" in plan day (`suggest()`): spreads what's left of this
    week's targets over the remaining non-rest days and fits the day's
    share into free time (flex windows count as free), minus what's
    already planned that day, so pressing it twice adds nothing; gym goes
    in the evening, CWES rotates theory/lab/revision, the side hustle gets
    a marketing block if the week has nothing money-facing; it respects
    `maxHours`. Its lines go into the plan box for editing.
  - The game page has a 12-month heatmap of XP per day (absolute steps at
    100, 200 and 350 XP).
  - Single-key shortcuts while the planner is on screen and you aren't
    typing (paused while a big card or any site menu or popup is open,
    including the `/` page menu, whose filter letters would otherwise fire
    them): `q` quick log, `n` new,
    `p` plan day, `d w a g s` tabs, `[ ]` back/forward, `t` today, `?` list.
    The `keys` button next to `+ add` (or `?`) opens the same list as
    tappable buttons, one table (`KEYS`) for both, so it works on touch.
    A leading zero in a typed time means 24-hour (`06:00` is morning);
    without it, 1 to 6 reads as pm.
  - Badges: 88 in nine groups (`ACH_GROUPS`: hardcore, streaks, cwes,
    side hustle, gym, quests & bosses, money & trackers, xp, life), each shown as a hexagon medallion
    (`medalSvg()`/`medal()`): an icon from game-icons.net on a dark plate,
    in the theme's colours only (no emoji). The icons (`GI`, path data only,
    rounded to 1 decimal with a tokeniser so numbers never merge, 512x512)
    are by Lorc, Delapouite and contributors under CC BY 3.0, so the game
    tab carries a credit line with links; keep it. They are copied into
    planner.js, never loaded from another site. `PIX` (8x8 pixel icons) is
    only a fallback. Rarity (`RARE`, default common)
    sets the frame: common one frame, rare a second inner frame, epic a
    heavy frame with white corner studs, legendary spikes from every corner,
    a dashed ring and a white icon. Earned medallions glow red (stronger
    with rarity) and get a light sweep on hover; locked ones are dark
    steel with a progress bar. Ranks are medallions too (`rankRarity()`),
    the current one shown big by the level in the game page; unlock cards
    name the rarity ("legendary badge unlocked"). Each earned badge is worth +25 coins. The
    game page names the closest unearned badge ("next badge"). When badges
    are added, bump `ACH_VERSION`: on the next change, badges already earned
    are recorded quietly (`game.achv`) instead of toasting all at once.
    Ranks (`RANKS`) every few levels from recruit (1) to ascended (100),
    each with a pixel insignia shown by the level in the header; a new rank gets
    its own full-screen card, and so does a badge when nothing bigger
    happened in the same change.
  - Quests are generated (`DT` daily and `WT` weekly templates x amounts x
    40 CWES web topics in `TOPICS`): 126 daily, their 126 elite versions
    and 130 weekly, 382 in all. A seeded draw per date or week
    (`pickGen()`, `rng()`) always gives the same picks; it never repeats a
    template in one draw, leans toward the main planner's
    `settings.focus` (main priority: CWES by default; the first daily
    pick and two weekly picks always come from it; side-hustle quests are
    rare unless it's the priority), and gets harder with level (tiers by
    amount; elite third daily quest from level 10, double xp). Ids hold
    everything needed to check them later (`d:cwesmin:90`,
    `e:early:8`, `w:topicw:xss.3`); `resolveQ()` also still reads the old
    fixed ids. Each quest reports progress `[have, need]` from `dayCtx()`
    or `weekCtx()`. Topic quests count CWES blocks with the topic's word
    in the title or notes. Weekly picks are stored in `game.wquests` by the
    week's first day; finishing all three adds a +100 "weekly sweep" (big
    card) and the weekly badges. The planner header shows today's quests
    with progress and "week n/3", the week view and the game page list the
    weekly ones with progress bars.
  - Quest style (`settings.questStyle`, set next to main priority):
    `flexible` (the default) only asks for outcomes (time, days, early
    starts, cleared days, gym, planning, reflecting) and never says how to
    study; `structured` also draws the templates marked `structured: true`
    (labs, theory/revision blocks, long blocks, topics). In flexible mode,
    today's and this week's stored picks that hold a structured quest are
    drawn again as long as none of them is done (`misfit()`, then `qFresh`
    makes `gameStep` store the new ids); finished history never changes.
  - Quests are never ticked by hand: they tick from finished work. Each
    unfinished quest has a button (`questAction()`): CWES, gym and side
    hustle quests `▶ start` the timer with a fitting title (a topic quest
    names the topic so its keyword counts) and open the planner; plan
    quests open tomorrow with plan day (or a new CWES form); reflection
    quests open and focus today's reflection; money quests open the first
    Finance page (`ctx.openFinance`); anything else opens today. From the
    game page this goes through `ctx.openPlanner(then)`; UI flags live in
    `uiState` by page id, so the planner mount picks them up. Header quest
    chips and whole quest rows do the same. With a timer already running
    in that area the button says "timer on" and only opens the planner.
  - Quest saving: the quests on screen are the ones saved. `noteShown()`
    keeps what was last drawn while today's picks weren't saved yet
    (`SHOWN`, with the quest style and focus as `qSig`), and
    `lockQuests(game, G)` saves those, so a change never swaps the
    quests you were looking at. The planner calls it in `gameStep`; on
    every other real change (a tracker tick, finance, a Day card tick)
    index.html's `save()` calls it (`lockToday()`) when `Planner.needsLock()`
    says today's picks are missing. `needsLock()` runs on every save, so it
    must stay cheap: it only says yes for the first change of the day, never
    for unwon kept quests (that used to score the whole game on every
    keystroke). Kept wins are saved where planner items change: the
    planner's `gameStep` and the Day card's plan ticks (`lockToday()` before
    `save()`). The reflection box saves on each keystroke but runs
    `gameStep` only after a 700ms pause. History is never trimmed: past quest XP
    is worked out from `game.quests`/`game.wquests`, so trimming took XP
    away (it used to cut after 60 days and 30 weeks).
  - Kept quests (`keep: true`: clear the day, every !!/!!! task, clear a
    6h+ day) stay won once won, even if more is added later; the win is
    saved in `game.qwon[date]`, so Ctrl+Z still takes it back. Other
    quests follow the live state.
  - Draws never hold two quests measuring the same thing (`family`: CWES
    time vs focused time vs side time, weekly hours, "on n days"), and a
    weekly "on n days" quest is never drawn when the days left can't make
    it (`perDay`, `daysLeft`). A quest that can't be done any more is
    shown as missed with no button: daily early quests after their hour
    (`late`), weekly per-day quests once the days left fall short.
  - Early means morning: nothing starting before 04:00 (`DAWN`) counts as
    early, for quests and for the early bird and 5am club badges. Early
    quests are only drawn when they fit you: daily ones when the day
    already has a CWES block planned before that hour, weekly ones after
    2+ early CWES mornings in the last four weeks.
  - Outcome-only quests added for variety: beat yesterday's CWES time,
    finish every CWES block you planned, note what you learned in a CWES
    block (a finished block with notes), and weekly: beat last week's
    CWES hours, note what you learned on n days.
  - An open planner or game page redraws when the date changes (checked
    every 30s or 60s, not while you're typing), so quests and "today"
    move on at midnight. Day contexts and finished CWES minutes are cached
    per index (`memo`), so scoring years of quests stays fast.
  - Hardcore layer: a "hardcore" badge group (consistency and intensity:
    no zero days = 1h+ of CWES or side hustle a day, deep work = 4h+ in a
    day, flawless weeks = boss beaten and every day cleared, boss and gym
    runs in a row, raids, a comeback after a broken 7+ run, 5am club, 1,000
    xp days, 500h CWES, 1,000h of focus, level 150...) and a fifth rarity,
    mythic: an inverted medallion (solid red plate, dark icon, twelve
    spikes, white ring). Runs never break on a week or day that isn't over.
    Raid bosses: every 4th week (`isRaid()`, by week number) the boss needs
    150% of every target and pays 500 xp. Elite quests: from level 10 the
    third daily quest is an elite one (`QDEF` entries with `elite`, worth
    60). Ranks go on to immortal (150) and godlike (200).
  - Coins and real rewards: 1 coin per 10 XP plus 25 per badge, minus what
    was spent. The
    reward shop (`game.rewards`, `{ id, name, cost }`, editable, three
    examples on a new page) is for real treats; claiming one adds to
    `game.claims` (`{ id, name, cost, date }`), only when you can afford it,
    and Ctrl+Z gives the coins back.
  - Loud mode (`game.loud`, the default) vs subtle: loud plays tiny
    chiptunes made with the Web Audio API (no sound files; `game.mute`
    silences them, the `♪` button in the header), drops red and white
    squares, and shows a full-screen card for level ups, a beaten boss and
    a claimed reward; subtle uses toasts only. Confetti and the card's
    motion are skipped when the device asks for reduced motion.
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
  inside the sync/icon/font/new-page popups and in forms whose typing isn't
  saved yet: the finance and planner add/edit forms, quick log, plan day,
  template name, the finance search, and inputs marked `data-native-undo`
  such as "+ add a category" or a new reward; there the app's undo would take
  back the last saved change instead of the typing). `save()` compares snapshots
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
  where dragging pans and scrolling zooms (`zoom` 1..4, `px`/`py` 0..1 pan;
  a zoom saves 400ms after the wheel stops, so it is one undo step),
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
