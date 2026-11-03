import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { familyForText } from '@/lib/fonts'
import { missingGlyphs, type OriginalFont } from '@/lib/original-font'
import { originalFontFor, scanPageFonts } from './font-scan'
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

async function detect(page: PDFPageProxy): Promise<TextBlock[]> {
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
    pieces.push({ str: it.str, x: tx, baseline: ty, width: it.width, size, ascent, descent, fontName: it.fontName, ocr })
  }

  pieces.sort((p, q) => p.baseline - q.baseline || p.x - q.x)

  // Group into lines: same baseline (± 25% size), similar size, no big gaps.
  const lines: Piece[][] = []
  for (const p of pieces) {
    const line = lines.find((l) => {
      const last = l[l.length - 1]
      const gap = p.x - (last.x + last.width)
      return (
        Math.abs(last.baseline - p.baseline) < 0.25 * Math.max(last.size, p.size) &&
        Math.abs(last.size - p.size) < 0.35 * last.size &&
        gap > -0.5 * p.size &&
        gap < 1.2 * p.size
      )
    })
    if (line) line.push(p)
    else lines.push([p])
  }

  const blocks: TextBlock[] = []
  for (const line of lines) {
    line.sort((p, q) => p.x - q.x)
    let text = ''
    let prevEnd = -Infinity
    for (const p of line) {
      const gap = p.x - prevEnd
      if (text && gap > 0.18 * p.size && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' '
      text += p.str
      prevEnd = p.x + p.width
    }
    text = text.replace(/\s+$/, '').replace(/^\s+/, '')
    if (!text) continue
    const first = line.find((p) => p.str.trim()) ?? line[0]
    const size = Math.max(...line.map((p) => p.size))
    const asc = Math.max(...line.map((p) => p.ascent))
    const desc = Math.max(...line.map((p) => p.descent))
    const baseline = line.reduce((s, p) => s + p.baseline, 0) / line.length
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
    })
  }
  return blocks
}
