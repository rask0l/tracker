# tracker

A single-page **100-day tracker**: a 10x10 grid of tick boxes. Click one box a
day. State lives entirely in the browser (`localStorage`, key `hundred-v1`), so
nothing is stored in the repo.

Plain static `index.html` (inline CSS + JS, no framework). Built with Jekyll
only so it can deploy to GitHub Pages at `rask0l.github.io/tracker`
(`baseurl: /tracker`). The whole site is `noindex`.

## Run locally

```bash
bundle exec jekyll serve
# http://127.0.0.1:4000/tracker/
```

Or just open `index.html` directly — it needs no build.
