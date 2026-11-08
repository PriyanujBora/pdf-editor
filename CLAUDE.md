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
npm run test:fidelity  # export keeps forms/outlines/tags/attachments/labels/encryption (dev server + tests/.venv)
npm run test:edit-stability [-- filter]  # every editable line of fixtures + tests/corpus: no-op, editing,
                       # same-length word, missing glyph, size (needs dev server + tests/.venv, see tests/tools)
npm run corpus:word    # real Word "Save as PDF" output into tests/corpus (Windows + Word only)
```

`tests/corpus/` (private real-world PDFs) and `tests/.venv` (pypdf/PDFium tools) are gitignored.

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
  lib/text/capture.ts       every glyph pdf.js draws (operator list): position, font, size, Tc/Tw/Tz/Ts, colour
  lib/text/lines.ts         captured glyphs → editable lines with styled runs (SourceLine)
  lib/text/line-layout.ts   layout of an edited line — shared by editor and export (WYSIWYG)
  lib/text/fallback.ts      stand-in family per PDF font: names → metric clones, else width fit
  lib/scan/                 scan-matched edits: fit.ts (fit a scanned line), compose.ts (build the
                            patch), pixels.ts (raw scan pixels), raster.ts, source.ts (paper/ink model)
public/fonts/               bundled TTFs — Inter, Roboto, Tinos (Times-metric, Apache-2.0), Noto Serif,
                            Noto Sans Bengali/Devanagari, and metric clones Arimo (Arial/Helvetica),
                            Carlito (Calibri), Cousine (Courier), Gelasio (Georgia) — OFL; the clones are
                            built by scripts/build-fallback-fonts.py (unhinted Latin subsets)
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
- Edited printed lines: `TextElement.source: SourceLine` (captured glyphs, styled runs, box, space width,
  justified flag, background, glyph tables of its fonts). `text` is compared with `source.text` word by
  word (`lib/text/line-layout.ts`): unchanged words in place → nothing drawn or covered; shifted words →
  patch + same glyphs redrawn; new words → patch + laid out in the style of the run they replace.
  `override` = user restyled the line in the panel (every word then uses the element fields). Legacy
  `cover` elements (old autosaves, scan fallback) still render the old way.
- `ImageElement { x, y, width, height, rotation, assetId }`. Image bytes live in `session.assets`, not in
  undo history.
- Editing a printed line is an **edit session** (`beginEditSession`/`endEditSession` in actions.ts): undo is
  paused; leaving with the line exactly as printed drops the draft (no element, no undo step); otherwise the
  session is one undo step.
- Undo: each discrete action is its own step; repeated `updateElement` calls on the *same element and
  same fields* within 1s merge (typing, colour drags, nudges). Drag/transform ends pass `{ merge: false }`.

## Export pipeline (worker)

0. No edits, same pages in the same order → the **original bytes** are downloaded (perfect fidelity,
   protection included) unless the user chose to remove protection (`isUnchanged` in export-client).
1. Load the source with pdf-lib and **edit it in place** (`password` when encrypted; owner-only files use
   `''`; `updateMetadata: false`, `preserveXFA: true`). Never copy pages into a new document — that drops
   forms, outlines, named dests, page labels, tags, XMP, attachments, viewer prefs.
2. Pages that get drawn on receive a private copy of their Resources (`privateResources`); `/Rotate` set.
3. Per element: `q`, `cm` = (page space → PDF space) · (element frame), draw, `Q`.
   Covers are drawn first, then elements in insertion order.
4. Text is shaped with fontkit (`font.layout`) and drawn **glyph by glyph** with `Tm` so GPOS offsets
   (Indic marks) survive; glyphs are registered in pdf-lib's subset embedder (internal API, see
   `encodeGlyph`). Italic on a face without italics = synthetic oblique (shear 0.2), like browsers.
   Edited printed lines (`drawSourceLine`): same layout as the editor; original glyphs reuse the font
   dictionary (incl. non-embedded and Type3, for moved glyphs) with the same codes, stand-ins are embedded.
5. `rebuildPageTree` (one flat /Pages in output order, inheritable attributes pushed to leaves),
   `pruneDeletedPages` (outline items, named dests, links, tags + ParentTree, form fields, OpenAction;
   page labels rewritten per surviving page), `flush()`, `collectGarbage`, then optional
   `applySourceEncryption` (keep protection) — all in `lib/export/doc-structure.ts` / `keep-encryption.ts`.
6. `save({ useObjectStreams: true, updateFieldAppearances: false })`. `npm run test:fidelity` checks it all
   (pikepdf/pypdf/PDFium/Ghostscript), including both passwords and the permissions.

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
- Text detection heuristics (`text-blocks.ts`), tuned on real files: font size is the vertical scale,
  except Type3 fonts (Figma/Canva — use horizontal) and OCR glyph-box fonts (ascent 1/descent 0 —
  divide by 0.7). Skew up to ~2° counts as horizontal. TeX font names map to Noto Serif. Existing text
  is editable from the Select tool (hit areas are invisible until hovered).
- **Original fonts.** Edited lines default to the PDF's own font (`TextElement.original` +
  `useOriginal`). `lib/pdf/font-scan.ts` reads pdf.js operator lists to learn which glyphs each font has
  actually drawn (char code, Unicode, width, pdf.js fontChar); only those are trusted, since embedded
  fonts are subsets. Editor draws glyph-by-glyph with the pdf.js FontFace (`loadedName`); export reuses
  the font dictionary (matched by /BaseFont, composite only if Identity-H) with the same codes via `TJ`.
  Missing glyph → automatic fallback to the bundled `font` (panel explains). Type3, OCR glyph-less and
  non-0.001 font-matrix fonts are never reused. Spaces a font lacks (TeX) become TJ gaps.
- **Editing printed text is WYSIWYG.** The inline textarea is an invisible input proxy (transparent text,
  caret and selection; pointer-events none); the canvas draws the line and our own caret from
  `LineLayout.carets`. Pressing on the line while editing calls `preventDefault` on mousedown/touchstart
  (keeps focus) and moves the caret. Never show the textarea's text for printed lines — that is the font
  swap users hated. Clicks place the caret at the click point; nothing is selected.
- React StrictMode re-runs effects: the inline editor counts mounts per element and ends a session only if
  it is still unmounted on the next tick.
- Glyph capture mirrors pdf.js' canvas maths exactly (showText): origin = CTM·Tm·(x + adv·Th, y + rise),
  `setTextMatrix` resets only x (pdf.js 6). Use it, not text items, for vector lines: pdf.js text items
  insert fake spaces at gaps ≥ 0.102 em (letter-spacing → "Q U A R T E R L Y", Word's Bengali clusters).
  Spaces are inferred only for gaps beyond the line's own median letter gap; never before combining marks.
- Non-embedded fonts (all standard-14 text) have **no pdf.js FontFace** (`missingFile`): draw them with the
  metric clone in the editor; the export keeps using their dictionary. Word draws spaces with a separate
  simple font, so its Type0 fonts never "have" a space: new spaces use the line's measured word gap.
- Variable fonts instanced with fontTools keep the default names — the build script renames styles.
- **Edited-line layout rules** (`line-layout.ts`, all verified by `test:edit-stability` — don't regress):
  - Only changed characters are new: common prefix/suffix of a replaced stretch stay printed glyphs.
  - New text inherits the replaced text's spacing density ((printed − natural width) per char): Word's
    TJ kerning and letter spacing, Chrome's per-glyph positions, justification. Same letters → same width.
  - New text takes the style of the printed text it replaces, not the neighbour's.
  - Shifts < 0.02 pt are float noise (glyph stays); justified spreading ignores deltas < 0.05 pt.
  - Patches cover individual glyphs, vertically limited by the neighbouring lines' ink (descenders
    ~0.23 em, ascenders ~0.76 em; `coverTop/coverBottom`) — font boxes overlap in tight paragraphs.
    Pieces of the same row are not neighbours.
- pdf.js `isSpace` means char code 32, not a space: Type3 fonts may put "o" there. Whitespace is decided
  by Unicode (Tw still applies to code 32). Glyphs mapped to control characters are not text.
- Text opacity (ExtGState `ca`, Canva greys) is captured and flattened into the colour against the sampled
  background when an edit starts. Type3 fonts often lack /BaseFont: the export finds them by a
  (code, width) signature against /Widths.
- PDFium truncates fractional glyph widths (pdfTeX, pdf-lib): redrawn glyphs, placed at exact positions,
  drift ≤ ~0.01 pt/glyph from PDFium's own placement of the originals. The harness accepts that smooth
  drift and still fails jumps.
- **Scan-matched edits** (`TextElement.scan`, `lib/scan/`): editing an invisible OCR line over a page
  image draws the new text *into* the scan. Hard-won rules — don't regress them:
  - Analyse the scan's **own pixels** (`pixels.ts`: decoded image object + its CTM), never a pdf.js
    render of the page — that resamples and the fit learns blur that isn't there. Regions are snapped to
    the image pixel grid so the exported patch lines up 1:1.
  - Fit = font/size/baseline from the OCR text, per-word x offsets (cumulative: justified lines), then
    quarter-pixel x/y alignment per word, per-word bold by *relative* ink mass.
  - Appearance: tone is a **histogram-matched** response curve (per-pixel fits average cores with paper →
    grey haze); blur and stroke weight are chosen by edge steepness + ink mass (pixel error always prefers
    soft edges). Score and measure only inside the line's band (`lineBand`) — neighbours intrude.
  - Patch = transparent except erased old words (synthesized paper with real grain) and new strokes.
    Only changed words are repainted; following words move with their own scanned ink. Never stored:
    rebuilt from the page + `ScanMatch` + current text, so undo/autosave stay consistent.
  - Gate: correlation < 0.8, busy paper or faint ink → plain patch (`editVectorBlock`) with a toast.
  - Export: patch PNG + invisible text (render mode 3) + a Keywords note that scanned text was altered.
- **pdf-lib in-place export traps:** `removePage()` deletes the page object (rebuild the page tree
  instead); `normalize()` assigns *inherited* Resources by reference (copy before adding fonts);
  `save()` writes unreachable objects (garbage-collect, or deleted pages and replaced streams stay in the
  file); `updateFieldAppearances` defaults to true and would redraw every field in Helvetica; the
  decrypting parse loses the trailer's /Info pointer (restored from an undecrypted probe).
- **Keeping encryption:** pdf-lib can only create new encryption. We reuse the source's /Encrypt dict, /ID
  and file key (pdf-lib's `CipherTransformFactory`, reached via the `@cantoo/pdf-lib/crypto` Vite alias,
  plus a PDFSecurity whose key/version are replaced). The writer encrypts stream data only and keeps the
  catalog, page dicts and stream dicts out of object streams, so their strings are encrypted by us.
- Glyph capture uses `getOperatorList({ annotationMode: DISABLE })`: annotation appearances (form values,
  stamps) are not page text.
- **Edited text is removed, not covered** (`lib/content/remove-text.ts`, export worker only): the page
  content is tokenized with byte spans; text state + CTM are tracked (Form XObjects too) to find each
  printed glyph the layout no longer keeps (matched by char code + page-space origin within 0.6 pt);
  those glyphs become TJ adjustments of their advance, n = −(w0·1000 + (Tc+Tw')·1000/Tfs), so nothing
  else moves; /ActualText//Alt//E around them is dropped; a form that needs edits is cloned per page.
  The new text is spliced in right after the text object it replaces (reading order, same tagged span),
  under the inverse of the CTM there — unless a clip there could cut it (then appended). The rewritten
  content is wrapped in q…Q and /Contents stays an array (pdf-lib appends to it later). Scan edits remove
  the old OCR words (Tr 3) under the line; legacy patches remove what's under them.
  Fallback (patch + toast + panel warning that the old text is still in the file): clip text (Tr ≥ 4),
  vertical writing, non-Identity CMaps, fonts without widths, nested forms, glyph not found.
  PDFium truncates fractional widths, so glyphs after a removed word may move ≤ n/1000 em there
  (agreed tolerance; exact in pdf.js/Acrobat/Preview). The editor still shows patches while editing.

## Workflow

- Plan → build in feature order → commit after each feature (end commit messages with the
  `Co-Authored-By` line from the session instructions).
- After UI or export changes: `npm run typecheck && npm run lint`, run `npm run test:e2e`, and look at the
  screenshots in `tests/out/`. For export changes also render the output with PDFium.
