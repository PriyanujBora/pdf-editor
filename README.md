# Free PDF Editor

Edit PDFs in the browser — change existing text, add text and images, redact, reorder/rotate/delete
pages, download. Everything runs on your device; no file is ever uploaded. Installable and works offline.

Free forever: no ads, no account, no limits, no watermarks. See `/about` in the app for how to verify
that files never leave the device.

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

## Licence

MIT (see LICENSE). Bundled fonts keep their own licences (SIL OFL 1.1, Apache 2.0): public/fonts/LICENSE.txt.

## Notes

- Fonts bundled for editing/export: Inter, Roboto, Noto Serif, Noto Sans Bengali, Noto Sans Devanagari
  (SIL Open Font License). Original fonts in PDFs are usually subsets, so edited text uses the closest
  bundled family at the original size and colour.
- Edited existing text is really removed from the downloaded file: the old words are taken out of the
  page's content stream, so copying, searching and text extraction no longer find them. Only when that's
  impossible (rare fonts, text used as a clip) is the old text covered instead, and the app says so.
- Clicking existing text edits its whole paragraph: the text reflows within the paragraph's column,
  alignment (including justified) and line spacing, unchanged words keep the PDF's own letters, and
  text that no longer fits is outlined with a "Shrink to fit" option. Alt-click edits a single line.
- Fill in forms (and flatten them), turn a flat printed form into a fillable one, sign (draw, type or
  upload; saved only on your device), annotate (highlight, underline, strike, notes, drawings, shapes —
  standard PDF annotations), insert pages from other PDFs, add blank pages, duplicate, extract or split,
  and compress images with a size preview.
- Redaction removes what is under each mark from the file — text (including invisible OCR text), image
  pixels, drawings, comments, form fields — then draws a black box. Find & redact searches words, regular
  expressions and common patterns (emails, phone numbers, PAN, Aadhaar, card numbers). Optional clean-up
  removes metadata, JavaScript, attachments, hidden layers, comments and form values. The result is opened
  again and checked before it is saved; if anything marked can still be found, nothing is downloaded.
