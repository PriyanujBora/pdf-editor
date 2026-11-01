# Free PDF Editor — project guide

Browser-only PDF editor. Vite + React 19 + TypeScript (strict), Tailwind v4 + shadcn/ui, pdf.js for
rendering/text extraction, @cantoo/pdf-lib + @pdf-lib/fontkit for writing, react-konva for the editing
overlay, Zustand + zundo for state/undo, IndexedDB autosave, PWA. Hosted as static assets on a
Cloudflare **Worker** (not Pages).

## Non-negotiable rules

- **Files never leave the device.** No backend, no analytics, no third-party requests. The CSP in
  `public/_headers` (`connect-src 'self'`) enforces this; never loosen it to add a remote service.
- **Deploy target is Cloudflare Workers static assets** via `wrangler.jsonc` (`assets.directory: ./dist`).
  Do not convert to Pages. Do not deploy or log in to Cloudflare unless the user asks.
- **Keep the initial bundle lean.** pdf.js (+ worker), Konva, pdf-lib, the editor UI and document fonts are
  all lazy. The landing page must not import them. Check with `npm run build` (initial `index-*.js` ≈ 98 KB gz).
- **WYSIWYG:** the editor canvas and the export must lay text out identically — same font files, same
  baseline maths (`src/lib/text-layout.ts`). Change both sides together.
- Responsive: desktop ≥ 1024px = top toolbar + left thumbnails + right properties; below that = bottom
  toolbar, properties in a vaul Drawer, thumbnails in a Sheet. Touch targets ≥ 44px. Light + dark.

## Commands

```
npm run dev            # Vite dev server (copies pdf.js assets first)
npm run build          # typecheck + production build into dist/ (+ service worker)
npm run cf:dev         # build, then serve dist/ with `wrangler dev` (real _headers/CSP), :8787
npm run typecheck | lint | format
npm run fixtures       # generate tests/fixtures/*.pdf (text-heavy, multi-page, scanned, encrypted, corrupt)
npm run test:e2e       # Playwright suite at 390/820/1440px against E2E_URL (default http://localhost:5199/)
npm run test:prod      # smoke test of the built app under wrangler dev (CSP, export, offline)
```

The e2e suite drives the dev server and reads state through `window.__doc/__ui/__session`, which are
exposed only in dev builds (`src/App.tsx`).

## Layout

```
src/
  types.ts                  data model (see below)
  store/document.ts         undoable doc: pages[] + elements{} (zustand + zundo)
  store/session.ts          open file: bytes, pdf.js proxy, source page geometry, image assets
  store/ui.ts               tool, zoom, selection, editing, panels, theme
  lib/open-document.ts      parse with pdf.js, read page geometry, errors (password / corrupt)
  lib/persist.ts            IndexedDB autosave (idb-keyval) — never stores passwords
  lib/fonts.ts              bundled font registry, script runs (Latin/Bengali/Devanagari), CSS font strings
  lib/text-layout.ts        shared baseline/line-height maths (editor + export)
  lib/measure.ts            canvas text measuring for the editor
  lib/images.ts             PNG/JPG ingest (EXIF orientation baked in, ≤ 4096px)
  lib/pdf/pdfjs.ts          lazy pdf.js loader + asset URLs (public/pdfjs, copied at build)
  lib/pdf/text-blocks.ts    group pdf.js text items into editable lines; map original font → bundled
  lib/pdf/sample.ts         sample ink + background colour from the rendered page canvas
  lib/export/export.worker.ts  builds the output PDF in a Web Worker
  lib/export/matrix.ts      affine maths; page-space ↔ PDF user space
  lib/export/fontkit-compat.ts  adapter fixing @pdf-lib/fontkit issues (see gotchas)
  features/landing/         drop zone, password dialog
  features/editor/          Editor shell, Viewer (zoom/pinch/virtualization), PageView/PageCanvas,
                            PageOverlay (Konva), InlineTextEditor, Thumbnails, PropertiesPanel, toolbars
public/fonts/               bundled TTFs (OFL) — Inter, Roboto, Noto Serif, Noto Sans Bengali/Devanagari
```

## Data model and coordinates

- **Page space**: PDF points, origin top-left of the page *as displayed with its original /Rotate*,
  y down — i.e. pdf.js viewport space at scale 1. All element coordinates use it.
- `PageItem { id, srcIndex, rotation }` — output order; `rotation` is the user's extra rotation. User
  rotation rotates the whole page (elements included): the Konva group and the canvas both apply it, and
  export just sets `/Rotate = original + user`.
- `TextElement { x, y, rotation, text, font, size, color, bold, italic, align, lineHeight, cover? }`.
  `(x, y)` is the box top-left; the first baseline is at `y + ASCENT·size`. Boxes are auto-width; lines
  break only on `\n`. `cover` = the original-text region (page space) + sampled background colour.
- `ImageElement { x, y, width, height, rotation, assetId }`. Image bytes live in `session.assets`, not in
  undo history.
- Undo: each discrete action is its own step; repeated `updateElement` calls on the *same element and
  same fields* within 1s merge (typing, colour drags, nudges). Drag/transform ends pass `{ merge: false }`.

## Export pipeline (worker)

1. Load source with pdf-lib (`password` when encrypted; owner-only files use `''`).
2. `copyPages` into a fresh document in output order; set `/Rotate`.
3. Per element: `q`, `cm` = (page space → PDF space) · (element frame), draw, `Q`.
   Covers are drawn first, then elements in insertion order.
4. Text is shaped with fontkit (`font.layout`) and drawn **glyph by glyph** with `Tm` so GPOS offsets
   (Indic marks) survive; glyphs are registered in pdf-lib's subset embedder (internal API, see
   `encodeGlyph`). Italic on a face without italics = synthetic oblique (shear 0.2), like browsers.
5. `save({ useObjectStreams: true })`, validated against Chrome's PDFium + pypdf strict during dev.

## Gotchas

- `@pdf-lib/fontkit` + `@cantoo/pdf-lib`: always register `compatFontkit`, never raw fontkit. It (a)
  hides fontkit's internal `encode()` that @cantoo/pdf-lib mistakes for the v2 API, and (b) pads glyph
  data to even length — fontkit writes a short `loca` without padding, corrupting Inter / Noto Serif.
- fontkit's Indic shaper needs a global `regeneratorRuntime` → `import 'regenerator-runtime/runtime'`
  at the top of the worker.
- pdf.js 6: `pdf.loadingTask.destroy()` (no `pdf.destroy()`), `page.render({ canvas, viewport })`, no
  `isEvalSupported`. pdf.js uses opaque canvases → Chrome applies LCD subpixel AA, so colour sampling uses
  per-channel medians.
- Konva + touch: shapes `preventDefault` touch events by default, which blocks scrolling. Unselected
  shapes set `preventDefault={false}`; on touch, elements are draggable only once selected.
- iOS keyboard: focus must happen inside the tap. `primeKeyboard()` focuses a proxy textarea in the
  Konva tap handler; the inline editor takes focus on mount. Inline editor font-size ≥ 16px (scaled by
  transform) to stop iOS zoom-on-focus.
- Vite dev reloads the page when it discovers a new dependency; keep `optimizeDeps.include` complete or
  the e2e suite will flake.
- Edited text is **covered, not erased**: the original glyphs stay in the content stream (copy/search
  still finds them). The UI says so. Real removal = content-stream rewriting (future work).

## Workflow

- Plan → build in feature order → commit after each feature (end commit messages with the
  `Co-Authored-By` line from the session instructions).
- After UI or export changes: `npm run typecheck && npm run lint`, run `npm run test:e2e`, and look at the
  screenshots in `tests/out/`. For export changes also render the output with PDFium.
