import type { PDFPageProxy } from 'pdfjs-dist'
import { loadPdfJs } from '@/lib/pdf/pdfjs'

/**
 * Every glyph pdf.js draws on a page, with its exact position, font, size, spacing and colour,
 * read from the operator list with the same maths as pdf.js' canvas renderer (showText):
 * glyph origin = CTM · Tm · (x + advance·Th, y + rise), advance = w·size·fontMatrix + Tc (+ Tw).
 * Page space = pdf.js viewport space at scale 1 (the CTM starts with the viewport transform).
 */

export interface CapturedGlyph {
  uni: string
  code: number
  fontChar: string
  /** Width in glyph units (×fontMatrix → em), without spacing. */
  w: number
  space: boolean
  /** pdf.js font id. */
  font: string
  /** Origin (page space) of the glyph on its baseline *with* rise, and the rise itself (+ up). */
  x: number
  y: number
  rise: number
  /** Advance to the next glyph (spacing included), font size, horizontal scale of shapes. */
  adv: number
  size: number
  hScale: number
  charSpacing: number
  wordSpacing: number
  color: string
  /** Fill opacity (ExtGState ca). */
  alpha: number
  mode: number
  /** Baseline runs left-to-right with no rotation or mirroring (only these are editable). */
  upright: boolean
}

export interface CapturedFont {
  id: string
  name: string
  missingFile: boolean
  type3: boolean
  composite: boolean
  vertical: boolean
  fontMatrix: number
  bold: boolean
  italic: boolean
  black: boolean
  serif: boolean
  ascent: number
  descent: number
}

type M = [number, number, number, number, number, number]
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]
const ID: M = [1, 0, 0, 1, 0, 0]

interface State {
  ctm: M
  tm: M
  x: number
  y: number
  lineX: number
  lineY: number
  font: string | null
  size: number
  dir: number
  charSpacing: number
  wordSpacing: number
  hScale: number
  leading: number
  rise: number
  mode: number
  color: string
  alpha: number
}

const hex = (v: number) =>
  Math.round(Math.min(255, Math.max(0, v)))
    .toString(16)
    .padStart(2, '0')

function toColor(arg: unknown): string | null {
  if (typeof arg === 'string' && /^#[0-9a-f]{6}$/i.test(arg)) return arg.toLowerCase()
  if (Array.isArray(arg) || ArrayBuffer.isView(arg)) {
    const a = Array.from(arg as ArrayLike<number>)
    if (a.length >= 3) return '#' + a.slice(0, 3).map(hex).join('')
  }
  return null
}

export async function captureGlyphs(page: PDFPageProxy): Promise<{ glyphs: CapturedGlyph[]; fonts: Map<string, CapturedFont> }> {
  const { OPS } = await loadPdfJs()
  const ops = await page.getOperatorList()
  const vp = page.getViewport({ scale: 1 })
  const fonts = new Map<string, CapturedFont>()
  const glyphs: CapturedGlyph[] = []

  const fontInfo = (id: string): CapturedFont | null => {
    let f = fonts.get(id)
    if (f) return f
    let o: Record<string, unknown>
    try {
      o = page.commonObjs.get(id) as Record<string, unknown>
    } catch {
      return null
    }
    if (!o) return null
    const fm = (o.fontMatrix as number[] | undefined) ?? [0.001, 0, 0, 0.001, 0, 0]
    f = {
      id,
      name: String(o.name ?? ''),
      missingFile: !!o.missingFile,
      type3: !!o.isType3Font,
      composite: !!o.composite,
      vertical: !!o.vertical,
      fontMatrix: fm[0] || 0.001,
      bold: !!o.bold,
      italic: !!o.italic,
      black: !!o.black,
      serif: !!o.isSerifFont || o.fallbackName === 'serif',
      ascent: typeof o.ascent === 'number' && o.ascent > 0.4 && o.ascent < 1.5 ? o.ascent : 0.8,
      descent: typeof o.descent === 'number' && o.descent < 0 && o.descent > -0.6 ? -o.descent : 0.22,
    }
    fonts.set(id, f)
    return f
  }

  let s: State = {
    ctm: vp.transform as M,
    tm: ID,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    font: null,
    size: 0,
    dir: 1,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    mode: 0,
    color: '#000000',
    alpha: 1,
  }
  const stack: State[] = []
  const moveText = (x: number, y: number) => {
    s.x = s.lineX += x
    s.y = s.lineY += y
  }

  const show = (items: unknown[]) => {
    const font = s.font ? fontInfo(s.font) : null
    if (!font || !s.size) return
    const th = s.hScale * s.dir
    const widthScale = s.size * font.fontMatrix
    const m = mul(s.ctm, s.tm)
    // Page-space lengths of one text-space unit along the baseline (with Th) and up.
    const hx = m[0] * th
    const hy = m[1] * th
    const hlen = Math.hypot(hx, hy)
    const vlen = Math.hypot(m[2], m[3])
    const pageSize = s.size * vlen
    // Upright: baseline points right (+x), "up" points to -y in page space, little skew.
    const upright = hx > 0 && Math.abs(hy) < 0.035 * hx && m[3] < 0 && Math.abs(m[2]) < 0.035 * -m[3] && !font.vertical
    let x = 0
    for (const g of items) {
      if (typeof g === 'number') {
        x += (-g * s.size) / 1000
        continue
      }
      if (!g || typeof g !== 'object') continue
      const glyph = g as { unicode?: string; fontChar?: string; width?: number; isSpace?: boolean; originalCharCode?: number }
      const space = !!glyph.isSpace
      const w = glyph.width ?? 0
      const spacing = (space ? s.wordSpacing : 0) + s.charSpacing
      const advText = w * widthScale + spacing * s.dir
      const tx = s.x + x * th
      const ty = s.y + s.rise
      const px = m[0] * tx + m[2] * ty + m[4]
      const py = m[1] * tx + m[3] * ty + m[5]
      glyphs.push({
        uni: glyph.unicode ?? '',
        code: glyph.originalCharCode ?? 0,
        fontChar: glyph.fontChar ?? '',
        w,
        space,
        font: font.id,
        x: px,
        y: py,
        rise: s.rise * vlen,
        adv: advText * hlen,
        size: pageSize,
        hScale: vlen ? hlen / vlen : 1,
        charSpacing: s.charSpacing * hlen,
        wordSpacing: s.wordSpacing * hlen,
        color: s.color,
        alpha: s.alpha,
        mode: s.mode,
        upright,
      })
      x += advText
    }
    s.x += x * th
  }

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const a = ops.argsArray[i] as unknown[]
    switch (fn) {
      case OPS.save:
      case OPS.paintFormXObjectBegin:
        stack.push({ ...s })
        if (fn === OPS.paintFormXObjectBegin && Array.isArray(a?.[0]) && (a[0] as number[]).length === 6) s.ctm = mul(s.ctm, a[0] as M)
        break
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
        s = stack.pop() ?? s
        break
      case OPS.transform:
        s.ctm = mul(s.ctm, (Array.isArray(a[0]) ? a[0] : a) as M)
        break
      case OPS.beginText:
        s.tm = ID
        s.x = s.lineX = s.y = s.lineY = 0
        break
      case OPS.setFont: {
        s.font = a[0] as string
        const size = a[1] as number
        s.dir = size < 0 ? -1 : 1
        s.size = Math.abs(size)
        break
      }
      case OPS.setCharSpacing:
        s.charSpacing = a[0] as number
        break
      case OPS.setWordSpacing:
        s.wordSpacing = a[0] as number
        break
      case OPS.setHScale:
        s.hScale = (a[0] as number) / 100
        break
      case OPS.setLeading:
        s.leading = -(a[0] as number)
        break
      case OPS.setTextRise:
        s.rise = a[0] as number
        break
      case OPS.setTextRenderingMode:
        s.mode = a[0] as number
        break
      case OPS.moveText:
        moveText(a[0] as number, a[1] as number)
        break
      case OPS.setLeadingMoveText:
        s.leading = a[1] as number
        moveText(a[0] as number, a[1] as number)
        break
      case OPS.setTextMatrix: {
        const tm = (Array.isArray(a[0]) || ArrayBuffer.isView(a[0]) ? Array.from(a[0] as ArrayLike<number>) : a) as M
        s.tm = [tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]]
        // Exactly like pdf.js' canvas: only x is reset.
        s.x = s.lineX = 0
        break
      }
      case OPS.nextLine:
        moveText(0, s.leading)
        break
      case OPS.showText:
      case OPS.showSpacedText:
        show(a[0] as unknown[])
        break
      case OPS.nextLineShowText:
        moveText(0, s.leading)
        show(a[0] as unknown[])
        break
      case OPS.nextLineSetSpacingShowText:
        s.wordSpacing = a[0] as number
        s.charSpacing = a[1] as number
        moveText(0, s.leading)
        show(a[2] as unknown[])
        break
      case OPS.setGState:
        for (const [k, v] of (a[0] as [string, unknown][]) ?? []) {
          if (k === 'ca' && typeof v === 'number') s.alpha = v
          else if (k === 'Font' && Array.isArray(v)) {
            s.font = v[0] as string
            s.dir = (v[1] as number) < 0 ? -1 : 1
            s.size = Math.abs(v[1] as number)
          }
        }
        break
      case OPS.setFillRGBColor: {
        const c = toColor(a.length === 1 ? a[0] : a)
        if (c) s.color = c
        break
      }
      case OPS.setFillGray: {
        const v = (a[0] as number) * 255
        s.color = '#' + hex(v).repeat(3)
        break
      }
      case OPS.setFillCMYKColor: {
        const [c, mm, y, k] = a as number[]
        s.color = '#' + [c, mm, y].map((v) => hex(255 * (1 - v) * (1 - k))).join('')
        break
      }
    }
  }
  return { glyphs, fonts }
}
