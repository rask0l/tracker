# Cloud sync worker

A tiny Cloudflare Worker that stores the tracker's data in an R2 bucket, so
every device sees the same pages. The site talks to it from the sidebar's
`sync` button. Nothing secret lives in this folder: the sync key is a Worker
secret you set yourself.

## One-time setup

1. Create a free Cloudflare account, then open **R2** in the dashboard and
   enable it (it asks for a card; this usage stays inside the free tier).
   Optionally add a billing notification so nothing can surprise you.
2. From this folder, log in and create the bucket:

   ```bash
   npx wrangler login
   npx wrangler r2 bucket create tracker-sync
   ```

3. Make a long random sync key and store it on the worker. Keep a copy
   somewhere safe (a password manager); every device needs it.

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   npx wrangler secret put SYNC_TOKEN
   ```

4. Deploy:

   ```bash
   npx wrangler deploy
   ```

   It prints the worker address, e.g. `https://tracker-sync.<you>.workers.dev`.

5. On the site, open the sidebar, press `sync`, paste the address and the
   key, and press `connect`. Do the same on every other device and choose
   "use the cloud copy" there.

## When two devices both changed

Each upload says which cloud copy it grew from (`?base=`). If the cloud has
changed since, the worker refuses it (409) instead of overwriting, and the
site pauses sync and asks which copy should stay. The one you don't pick is
kept in that browser as a safety copy (sidebar: "safety copies").

After changing `worker.js`, deploy again (`npx wrangler deploy`). Until
then the old worker ignores `?base=`; the site still checks on open, but
the worker can't refuse a stale upload.

## What it stores

- `state.json`: the latest state, with photos swapped for `blob:<sha256>` refs
- `blobs/<sha256>`: each photo once, as its data URL
- `history/<YYYY-MM-DD>.json`: one snapshot per day to roll back to

To change which sites may call it, edit `ALLOWED_ORIGINS` in `worker.js`
and deploy again.
