# tracker

A single-page **100-day tick-box tracker**. It replaced an older multi-page
progress dashboard (study/gym/notes/blog); that history was intentionally
wiped. Everything here is for the owner only. The site is `noindex` and is not
linked from anywhere.

## What it is

- `index.html` is the entire site: a self-contained static page with inline
  CSS and JS, no framework, no Jekyll layout. A 10x10 grid of 100 buttons.
  Clicking a box toggles that day done.
- **State is browser-only.** Everything saves to `localStorage` under key
  `hundred-v1` as `{ days: boolean[100], label: string }`. The repo holds no
  progress. Clearing site data wipes it; there is no export/import yet.
- The first unticked box is highlighted as "today" (an inset border). The
  progress bar and `N / 100` count derive from how many boxes are ticked.
- `reset all` is a two-click button (arm, then confirm within 3s) so a stray
  tap never clears the grid. No native `confirm()` dialog is used.

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
