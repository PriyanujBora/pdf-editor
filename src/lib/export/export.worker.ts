/// <reference lib="webworker" />
// @pdf-lib/fontkit's Indic shaper relies on a global regeneratorRuntime.
import 'regenerator-runtime/runtime'
import {
  beginText,
  concatTransformationMatrix,
  degrees,
  endText,
  PDFDocument,
  PDFHexString,
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFNumber,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  PDFRef,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  TextRenderingMode,
  showText,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from '@cantoo/pdf-lib'
import { FONT_FAMILIES, fontFileUrl, fontRuns, OBLIQUE_SHEAR } from '@/lib/fonts'
import { encodeLine, usesOriginal, type OriginalFont } from '@/lib/original-font'
import { alignOffset, baselineOffset, splitLines } from '@/lib/text-layout'
import { coversFor, layoutLine, type LineLayout, type Measure } from '@/lib/text/line-layout'
import { glyphBaseline } from '@/lib/text/para-layout'
import type { Cover, FontFamilyId, ImageElement, RedactElement, TextElement } from '@/types'
import { collectGarbage, privateResources, pruneDeletedPages, rebuildPageTree, removeAnnotations } from './doc-structure'
import { annotationsUnder, redactPage, type Box, type ImageSwap } from '@/lib/content/redact'
import { sanitize } from './sanitize'
import { fillForm } from './fill-form'
import { findLeaks, scrubStrings } from './verify-scan'
import { compatFontkit } from './fontkit-compat'
import { applySourceEncryption, readEncryption } from './keep-encryption'
import { elementFrame, invert, mul, pdfToPage, type Mat } from './matrix'
import type { ExportRequest, ExportResponse, RedactionReport, RemovalNote } from './protocol'
import { clipAllows, planRemoval, type Anchor, type GlyphTarget, type RegionTarget } from '@/lib/content/remove-text'

declare const self: DedicatedWorkerGlobalScope

self.onmessage = async (e: MessageEvent<ExportRequest>) => {
  try {
    const notes: RemovalNote[] = []
    const out: { redaction?: RedactionReport; formNotes?: string[] } = {}
    const bytes = await buildPdf(e.data, notes, out)
    self.postMessage({ type: 'done', bytes, notes, redaction: out.redaction, formNotes: out.formNotes } satisfies ExportResponse, [bytes.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies ExportResponse)
  }
}

const progress = (value: number) => self.postMessage({ type: 'progress', value } satisfies ExportResponse)

async function buildPdf(req: ExportRequest, notes: RemovalNote[], out: { redaction?: RedactionReport; formNotes?: string[] }): Promise<Uint8Array> {
  // Edit the source document itself (not copies of its pages in a new one) so forms, outlines,
  // named destinations, page labels, tags, metadata and attachments survive.
  const enc = req.keepEncryption ? await readEncryption(req.bytes, req.password) : null
  if (enc && !enc.supported) throw new Error('This file uses a kind of password protection that can’t be kept. Choose “Remove protection” to download it.')
  const doc = await PDFDocument.load(req.bytes, {
    password: req.password,
    ignoreEncryption: false,
    updateMetadata: false,
    preserveXFA: true,
  }).catch(async (err) => {
    // Unencrypted files: pdf-lib refuses a password argument it doesn't need on some files.
    if (/encrypt/i.test(String(err))) throw err
    return PDFDocument.load(req.bytes, { updateMetadata: false, preserveXFA: true })
  })
  doc.registerFontkit(compatFontkit)
  // pdf-lib's decrypting parse loses the trailer's /Info pointer (xref-stream trailers): restore it.
  if (!doc.context.trailerInfo.Info) {
    const probe = enc?.probe ?? (await PDFDocument.load(req.bytes, { ignoreEncryption: true, updateMetadata: false }))
    const info = probe.context.trailerInfo.Info
    if (info instanceof PDFRef && doc.context.lookup(info) instanceof PDFDict) doc.context.trailerInfo.Info = info
  }
  // Scan-matched edits are hard to spot by eye; say so in the metadata.
  const scanNote = () => {
    if (!req.elements.some((el) => el.kind === 'text' && el.scan)) return
    const prev = doc.getKeywords()
    const note = 'Edited with Free PDF Editor: text on scanned pages was altered'
    if (!prev?.includes(note)) doc.setKeywords([...(prev ? [prev] : []), note])
  }
  scanNote()

  const pages = doc.getPages()
  const order = req.pages.map((p) => p.srcIndex)
  progress(0.15)

  const fonts = new FontCache(doc, req.baseUrl)
  const originals = new OriginalFonts(doc)
  const images = new Map<string, PDFImage>()

  for (let i = 0; i < req.pages.length; i++) {
    const item = req.pages[i]
    const info = req.sourcePages[item.srcIndex]
    const page = pages[item.srcIndex]
    const els = req.elements.filter((el) => el.pageId === item.id)
    if ((info.rotate + item.rotation) % 360 !== ((page.getRotation().angle % 360) + 360) % 360)
      page.setRotation(degrees((info.rotate + item.rotation) % 360))
    if (!els.length) continue
    // Never add to a Resources dictionary other pages share.
    privateResources(doc, page)

    // page space → PDF user space
    const pageMat = pdfToPage(info.view, info.rotate)
    const toPdf = invert(pageMat)

    // Remove the old text from the content stream before drawing anything (Phase 3): glyphs edited
    // lines no longer keep in place, the old OCR words under scan edits, older saves' patch areas.
    const lines = new Map<string, Awaited<ReturnType<typeof layoutSourceLine>>>()
    const glyphTargets: GlyphTarget[] = []
    const owners: { el: string; gi: number }[] = []
    const regions: RegionTarget[] = []
    const regionOwners: string[] = []
    for (const el of els) {
      if (el.kind !== 'text') continue
      if (el.source) {
        const prep = await layoutSourceLine(el, fonts)
        lines.set(el.id, prep)
        for (const gi of prep.L.gone) {
          const g = el.source.glyphs[gi]
          glyphTargets.push({ x: g.x, y: glyphBaseline(el.source, gi) - el.source.runs[g.run].rise, code: g.code })
          owners.push({ el: el.id, gi })
        }
      } else if (el.scan) {
        const b = el.scan.lineBox
        regions.push({ rect: { x: b.x - 1, y: b.y - 1, width: b.width + 2, height: b.height + 2 }, invisibleOnly: true })
        regionOwners.push(el.id)
      } else if (el.cover) {
        regions.push({ rect: el.cover, invisibleOnly: false })
        regionOwners.push(el.id)
      }
    }
    const removed = new Map<string, Set<number>>()
    const painted = new Set<string>()
    if (glyphTargets.length || regions.length) {
      const plan = planRemoval(page, [pageMat.a, pageMat.b, pageMat.c, pageMat.d, pageMat.e, pageMat.f], glyphTargets, regions)
      const r = plan.result
      const failed = new Map<string, string>()
      r.glyphs.forEach((ok, ti) => {
        const { el, gi } = owners[ti]
        if (ok) {
          let s = removed.get(el)
          if (!s) removed.set(el, (s = new Set()))
          s.add(gi)
        } else failed.set(el, r.reasons[0] ?? 'unsupported content')
      })
      r.regions.forEach((ok, ri) => !ok && failed.set(regionOwners[ri], r.reasons[0] ?? 'unsupported content'))
      for (const [elementId, reason] of failed) notes.push({ elementId, reason })
      // New text goes where the old text was in the content (reading order, same tagged span), unless
      // a clip there could cut it; otherwise it is appended at the end of the page as before.
      const inserts: { anchor: Anchor; bytes: Uint8Array }[] = []
      for (const el of els) {
        if (el.kind !== 'text' || !el.source) continue
        const prep = lines.get(el.id)
        if (!prep?.L.changed) continue
        const ti = owners.findIndex((o) => o.el === el.id && r.glyphs[owners.indexOf(o)])
        const anchor = ti >= 0 ? plan.anchorOf(ti) : undefined
        if (!anchor || !clipAllows(anchor.clip, prep.L.bounds)) continue
        const src = removed.get(el.id) ?? new Set<number>()
        inserts.push({ anchor, bytes: record(page, () => paintSourceLine(page, toPdf, el, prep, fonts, originals, src)) })
        painted.add(el.id)
      }
      plan.commit(inserts)
    }

    // Covers first so no replacement text is hidden by another cover.
    // Scan-matched edits are part of the page image: draw them first, with an
    // invisible text layer so the new words stay searchable/selectable.
    for (const el of els) {
      if (el.kind !== 'text' || !el.scan) continue
      const png = req.scanPatches[el.id]
      if (png) {
        const img = await doc.embedPng(png)
        const r = el.scan.region
        withFrame(page, mul(toPdf, elementFrame(r.x, r.y, 0)), () =>
          page.drawImage(img, { x: 0, y: -r.height, width: r.width, height: r.height }),
        )
      }
      await drawText(page, toPdf, el, fonts, true)
    }
    for (const el of els) {
      if (el.kind === 'text' && el.cover) drawCover(page, toPdf, el.cover)
    }
    for (const el of els) {
      if (el.kind === 'text' && el.scan) continue
      if (el.kind === 'text' && el.source) {
        const prep = lines.get(el.id)
        if (prep && !painted.has(el.id)) paintSourceLine(page, toPdf, el, prep, fonts, originals, removed.get(el.id) ?? new Set())
        continue
      }
      if (el.kind === 'text') {
        if (!drawOriginalText(page, toPdf, el, originals)) await drawText(page, toPdf, el, fonts)
      } else if (el.kind === 'image') await drawImage(page, toPdf, el, req, images, doc)
    }
    progress(0.15 + (0.6 * (i + 1)) / req.pages.length)
  }

  // Form values (Phase 6): before redaction, so fields under a mark still leave with their values.
  const filled = await fillForm(doc, req.formValues ?? {}, !!req.flattenForm, (family) => fonts.get(family, false, false))
  out.formNotes = filled.notes

  // Redaction (Phase 4): a second pass over the finished page content — edits and added text
  // included — once pdf-lib has written its fonts (their widths locate the glyphs).
  const marks = req.elements.filter((el): el is RedactElement => el.kind === 'redact')
  const report: RedactionReport = { problems: [], leaks: [], removed: { glyphs: 0, images: 0, paths: 0, annotations: 0 }, sanitized: [], sanitizeNotes: [] }
  const markedPages: PDFPage[] = []
  if (marks.length) {
    await doc.flush()
    const deadAnnots: ReturnType<typeof annotationsUnder> = []
    for (let i = 0; i < req.pages.length; i++) {
      const item = req.pages[i]
      const mine = marks.filter((m) => m.pageId === item.id)
      if (!mine.length) continue
      const info = req.sourcePages[item.srcIndex]
      const page = pages[item.srcIndex]
      markedPages.push(page)
      const pageMat = pdfToPage(info.view, info.rotate)
      const toPage = [pageMat.a, pageMat.b, pageMat.c, pageMat.d, pageMat.e, pageMat.f] as [number, number, number, number, number, number]
      const rects: Box[] = mine.map((m) => [m.x, m.y, m.x + m.width, m.y + m.height])
      const swaps: ImageSwap[] = []
      for (const patch of req.imagePatches[item.id] ?? []) {
        const img = patch.mime === 'image/png' ? await doc.embedPng(patch.bytes) : await doc.embedJpg(patch.bytes)
        swaps.push({ ctm: patch.ctm, ref: img.ref })
      }
      const r = redactPage(page, toPage, rects, swaps)
      for (const why of r.problems) report.problems.push(`Page ${i + 1}: ${why} is under a mark and can’t be removed.`)
      report.removed.glyphs += r.glyphs
      report.removed.images += r.images
      report.removed.paths += r.paths
      deadAnnots.push(...annotationsUnder(page, toPage, rects))
      // The opaque box, on top of everything left on the page.
      const toPdf = invert(pageMat)
      for (const m of mine) drawCover(page, toPdf, { x: m.x, y: m.y, width: m.width, height: m.height, color: '#000000', original: '' })
    }
    report.removed.annotations = removeAnnotations(doc, pages, deadAnnots)
    // Marked words in bookmark titles and tag texts.
    scrubStrings(doc, marks.flatMap((m) => (m.text ? [m.text] : [])))
  }
  const kept = req.pages.map((p) => pages[p.srcIndex])
  if (Object.values(req.sanitize).some(Boolean)) {
    const r = sanitize(doc, kept, req.sanitize)
    report.sanitized = r.removed
    report.sanitizeNotes = r.notes
    if (req.sanitize.metadata) scanNote()
  }

  // Page order, deleted pages and everything that pointed at them; then drop unreachable objects
  // (deleted pages, replaced streams, superseded revisions) so they don't ship in the file.
  rebuildPageTree(doc, pages, order)
  pruneDeletedPages(doc, pages, order)
  await doc.flush()
  collectGarbage(doc.context)
  if (marks.length || Object.values(req.sanitize).some(Boolean)) {
    report.leaks = findLeaks(doc, kept, markedPages, marks.flatMap((m) => (m.text ? [m.text] : [])))
    out.redaction = report
    // Never hand out a file that still holds what was marked.
    if (report.problems.length || report.leaks.length) return new Uint8Array()
  }
  if (enc) applySourceEncryption(doc, enc)
  progress(0.85)

  const bytes = await doc.save({ useObjectStreams: true, updateFieldAppearances: false, addDefaultPage: false })
  progress(1)
  return bytes
}

function withFrame(page: PDFPage, m: Mat, draw: () => void) {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(m.a, m.b, m.c, m.d, m.e, m.f))
  draw()
  page.pushOperators(popGraphicsState())
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

function drawCover(page: PDFPage, toPdf: Mat, c: Cover) {
  // Plain operators (not drawRectangle) so recorded drawing (see `record`) captures them too.
  const col = hexToRgb(c.color)
  withFrame(page, mul(toPdf, elementFrame(c.x, c.y, 0)), () => {
    page.pushOperators(
      setFillingRgbColor(col.red, col.green, col.blue),
      PDFOperator.of(PDFOperatorNames.AppendRectangle, [0, -c.height, c.width, c.height].map((v) => PDFNumber.of(v))),
      PDFOperator.of(PDFOperatorNames.FillNonZero),
    )
  })
}

/** Runs `draw` with the page's operators captured instead of appended (for in-place insertion). */
function record(page: PDFPage, draw: () => void): Uint8Array {
  const ops: PDFOperator[] = []
  const orig = page.pushOperators.bind(page)
  page.pushOperators = (...o: PDFOperator[]) => void ops.push(...o)
  try {
    draw()
  } finally {
    page.pushOperators = orig
  }
  return PDFContentStream.of(page.doc.context.obj({}), ops, false).getUnencodedContents()
}

async function drawImage(
  page: PDFPage,
  toPdf: Mat,
  el: ImageElement,
  req: ExportRequest,
  cache: Map<string, PDFImage>,
  doc: PDFDocument,
) {
  const asset = req.assets[el.assetId]
  if (!asset) return
  let img = cache.get(asset.id)
  if (!img) {
    img = asset.mime === 'image/png' ? await doc.embedPng(asset.bytes) : await doc.embedJpg(asset.bytes)
    cache.set(asset.id, img)
  }
  const image = img
  withFrame(page, mul(toPdf, elementFrame(el.x, el.y, el.rotation)), () => {
    page.drawImage(image, { x: 0, y: -el.height, width: el.width, height: el.height })
  })
}

// --- Text ------------------------------------------------------------------

interface FontkitGlyph {
  id: number
  codePoints: number[]
}
interface FontkitRun {
  glyphs: FontkitGlyph[]
  positions: { xAdvance: number; xOffset: number; yOffset: number }[]
}
interface FontkitFont {
  unitsPerEm: number
  layout: (text: string, features?: unknown) => FontkitRun
}
/** Internals of pdf-lib's CustomFontSubsetEmbedder that we rely on. */
interface SubsetEmbedder {
  font: FontkitFont
  fontFeatures?: unknown
  subset?: { includeGlyph: (g: FontkitGlyph) => number }
  glyphs?: FontkitGlyph[]
  glyphIdMap?: Map<number, number>
  glyphCache?: { invalidate: () => void }
}

class FontCache {
  private fonts = new Map<string, Promise<PDFFont>>()
  private keys = new WeakMap<PDFPage, Map<PDFFont, PDFName>>()
  private doc: PDFDocument
  private baseUrl: string
  constructor(doc: PDFDocument, baseUrl: string) {
    this.doc = doc
    this.baseUrl = baseUrl
  }

  get(id: FontFamilyId, bold: boolean, italic: boolean) {
    const url = fontFileUrl(id, bold, italic, this.baseUrl)
    let p = this.fonts.get(url)
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`Could not load font ${url}`)
          return r.arrayBuffer()
        })
        .then((buf) => this.doc.embedFont(buf, { subset: true }))
      this.fonts.set(url, p)
    }
    return p
  }

  /** Resource name of `font` on `page`, registering it once per page. */
  key(page: PDFPage, font: PDFFont) {
    let m = this.keys.get(page)
    if (!m) this.keys.set(page, (m = new Map()))
    let k = m.get(font)
    if (!k) m.set(font, (k = page.node.newFontDictionary(font.name, font.ref)))
    return k
  }
}

/** Glyph id inside the embedded subset (mirrors pdf-lib's encodeText). */
function encodeGlyph(emb: SubsetEmbedder, g: FontkitGlyph): number {
  if (!emb.subset) return g.id
  const sid = emb.subset.includeGlyph(g)
  if (emb.glyphs) emb.glyphs[sid - 1] = g
  emb.glyphIdMap?.set(g.id, sid)
  emb.glyphCache?.invalidate()
  return sid
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0')

interface ShapedRun {
  font: PDFFont
  emb: SubsetEmbedder | null
  run: FontkitRun | null
  text: string
  width: number
  oblique: boolean
}

async function shapeLine(line: string, el: TextElement, fonts: FontCache): Promise<{ runs: ShapedRun[]; width: number }> {
  const runs: ShapedRun[] = []
  let width = 0
  for (const r of fontRuns(line, el.font)) {
    const font = await fonts.get(r.font, el.bold, el.italic)
    const emb = (font as unknown as { embedder?: SubsetEmbedder }).embedder ?? null
    const oblique = el.italic && !FONT_FAMILIES[r.font].hasItalic
    if (emb?.font?.layout) {
      const run = emb.font.layout(r.text, emb.fontFeatures)
      const k = el.size / emb.font.unitsPerEm
      const w = run.positions.reduce((s, p) => s + p.xAdvance, 0) * k
      runs.push({ font, emb, run, text: r.text, width: w, oblique })
      width += w
    } else {
      const w = font.widthOfTextAtSize(r.text, el.size)
      runs.push({ font, emb: null, run: null, text: r.text, width: w, oblique })
      width += w
    }
  }
  return { runs, width }
}

async function drawText(page: PDFPage, toPdf: Mat, el: TextElement, fonts: FontCache, invisible = false) {
  const lines = splitLines(el.text)
  const shaped = await Promise.all(lines.map((l) => shapeLine(l, el, fonts)))
  const boxW = Math.max(0, ...shaped.map((s) => s.width))

  withFrame(page, mul(toPdf, elementFrame(el.x, el.y, el.rotation)), () => {
    const c = hexToRgb(el.color)
    page.pushOperators(setFillingRgbColor(c.red, c.green, c.blue), beginText())
    if (invisible) page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible))
    shaped.forEach((line, i) => {
      const yb = -baselineOffset(i, el.size, el.lineHeight)
      let pen = alignOffset(el.align, boxW, line.width)
      for (const r of line.runs) {
        const key = fonts.key(page, r.font)
        page.pushOperators(setFontAndSize(key, el.size))
        const shear = r.oblique ? OBLIQUE_SHEAR : 0
        if (r.run && r.emb) {
          const k = el.size / r.emb.font.unitsPerEm
          r.run.glyphs.forEach((g, gi) => {
            const p = r.run!.positions[gi]
            const sid = encodeGlyph(r.emb!, g)
            page.pushOperators(
              setTextMatrix(1, 0, shear, 1, pen + p.xOffset * k, yb + p.yOffset * k),
              showText(PDFHexString.of(hex4(sid))),
            )
            pen += p.xAdvance * k
          })
        } else {
          page.pushOperators(setTextMatrix(1, 0, shear, 1, pen, yb), showText(r.font.encodeText(r.text)))
          pen += r.width
        }
      }
    })
    page.pushOperators(endText())
  })
}

// --- Text in the PDF's own font -------------------------------------------------

const N = (n: string) => PDFName.of(n)
const SIMPLE = new Set(['Type1', 'TrueType', 'MMType1'])

/** Finds the font dictionary to reuse for an OriginalFont and its resource name on a page. */
class OriginalFonts {
  private refs = new Map<string, PDFRef | null>()
  private keys = new WeakMap<PDFPage, Map<string, PDFName>>()
  private doc: PDFDocument
  constructor(doc: PDFDocument) {
    this.doc = doc
  }

  private matches(dict: PDFDict, f: OriginalFont, type3 = false) {
    const bf = dict.get(N('BaseFont'))
    if (!(bf instanceof PDFName) || bf.decodeText() !== f.baseFont) return false
    const sub = dict.get(N('Subtype'))
    if (!(sub instanceof PDFName)) return false
    // Composite fonts: only Identity-H, where our 2-byte codes are the CIDs.
    if (f.composite) return sub === N('Type0') && dict.get(N('Encoding')) === N('Identity-H')
    return SIMPLE.has(sub.decodeText()) || (type3 && sub === N('Type3'))
  }

  /** A Type3 font on the page whose /Widths match the captured (code, width) pairs. */
  keyForType3(page: PDFPage, sig: [number, number][]): PDFName | null {
    const ctx = this.doc.context
    const fontRes = page.node.Resources()?.lookupMaybe(N('Font'), PDFDict)
    if (!fontRes || !sig.length) return null
    for (const [key, val] of fontRes.entries()) {
      const dict = ctx.lookupMaybe(val, PDFDict)
      if (!dict || dict.get(N('Subtype')) !== N('Type3')) continue
      const first = (dict.lookup(N('FirstChar')) as { asNumber?: () => number } | undefined)?.asNumber?.() ?? 0
      const widths = dict.lookupMaybe(N('Widths'), PDFArray)
      if (!widths) continue
      const ok = sig.every(([code, w]) => {
        const v = (ctx.lookup(widths.get(code - first)) as { asNumber?: () => number } | undefined)?.asNumber?.()
        return v !== undefined && Math.abs(v - w) < 1e-3 * Math.max(1, Math.abs(w))
      })
      if (ok) return key
    }
    return null
  }

  /** Existing key on the page, or the font registered under a new key. */
  keyFor(page: PDFPage, f: OriginalFont, type3 = false): PDFName | null {
    let perPage = this.keys.get(page)
    if (!perPage) this.keys.set(page, (perPage = new Map()))
    const cached = perPage.get(f.baseFont)
    if (cached) return cached

    const ctx = this.doc.context
    const fontRes = page.node.Resources()?.lookupMaybe(N('Font'), PDFDict)
    if (fontRes) {
      for (const [key, val] of fontRes.entries()) {
        const dict = ctx.lookupMaybe(val, PDFDict)
        if (dict && this.matches(dict, f, type3)) {
          perPage.set(f.baseFont, key)
          return key
        }
      }
    }
    // Used inside a form XObject (or another page): find it anywhere.
    let ref = this.refs.get(f.baseFont)
    if (ref === undefined) {
      ref = null
      for (const [r, obj] of ctx.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && this.matches(obj, f, type3)) {
          ref = r
          break
        }
      }
      this.refs.set(f.baseFont, ref)
    }
    if (!ref) return null
    const key = page.node.newFontDictionary(f.baseFont.replace(/[^A-Za-z0-9]/g, ''), ref)
    perPage.set(f.baseFont, key)
    return key
  }
}

/**
 * Draws a text element with its original PDF font: same char codes, widths
 * from the font itself; spaces the font lacks (TeX) become TJ gaps. Returns
 * false when the font can't be reused, so the caller falls back.
 */
function drawOriginalText(page: PDFPage, toPdf: Mat, el: TextElement, originals: OriginalFonts): boolean {
  if (!usesOriginal(el)) return false
  const f = el.original
  const key = originals.keyFor(page, f)
  if (!key) return false
  const ctx = page.doc.context
  const lines = splitLines(el.text).map((l) => encodeLine(l, f))
  const widths = lines.map((l) => (l.width / 1000) * el.size)
  const boxW = Math.max(0, ...widths)
  const digits = f.composite ? 4 : 2

  withFrame(page, mul(toPdf, elementFrame(el.x, el.y, el.rotation)), () => {
    const c = hexToRgb(el.color)
    page.pushOperators(setFillingRgbColor(c.red, c.green, c.blue), beginText(), setFontAndSize(key, el.size))
    lines.forEach((line, i) => {
      const parts: (PDFHexString | number)[] = []
      let hex = ''
      for (const it of line.items) {
        if ('gap' in it) {
          if (hex) parts.push(PDFHexString.of(hex))
          hex = ''
          parts.push(-it.gap) // TJ numbers move left; negative = advance right
        } else hex += it.code.toString(16).padStart(digits, '0')
      }
      if (hex) parts.push(PDFHexString.of(hex))
      if (!parts.length) return
      page.pushOperators(
        setTextMatrix(1, 0, 0, 1, alignOffset(el.align, boxW, widths[i]), -baselineOffset(i, el.size, el.lineHeight)),
        PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [ctx.obj(parts) as PDFArray]),
      )
    })
    page.pushOperators(endText())
  })
  return true
}

// --- Edited existing lines ---------------------------------------------------------

/**
 * Draws an edited existing line with the same layout as the editor (lib/text/line-layout.ts):
 * unchanged words emit nothing (the PDF's own glyphs stay as they are), changed or shifted words get
 * a patch in the sampled page colour and are drawn again — original glyphs with the original font
 * dictionary and the same codes, new characters with the PDF font where it has them, otherwise the
 * metric-compatible stand-in, glyph by glyph.
 */
/** Layout of an edited line with its stand-in fonts loaded (measuring must be synchronous). */
async function layoutSourceLine(el: TextElement, fonts: FontCache): Promise<{ L: LineLayout; fontOf: (f: FontFamilyId, b: boolean, i: boolean) => PDFFont | undefined }> {
  const src = el.source!
  // Stand-in fonts the layout may use, loaded up front so measuring is synchronous.
  const loaded = new Map<string, PDFFont>()
  const want: [FontFamilyId, boolean, boolean][] = src.runs.map((r) => [r.family, r.bold, r.italic])
  if (el.override) want.push([el.font, el.bold, el.italic])
  for (const [f, b, i] of want) {
    const k = `${f}|${+b}|${+i}`
    if (!loaded.has(k)) loaded.set(k, await fonts.get(f, b, i))
  }
  const fontOf = (f: FontFamilyId, b: boolean, i: boolean) => loaded.get(`${f}|${+b}|${+i}`)
  const measure: Measure = (family, bold, italic, text) => {
    const font = fontOf(family, bold, italic)
    const emb = (font as unknown as { embedder?: SubsetEmbedder })?.embedder
    if (!font) return 0.5 * [...text].length
    if (emb?.font?.layout) return emb.font.layout(text, emb.fontFeatures).positions.reduce((s, p) => s + p.xAdvance, 0) / emb.font.unitsPerEm
    return font.widthOfTextAtSize(text, 1)
  }
  return { L: layoutLine(el, measure), fontOf }
}

function paintSourceLine(
  page: PDFPage,
  toPdf: Mat,
  el: TextElement,
  { L, fontOf }: Awaited<ReturnType<typeof layoutSourceLine>>,
  fonts: FontCache,
  originals: OriginalFonts,
  removed: Set<number>,
) {
  const src = el.source!
  if (!L.changed) return
  // Patches only where the old glyph could not be removed from the content stream.
  for (const c of coversFor(src, L.gone.filter((gi) => !removed.has(gi)))) drawCover(page, toPdf, { ...c, color: src.background, original: '' })

  const ctx = page.doc.context
  withFrame(page, mul(toPdf, elementFrame(0, 0, 0)), () => {
    let color = ''
    const fill = (hex: string) => {
      if (hex === color) return
      color = hex
      const c = hexToRgb(hex)
      page.pushOperators(setFillingRgbColor(c.red, c.green, c.blue))
    }
    page.pushOperators(beginText())
    const standIn = (text: string, family: FontFamilyId, bold: boolean, italic: boolean, size: number, hScale: number, hex: string, x: number, y: number) => {
      const font = fontOf(family, bold, italic)
      if (!font) return
      const emb = (font as unknown as { embedder?: SubsetEmbedder }).embedder ?? null
      const key = fonts.key(page, font)
      fill(hex)
      page.pushOperators(setFontAndSize(key, size))
      const shear = italic && !FONT_FAMILIES[family].hasItalic ? OBLIQUE_SHEAR : 0
      if (emb?.font?.layout) {
        const run = emb.font.layout(text, emb.fontFeatures)
        const k = size / emb.font.unitsPerEm
        let pen = x
        run.glyphs.forEach((g, gi) => {
          const p = run.positions[gi]
          page.pushOperators(
            setTextMatrix(hScale, 0, shear, 1, pen + p.xOffset * k * hScale, -y + p.yOffset * k),
            showText(PDFHexString.of(hex4(encodeGlyph(emb, g)))),
          )
          pen += p.xAdvance * k * hScale
        })
      } else page.pushOperators(setTextMatrix(hScale, 0, shear, 1, x, -y), showText(font.encodeText(text)))
    }
    for (const d of L.draws) {
      if (d.kind === 'text') {
        standIn(d.text, d.family, d.bold, d.italic, d.size, d.hScale, d.color, d.x, d.y)
        continue
      }
      const run = src.runs[d.run]
      const key = run.type3
        ? originals.keyForType3(page, run.widthSig ?? [])
        : originals.keyFor(page, { baseFont: run.baseFont, composite: run.composite, glyphs: {}, spaceGap: 0 })
      if (!key) {
        standIn(d.uni, run.family, run.bold, run.italic, run.size * run.familyScale * (d.scale ?? 1), run.hScale, run.color, d.x, d.y)
        continue
      }
      fill(run.color)
      const code = d.code.toString(16).padStart(run.composite ? 4 : 2, '0')
      page.pushOperators(
        setFontAndSize(key, run.size * (d.scale ?? 1)),
        setTextMatrix(run.hScale, 0, 0, 1, d.x, -d.y),
        PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [ctx.obj([PDFHexString.of(code)]) as PDFArray]),
      )
    }
    page.pushOperators(endText())
  })
}
