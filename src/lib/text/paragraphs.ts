import type { ParaAlign } from '@/types'
import type { CapturedLine } from './lines'

/**
 * Groups detected lines into paragraphs (Phase 5). Two lines belong together when they are in the
 * same column, set in the same dominant font and size, at a steady leading with no extra gap, and the
 * lower one doesn't start a list item. Lines after the first share a left edge (or a centre / right
 * edge for centred and right-aligned text); the first line may be indented or hang (bullets).
 */

export interface ParaLine {
  source?: CapturedLine
  ocr: boolean
}

export interface ParaGroup {
  /** Rows top to bottom, each the indices (into the input) of the pieces on that baseline. */
  members: number[][]
  align: ParaAlign
  left: number
  right: number
  firstLeft: number
  leading: number
}

const BULLET = /^\s*(?:[•◦▪‣∙·●○■□➢➤►–—*-]\s|\(?\d{1,3}[.)]\s|\(?[a-zA-Z][.)]\s|\(?[ivxIVX]{1,4}[.)]\s)/
const median = (a: number[]) => {
  const s = a.slice().sort((p, q) => p - q)
  return s.length ? s[s.length >> 1] : 0
}

interface Info {
  i: number[]
  line: CapturedLine
  /** Text of the row's last piece (sentence end). */
  tail: string
  left: number
  right: number
  base: number
  size: number
  font: string
}

function dominantFont(l: CapturedLine) {
  const counts = new Map<number, number>()
  for (const g of l.glyphs) if (g.uni.trim()) counts.set(g.run, (counts.get(g.run) ?? 0) + 1)
  const run = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  return l.runs[run]?.baseFont || l.runs[run]?.loadedName || ''
}

const cache = new WeakMap<readonly ParaLine[], ParaGroup[]>()

export function groupParagraphs(blocks: readonly ParaLine[]): ParaGroup[] {
  const hit = cache.get(blocks)
  if (hit) return hit
  const pieces: Info[] = []
  blocks.forEach((b, i) => {
    const l = b.source
    if (!l || b.ocr || !l.text.trim()) return
    pieces.push({ i: [i], line: l, tail: l.text, left: l.box.x, right: l.box.x + l.box.width, base: l.baseline, size: l.size, font: dominantFont(l) })
  })
  pieces.sort((a, b) => a.base - b.base || a.left - b.left)
  // Pieces of one row (a line the text capture split, e.g. complex-script glyphs drawn out of order):
  // same baseline, same size, touching or overlapping.
  const infos: Info[] = []
  for (const p of pieces) {
    const row = infos.find((r) => Math.abs(r.base - p.base) < 0.5 && Math.abs(r.size - p.size) <= 0.08 * r.size && p.left - r.right < 1.5 * p.size && r.left - p.right < 1.5 * p.size)
    if (row) {
      row.i.push(...p.i)
      if (p.left >= row.left) row.tail = p.tail
      row.left = Math.min(row.left, p.left)
      row.right = Math.max(row.right, p.right)
    } else infos.push({ ...p, i: [...p.i] })
  }

  const paras: Info[][] = []
  for (const L of infos) {
    let best: Info[] | null = null
    let bestGap = Infinity
    for (const P of paras) {
      const Q = P[P.length - 1]
      const gap = L.base - Q.base
      if (gap <= 0.3 * L.size || gap > 2.2 * L.size) continue
      if (Math.abs(L.size - Q.size) > 0.08 * Math.max(L.size, Q.size) || L.font !== Q.font) continue
      if (BULLET.test(L.line.text)) continue
      // Same column: the new line overlaps the paragraph's horizontal span.
      const colL = Math.min(...P.map((p) => p.left))
      const colR = Math.max(...P.map((p) => p.right))
      const ov = Math.min(colR, L.right) - Math.max(colL, L.left)
      if (ov < 0.5 * Math.min(L.right - L.left, colR - colL)) continue
      if (P.length >= 2) {
        const lead = median(P.slice(1).map((p, k) => p.base - P[k].base))
        if (Math.abs(gap - lead) > 0.12 * lead + 0.3) continue
        const lefts = P.slice(1).map((p) => p.left)
        const sameLeft = lefts.every((x) => Math.abs(x - lefts[0]) <= 1.5) && Math.abs(L.left - lefts[0]) <= 1.5
        const sameRight = P.every((p) => Math.abs(p.right - P[0].right) <= 1.5) && Math.abs(L.right - P[0].right) <= 1.5
        const c = (p: Info) => (p.left + p.right) / 2
        const sameCentre = P.every((p) => Math.abs(c(p) - c(P[0])) <= 1.5) && Math.abs(c(L) - c(P[0])) <= 1.5
        if (!sameLeft && !sameRight && !sameCentre) continue
        // A short line ending a sentence closes a left-aligned paragraph.
        if (sameLeft && /[.!?:]\s*$/.test(Q.tail) && Q.right < colR - 0.25 * (colR - colL)) continue
      } else {
        if (gap < 0.95 * L.size || gap > 1.9 * L.size) continue
        // The second line starts within a few ems of the first (indent, hanging bullet) or shares
        // its centre / right edge.
        const c = (p: Info) => (p.left + p.right) / 2
        const near = Math.abs(L.left - Q.left) <= 6 * L.size || Math.abs(c(L) - c(Q)) <= 1.5 || Math.abs(L.right - Q.right) <= 1.5
        if (!near) continue
        if (/[.!?:]\s*$/.test(Q.tail) && Q.right < L.right - 0.25 * (L.right - L.left)) continue
      }
      if (gap < bestGap) {
        bestGap = gap
        best = P
      }
    }
    if (best) best.push(L)
    else paras.push([L])
  }

  const out: ParaGroup[] = paras.map((P) => {
    const n = P.length
    const right = Math.max(...P.map((p) => p.right))
    const rest = n > 1 ? P.slice(1) : P
    const left = n > 1 ? median(rest.map((p) => p.left)) : P[0].left
    const leading = n > 1 ? median(P.slice(1).map((p, k) => p.base - P[k].base)) : P[0].size * 1.2
    let align: ParaAlign = 'left'
    if (n > 1) {
      const sameLeft = rest.every((p) => Math.abs(p.left - left) <= 1.5)
      const body = P.slice(0, -1)
      const fullRight = body.every((p) => Math.abs(p.right - right) <= 1.5)
      if (sameLeft && fullRight && (body.every((p) => p.line.justified) || n >= 3)) align = 'justify'
      else if (!sameLeft) {
        const c = (p: Info) => (p.left + p.right) / 2
        if (P.every((p) => Math.abs(p.right - right) <= 1.5)) align = 'right'
        else if (P.every((p) => Math.abs(c(p) - c(P[0])) <= 1.5)) align = 'center'
      }
    }
    return { members: P.map((p) => p.i), align, left, right, firstLeft: P[0].left, leading }
  })
  cache.set(blocks, out)
  return out
}

/** The paragraph a line belongs to (null for a single line). */
export function paragraphOf(blocks: readonly ParaLine[], index: number): ParaGroup | null {
  const g = groupParagraphs(blocks).find((p) => p.members.some((row) => row.includes(index)))
  return g && g.members.length > 1 ? g : null
}
