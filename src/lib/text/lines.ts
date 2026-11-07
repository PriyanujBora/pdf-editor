import type { FontFamilyId, OriginalFont, PtRect, SourceGlyph, SourceLine, SourceRun } from '@/types'
import type { CapturedFont, CapturedGlyph } from './capture'
import { chooseFallback, type FontTraits } from './fallback'

/**
 * Groups captured glyphs into editable lines with styled runs. Unlike pdf.js text items this keeps
 * every glyph's own position, font, colour and spacing, so an edit can leave unchanged words exactly
 * as printed. Spaces the PDF never drew are inferred from gaps *beyond the line's own letter
 * spacing*, so letter-spaced headings don't turn into "Q U A R T E R L Y".
 */

export type CapturedLine = Omit<SourceLine, 'background' | 'fonts'> & { size: number; family: FontFamilyId; bold: boolean; italic: boolean; color: string }

interface G extends CapturedGlyph {
  /** Baseline without rise (page y, down). */
  base: number
}

const median = (v: number[]) => {
  if (!v.length) return 0
  const a = v.slice().sort((x, y) => x - y)
  return a[a.length >> 1]
}
const isMark = (s: string) => /^\p{M}/u.test(s)
const isIndic = (s: string) => /[ऀ-෿]/.test(s)
// By Unicode only: pdf.js sets `isSpace` for char code 32, which a Type3 font may use for "o" (Tw still
// applies to that code — the capture keeps `space` for spacing maths).
const isBlank = (g: CapturedGlyph) => !!g.uni && !g.uni.trim()
const SYMBOL = /symbol|dingbat|wingding|webding|marlett/i

function segmentsOf(glyphs: G[]): G[][] {
  const segs: G[][] = []
  let cur: G[] = []
  for (const g of glyphs) {
    const prev = cur[cur.length - 1]
    if (prev) {
      const size = Math.max(prev.size, g.size)
      const gap = g.x - (prev.x + prev.adv)
      if (Math.abs(g.base - prev.base) > 0.2 * size || gap < -0.6 * size || gap > 1.5 * size) {
        segs.push(cur)
        cur = []
      }
    }
    cur.push(g)
  }
  if (cur.length) segs.push(cur)
  return segs
}

const segStart = (s: G[]) => Math.min(...s.map((g) => g.x))
const segEnd = (s: G[]) => Math.max(...s.map((g) => g.x + g.adv))
const segBase = (s: G[]) => median(s.map((g) => g.base))
const segSize = (s: G[]) => median(s.map((g) => g.size))

/** Rows by baseline, then split into lines at column-sized gaps. */
function linesOf(segs: G[][]): G[][] {
  const rows: G[][][] = []
  for (const seg of segs) {
    const base = segBase(seg)
    const size = segSize(seg)
    const row = rows.find((r) => Math.abs(segBase(r[0]) - base) < 0.25 * Math.max(size, segSize(r[0])))
    if (row) row.push(seg)
    else rows.push([seg])
  }
  const lines: G[][] = []
  for (const row of rows) {
    row.sort((a, b) => segStart(a) - segStart(b))
    let cur: G[] = []
    let end = -Infinity
    for (const seg of row) {
      const size = Math.max(segSize(seg), cur.length ? segSize(cur) : 0)
      const gap = segStart(seg) - end
      if (cur.length && (gap > 1.2 * size || gap < -0.5 * size)) {
        lines.push(cur)
        cur = []
      }
      cur = cur.concat(seg)
      end = Math.max(end, segEnd(seg))
    }
    if (cur.length) lines.push(cur)
  }
  return lines
}

/** Small raised/lowered runs next to a line (Word-style superscripts) become part of it. */
function mergeScripts(lines: G[][]): G[][] {
  const out = lines.map((l) => l.slice())
  const dead = new Set<number>()
  for (let i = 0; i < out.length; i++) {
    const small = out[i]
    const size = segSize(small)
    const base = segBase(small)
    if (small.length > 6) continue
    let host = -1
    for (let j = 0; j < out.length; j++) {
      if (j === i || dead.has(j)) continue
      const main = out[j]
      const ms = segSize(main)
      const mb = segBase(main)
      const up = mb - base
      const sup = up > 0.15 * ms && up < 0.6 * ms
      const sub = up < -0.05 * ms && up > -0.35 * ms
      if (size > 0.85 * ms || !(sup || sub)) continue
      if (segStart(small) < segStart(main) - 0.2 * ms || segStart(small) > segEnd(main) + 0.6 * ms) continue
      host = j
      break
    }
    if (host < 0) continue
    const main = out[host]
    const mb = segBase(main)
    for (const g of small) {
      const k = main.findIndex((m) => m.x > g.x)
      const shifted = { ...g, rise: g.rise + (mb - g.base), base: mb }
      if (k < 0) main.push(shifted)
      else main.splice(k, 0, shifted)
    }
    dead.add(i)
  }
  return out.filter((_, i) => !dead.has(i))
}

export function buildLines(
  captured: CapturedGlyph[],
  fonts: Map<string, CapturedFont>,
): CapturedLine[] {
  const glyphs: G[] = captured
    .filter((g) => g.upright && g.mode !== 3 && g.mode !== 7 && g.size >= 1 && (g.uni !== '' || g.w > 0))
    // Some fonts map glyphs to control characters (newlines in Canva-style Type3 fonts): not text.
    // oxlint-disable-next-line no-control-regex
    .map((g) => ({ ...g, uni: g.uni.replace(/[\u0000-\u001f\u007f]/g, ''), base: g.y + g.rise }))

  // Per font: widths it drew (for choosing a stand-in) → traits.
  const widthsByFont = new Map<string, Map<string, number>>()
  for (const g of glyphs) {
    if ([...g.uni].length !== 1 || isBlank(g)) continue
    const f = fonts.get(g.font)
    let m = widthsByFont.get(g.font)
    if (!m) widthsByFont.set(g.font, (m = new Map()))
    if (!m.has(g.uni)) m.set(g.uni, g.w * (f?.fontMatrix ?? 0.001) * 1000)
  }
  const traits = new Map<string, FontTraits>()
  const traitsOf = (id: string) => {
    let t = traits.get(id)
    if (!t) {
      const f = fonts.get(id)
      t = chooseFallback(f?.name ?? '', widthsByFont.get(id) ?? new Map(), {
        bold: f?.bold,
        italic: f?.italic,
        black: f?.black,
        serif: f?.serif,
      })
      traits.set(id, t)
    }
    return t
  }

  const result: CapturedLine[] = []
  for (const line of mergeScripts(linesOf(segmentsOf(glyphs)))) {
    const visible = line.filter((g) => !isBlank(g))
    if (!visible.length) continue
    const sizeAll = median(visible.map((g) => g.size))

    // Letter spacing of this line: the typical gap between neighbouring letters.
    const letterGaps: number[] = []
    for (let i = 1; i < line.length; i++) {
      const p = line[i - 1]
      const g = line[i]
      if (isBlank(p) || isBlank(g)) continue
      const gap = g.x - (p.x + p.adv)
      if (Math.abs(gap) < 0.5 * sizeAll) letterGaps.push(gap)
    }
    const letterGap = Math.max(-0.1 * sizeAll, Math.min(0.4 * sizeAll, median(letterGaps)))

    // Runs.
    const runs: SourceRun[] = []
    const runKeys = new Map<string, number>()
    const runOf = (g: G) => {
      const key = [g.font, g.size.toFixed(2), g.color, g.alpha.toFixed(2), g.rise.toFixed(1), g.charSpacing.toFixed(2), g.wordSpacing.toFixed(2), g.hScale.toFixed(3)].join('|')
      let r = runKeys.get(key)
      if (r === undefined) {
        const f = fonts.get(g.font)
        const t = traitsOf(g.font)
        r = runs.length
        runs.push({
          loadedName: g.font,
          baseFont: f?.name ?? '',
          composite: !!f?.composite,
          type3: !!f?.type3,
          embedded: !!f && !f.missingFile && !f.type3,
          size: g.size,
          hScale: g.hScale,
          fontMatrix: f?.fontMatrix ?? 0.001,
          charSpacing: g.charSpacing,
          wordSpacing: g.wordSpacing,
          rise: g.rise,
          color: g.color,
          alpha: g.alpha,
          bold: t.bold,
          italic: t.italic,
          family: t.family,
          familyScale: t.scale,
        })
        runKeys.set(key, r)
      }
      return r
    }

    // Text with inferred spaces.
    const outGlyphs: SourceGlyph[] = []
    const charGlyph: number[] = []
    let text = ''
    const wordGaps: number[] = []
    let gapStart: number | null = null
    for (let i = 0; i < line.length; i++) {
      const g = line[i]
      const prev = line[i - 1]
      const run = runOf(g)
      if (prev && !isBlank(prev) && !isBlank(g)) {
        const gap = g.x - (prev.x + prev.adv)
        const indic = isIndic(prev.uni) || isIndic(g.uni)
        const threshold = letterGap + (indic ? 0.3 : 0.15) * Math.max(prev.size, g.size)
        if (gap > threshold && !isMark(g.uni) && !/\s$/.test(text)) {
          text += ' '
          charGlyph.push(-1)
          wordGaps.push(gap)
        }
      }
      if (isBlank(g)) {
        if (gapStart === null && prev && !isBlank(prev)) gapStart = prev.x + prev.adv
      } else if (gapStart !== null) {
        wordGaps.push(g.x - gapStart)
        gapStart = null
      }
      const gi = outGlyphs.length
      outGlyphs.push({ uni: g.uni, x: g.x, adv: g.adv, run, code: g.code, fontChar: g.fontChar, w: g.w })
      const chars = isBlank(g) ? (/\s$/.test(text) || !text ? '' : ' ') : g.uni
      for (const ch of chars) {
        text += ch
        charGlyph.push(gi)
      }
    }
    for (const [ri, run] of runs.entries()) {
      if (!run.type3) continue
      const sig = new Map<number, number>()
      for (const g of outGlyphs) if (g.run === ri && sig.size < 8) sig.set(g.code, g.w)
      run.widthSig = [...sig]
    }
    // Trim inferred/trailing spaces at the ends.
    while (text.endsWith(' ')) {
      text = text.slice(0, -1)
      charGlyph.pop()
    }
    while (text.startsWith(' ')) {
      text = text.slice(1)
      charGlyph.shift()
    }
    if (!text.trim()) continue

    // Box (ink extent from font ascent/descent), base size and dominant style.
    let top = Infinity
    let bottom = -Infinity
    let x0 = Infinity
    let x1 = -Infinity
    const base = median(visible.map((g) => g.base))
    for (const g of line) {
      const f = fonts.get(g.font)
      const asc = f?.ascent ?? 0.8
      const desc = f?.descent ?? 0.22
      top = Math.min(top, g.base - g.rise - asc * g.size)
      bottom = Math.max(bottom, g.base - g.rise + desc * g.size)
      if (!isBlank(g)) {
        x0 = Math.min(x0, g.x)
        x1 = Math.max(x1, g.x + g.adv)
      }
    }
    const weight = new Map<number, number>()
    for (const g of visible) {
      const r = runOf(g)
      const run = runs[r]
      if (Math.abs(run.rise) > 0.05 * run.size || SYMBOL.test(run.baseFont)) continue
      weight.set(r, (weight.get(r) ?? 0) + [...g.uni].length)
    }
    const ranked = [...weight].sort((a, b) => b[1] - a[1])
    const main = runs[ranked[0]?.[0] ?? 0]
    // Character-weighted median size of the main runs (bullets/superscripts don't count).
    const sizes: number[] = []
    for (const [r, n] of weight) for (let k = 0; k < n; k++) sizes.push(runs[r].size)
    const size = median(sizes.length ? sizes : visible.map((g) => g.size))

    // Natural space: the font's own space glyph (without Tw), else a quarter em.
    const spaceGlyphs = line.filter((g) => g.uni === ' ')
    const natural =
      median(spaceGlyphs.map((g) => g.w * (fonts.get(g.font)?.fontMatrix ?? 0.001) * g.size * g.hScale)) || main.size * 0.25
    const spaceWidth = median(wordGaps) || natural
    const justified = wordGaps.length >= 3 && (median(wordGaps) > 1.45 * natural || spaceGlyphs.some((g) => g.wordSpacing > 0.3))

    const box: PtRect = { x: x0, y: top, width: Math.max(x1 - x0, size * 0.3), height: bottom - top }
    result.push({
      text,
      charGlyph,
      glyphs: outGlyphs,
      runs,
      baseline: base,
      box,
      spaceWidth,
      justified,
      size,
      family: main.family,
      bold: main.bold,
      italic: main.italic,
      color: main.color,
    })
  }
  return result
}

export type { OriginalFont }
