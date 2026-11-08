import type { SearchLine } from '@/lib/redact/find'
import type { AnnotElement, PtRect } from '@/types'

/**
 * Text selection for markup annotations (highlight, underline, strike): from the character nearest
 * the press to the one nearest the release, in reading order (lines top to bottom), one rectangle
 * per line. Uses the same glyph boxes as Find & redact.
 */

interface Pos {
  line: number
  char: number
}

function nearest(lines: SearchLine[], x: number, y: number): Pos | null {
  let best: Pos | null = null
  let bestD = Infinity
  lines.forEach((l, li) => {
    l.boxes.forEach((b, ci) => {
      if (!b) return
      const dy = y < b.y ? b.y - y : y > b.y + b.height ? y - b.y - b.height : 0
      const dx = x < b.x ? b.x - x : x > b.x + b.width ? x - b.x - b.width : 0
      // Vertical distance dominates: stay on the line under the pointer.
      const d = dy * 4 + dx
      if (d < bestD) {
        bestD = d
        // Past the middle of a glyph → the selection includes it.
        best = { line: li, char: x > b.x + b.width / 2 ? ci + 1 : ci }
      }
    })
  })
  return bestD < 40 ? best : null
}

export function selectText(lines: SearchLine[], x0: number, y0: number, x1: number, y1: number): { quads: PtRect[]; text: string } {
  // Reading order: by line top, then left.
  const order = lines.map((l, i) => ({ l, i, top: Math.min(...l.boxes.filter((b) => b).map((b) => b!.y)), left: Math.min(...l.boxes.filter((b) => b).map((b) => b!.x)) }))
  order.sort((a, b) => (Math.abs(a.top - b.top) < 2 ? a.left - b.left : a.top - b.top))
  const sorted = order.map((o) => o.l)
  let a = nearest(sorted, x0, y0)
  let b = nearest(sorted, x1, y1)
  if (!a || !b) return { quads: [], text: '' }
  if (b.line < a.line || (b.line === a.line && b.char < a.char)) [a, b] = [b, a]
  const quads: PtRect[] = []
  const parts: string[] = []
  for (let li = a.line; li <= b.line; li++) {
    const l = sorted[li]
    const from = li === a.line ? a.char : 0
    const to = li === b.line ? b.char : l.text.length
    let rx0 = Infinity
    let ry0 = Infinity
    let rx1 = -Infinity
    let ry1 = -Infinity
    for (let c = from; c < to; c++) {
      const box = l.boxes[c]
      if (!box) continue
      rx0 = Math.min(rx0, box.x)
      ry0 = Math.min(ry0, box.y)
      rx1 = Math.max(rx1, box.x + box.width)
      ry1 = Math.max(ry1, box.y + box.height)
    }
    if (!isFinite(rx0)) continue
    quads.push({ x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 })
    parts.push(l.text.slice(from, to).trim())
  }
  return { quads, text: parts.join(' ') }
}

/** Bounding box of absolute rectangles / point lists. */
export function bbox(rects: PtRect[], points: number[][] = [], pad = 0): PtRect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.width)
    y1 = Math.max(y1, r.y + r.height)
  }
  for (const s of points)
    for (let i = 0; i + 1 < s.length; i += 2) {
      x0 = Math.min(x0, s[i])
      y0 = Math.min(y0, s[i + 1])
      x1 = Math.max(x1, s[i])
      y1 = Math.max(y1, s[i + 1])
    }
  return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad }
}

export const ANNOT_COLORS = ['#ffd400', '#7ee081', '#5cc8ff', '#ff8fb1', '#e5484d', '#1d3fbf', '#111111']

export const ANNOT_LABEL: Record<AnnotElement['type'], string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'Strikethrough',
  note: 'Note',
  ink: 'Drawing',
  rect: 'Rectangle',
  arrow: 'Arrow',
}
