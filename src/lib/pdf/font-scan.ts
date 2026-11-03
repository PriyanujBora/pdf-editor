import type { PDFPageProxy } from 'pdfjs-dist'
import { create } from 'zustand'
import { loadPdfJs } from '@/lib/pdf/pdfjs'
import type { GlyphEntry, OriginalFont } from '@/lib/original-font'

/**
 * Collects, from pdf.js operator lists, which glyphs each embedded font has
 * actually drawn. Glyph sets are merged per /BaseFont across scanned pages, so
 * the more pages have been looked at, the more characters an edit can use.
 */

interface PdfJsGlyph {
  originalCharCode: number
  fontChar: string
  unicode: string
  width: number
  isInFont: boolean
}
interface PdfJsFont {
  name?: string
  type?: string
  composite?: boolean
  vertical?: boolean
  fontMatrix?: number[]
  isSerifFont?: boolean
}

interface FontRecord {
  font: OriginalFont
  /** pdf.js FontFace family to draw with in the editor (per loaded document). */
  loadedName: string
}

const byBase = new Map<string, FontRecord>()
const byLoaded = new Map<string, FontRecord>()
const scanned = new Map<string, Promise<void>>()

/** BaseFont → pdf.js loaded font family, as a store so text nodes re-render once known. */
export const useOriginalFaces = create<{ faces: Record<string, string> }>()(() => ({ faces: {} }))

export function resetFontScan() {
  backgroundStarted = false
  byBase.clear()
  byLoaded.clear()
  scanned.clear()
  useOriginalFaces.setState({ faces: {} })
}

/** Fonts we can't (or mustn't) reuse: Type3 (no real font), OCR glyph-less fonts, vertical, odd matrices. */
function reusable(f: PdfJsFont) {
  if (!f.name || f.type === 'Type3' || f.vertical) return false
  if (/glyphless|^untitled$/i.test(f.name)) return false
  const fm = f.fontMatrix?.[0] ?? 0.001
  return Math.abs(fm - 0.001) < 1e-6
}

export function scanPageFonts(page: PDFPageProxy, key: string): Promise<void> {
  let p = scanned.get(key)
  if (!p) {
    p = scan(page).catch(() => {})
    scanned.set(key, p)
  }
  return p
}

async function scan(page: PDFPageProxy) {
  const { OPS } = await loadPdfJs()
  const ops = await page.getOperatorList()
  let current: string | null = null
  const faces: Record<string, string> = {}
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    if (fn === OPS.setFont) {
      current = ops.argsArray[i][0] as string
      continue
    }
    if (fn !== OPS.showText || !current) continue
    let rec = byLoaded.get(current)
    if (!rec) {
      let info: PdfJsFont
      try {
        info = page.commonObjs.get(current) as PdfJsFont
      } catch {
        continue
      }
      if (!reusable(info)) continue
      const existing = byBase.get(info.name!)
      rec = existing ?? {
        loadedName: current,
        font: { baseFont: info.name!, composite: !!info.composite, glyphs: {}, spaceGap: 333 },
      }
      rec.loadedName = current
      byBase.set(info.name!, rec)
      byLoaded.set(current, rec)
      faces[info.name!] = current
    }
    const glyphs = rec.font.glyphs
    for (const g of ops.argsArray[i][0] as (PdfJsGlyph | number | null)[]) {
      if (!g || typeof g !== 'object' || !g.isInFont || !g.unicode || !g.fontChar) continue
      // Skip codes beyond what our encoder writes (1 byte simple, 2 bytes composite).
      if (g.originalCharCode > (rec.font.composite ? 0xffff : 0xff)) continue
      if (!glyphs[g.unicode]) glyphs[g.unicode] = [g.originalCharCode, g.width, g.fontChar] satisfies GlyphEntry
    }
    if (glyphs[' ']) rec.font.spaceGap = glyphs[' '][1]
  }
  if (Object.keys(faces).length) useOriginalFaces.setState((s) => ({ faces: { ...s.faces, ...faces } }))
}

/** Snapshot of everything known about the font pdf.js loaded as `loadedName`. */
export function originalFontFor(loadedName: string): OriginalFont | undefined {
  const rec = byLoaded.get(loadedName)
  if (!rec || !Object.keys(rec.font.glyphs).length) return undefined
  return { ...rec.font, glyphs: { ...rec.font.glyphs } }
}

/** Latest merged glyph set for a font (more pages scanned → more glyphs). */
export function refreshOriginal(f: OriginalFont): OriginalFont {
  const rec = byBase.get(f.baseFont)
  if (!rec) return f
  return { ...f, glyphs: { ...rec.font.glyphs, ...f.glyphs }, spaceGap: rec.font.spaceGap }
}

let backgroundStarted = false

/**
 * Scans the rest of the document's pages (idle, one at a time) so fonts used
 * across pages gain the glyphs seen elsewhere. Started on the first edit.
 */
export function scanDocumentInBackground(pdf: { numPages: number; getPage: (n: number) => Promise<PDFPageProxy> }, max = 80) {
  if (backgroundStarted) return
  backgroundStarted = true
  const idle = (cb: () => void) =>
    'requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 2000 }) : setTimeout(cb, 50)
  let n = 1
  const next = () => {
    if (!backgroundStarted || n > Math.min(pdf.numPages, max)) return
    const pageNo = n++
    void pdf
      .getPage(pageNo)
      .then((p) => scanPageFonts(p, String(pageNo - 1)))
      .finally(() => idle(next))
  }
  idle(next)
}
