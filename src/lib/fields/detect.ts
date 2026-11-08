import type { PDFPageProxy } from 'pdfjs-dist'
import { loadPdfJs } from '@/lib/pdf/pdfjs'
import type { SearchLine } from '@/lib/redact/find'
import type { PtRect } from '@/types'

/**
 * Flat form → fillable (Phase 6): where a printed form expects answers. From the page's drawings —
 * thin horizontal lines (write-on lines), empty rectangles (boxes), small squares (tick boxes) — and
 * from runs of underscores in the text. Lines under printed text (underlined words, links), boxes
 * with text inside (table cells) and page-wide rules are not fields. Each suggestion gets a name
 * from the label to its left ("Name:" → "Name").
 */

export interface FieldSuggestion {
  fieldType: 'text' | 'checkbox'
  rect: PtRect
  name: string
  multiline?: boolean
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

interface Shape {
  box: PtRect
  stroke: boolean
}

async function shapes(page: PDFPageProxy, rotation: number): Promise<Shape[]> {
  const { OPS } = await loadPdfJs()
  const ops = await page.getOperatorList({ annotationMode: 0 })
  const vp = page.getViewport({ scale: 1, rotation })
  let ctm = vp.transform as M
  const stack: M[] = []
  const out: Shape[] = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const a = ops.argsArray[i] as unknown[]
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      if (fn === OPS.paintFormXObjectBegin && Array.isArray(a?.[0]) && (a[0] as number[]).length === 6) ctm = mul(ctm, a[0] as M)
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mul(ctm, a as M)
    else if (fn === OPS.constructPath) {
      const op = a[0] as number
      const mm = a[2] as ArrayLike<number> | null
      if (!mm || mm.length < 4) continue
      const pts = [
        [mm[0], mm[1]],
        [mm[2], mm[1]],
        [mm[0], mm[3]],
        [mm[2], mm[3]],
      ].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]])
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const stroke = op === OPS.stroke || op === OPS.closeStroke || op === OPS.fillStroke || op === OPS.closeFillStroke || op === OPS.eoFillStroke
      if (op === OPS.endPath) continue // clip only
      out.push({ box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }, stroke })
    }
  }
  return out
}

const overlapX = (a: PtRect, b: PtRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
const inside = (b: { x: number; y: number; width: number; height: number }, r: PtRect) => b.x + b.width / 2 > r.x && b.x + b.width / 2 < r.x + r.width && b.y + b.height / 2 > r.y && b.y + b.height / 2 < r.y + r.height

/** The label printed just left of a field on the same line ("Date of birth:" → "Date of birth"). */
function labelFor(lines: SearchLine[], r: PtRect): string {
  const cy = r.y + r.height / 2
  let best = ''
  let bestX = -Infinity
  for (const l of lines) {
    const boxes = l.boxes.filter((b) => b) as { x: number; y: number; width: number; height: number }[]
    if (!boxes.length) continue
    const top = Math.min(...boxes.map((b) => b.y))
    const bottom = Math.max(...boxes.map((b) => b.y + b.height))
    if (cy < top - 6 || cy > bottom + 10) continue
    // Characters ending left of the field, within 220 pt.
    let s = ''
    let endX = -Infinity
    l.boxes.forEach((b, i) => {
      if (b && b.x + b.width <= r.x + 2 && b.x > r.x - 220) {
        s += l.text[i]
        endX = Math.max(endX, b.x + b.width)
      } else if (!b && s) s += ' '
    })
    s = s.replace(/_+/g, ' ').trim()
    if (s && endX > bestX) {
      bestX = endX
      best = s
    }
  }
  // The last phrase before the field: after a previous field / big gap the label restarts.
  const parts = best.split(/\s{2,}|[:：]\s+(?=\S)/)
  const left = (parts[parts.length - 1] ?? '').replace(/[:：*\s]+$/, '').slice(0, 40).trim()
  if (left) return left
  // Else a label just above the field's top-left corner (answer boxes).
  for (const l of lines) {
    const boxes = l.boxes.filter((b) => b) as { x: number; y: number; width: number; height: number }[]
    if (!boxes.length) continue
    const bottom = Math.max(...boxes.map((b) => b.y + b.height))
    const x0 = Math.min(...boxes.map((b) => b.x))
    if (bottom <= r.y + 1 && bottom > r.y - 18 && Math.abs(x0 - r.x) < 24) return l.text.replace(/_+/g, ' ').replace(/[:：*\s]+$/, '').slice(0, 40).trim()
  }
  return ''
}

/** Tick boxes are labelled on their right ("☐ I agree to the terms"). */
function labelRight(lines: SearchLine[], r: PtRect): string {
  const cy = r.y + r.height / 2
  for (const l of lines) {
    let s = ''
    let started = false
    l.boxes.forEach((b, i) => {
      if (b && b.x >= r.x + r.width - 1 && b.x < r.x + r.width + 14 && Math.abs(b.y + b.height / 2 - cy) < r.height) started = true
      if (started && (!b || b.x >= r.x + r.width - 1)) s += l.text[i]
    })
    const t = s.replace(/_+/g, ' ').trim()
    if (t) return t.split(/\s{2,}/)[0].slice(0, 40).trim()
  }
  return ''
}

export async function detectFields(page: PDFPageProxy, rotation: number, lines: SearchLine[], pageWidth: number): Promise<FieldSuggestion[]> {
  const glyphs = lines.flatMap((l) => l.boxes.filter((b) => b)) as PtRect[]
  const out: FieldSuggestion[] = []
  const taken = (r: PtRect) => out.some((o) => Math.abs(o.rect.x - r.x) < 3 && Math.abs(o.rect.y - r.y) < 3 && Math.abs(o.rect.width - r.width) < 6)
  const add = (s: FieldSuggestion) => !taken(s.rect) && out.push(s)
  const textSize = 11

  for (const { box: b, stroke } of await shapes(page, rotation)) {
    // Tick boxes: small squares.
    if (b.width >= 6 && b.width <= 20 && Math.abs(b.width - b.height) < 2.5 && !glyphs.some((g) => inside(g, b))) {
      add({ fieldType: 'checkbox', rect: { x: b.x, y: b.y, width: b.width, height: b.height }, name: '' })
      continue
    }
    // Write-on lines: thin, long enough, not page-wide rules, not under printed text.
    if (b.height <= 1.8 && b.width >= 36 && b.width < 0.85 * pageWidth) {
      const underText = glyphs.some((g) => overlapX(g, b) > 0.3 * g.width && b.y - (g.y + g.height) < 4 && b.y - (g.y + g.height) > -2)
      if (underText) continue
      add({ fieldType: 'text', rect: { x: b.x, y: b.y - textSize * 1.35, width: b.width, height: textSize * 1.35 }, name: '' })
      continue
    }
    // Answer boxes: empty stroked rectangles of a text field's size.
    if (stroke && b.height >= 12 && b.height <= 140 && b.width >= 30 && b.width < 0.95 * pageWidth && !glyphs.some((g) => inside(g, b))) {
      add({ fieldType: 'text', rect: { x: b.x + 1, y: b.y + 1, width: b.width - 2, height: b.height - 2 }, name: '', multiline: b.height > 34 })
    }
  }
  // Underscore runs in the text ("Name: ________").
  for (const l of lines) {
    const re = /_{4,}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(l.text))) {
      const bs = l.boxes.slice(m.index, m.index + m[0].length).filter((b) => b) as PtRect[]
      if (!bs.length) continue
      const x0 = Math.min(...bs.map((b) => b.x))
      const x1 = Math.max(...bs.map((b) => b.x + b.width))
      const bottom = Math.max(...bs.map((b) => b.y + b.height))
      const h = Math.max(...bs.map((b) => b.height))
      add({ fieldType: 'text', rect: { x: x0, y: bottom - h, width: x1 - x0, height: h }, name: '' })
    }
  }
  out.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  const used = new Map<string, number>()
  out.forEach((s, i) => {
    const base = (s.fieldType === 'checkbox' ? labelRight(lines, s.rect) : '') || labelFor(lines, s.rect) || (s.fieldType === 'checkbox' ? 'Check box' : 'Field') + ` ${i + 1}`
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    s.name = n > 1 ? `${base} ${n}` : base
  })
  return out
}
