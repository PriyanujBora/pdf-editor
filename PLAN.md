# PLAN — refocus on the pain points

Phase 0 deliverable: audit of the brief's section 3, reproduction of G1–G8, per-phase plan, and two
spikes (content-stream removal for Phase 3, in-place export for Phase 2). No app code was changed.

**Evidence** (local only, gitignored): `tests/out/phase0/`

| What | Where |
|---|---|
| Labelled screenshot strip per line: untouched → clicked → left unchanged → same-length word → after → missing glyph → nudged handle | `<case>-strip.png` |
| Montages | `m-fonts.png`, `m-spacing.png` |
| Raw state per case (block, pdf.js pieces, element after click, selection, …) | `results.json` |
| PDFium metrics | `metrics.json` |
| Exports | `<case>-noop.pdf`, `-replace.pdf`, `-missing.pdf` |
| Removal-spike outputs | `spike/` |
| No-edit exports for the fidelity check | `noedit/` |
| The throwaway scripts that produced all of the above | `scripts/` |
| Generated repro PDFs (Word "Save as PDF" via COM, Chrome/Skia print-to-PDF incl. a Type3 font, raw-operator PDF, fidelity probe) | `fixtures/` |

The three private PDFs from earlier sessions were used too. Their results are in `tests/out/phase0/private/`. This document
describes them only by producer: pdfTeX/LaTeX, a Type3 (Canva-style) producer, and an OCR'd PDFium scan.

---

## 1. Summary

- **Every claim in section 3 is confirmed in the code and reproduced in the running app.** Three need
  correcting:
  - **G8:** text has *no* middle handles; the corner handles are what change the size.
  - **G5:** superscripts on their own baseline don't inflate the line. Instead they get *hidden* by the cover.
  - **G6:** Courier falls through to Inter, and Caladea is *not* metric-compatible with today's Cambria.
- **Eleven more defects found** (N1–N11, §3). The worst:
  - non-embedded fonts (all standard-14 text) are drawn in the browser's default *serif* in the
    editor, while the export uses the real font;
  - letter-spaced text becomes "Q U A R T E R L Y";
  - Word's fonts never "have" a space, so every space gets 1/3 em;
  - a click selects the whole line, so the first keystroke replaces it.
- **Measured damage before any fix** (§4):
  - clicking a line and leaving without typing changes **10–42 % of that line's pixels** in the export;
  - a same-length one-word change moves the *other* words **up to 40 pt before the edit and 86 pt after
    it**;
  - glyphs render **up to 25 % taller** from the fallback font alone, and 36 % taller when a bullet inflates the size.
- **Fidelity (B, C) confirmed**: a no-edit round trip of a probe file drops XMP, tags, outlines,
  named dests, attachments, page labels, viewer prefs, the AcroForm, and Author/Subject/Keywords.
  Encrypted input comes back unencrypted.
- **The Phase 3 approach works.** A ~390-line span-preserving content-stream rewriter removed 23
  target lines/words from six producer styles. The removed text vanished from pdftotext, PDFium and
  pypdf. (One LaTeX word appears twice on its page, so that case can only show the targeted copy
  gone.) The rest of the page rendered **pixel-identical** in 21 of 23 cases. The 2 exceptions shift
  by 0.02–0.05 pt because PDFium truncates fractional glyph widths (§6.4).
- **Two traps found, which the plan must handle:**
  - pdf-lib writes unreachable objects, so the *old* content stream survives in the file after a "removal";
    a garbage-collection pass is mandatory.
  - pdf-lib's `removePage()` deletes the page object, so it can't be used to reorder pages.
- **Decisions I need from you** are collected in §10: fonts and their sizes, the Phase 3 pixel tolerance,
  how to keep the owner password, touch selection scope, and Word fixtures in the private corpus.

---

## 2. Audit of section 3

### Bugs G1–G8

| # | Verdict | Root cause in the code | Reproduced |
|---|---|---|---|
| G1 | **Confirmed**, and worse | `PageOverlay.tsx:282` hides the TextNode while editing. `InlineTextEditor.tsx:92-94` draws the text in the textarea with the *bundled* font and the sampled colour, sized by `measureText(el)` (bundled, `:28`). Also `:38`: on entry the textarea **selects the whole line**, so the first keystroke replaces everything (N8). | Every case: Calibri→Roboto, Cambria/Georgia→Noto Serif, Courier New→Inter, LaTeX CM→Noto Serif, Type3→Inter, Bengali→broken clusters (`m-fonts.png`, column 2) |
| G2 | **Confirmed** | `actions.ts:124-161` builds element + cover on the click itself. `InlineTextEditor.tsx:63` only deletes when the text is empty *and* there's no cover. The no-op is also an undo step and is autosaved, and the line's hit area is then hidden (`PageOverlay.tsx:100-107`), so the original can't be re-selected. | 29/29 lines keep an element after click + Esc. The export changes 10–42 % of the line's pixels (§4) |
| G3 | **Confirmed**, and worse | `original-font.ts:81` `usesOriginal()` is all-or-nothing. *Also* `text-blocks.ts:238` drops `original` at detection time if the line's own text needs glyphs from two fonts, so every mixed bold/regular line uses the bundled font from the first click. | Typing "yearly" (y not in subset): Courier New→Inter **15 % narrower, glyphs 25 % taller**; Cambria→Noto Serif 11 % wider, 15 % taller; Verdana→Roboto 14 % narrower |
| G4 | **Confirmed** | `text-blocks.ts:220` maps family/bold/italic from the **first** piece; `:224` picks `original` from the dominant font. Colour is a single sample of the darkest pixels (`actions.ts:152`, `sample.ts`), so a blue link and a red word turn the majority colour. | Word "**Name:** John Smith, email <link>" → all bold Roboto, black, link colour and underline gone. "Status: **OVERDUE**" → OVERDUE loses bold and red (`word-mixed-strip.png`, `word-status-strip.png`) |
| G5 | **Confirmed for bullets; corrected for superscripts** | `text-blocks.ts:208` uses `Math.max` of piece sizes (OCR lines use the median). Superscripts sit > 0.25·size off the baseline, so `:164` puts them in their *own* row: they don't inflate the line, but the line's cover **hides them**, so the footnote marker vanishes (N5). Bullets on the same baseline do join the line. | Chrome: 15 pt Wingdings bullet + 11 pt text → whole line **11 → 15 pt**, and the bullet becomes the letter "l" (pdf.js's Unicode for Wingdings). Word: Symbol bullet joins, its tab gap collapses to one space, and the text jumps left (`chrome-bullet-strip.png`) |
| G6 | **Confirmed** (one omission) | `text-blocks.ts:87` defaults to Inter. `:94-99`: Arial/Helvetica/Calibri/Segoe/Verdana → Roboto. `:103-109`: Georgia/Cambria/… → Noto Serif. **Courier/Courier New matches nothing → Inter** (monospace → proportional). Measured against the Windows originals (§8): Calibri→Roboto sentences **+8–10 % wide, x-height +14 %**; Courier→Inter −14–18 %; Verdana→Roboto −11–15 %. | Visible in every fallback screenshot |
| G7 | **Confirmed**, with two extra causes | No Tc/Tw/Tz/TJ capture anywhere in `src/`. The detected box *is* right, because pdf.js item widths include them; it's the re-layout that drops them. Extra causes: (a) N1, fake spaces in letter-spaced text; (b) N3, Word's Type0 fonts have no space glyph, so `font-scan.ts:139` gives every space 333/1000 em (Calibri's real space is 226). | Tw line −17 % width, Tz line +39 %. Words *before* the edit drift even with the original font reused: up to 15 pt on plain lines (Word's Courier New: space 333 instead of 600) and 36–40 pt on Tw/Tz lines (§4) |
| G8 | **Corrected** | Text boxes have only **corner** anchors (`PageOverlay.tsx:304-317`, `keepRatio`), not middle ones. `:194` scales `size` by `scaleY` for any corner drag. Touch anchors are 18 px with a 26 px hit stroke, so accidental drags are easy. | A 3×4 px corner nudge: 11.04 → 11.1 pt (`word-mixed-strip.png`, last row) |

### Gaps A–F

| # | Verdict | Evidence |
|---|---|---|
| A | **Confirmed** | `CLAUDE.md` gotcha + `PropertiesPanel.tsx:258`. The warning is only in the side panel, which on phones/tablets is a closed drawer. |
| B | **Confirmed** on a probe file and on real files | `export.worker.ts:60` `PDFDocument.create()`, `:71` `copyPages`; only Title is copied (`:64`). No-edit round trip of the probe (Word PDF + bookmarks, named dest, attachment, page labels, viewer prefs, form field), feature by feature: XMP ✗, StructTreeRoot/MarkInfo/Lang ✗, Outlines 3→0, Names/Dests ✗, attachments 1→0, PageLabels ✗, ViewerPreferences/PageMode ✗, AcroForm 1→0, Info Author/Subject/Keywords ✗. **Kept but broken**: the link to the named dest (its target is gone), the form widget (no field), and `/StructParents` (no ParentTree). The private LaTeX file loses 7 bookmarks and its named dests; the private Type3 file loses tags, XMP and ViewerPreferences. |
| C | **Confirmed** | `encrypted.pdf` (AES-256) → export is unencrypted; nothing tells the user. |
| D | **Confirmed** | `text-layout.ts:1-6`: auto-width, `\n` only. |
| E | **Confirmed** | None of forms, signatures, annotations, merge/split exists. |
| F | **Confirmed** | `tests/make-fixtures.mjs` covers text-heavy, multi-page, scanned (±OCR), encrypted, corrupt only. |

---

## 3. Defects found beyond section 3

| # | Defect | Cause | Effect |
|---|---|---|---|
| N1 | **Letter-spaced text gets fake spaces** | pdf.js `getTextContent` inserts a space at gaps ≥ 0.102 em (`TRACKING_SPACE_FACTOR`, pdf.worker.mjs:35631). Tc 1.5 at 12 pt triggers it. | "QUARTERLY SUMMARY" becomes `"Q U A R T E R L Y S U M M A R Y"`; the real word gap is indistinguishable, find/replace of "SUMMARY" fails, the export contains real spaces between letters |
| N2 | **Non-embedded fonts draw in the default serif in the editor** | `font-scan.ts:144` maps BaseFont → the pdf.js `loadedName`, but pdf.js registers no FontFace for non-embedded fonts (`missingFile: true`; it uses a system CSS stack). `TextNode.tsx:63` asks for `12px "g_d0_f1"`, so the canvas falls back to Times. | Editor shows Times, export shows Helvetica: a WYSIWYG break on **all standard-14 text**, including `text-heavy.pdf` (the e2e checks state, not pixels) |
| N3 | **Word fonts have no space glyph** | Word draws spaces with a paired simple TrueType font; the Type0 letter font never draws a space, so `spaceGap` stays 333 | +1.2 pt per space at 11 pt Calibri: words drift even with the original font |
| N4 | **Symbol-font bullets turn into letters** | Wingdings "l" (●) has Unicode "l" in pdf.js; re-drawing it with the line's text font prints "l" | ● → l |
| N5 | **Superscripts / neighbours under the cover disappear** | They're separate blocks, but inside the edited line's cover rectangle | Footnote markers vanish; Word's link **underline** (a vector path) also vanishes |
| N6 | **Tw-justified lines split into one block per word** | Column-split rule `gap > 1.2·size` (`text-blocks.ts:181`) ignores word spacing | A justified paragraph line in a narrow column can't be edited as a line |
| N7 | **Bengali (Word) gets spaces inside words** | Same pdf.js gap heuristic between positioned clusters | Broken shaping in the editor ("ব াংলা") |
| N8 | **Click selects the whole line** | `InlineTextEditor.tsx:38` `ta.select()` | First keystroke replaces the line; the caret is never where you clicked |
| N9 | **Link annotations don't follow edits** | Only the text changes | The clickable area no longer matches the text |
| N10 | **No-op click creates an undo step and an autosave** | `addElement` on click | Undo history fills with nothing-edits |
| N11 | **Removal would leave old text in the file** | pdf-lib saves unreachable objects (§6.5) | A naïve content-stream rewrite "removes" text that `qpdf --show-object` still finds |

---

## 4. Reproduction numbers (before any fix)

### How these were measured

**Driver.** `scripts/repro.mjs` drives the dev app at 1440 px, using the app's own detection (`getTextBlocks`, same module
instance). For each line it performs, in order:

1. Screenshot the line untouched.
2. Click it (Select tool) and screenshot again.
3. Press Esc and screenshot.
4. Export.
5. Replace one word with a same-length word made of glyphs the subset has, then export.
6. Type a glyph the subset lacks, then export.
7. On one line, nudge a corner handle.

**Metrics.** `scripts/analyze.py` compares exports with PDFium, using glyph origins (`FPDFText_GetCharOrigin`)
filtered to the line's baseline.

### Results

Producers: real Word 2019 "Save as PDF" output and Chrome/Skia print-to-PDF. "ops" lines are
raw operators.

| Line | No-op: line pixels changed | Unchanged glyphs, max drift before / after the edited word (pt) | Line width × | Glyph height × |
|---|---|---|---|---|
| Word, bold label + link | 42 % | 2.3 / 24.5 | 1.11 | 1.13 |
| Word, red bold word | 36 % | 12.3 / 21.8 | 1.09 | 1.13 |
| Word, Symbol bullet | 25 % | 8.7 / 30.9 | 1.13 | 1.17 |
| Word, justified line | 28 % | 4.8 / 21.3 | 1.05 | 1.00 |
| Word, Calibri (original font reused) | 27 % | 5.8 / 9.7 | 1.04 | 1.00 |
| Word, Courier New (original reused) | 17 % | 13.9 / 19.5 | 0.94 | 1.00 |
| Chrome, Wingdings bullet | 27 % | 26.9 / 85.7 | **1.33** | **1.36** |
| Chrome, red bold word | 32 % | 7.4 / 8.7 | 0.97 | 1.01 |
| ops, Tw 6 | 26 % | 36.0 / 38.0 | **0.83** | 1.00 |
| ops, Tz 75 | 38 % | 40.2 / 52.9 | **1.39** | 1.00 |
| ops, TeX-style TJ gaps | 18 % | 0.5 / 0.6 | 1.00 | 1.00 |
| text-heavy, Roboto subset | 25 % | 2.4 / 7.1 | 1.03 | 1.00 |

Missing-glyph runs (G3, whole line falls back): Courier New 0.85× width / 1.25× height, Cambria
1.11× / 1.15×, Georgia 1.07× / 1.10×, Verdana 0.86× / 0.96×.

**Five worst lines** (the "before" set for Phase 1's done criteria):

1. Chrome Wingdings bullet (11→15 pt, ● → "l")
2. Word bold-label + link line (all bold, wrong family, colour and underline lost)
3. Tz 75 line (+39 % width, serif in the editor)
4. Courier New + missing glyph (monospace → Inter)
5. Letter-spaced heading (fake spaces, lost word gap)

---

## 5. The plan, phase by phase

Every phase:

- Fixtures and failing checks first, then implementation, then verification, then one commit per feature.
- At the end: `npm run build` sizes, `typecheck`, `lint`, `test:e2e` and screenshots at 390/820/1440 px in light and dark.
- No new runtime dependency is planned through Phase 6. Fonts are static assets, lazy per style, and need your approval (§8).

### Phase 1 — Edit stability

**Harness first** (`npm run test:edit-stability`)

*Corpus.*

- `tests/corpus/` is gitignored, except a committed `README.md`.
- `tests/make-fixtures.mjs` gains portable producer imitations:
  - Chrome/Skia via Playwright `page.pdf()`. Google Docs exports through the same Skia engine.
  - Canva/Figma-style **Type3**: Chrome given a copy of Tinos marked restricted-embedding, which Skia must emit as Type3 (proven in Phase 0).
  - TeX-style: TJ gaps, no space glyphs.
  - Word-style: Type0 Identity-H, per-glyph TJ kerning, separate WinAnsi space font, MCID spans, per-run `q … W n`.
  - LibreOffice-style: simple TrueType + `/Widths` + TJ.
  - Layouts: justified two-column article, letter-spaced (Tc) heading, mixed bold/regular + coloured link, symbol-font bullet, Ts and separate-baseline superscripts, Bengali/Devanagari.
- Real Word output can't be produced on every machine (needs Word). A Windows-only `npm run corpus:word` writes it to `tests/corpus/`.

*Driver.* `tests/edit-stability.mjs` drives the dev app like the Phase 0 driver, on every editable line of every fixture and corpus file.

*Checks.* Implemented with PDFium/pypdf through `tests/tools/*.py` (see §9):

1. Enter and leave with no change: the editor is pixel-identical and the export contains no element for the line.
2. While editing, the editor matches the pre-click render with the caret masked.
3. Same-length word: unchanged glyph origins stay within 0.25 pt, with the same font, size, weight and colour (PDFium per-char font/size/fill).
4. A glyph missing from the subset: only that char falls back.
5. Cap height and x-height within 2 %.

*Report.* Pass rate per check × producer, plus worst-case crops into `tests/out/stability/`.

**Fixes, in order**

1. **Clicking is free (G2, N8, N10).**
   - A click starts an *edit session* in `store/ui.ts` (`{ pageId, blockId, caret }`) and creates no document element.
   - The caret goes where you clicked: x → glyph index from the captured positions.
   - The first real change commits the element.
   - On leave, if the text and styles equal the source, the element is dropped.
   - The whole session is **one undo step**: snapshot before, then push a single past state on commit.
2. **WYSIWYG typing (G1).**
   - The textarea becomes an input proxy: transparent, ≥ 16 px for iOS, positioned at the caret so IME candidate windows appear in place. `primeKeyboard()` is kept.
   - The TextNode stays visible and draws the runs through the shared layout engine.
   - We draw the caret, the selection and IME composition text from our own glyph positions.
   - While nothing has changed we draw *nothing* over the line, so the pdf.js render shows through and is pixel-identical by construction.
   - Scan-matched edits get the same transparent proxy (scan code otherwise frozen).
   - Update the CLAUDE.md gotcha.
3. **Runs (G4, N4).**
   - A new operator-list capture extends the walk that `font-scan.ts` already does. Per glyph it records page-space origin, advance, font, size, fill colour, Tc/Tw/Tz/Ts and render mode, so vector text needs **no colour sampling**.
   - `text-blocks.ts` builds lines and runs from it, each run with its own font and colour.
   - Line text is derived from glyph gaps, not pdf.js `str`. The space threshold is relative to the font's space and the line's Tc, which fixes N1 and N7. A gap never splits before a combining mark.
   - Typing inherits the style of the run at the caret.
   - Export draws runs.
4. **Per-glyph fallback (G3).**
   - The layout engine encodes each character in the original font if that font has drawn it, *or* if the font is **not embedded** (then any char in its encoding works, with widths from `/Widths` or the standard-14 AFM metrics pdf-lib already bundles).
   - Otherwise the character uses the fallback font, scaled to the original's x-height (font-size-adjust style).
   - An inline note under the line lists the fallback characters.
5. **Correct size (G5, N5).**
   - The character-weighted median size of the main runs.
   - Bullets, symbol glyphs, drop caps and super/subscripts become their own runs with their own size, `baselineShift` and **original x**, so the tab gap stays.
   - The cover only spans changed words and the words that actually moved (before Phase 3 removes covers entirely).
6. **Metric-compatible fallbacks (G6, N2).**
   - Map by name to the fonts in §8.
   - For unknown fonts, a least-squares fit of each bundled family's advances to the advances `font-scan` saw, with Inter only as a last resort.
   - Non-embedded fonts are drawn in the editor with the metric-compatible bundled face (Helvetica→Arimo, Times→Tinos, Courier→Cousine), never with a missing pdf.js face.
7. **Original spacing (G7, N3).**
   - Unchanged words keep their captured glyph positions exactly.
   - Changed words are laid out fresh with the run's Tc/Tw/Tz.
   - Later words move only by the width difference.
   - Justified lines (detected from alignment against the column) spread the difference over word gaps.
   - New spaces use the line's measured word gap.
   - The editor and export use one module, `lib/text/layout.ts`.
8. **No silent resize (G8).** Edited original text gets move-only handles. Size changes come only from the panel, or Shift + corner drag. New text boxes keep corner resize.

**Data model** (`types.ts`, autosave → `version: 2` with a v1 migration that makes one run per element)

```ts
interface TextRun {
  text: string
  font: FontFamilyId          // bundled fallback (metric-compatible)
  original?: string           // BaseFont key into the session's original-font table
  size: number; bold: boolean; italic: boolean; color: string
  baselineShift?: number      // pt, + up (Ts, superscripts)
  charSpacing?: number; wordSpacing?: number; hScale?: number   // Tc, Tw (pt), Tz/100
}
interface SourceLine {        // immutable capture of the line as printed
  text: string; baseline: number; justified?: boolean
  glyphs: { run: number; uni: string; x: number; adv: number }[]
}
interface TextElement extends BaseElement {
  kind: 'text'; runs: TextRun[]; align: TextAlign; lineHeight: number
  source?: SourceLine; cover?: Cover; scan?: ScanMatch
}
```

Glyph tables (`OriginalFont`) move from each element into `store/session.ts` and are sent to the
worker with the export. They can be rebuilt from the PDF, so undo and autosave stay small.

**Files**

- New in `src/lib/text/`: `capture.ts`, `layout.ts`, `fallback.ts`, `runs.ts`
- `lib/pdf/text-blocks.ts`, `lib/pdf/font-scan.ts`, `lib/original-font.ts`, `lib/fonts.ts`, `lib/text-layout.ts`, `lib/measure.ts`
- `features/editor/InlineTextEditor.tsx` (input proxy), `elements/TextNode.tsx` (runs + caret/selection), `PageOverlay.tsx`, `actions.ts`, `PropertiesPanel.tsx` (style at caret/selection; size control)
- `store/ui.ts`, `store/document.ts`, `lib/persist.ts`, `lib/export/export.worker.ts`, `types.ts`
- `public/fonts/` (after approval), `tests/*`, `CLAUDE.md`

**Risks**

- Custom caret, selection and IME on mobile: native selection handles are lost on a transparent textarea. Plan: tap to place the caret, double-tap for a word, Shift/keyboard selection everywhere. Drag handles on touch are a stretch goal (decision 4).
- The capture and pdf.js text items disagree on line grouping. The capture becomes the source of truth, with pdf.js items kept only as a fallback.
- The width fit picks a poor family for an odd font. The fallback note names the face used.
- Scan-matched edits must not regress: run its existing e2e cases.

### Phase 2 — Export fidelity

**Pipeline**

0. **No edits and no page changes → download the original bytes.** That is perfect fidelity, including encryption.
1. Load once (`updateMetadata: false`, `preserveXFA: true`) and decrypt, keeping the original
   `/Encrypt`, `/ID` and file key.
2. Rebuild the page tree as one flat `/Pages` node in output order. Push inheritable `Resources`,
   `MediaBox`, `CropBox` and `Rotate` onto the leaves first, then set `/Rotate`. **Never call `removePage()`**: it
   deletes the page object (§7).
3. Deleted pages: remove every reference before garbage collection, or those references keep the page (and its private content) in
   the file. That covers:
   - outline items, which are dropped (or retargeted to a surviving parent — your call; the brief says drop);
   - named dests, and links/actions targeting the page;
   - struct elements with `/Pg` = deleted page, and their ParentTree entries;
   - fields whose widgets are all on deleted pages;
   - an `/OpenAction` to it.
   `PageLabels` are recomputed so every surviving page keeps its label text.
4. Draw elements. New fonts, images and graphics states go into a **page-private copy** of
   `Resources` (copy-on-write; pdf-lib's `normalize()` shares inherited dicts, §7).
5. **Garbage-collect**: mark from the trailer, delete everything unreachable (deleted pages, replaced streams,
   old incremental revisions). This is a privacy requirement, not tidiness (§6.5).
6. Keep protection (dialog on download, default **yes**): re-encrypt with the *original* Encrypt dictionary,
   ID and key, so the user password, the owner password and the permissions are all unchanged. Encrypt strings inside stream
   dictionaries ourselves: pdf-lib only encrypts stream data, and with object streams every other string is
   already covered (verified with pypdf and qpdf). If a handler can't be preserved: AES-256 with the same user password and
   permissions plus a new owner password, and the dialog says so (decision 3). The password is never stored.
7. `save({ useObjectStreams: true })`. Info and XMP are kept as they are; only ModDate/ModifyDate are updated, together.

**Fixtures**: `form.pdf` (text, multiline, checkbox, radio, dropdown, list, calculated field with JS),
`bookmarks.pdf` (nested outlines, named + explicit dests, internal links, page labels),
`tagged.pdf`, `attachments.pdf`, `encrypted-perms.pdf` (user + owner password, restricted
permissions; RC4-128, AES-128, AES-256).

**`npm run test:fidelity`** runs a feature inventory with pikepdf/pypdf, like `scripts/fidelity.py`, comparing:

- no-edit, through the in-place path forced on, against the original;
- reorder + delete, where the expected inventory accounts for the deleted pages;
- an edited file.

It also checks:

- decryption with **both** passwords and the permission bits;
- PDFium renders of every page;
- pypdf strict and Ghostscript `nullpage` parse;
- no unreachable objects, and no object referencing a deleted page.

**Files**: `lib/export/export.worker.ts`, new `lib/export/{page-tree,prune,gc,encrypt}.ts`,
`lib/export/protocol.ts`, `features/editor/actions.ts` + a small `ProtectDialog.tsx`, `tests/*`.

**Risks**

- Encryption reuse depends on pdf-lib internals (`context.security`, `getEncryptFn`). Pin the version and cover it with tests.
- Struct-tree pruning is fiddly. Fallback: keep the tree, but repoint struct elements of deleted pages to nothing and drop their ParentTree entries.
- Large files are held fully in memory. That's already the case; Phase 8 measures it.

### Phase 3 — Edited text is actually removed

**Engine** (`lib/content/`, worker-only and lazy): `tokenize.ts` (byte-span preserving), `interpret.ts`
(text state, CTM, Form XObjects), `fonts.ts` (code length, widths, ToUnicode, standard-14 AFM),
`remove.ts` (TJ splitting), `rewrite.ts` (splice, copy-on-write streams/forms/resources).
The Phase 0 spike is the prototype (§6).

**Behaviour**

- Edited lines remove *only the changed words'* glyphs. Unchanged words stay as the original content-stream
  glyphs, which is perfect fidelity, and the new words are drawn with the Phase 1 layout.
- When a line can't be removed (§6.3), it keeps the cover and an **inline warning at the line** says the old
  text is still in the file.
- Scan-matched edits remove the changed OCR words from the invisible layer.

**Editor preview**

- After a pause in typing, the worker produces the page with the glyphs removed and pdf.js re-renders it.
- The editor therefore shows exactly what the export will contain.
- Covers are only a momentary placeholder until that re-render arrives.

**Acceptance**

- On every text fixture, pdftotext, pypdf and pdf.js find no trace of the old string, including in unreachable objects, which GC removes.
- Pixel diff outside the edited region is 0 in PDFium, with a ≤ 0.05 pt glyph-shift tolerance for fractional-width fonts (decision 2).

Docs: README, CLAUDE.md ("covered, not erased" becomes the fallback-only rule) and the panel copy.

**Risks**

- Non-Identity CMaps (CJK): fall back, or load pdf.js bcmaps lazily.
- Text used as a clip (Tr 4–7): fall back.
- `/ActualText` spans: rewrite or drop them, or extractors keep the old string.
- Tagged PDFs: insert the new text inside the same marked-content sequence when possible, otherwise mark it `/Artifact`.

### Phase 4 — Real redaction and sanitising

The Phase 3 engine, plus:

- **Image pixels:** re-encode only the affected image XObjects, decoded via pdf.js (as `pixels.ts` already does) and
  re-encoded with OffscreenCanvas. No new dependency; JBIG2/JPX sources become Flate/JPEG.
- **Vector paths** fully inside a mark.
- **Annotations** intersecting a mark, and **widgets and values** of fields intersecting it.
- **OCR-layer glyphs.**

Then an opaque box. Find-all presets: email, phone, PAN, Aadhaar, card numbers with Luhn.

**Sanitise**: Info/XMP, JavaScript (Names/JavaScript, OpenAction, AA), embedded files, OCGs,
comments, and form data by choice.

**Verify**: re-extract the output with pdf.js and scan every object for the strings. Then show
"Verified: 0 matches remain", or block the download and list what couldn't be removed.

**Fixtures**: a Manafort-style "black box over live text" file and an OCR'd scan.

**Risks**: text inside Form XObjects shared across pages must be cloned per page; image re-encode cost on big scans.

**As built** (`npm run test:redaction`):

- Marks are elements (`RedactElement`), so undo, autosave and selection work as for everything else.
- Dragging marks an area; a tap marks the word under it, not the whole line, because words are the
  common target and dragging covers a line.
- Find & redact covers visible and invisible OCR text. Marks over OCR text are padded, since OCR boxes
  only roughly fit the scanned ink.
- Redaction runs as a second pass over the finished page content, after `flush()`, so edits and added text
  under a mark are removed too.
- Marked strings in bookmark titles and tag texts are replaced with █.
- The download is refused (with reasons) for:
  - inline images, stencil masks and images inside forms under a mark;
  - clip text and unreadable fonts;
  - added images or scan-edit patches that overlap a mark;
  - any leak found by the worker's object scan or the pdf.js re-read.
- Not done:
  - paths that only cross a mark are kept (they are covered by the box);
  - hidden-layer content inside form XObjects is not removed (the app says so);
  - OCMD visibility expressions are kept.

### Phase 5 — Paragraph editing with reflow

- Group lines into paragraphs: same column edge or centre/right alignment, consistent leading, same dominant run style, no large gap. Detect justification.
- Line editing stays available ("Edit line" / modifier).
- `TextElement.wrapWidth` and `align: 'justify'`. One shared line breaker in `text-layout.ts`; it must respect Indic clusters.
- Overflow is outlined, with the hint and shrink-to-fit offered; text never silently covers content below.
- Phase 3 removal works per paragraph.
- **Fixtures**: two-column article, justified legal clause, bulleted list, mixed bold/regular paragraph, Bengali paragraph.
- **Risks**: paragraph detection on real files (hanging indents, lists); line-break parity between canvas and export (same font files, same breaker).

**As built** (`npm run test:paragraphs`):

- Paragraph edits reuse the line pipeline: one merged source, the same draws, removal and export.
- Edits that stay within a line keep Phase 1 line-edit quality.
- Reflow keeps unchanged words rigid, which fixed Chrome's reordered Bengali clusters.
- Not done:
  - hard line breaks (Enter ends editing);
  - hyphenation;
  - re-detecting a paragraph that spans a column or page break.

### Phase 6 — The everyday jobs (in order)

1. **Fill forms.** Field geometry and values from pdf.js; writes via pdf-lib's form API with appearance streams in the field's own DA font (embed a font for non-Latin values). Values live in autosave; optional flatten; Tab order. Calculation scripts are kept but not executed; the UI says "recalculated in Acrobat".
2. **Signatures.** Drawn (pointer), typed (script fonts, OFL, lazy — sizes to approve), or uploaded with a simple luminance-threshold background removal. Kept in IndexedDB only. One-tap placement plus an optional date.
3. **Real annotations.** Highlight, underline and strike from a text selection; notes, ink, rectangle, arrow. Editable and deletable, with appearance streams for PDFium and Acrobat.
4. **Pages.** Merge or insert from another PDF, blank page, extract/split, duplicate. `PageItem.source` becomes `{ docId, srcIndex }`. The Phase 2 rules apply to merged files, including two sets of outlines, dests and fields with clashing names.
5. **Flat form → fillable.** Detect underlines and boxes from the captured paths, suggest fields, let the user adjust.
6. **Compress.** Downsample images locally with a size preview.

**As built** (`npm run test:forms`, `npm run test:everyday`):

- Every item ships. Calculation scripts are kept but not run (the form panel says so).
- Inserted PDFs must not be password-protected (the app says so).
- Compress leaves CMYK, indexed, predictor and masked images as they are.
- Duplicated pages share content streams (nothing edits streams in place).

### Phase 7 — Trust you can verify

Offline indicator once the service worker has cached the app, "Built on this device in 1.2 s",
the landing page and `/about` copy. **I will ask you for the business model and licence wording
before writing any of it.**

**As built:**

- Landing trust strip: files never leave the device, free forever, a live offline badge, About & privacy.
- `/about` explains how to verify each claim (CSP, Network tab, offline, source), shows offline
  readiness, has "Forget everything on this device", and lists honest limits and licences.
- Every download toast says "Built on this device in X s". MIT LICENSE added.
- Checked in `test:prod`.

### Phase 8 — Performance budgets

Fixtures: a 500-page text PDF, a 150 MB image scan and a 2,000-page PDF. `npm run test:perf` reports:

- first page visible (target ≤ 1.5 s for 50 MB);
- long tasks over 100 ms while scrolling, and frame rate;
- peak memory (≤ 1 GB on the 150 MB file);
- streamed export progress.

A regression over 20 % fails. Android numbers are recorded manually.

**As built** (`npm run fixtures:perf`, then `npm run test:perf` against the production build under
`wrangler dev`; `PERF_URL` picks the server, `--update` rewrites `tests/perf-baseline.json`):

| File | First page | Scroll fps | Long tasks > 100 ms (max) | Peak MB (browser idle) | Export (progress steps) |
|---|---|---|---|---|---|
| 50 MB scan | 0.89 s | 56 | 0 | 1,130 (350) | – |
| 150 MB scan | 0.95 s | 48 | 0 | 1,174 (350) → **+824 MB** | – |
| 500-page text | 0.93 s | 58 | 0 | 1,051 (365) | 1.2 s (64) |
| 2,000-page text | 0.89 s | 34 | 7 (362 ms) | 1,519 (360) | – |

Desktop Chromium, Windows 11. Timing and memory are measured in separate runs, because the memory
sampler slows the page down. Peak memory is reported for the whole browser, so the budget is checked
against its rise over idle.

What changed:

- **Opening**
  - One shared pdf.js worker.
  - The landing page prefetches the editor and pdf.js when idle.
  - The first 16 page sizes are read before showing the page, the rest in the background (exports wait for `pageInfoReady`).
  - Bookmarks and form info load later.
  - The autosave copy is written 1.5 s after opening; every other autosave write queues behind it.
- **Memory**
  - Files over 32 MB aren't held as bytes. pdf.js takes the buffer, and the app keeps the picked file (a Blob), re-reading it to export.
  - `page.cleanup()` after each render, and `pdf.cleanup()` once the viewer is idle.
  - Thumbnails render one at a time, after the first page.
- **Scrolling**
  - Pooled IntersectionObservers.
  - Pages flying past don't start a render, and their Konva overlay mounts only after 150 ms on screen.
  - The current page is found by binary search.
  - Each thumbnail subscribes to "am I current" itself, so the list doesn't re-render on scroll.
  - Thumbnails use `content-visibility: auto`.
  - The thumbnail list grows in idle chunks.
- **Export**: progress is streamed per page and while saving (pdf-lib's writer yields between objects).

Imperfect: 2,000-page files still scroll at about 34 fps, with a few layout-bound long tasks (every page
is a DOM box). Android numbers are to be recorded by hand.

---

## 6. Spike: removing text from the content stream (Phase 3)

`tests/out/phase0/scripts/spike-remove.mjs` (~390 lines) on top of @cantoo/pdf-lib:

1. Concatenate the page's content streams.
2. Tokenize into operations, keeping the **byte span** of each.
3. Interpret the text state and CTM.
4. Find the target glyphs.
5. Rewrite only the operators that draw them.
6. Splice them back into the untouched bytes.

`verify-spike.py` checks pdftotext, PDFium and pypdf, and diffs PDFium renders at 216 dpi.

### 6.1 Results

| Target | Producer technique | Glyphs / ops rewritten | Old text found after (3 extractors) | Pixels changed outside the line |
|---|---|---|---|---|
| Georgia line | Word: Type0 Identity-H, kerned TJ, MCID spans, separate space font | 50 / 2 | none | **0** |
| Calibri line | Word | 49 / 2 | none | **0** |
| Bold label + link line | Word, 3 fonts | 47 / 5 | none | **0** |
| Letter-spaced heading | Word, `Tc 3` | 17 / 1 | none | **0** |
| Justified line | Word | 98 / 1 | none | **0** |
| Bengali line | Word, Nirmala UI shaped glyphs | 37 / 10 | none (Xpdf can't read Bengali even before) | **0** |
| Georgia line | Chrome/Skia: one `Td`+`Tj` per glyph | 49 / 47 | none | **0** |
| Type3 line | Chrome/Skia Type3 | 65 / 65 | none | **0** |
| Tc / Tw / Tz / TJ-gap lines | pdf-lib, non-embedded Helvetica (AFM widths) | 29–42 / 1 each | none | **0** |
| Invoice line | pdf-lib Roboto Type0 | 41 / 1 | none | **0** |
| **One word mid-operator** (justified, kerned, Tc, Tw, Tz, TJ, Chrome) | | 7–18 / 1–11 | none | **0** — later glyphs moved ≤ 0.00006 pt |
| One word mid-operator | pdf-lib Type0, fractional `/W` | 10 / 1 | none | 455 px — later glyphs +0.022 pt |
| One word mid-operator | pdfTeX Type1, fractional `/Widths` | 13 / 1 | (word occurs twice) | 1527 px — later glyphs +0.046 pt |

All outputs pass pypdf strict.

### 6.2 Operators and how to split TJ

**What the interpreter handles**

- Text objects and state: `BT/ET`; `Tf Tc Tw Tz TL Ts Tr`; `Td TD Tm T*`.
- Showing text: `Tj TJ ' "`.
- Graphics state: `q/Q`, `cm`, and `gs` (an ExtGState `/Font` entry can set the font — the spike doesn't handle that yet).
- XObjects: `Do` (Form → recurse with `/Matrix` and its own or inherited `/Resources`; images are skipped).
- Kept verbatim: inline images (`BI … ID … EI`), marked content (`BMC/BDC/EMC/MP/DP`), `BX/EX`, comments and unknown operators.

**Glyph maths** (all in text space)

- Advance: `tx = (w0·Tfs + Tc + Tw·[1-byte code 32]) · Th`.
- `w0`:
  - simple fonts: `/Widths[code−FirstChar]`, else the standard-14 AFM, else `MissingWidth`;
  - Type0: `/W`, else `/DW`;
  - Type3: `/Widths × FontMatrix[0]`.
- Origin: `Trm = [Tfs·Th 0 0 Tfs 0 Ts] × Tm × CTM`.

**Splitting TJ**

- Every removed glyph becomes a TJ number `n = −(w0·1000 + (Tc + Tw')·1000/Tfs)`. TJ numbers skip Tc/Tw, so those are folded in.
- Adjacent numbers are merged and emptied strings dropped. Kept glyph bytes are re-emitted as hex strings.
- `Tj` → `TJ`.
- `'` → `T*` + `TJ`.
- `"` → `aw Tw ac Tc T*` + `TJ`. Tw/Tc persist after `"`, so this keeps the semantics.
- An operator whose glyphs are all removed becomes `[n] TJ`, so the pen still advances for following
  implicit-position operators in the same BT.
- The spike merges the page's streams into one new stream; the real version rewrites only affected streams.

**Matching** must be per glyph: one glyph can carry several characters (Word's Calibri draws
"tt" as one ligature glyph). Indexing glyphs by character offset removed the wrong glyphs in the first
spike run. In the product, targets come from the Phase 1 capture (positions + codes), not text search.

### 6.3 Form XObjects, Type3, and when to fall back

- **Form XObjects**: interpret recursively. To edit, clone the form for *this page* (new stream + new
  resource name), rewrite the clone and point this page's `Do` at it. A form shared by other pages (repeated
  headers, stamps) is never modified in place. Nested forms: the same rule at each level.
- **Type3**: works (row "Type3 line"). Widths come from `/Widths × FontMatrix`. Fall back if FontMatrix is skewed or rotated.
- **Fall back to cover + inline warning for**:
  - `Tfs = 0`;
  - text render modes 4–7 (the text is a clip; removing it changes the clip);
  - vertical writing (`Identity-V`);
  - non-Identity CMaps until bcmap support exists (pdf.js ships them in `public/pdfjs/cmaps`);
  - an ExtGState `/Font` we can't resolve;
  - glyphs inside a pattern or a Type3 glyph procedure.
- **Marked content**:
  - empty `BDC/EMC` pairs stay valid, so MCIDs and the struct tree remain consistent;
  - `/ActualText`, `/Alt` and `/E` on a sequence whose glyphs were removed must be dropped or rewritten, or Acrobat and PDFium extraction still report the old text.

### 6.4 Renderer width rounding

Removing glyphs from the middle of an operator was exact (≤ 0.00006 pt) whenever the font's widths
are integers: Word, Chrome, standard-14. With **fractional** widths (pdf-lib `/W`, pdfTeX `/Widths`
like `277.8`), the following glyphs shifted by a constant **+0.022 pt / +0.046 pt** in PDFium. That is about 1/20 of a
pixel at 100 %.

The cause is that PDFium **truncates** glyph widths to whole units while the spike uses the file's
exact values. For the removed Roboto glyphs (`/W` 562.012, 196.777, …), truncation predicts +0.0214 pt;
PDFium measured +0.0221 pt. Rounding would predict −0.0066 pt.

So in the original file, PDFium positions the following glyphs from truncated widths, while an exact viewer
(pdf.js) uses exact ones. No single replacement number reproduces both, and the literal "pixel diff = 0 in PDFium" can't
be guaranteed for such fonts. Options are in decision 2.

### 6.5 Old text stays in the file unless we collect garbage

After the spike "removed" a line, the page pointed at a new content stream, and the old stream with the
original text was **still in the file as an unreferenced object**. `scripts/orphans.py` found it by
scanning every xref entry. Viewers and extractors don't show it, but `qpdf --show-object` or any
forensic tool does.

pdf-lib serialises every object in its context. Phase 3 needs a mark-and-sweep before every save;
Phase 2 needs it for deleted pages, and Phase 4's verify step scans all objects, not just page content.

---

## 7. Spike: in-place export with @cantoo/pdf-lib 2.11.1 (Phase 2)

| Finding | Where | Consequence |
|---|---|---|
| `removePage(i)` calls `context.delete(page.ref)` | `api/PDFDocument.ts:938-945` | Can't reorder with remove + insert. Rebuild the page tree ourselves. |
| `PDFPageLeaf.normalize()` assigns the *inherited* Resources/Font/XObject dicts to the leaf by reference ("TODO: Clone … if it is inherited") | `core/structures/PDFPageLeaf.ts:204-246` | Adding a font to one page edits every page sharing the dict. Copy-on-write before touching resources. |
| `normalize()` wraps existing content in `q … Q` | same | Good: our appended content starts from a clean graphics *and* text state. |
| `save()` writes every indirect object, reachable or not; the parser reads all objects sequentially | `core/writers/PDFWriter.ts:228-247` | Deleted pages, replaced streams and superseded revisions ship unless we garbage-collect (§6.5). |
| Loading with a password decrypts and drops `/Encrypt`; `encrypt()` always makes a new ID, key and owner entry | `api/PDFDocument.ts:216-245, 320`; `core/security/PDFSecurity.ts:190-480` | Keeping the owner password means reusing the original Encrypt dict + key through the writer's `getEncryptFn` hook (internal API). |
| The writer encrypts **stream data only** | `core/writers/PDFWriter.ts:276-285` | With `useObjectStreams: true` every other dict sits inside an encrypted object stream, so pypdf and qpdf decrypt Info strings correctly. Strings *in stream dictionaries* (e.g. an attachment's `/Params /CheckSum`, `/ModDate`) stay plaintext: encrypt them ourselves. |
| A content-stream parser and text extractor exist (`api/extraction/`) | `ContentStreamParser.ts` | Lossy for rewriting: it skips inline images and maps `true/false/null` to numbers. Useful only as a reference; Phase 3 uses its own span-preserving tokenizer. |

---

## 8. Fallback fonts (G6): measurements and sizes

Advance-width and metric comparison against the Windows 11 originals (`scripts/fontcheck.py`, fontTools):

| Original | Candidate | Identical advances | Sentence width vs original | x-height × |
|---|---|---|---|---|
| Arial / Helvetica | **Arimo** | 100 % | 1.000 | 1.02 |
| Arial Bold | Roboto Bold (today) | 0 % | 0.945–0.975 | 1.02 |
| Calibri | **Carlito** | 100 % | 1.000 | 1.03 |
| Calibri | Roboto (today) | 1 % | **1.078–1.104** | **1.14** |
| Georgia | **Gelasio** | 100 % | 1.000 | 1.00 |
| Georgia | Noto Serif (today) | 2 % | 1.025–1.087 | 1.11 |
| Courier New | **Cousine** | 100 % | 1.000 | 1.25 (Courier New has a tiny x-height) |
| Courier New | Inter (today) | 5 % | **0.820–0.863** | 1.29 |
| Cambria (v6.99) | Caladea | **41 %** | **0.927–0.954** (digits differ: Cambria's are tabular) | 1.00 |
| Cambria | Noto Serif (today) | 2 % | 1.080–1.120 | 1.15 |
| Times New Roman | Tinos (bundled) | 100 % | 1.000 | 1.03 |
| Verdana | Roboto (today) | 0 % | 0.852–0.888 | 0.97 |

No open metric clone of Verdana or Segoe UI exists; the least-squares width fit plus per-glyph
original positions covers them.

**Sizes**: all are SIL OFL 1.1 in google/fonts. Arimo and Gelasio are variable fonts, instanced to static TTFs. Unhinted (PDF embedding doesn't use hinting), subset to Latin
+ Latin Extended-A + punctuation + currency including ₹. Every style is fetched only when a document needs it, and then
cached by the service worker:

| Family | All 4 styles, raw / gzip | Regular alone, raw / gzip |
|---|---|---|
| Arimo | 149 KB / 96 KB | 36 KB / 23 KB |
| Carlito | 387 KB / 177 KB | 90 KB / 42 KB |
| Cousine | 113 KB / 75 KB | 27 KB / 18 KB |
| Gelasio | 208 KB / 123 KB | 51 KB / 29 KB |
| Caladea | 169 KB / 88 KB | 42 KB / 22 KB |

Adding Greek + Cyrillic roughly doubles Arimo, Carlito and Cousine. The same unhinted subsetting would
shrink the bundled Tinos files, which are 507–582 KB each today. The landing bundle is unaffected.

---

## 9. Test tooling

- **Local tools.** The PDF checks need Python 3 with pypdf, pypdfium2, pikepdf (bundles qpdf),
  cryptography, fontTools, numpy and pillow. Plan: `tests/tools/requirements.txt` plus a gitignored
  `tests/.venv`. Node scripts call it through `PDF_TOOLS_PY`. This is dev-only; nothing ships.
- **Text extractors.** This machine has `pdftotext` (Xpdf 4.00, bundled with Git for Windows) and Ghostscript 10.08. On Linux and macOS, use
  poppler-utils.
- **Private files.** Private corpus files stay in `tests/corpus/` and private outputs in `tests/out/`; both are gitignored.
- **Baseline bundle** (`npm run build`, Vite gzip figures):

| Chunk | Raw | Gzip | Loading |
|---|---|---|---|
| `index-*.js` | 303 KB | **95.1 KB** | initial |
| CSS | — | 12.7 KB | initial |
| `Editor` | 541 KB | 168 KB | lazy |
| pdf.js | 430 KB | ~127 KB | lazy |
| export worker | 1.34 MB | ~595 KB | lazy, worker |

---

## 10. Decisions I need from you

1. **Fonts.**
   - Bundle Arimo, Carlito, Cousine and Gelasio (sizes in §8, lazy per style)?
   - Caladea doesn't match today's Cambria. Bundle it anyway (good shapes, plus a width fit), or skip it and let the width fit choose?
   - Latin-only subsets, or include Greek + Cyrillic?
2. **Phase 3 pixel criterion.** For fonts with fractional widths, a removal shifts the following glyphs
   ≤ 0.05 pt in PDFium. Options:
   - (a) **accept ≤ 0.05 pt as the tolerance** (recommended; invisible);
   - (b) truncate removed widths like PDFium does, which makes Chrome exact but pdf.js/Firefox off by the same amount;
   - (c) re-anchor the following glyphs with an absolute `Tm`, which has the same trade-off as (a).
3. **Encryption.** Preserve the original Encrypt dict and key, so the owner password still works?
   This relies on pdf-lib internals (recommended, with tests). The fallback is the same user password and permissions with a
   new random owner password, and the dialog says so.
4. **Touch selection in Phase 1.** Ship tap-to-place caret + double-tap word + keyboard selection first,
   with drag handles on touch as a follow-up? Or require handles in Phase 1?
5. **Word fixtures.** Real Word output needs Word, so it would live in the gitignored corpus, with portable
   imitations in `make-fixtures.mjs`. OK?
6. **Deleted pages in outlines.** Drop those entries (as the brief says), or retarget them to the
   nearest surviving page?
