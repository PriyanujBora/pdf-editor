import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { familyForText } from '@/lib/fonts'
import { missingGlyphs, type OriginalFont } from '@/lib/original-font'
import { isInvisibleFont, originalFontFor, scanPageFonts } from './font-scan'
import { captureGlyphs } from '@/lib/text/capture'
import { buildLines, type CapturedLine } from '@/lib/text/lines'
import type { FontFamilyId } from '@/types'

/** A detected line of existing text, in page space. */
export interface TextBlock {
  id: string
  text: string
  x: number
  /** Top of the ink box (baseline − ascent). */
  y: number
  width: number
  height: number
  baseline: number
  size: number
  font: FontFamilyId
  bold: boolean
  italic: boolean
  /** The line's own PDF font, when it can be reused for the edit. */
  original?: OriginalFont
  /** Invisible OCR text over a scanned image: edit by matching the scan. */
  ocr: boolean
  /** Vector text: every glyph as printed, so edits can keep unchanged words exactly. */
  source?: CapturedLine
}

interface Piece {
  str: string
  x: number
  baseline: number
  width: number
  size: number
  ascent: number
  descent: number
  fontName: string
  ocr: boolean
}

const cache = new Map<string, Promise<TextBlock[]>>()

export function getTextBlocks(page: PDFPageProxy, key: string) {
  let p = cache.get(key)
  if (!p) {
    p = scanPageFonts(page, key)
      .then(() => detect(page))
      .catch(() => [])
    cache.set(key, p)
  }
  return p
}

export function clearTextBlockCache() {
  cache.clear()
}

interface FontInfo {
  name?: string
  bold?: boolean
  italic?: boolean
  black?: boolean
  fallbackName?: string
  type?: string
}

function fontInfo(page: PDFPageProxy, fontName: string): FontInfo {
  try {
    if (page.commonObjs.has(fontName)) return page.commonObjs.get(fontName) as FontInfo
  } catch {
    /* font not loaded on the main thread */
  }
  return {}
}

/** TeX font names: CMR10, SFRM1095, ECBX1200, LMRoman10-Bold, … */
const TEX = /^(cm|sf|ec|tc)[a-z]{1,5}\d{2,4}$|^lm(roman|sans|mono)/i

/**
 * Closest bundled family for an original font. Embedded fonts are almost
 * always subsetted (missing glyphs we'd need), so we never reuse them.
 */
function mapFont(info: FontInfo, cssFamily: string | undefined): { font: FontFamilyId; bold: boolean; italic: boolean } {
  const name = (info.name ?? '').replace(/^[A-Z]{6}\+/, '')
  let bold = !!info.bold || !!info.black || /bold|black|heavy|semibold|demi/i.test(name)
  let italic = !!info.italic || /italic|oblique|slanted/i.test(name)
  // Unknown names (Type3 fonts from Figma/Canva, OCR layers) default to Inter.
  let font: FontFamilyId = 'inter'
  if (TEX.test(name)) {
    // TeX: SS = sans, TT = typewriter, everything else is (Computer/Latin) Modern Roman.
    font = /^(cm|sf|ec)ss|^lmsans/i.test(name) ? 'roboto' : /^(cm|sf|ec)tt|^lmmono/i.test(name) ? 'roboto' : 'noto-serif'
    bold ||= /^(cm|sf|ec)(bx|b|rb|sx|ssbx|ssdc)/i.test(name)
    italic ||= /^(cm|sf|ec)(ti|it|sl|si|bi|ssi)/i.test(name)
  } else if (/inter/i.test(name)) font = 'inter'
  else if (
    /roboto|arial|helvetica|liberation ?sans|nimbus ?sans|calibri|segoe|verdana|tahoma|open ?sans|noto ?sans(?!.*(bengali|devanagari))/i.test(
      name,
    )
  )
    font = 'roboto'
  else if (/times|tinos|liberation ?serif|nimbus ?rom|thorndale/i.test(name)) font = 'tinos'
  else if (/bengali|bangla|kalpurush|siyam|solaiman|vrinda/i.test(name)) font = 'noto-bengali'
  else if (/devanagari|mangal|hindi|kokila|aparajita|utsaah/i.test(name)) font = 'noto-devanagari'
  else if (
    /times|serif|georgia|garamond|cambria|minion|palatino|book|baskerville|caslon|century|bodoni|charter|merriweather|lora|tinos|libertin|roman/i.test(
      name,
    ) &&
    !/sans/i.test(name)
  )
    font = 'noto-serif'
  else if ((!name || info.type === 'Type3') && (info.fallbackName === 'serif' || cssFamily === 'serif')) font = 'noto-serif'
  return { font, bold, italic }
}

/** Text tilted less than this (≈ 2°) counts as horizontal — OCR layers are rarely perfectly level. */
const MAX_SKEW = 0.035

/**
 * Visible vector text comes from the glyph capture (exact positions, fonts, colours, spacing).
 * Invisible OCR layers over scans keep the pdf.js text-item path below, which scan matching is
 * tuned on. If the capture fails, every line falls back to that path.
 */
async function detect(page: PDFPageProxy): Promise<TextBlock[]> {
  let vector: TextBlock[] | null = null
  try {
    const { glyphs, fonts } = await captureGlyphs(page)
    vector = buildLines(glyphs, fonts).map((l) => ({
      id: `${Math.round(l.box.x * 10)}:${Math.round(l.baseline * 10)}`,
      text: l.text,
      x: l.box.x,
      y: l.box.y,
      width: l.box.width,
      height: l.box.height,
      baseline: l.baseline,
      size: l.size,
      font: familyForText(l.text, l.family),
      bold: l.bold,
      italic: l.italic,
      ocr: false,
      source: l,
    }))
  } catch (err) {
    console.warn('glyph capture failed, using text items', err)
  }
  const items = await detectFromItems(page, vector !== null)
  // Ids must be unique (React keys, hit areas): lines can start at the same point.
  const seen = new Map<string, number>()
  return [...(vector ?? []), ...items].map((blk) => {
    const n = seen.get(blk.id) ?? 0
    seen.set(blk.id, n + 1)
    return n ? { ...blk, id: `${blk.id}#${n}` } : blk
  })
}

async function detectFromItems(page: PDFPageProxy, ocrOnly: boolean): Promise<TextBlock[]> {
  const vp = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  const pieces: Piece[] = []

  for (const raw of tc.items) {
    const it = raw as TextItem
    // Whitespace-only items carry no glyphs to edit and can span column gaps
    // (TeX \hfill); word spacing is re-inserted from positions below.
    if (!('str' in it) || !it.str.trim() || it.dir === 'ttb') continue
    // item.transform is in PDF space; map into page space.
    const [a, b, c, d, e, f] = it.transform as number[]
    const m = vp.transform
    const ta = m[0] * a + m[2] * b
    const tb = m[1] * a + m[3] * b
    const tc2 = m[0] * c + m[2] * d
    const td = m[1] * c + m[3] * d
    const tx = m[0] * e + m[2] * f + m[4]
    const ty = m[1] * e + m[3] * f + m[5]
    // Only upright, (near-)horizontal text is editable for now.
    if (ta <= 0 || Math.abs(tb) > MAX_SKEW * ta) continue
    const style = tc.styles[it.fontName]
    // Normally the vertical scale is the font size (OCR layers stretch the
    // horizontal one to fit each word). Type3 fonts (Figma, Canva…) have no
    // metrics and pdf.js inflates their vertical scale, so use the horizontal.
    const type3 = fontInfo(page, it.fontName).type === 'Type3'
    // OCR layers over scans use a placeholder font whose box is exactly the
    // glyph height (ascent 1, descent 0): the vertical scale is then the cap
    // height, ≈ 0.7 of the real font size.
    const ocr = !!style && style.ascent >= 0.99 && Math.abs(style.descent ?? 1) < 0.01
    const size = type3 ? Math.hypot(ta, tb) : Math.hypot(tc2, td) / (ocr ? 0.7 : 1)
    if (size < 1) continue
    const ascent = ocr ? 0.75 : style?.ascent && style.ascent > 0.4 ? style.ascent : 0.8
    const descent = ocr ? 0.25 : style?.descent && style.descent < 0 ? -style.descent : 0.22
    // it.width is in text space × scale; for horizontal text it equals page units.
    if (ocrOnly && !ocr && !isInvisibleFont(it.fontName)) continue
    pieces.push({ str: it.str, x: tx, baseline: ty, width: it.width, size, ascent, descent, fontName: it.fontName, ocr })
  }

  pieces.sort((p, q) => p.baseline - q.baseline || p.x - q.x)

  // 1. Cluster by baseline. OCR layers put each word's box bottom at its
  //    lowest ink, so words with descenders sit slightly lower: compare with
  //    the cluster's running median, not the previous word.
  const rows: { pieces: Piece[]; base: number; size: number }[] = []
  for (const p of pieces) {
    const tol = (p.ocr ? 0.4 : 0.25) * p.size
    const row = rows.findLast(
      (r) => Math.abs(r.base - p.baseline) < Math.max(tol, 0.25 * r.size) && Math.abs(r.size - p.size) < 0.5 * r.size,
    )
    if (row) {
      row.pieces.push(p)
      row.base = median(row.pieces.map((q) => q.baseline))
      row.size = median(row.pieces.map((q) => q.size))
    } else rows.push({ pieces: [p], base: p.baseline, size: p.size })
  }

  // 2. Within a row, order by x and split at column-sized gaps.
  const lines: Piece[][] = []
  for (const row of rows) {
    row.pieces.sort((p, q) => p.x - q.x)
    let cur: Piece[] = []
    for (const p of row.pieces) {
      const last = cur[cur.length - 1]
      const gap = last ? p.x - (last.x + last.width) : 0
      if (last && (gap > 1.2 * Math.max(row.size, p.size) || gap < -0.5 * p.size)) {
        lines.push(cur)
        cur = []
      }
      cur.push(p)
    }
    if (cur.length) lines.push(cur)
  }

  const blocks: TextBlock[] = []
  for (const line of lines) {
    line.sort((p, q) => p.x - q.x)
    let text = ''
    let prevEnd = -Infinity
    for (const p of line) {
      const gap = p.x - prevEnd
      // OCR layers emit one item per word, sometimes almost touching.
      const minGap = p.ocr || isInvisibleFont(p.fontName) ? 0.02 : 0.18
      if (text && gap > minGap * p.size && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' '
      text += p.str
      prevEnd = p.x + p.width
    }
    text = text.replace(/\s+$/, '').replace(/^\s+/, '')
    if (!text) continue
    const first = line.find((p) => p.str.trim()) ?? line[0]
    // OCR glyph boxes vary per word (caps, descenders): use typical values.
    const ocrLine = line.every((p) => p.ocr)
    const size = ocrLine ? median(line.map((p) => p.size)) : Math.max(...line.map((p) => p.size))
    const asc = Math.max(...line.map((p) => p.ascent))
    const desc = Math.max(...line.map((p) => p.descent))
    const baseline = ocrLine
      ? quantile(
          line.map((p) => p.baseline),
          0.2,
        )
      : line.reduce((s, p) => s + p.baseline, 0) / line.length
    const x0 = first.x
    const x1 = Math.max(...line.map((p) => p.x + p.width))
    const style = tc.styles[first.fontName]
    const mapped = mapFont(fontInfo(page, first.fontName), style?.fontFamily)
    // The font that draws most of the line; reusable if it has every glyph.
    const share = new Map<string, number>()
    for (const p of line) if (!p.ocr) share.set(p.fontName, (share.get(p.fontName) ?? 0) + p.str.length)
    const dominant = [...share].sort((a, b) => b[1] - a[1])[0]?.[0]
    const original = dominant ? originalFontFor(dominant) : undefined
    blocks.push({
      id: `${Math.round(x0 * 10)}:${Math.round(baseline * 10)}`,
      text,
      x: x0,
      y: baseline - asc * size,
      width: Math.max(x1 - x0, size * 0.3),
      height: (asc + desc) * size,
      baseline,
      size,
      font: familyForText(text, mapped.font),
      bold: mapped.bold,
      italic: mapped.italic,
      original: original && missingGlyphs(text, original).length === 0 ? original : undefined,
      ocr: line.every((p) => p.ocr || isInvisibleFont(p.fontName)),
    })
  }
  return blocks
}

function quantile(v: number[], q: number) {
  const a = v.slice().sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]
}

const median = (v: number[]) => quantile(v, 0.5)
