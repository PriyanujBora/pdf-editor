# Free PDF Editor

Edit PDFs in the browser — change existing text, add text and images, reorder/rotate/delete pages,
download. Everything runs on your device; no file is ever uploaded. Installable and works offline.

## Run locally

Requires Node 20+.

```bash
npm install
npm run dev          # http://localhost:5173 (or pass --port)
```

Production build, served exactly as Cloudflare will serve it (headers, CSP, service worker):

```bash
npm run cf:dev       # builds, then `wrangler dev` on http://localhost:8787 — no Cloudflare login needed
```

## Test

```bash
npx playwright install chromium   # once
npm run fixtures                  # generate test PDFs into tests/fixtures
npm run dev -- --port 5199        # in another terminal
npm run test:e2e                  # phone 390px, tablet 820px, desktop 1440px; screenshots in tests/out
npm run test:prod                 # against `npm run cf:dev`
```

## Deploy (later)

The app is a static-assets-only Cloudflare Worker configured in `wrangler.jsonc`:

```bash
npm run build
npx wrangler deploy
```

## Notes

- Fonts bundled for editing/export: Inter, Roboto, Noto Serif, Noto Sans Bengali, Noto Sans Devanagari
  (SIL Open Font License). Original fonts in PDFs are usually subsets, so edited text uses the closest
  bundled family at the original size and colour.
- Edited existing text is covered with a patch of the sampled background colour; the original text is
  hidden, not erased from the file.
