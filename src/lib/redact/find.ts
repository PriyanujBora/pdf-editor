import type { PDFPageProxy } from 'pdfjs-dist'
import { captureGlyphs, type CapturedFont, type CapturedGlyph } from '@/lib/text/capture'
import type { PtRect } from '@/types'

/**
 * Text with positions for redaction: every glyph pdf.js draws, visible or not (OCR layers are text
 * too), grouped into lines. Each character of a line's text knows its glyph box, so a match becomes
 * page-space rectangles. Only upright text is searchable.
 */

export interface GlyphBox {
  x: number
  y: number
  width: number
  height: number
  /** Invisible text (OCR layer): its box only approximates the scanned ink. */
  invisible?: boolean
}

export interface SearchLine {
  text: string
  /** Box of each character of `text` (null = a space inferred from a gap). */
  boxes: (GlyphBox | null)[]
}

const pageCache = new Map<string, Promise<SearchLine[]>>()

export function clearSearchCache() {
  pageCache.clear()
}

export function searchLines(page: PDFPageProxy, key: string, rotation?: number): Promise<SearchLine[]> {
  let p = pageCache.get(key)
  if (!p) {
    p = captureGlyphs(page, rotation)
      .then(({ glyphs, fonts }) => groupLines(glyphs, fonts))
      .catch(() => [])
    pageCache.set(key, p)
  }
  return p
}

/** Page-space box of a captured glyph (upright text). */
export function glyphBox(g: CapturedGlyph, f: CapturedFont | undefined): GlyphBox {
  const asc = f?.ascent ?? 0.8
  const desc = f?.descent ?? 0.22
  const w = Math.max(g.adv - g.charSpacing - (g.space ? g.wordSpacing : 0), g.w * (f?.fontMatrix ?? 0.001) * g.size * g.hScale, 0.05 * g.size)
  const invisible = g.mode === 3 || g.mode === 7
  return { x: g.x, y: g.y - asc * g.size, width: w, height: (asc + desc) * g.size, ...(invisible ? { invisible } : {}) }
}

const median = (a: number[]) => {
  if (!a.length) return 0
  const s = a.slice().sort((p, q) => p - q)
  return s[s.length >> 1]
}

export function groupLines(glyphs: CapturedGlyph[], fonts: Map<string, CapturedFont>): SearchLine[] {
  const items = glyphs
    .filter((g) => g.upright && g.size >= 1)
    // oxlint-disable-next-line no-control-regex
    .map((g) => ({ g, uni: g.uni.replace(/[\u0000-\u001f\u007f]/g, ''), box: glyphBox(g, fonts.get(g.font)) }))
    .filter((it) => it.uni !== '')
  // Lines: glyphs whose baselines are within a third of their size, in x order.
  items.sort((a, b) => a.g.y - b.g.y || a.g.x - b.g.x)
  const rows: (typeof items)[] = []
  for (const it of items) {
    const row = rows.find((r) => {
      const ref = r[r.length - 1].g
      return Math.abs(ref.y - it.g.y) < 0.35 * Math.min(ref.size, it.g.size) || Math.abs(r[0].g.y - it.g.y) < 0.35 * Math.min(r[0].g.size, it.g.size)
    })
    if (row) row.push(it)
    else rows.push([it])
  }
  const out: SearchLine[] = []
  for (const row of rows) {
    row.sort((a, b) => a.g.x - b.g.x)
    const size = median(row.map((r) => r.g.size))
    let text = ''
    let boxes: (GlyphBox | null)[] = []
    let prevEnd = -Infinity
    const flush = () => {
      if (text.trim()) out.push({ text, boxes })
      text = ''
      boxes = []
    }
    for (const it of row) {
      const gap = it.g.x - prevEnd
      // Columns on the same baseline are separate lines; ordinary word gaps become spaces.
      if (text && gap > 3 * size) flush()
      else if (text && gap > 0.2 * size && !/\s$/.test(text) && !/^\s/.test(it.uni)) {
        text += ' '
        boxes.push(null)
      }
      for (const ch of it.uni) {
        text += /\s/.test(ch) ? ' ' : ch
        boxes.push(/\s/.test(ch) ? null : it.box)
      }
      prevEnd = Math.max(prevEnd, it.g.x + it.box.width)
    }
    flush()
  }
  return out
}

/** Union of the boxes of characters [start, end) of a line (spaces skipped). */
export function rangeRect(line: SearchLine, start: number, end: number): PtRect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let ocr = false
  for (let i = start; i < end; i++) {
    const b = line.boxes[i]
    if (!b) continue
    ocr ||= !!b.invisible
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.width)
    y1 = Math.max(y1, b.y + b.height)
  }
  if (!isFinite(x0)) return null
  // OCR boxes are fitted to the words only roughly (descenders, a slightly different baseline):
  // marks over scanned words get a generous margin so no ink peeks out.
  const padY = ocr ? Math.max(1, 0.22 * (y1 - y0)) : 0.5
  const padX = ocr ? Math.max(1, 0.12 * (y1 - y0)) : 0.5
  return { x: x0 - padX, y: y0 - padY, width: x1 - x0 + 2 * padX, height: y1 - y0 + 2 * padY }
}

// --- Patterns ------------------------------------------------------------------------

export type PresetId = 'email' | 'phone' | 'pan' | 'aadhaar' | 'card'

export const PRESETS: { id: PresetId; label: string; hint: string }[] = [
  { id: 'email', label: 'Emails', hint: 'name@example.com' },
  { id: 'phone', label: 'Phone numbers', hint: '+91 98765 43210, (555) 123-4567' },
  { id: 'pan', label: 'PAN', hint: 'ABCDE1234F' },
  { id: 'aadhaar', label: 'Aadhaar', hint: '1234 5678 9012 (checksum verified)' },
  { id: 'card', label: 'Card numbers', hint: '13–19 digits, Luhn checked' },
]

function luhn(digits: string) {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i]
    if (i % 2) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

// Verhoeff tables (Aadhaar's check digit).
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]
export function verhoeff(digits: string) {
  let c = 0
  for (let i = 0; i < digits.length; i++) c = VD[c][VP[i % 8][+digits[digits.length - 1 - i]]]
  return c === 0
}

const onlyDigits = (s: string) => s.replace(/\D/g, '')

interface Pattern {
  re: RegExp
  accept?: (m: string) => boolean
}

const PATTERNS: Record<PresetId, Pattern> = {
  email: { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  phone: {
    re: /(?<![\w+])\+?\(?\d[\d ().-]{6,}\d(?!\w)/g,
    accept: (m) => {
      const n = onlyDigits(m).length
      // Dates and amounts look like digit runs too: a phone number has 8–15 digits and no decimals.
      return n >= 8 && n <= 15 && !/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(m) && !/\d\.\d{2}$/.test(m)
    },
  },
  pan: { re: /(?<![A-Za-z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Za-z0-9])/g },
  aadhaar: {
    re: /(?<!\d)[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?!\d)/g,
    accept: (m) => verhoeff(onlyDigits(m)),
  },
  card: {
    re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    accept: (m) => luhn(onlyDigits(m)),
  },
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface Query {
  text: string
  regex: boolean
  caseSensitive: boolean
  presets: PresetId[]
}

/** Compiled query, or an error message (bad regular expression). */
export function compile(q: Query): Pattern[] | string {
  const out: Pattern[] = q.presets.map((p) => PATTERNS[p])
  const t = q.text.trim()
  if (t) {
    try {
      // Whitespace in a plain query matches any run of spaces (PDF line text has single spaces).
      const src = q.regex ? t : escapeRe(t).replace(/\s+/g, '\\s+')
      out.push({ re: new RegExp(src, q.caseSensitive ? 'gu' : 'giu') })
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid pattern'
    }
  }
  return out
}

export interface Match {
  text: string
  rect: PtRect
}

export function findInLines(lines: SearchLine[], patterns: Pattern[]): Match[] {
  const out: Match[] = []
  for (const line of lines) {
    const taken: [number, number][] = []
    for (const p of patterns) {
      p.re.lastIndex = 0
      for (const m of line.text.matchAll(p.re)) {
        const s = m.index ?? 0
        const e = s + m[0].length
        if (!m[0].trim() || (p.accept && !p.accept(m[0]))) continue
        if (taken.some(([a, b]) => s < b && e > a)) continue
        const rect = rangeRect(line, s, e)
        if (!rect) continue
        taken.push([s, e])
        out.push({ text: m[0].trim(), rect })
      }
    }
  }
  return out
}

/** The word under a page-space point, as a mark rectangle. */
export function wordAt(lines: SearchLine[], x: number, y: number): Match | null {
  for (const line of lines) {
    const i = line.boxes.findIndex((b) => b && x >= b.x - 0.5 && x <= b.x + b.width + 0.5 && y >= b.y && y <= b.y + b.height)
    if (i < 0) continue
    let s = i
    let e = i + 1
    while (s > 0 && line.boxes[s - 1]) s--
    while (e < line.text.length && line.boxes[e]) e++
    const rect = rangeRect(line, s, e)
    if (rect) return { text: line.text.slice(s, e), rect }
  }
  return null
}

/** Text whose glyph centres lie inside a rectangle (to describe area marks). */
export function textIn(lines: SearchLine[], r: PtRect): string {
  const parts: string[] = []
  for (const line of lines) {
    let s = ''
    line.boxes.forEach((b, i) => {
      if (!b) {
        if (s && !s.endsWith(' ')) s += ' '
        return
      }
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height) s += line.text[i]
    })
    if (s.trim()) parts.push(s.trim())
  }
  return parts.join(' ')
}
