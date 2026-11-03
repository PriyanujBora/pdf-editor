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
  PDFDict,
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
  showText,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from '@cantoo/pdf-lib'
import { FONT_FAMILIES, fontFileUrl, fontRuns, OBLIQUE_SHEAR } from '@/lib/fonts'
import { encodeLine, usesOriginal, type OriginalFont } from '@/lib/original-font'
import { alignOffset, baselineOffset, splitLines } from '@/lib/text-layout'
import type { Cover, FontFamilyId, ImageElement, TextElement } from '@/types'
import { compatFontkit } from './fontkit-compat'
import { elementFrame, invert, mul, pdfToPage, type Mat } from './matrix'
import type { ExportRequest, ExportResponse } from './protocol'

declare const self: DedicatedWorkerGlobalScope

self.onmessage = async (e: MessageEvent<ExportRequest>) => {
  try {
    const bytes = await buildPdf(e.data)
    self.postMessage({ type: 'done', bytes } satisfies ExportResponse, [bytes.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies ExportResponse)
  }
}

const progress = (value: number) => self.postMessage({ type: 'progress', value } satisfies ExportResponse)

async function loadSource(bytes: Uint8Array, password: string) {
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  if (!probe.isEncrypted) return probe
  // Owner-password-only files open with the empty user password.
  return PDFDocument.load(bytes, { password, updateMetadata: false })
}

async function buildPdf(req: ExportRequest): Promise<Uint8Array> {
  const src = await loadSource(req.bytes, req.password)
  const out = await PDFDocument.create()
  out.registerFontkit(compatFontkit)

  const title = src.getTitle()
  if (title) out.setTitle(title)
  out.setProducer('Free PDF Editor (pdf-lib)')
  out.setCreator('Free PDF Editor')

  const copied = await out.copyPages(
    src,
    req.pages.map((p) => p.srcIndex),
  )
  progress(0.15)

  const fonts = new FontCache(out, req.baseUrl)
  const originals = new OriginalFonts(out)
  const images = new Map<string, PDFImage>()

  for (let i = 0; i < req.pages.length; i++) {
    const item = req.pages[i]
    const info = req.sourcePages[item.srcIndex]
    const page = out.addPage(copied[i])
    page.setRotation(degrees((info.rotate + item.rotation) % 360))

    // page space → PDF user space
    const toPdf = invert(pdfToPage(info.view, info.rotate))
    const els = req.elements.filter((el) => el.pageId === item.id)

    // Covers first so no replacement text is hidden by another cover.
    for (const el of els) {
      if (el.kind === 'text' && el.cover) drawCover(page, toPdf, el.cover)
    }
    for (const el of els) {
      if (el.kind === 'text') {
        if (!drawOriginalText(page, toPdf, el, originals)) await drawText(page, toPdf, el, fonts)
      } else await drawImage(page, toPdf, el, req, images, out)
    }
    progress(0.15 + (0.7 * (i + 1)) / req.pages.length)
  }

  const bytes = await out.save({ useObjectStreams: true })
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
  withFrame(page, mul(toPdf, elementFrame(c.x, c.y, 0)), () => {
    page.drawRectangle({ x: 0, y: -c.height, width: c.width, height: c.height, color: hexToRgb(c.color), borderWidth: 0 })
  })
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

async function drawText(page: PDFPage, toPdf: Mat, el: TextElement, fonts: FontCache) {
  const lines = splitLines(el.text)
  const shaped = await Promise.all(lines.map((l) => shapeLine(l, el, fonts)))
  const boxW = Math.max(0, ...shaped.map((s) => s.width))

  withFrame(page, mul(toPdf, elementFrame(el.x, el.y, el.rotation)), () => {
    const c = hexToRgb(el.color)
    page.pushOperators(setFillingRgbColor(c.red, c.green, c.blue), beginText())
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

  private matches(dict: PDFDict, f: OriginalFont) {
    const bf = dict.get(N('BaseFont'))
    if (!(bf instanceof PDFName) || bf.decodeText() !== f.baseFont) return false
    const sub = dict.get(N('Subtype'))
    if (!(sub instanceof PDFName)) return false
    // Composite fonts: only Identity-H, where our 2-byte codes are the CIDs.
    if (f.composite) return sub === N('Type0') && dict.get(N('Encoding')) === N('Identity-H')
    return SIMPLE.has(sub.decodeText())
  }

  /** Existing key on the page, or the font registered under a new key. */
  keyFor(page: PDFPage, f: OriginalFont): PDFName | null {
    let perPage = this.keys.get(page)
    if (!perPage) this.keys.set(page, (perPage = new Map()))
    const cached = perPage.get(f.baseFont)
    if (cached) return cached

    const ctx = this.doc.context
    const fontRes = page.node.Resources()?.lookupMaybe(N('Font'), PDFDict)
    if (fontRes) {
      for (const [key, val] of fontRes.entries()) {
        const dict = ctx.lookupMaybe(val, PDFDict)
        if (dict && this.matches(dict, f)) {
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
        if (obj instanceof PDFDict && this.matches(obj, f)) {
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
