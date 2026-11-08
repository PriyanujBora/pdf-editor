import type { FontFamilyId, PtRect, SourceRun, TextElement } from '@/types'
import { layoutParagraph, lineOfGlyph } from './para-layout'

/**
 * Lays out an edited existing line (`TextElement.source`). Shared by the editor canvas and the
 * export worker — pure maths, the platform only supplies text measuring for bundled fonts.
 *
 * The edit is compared with the line as printed, word by word (LCS), then character by character
 * inside each replaced stretch:
 *  - printed glyphs that keep their place are not drawn or covered at all (the PDF's own glyphs stay);
 *  - printed glyphs that only shift (something before them changed width) are covered and drawn again
 *    with the same glyph of the same font at the new position;
 *  - new characters are laid out in the style of the text they replace: the PDF's own font where it
 *    has drawn that glyph, else the metric-compatible stand-in. They inherit the replaced text's
 *    spacing density (kerning, letter spacing, justification), so replacing a word by one with the
 *    same letters gives exactly the same width and nothing after it moves.
 * On justified lines any remaining width change is spread over the later word gaps.
 */

/** Advance of `text` in a bundled family at size 1 (em). */
export type Measure = (family: FontFamilyId, bold: boolean, italic: boolean, text: string) => number

export type LineDraw =
  | {
      kind: 'glyph'
      run: number
      code: number
      fontChar: string
      uni: string
      x: number
      /** Baseline y (page space), rise applied. */
      y: number
      /** Index of the source glyph when this is an original glyph that moved. */
      moved?: number
      /** Paragraph "Shrink to fit": the run's size times this. */
      scale?: number
    }
  | {
      kind: 'text'
      text: string
      family: FontFamilyId
      bold: boolean
      italic: boolean
      size: number
      hScale: number
      color: string
      x: number
      y: number
    }

export interface LineLayout {
  changed: boolean
  covers: PtRect[]
  draws: LineDraw[]
  /** x of every caret position 0…text.length (page space). */
  carets: number[]
  /** Vertical extent of the line (for caret and selection). */
  top: number
  bottom: number
  bounds: PtRect
  /** Characters drawn with a stand-in although the line has its own (embedded) font. */
  fallbackChars: string[]
  /** Printed ink glyphs that don't stay in place: the export removes them from the content stream. */
  gone: number[]
  /** Paragraphs: vertical band of each caret's line (else `top`/`bottom` for all). */
  caretBands?: { top: number; bottom: number }[]
  /** Paragraphs: number of lines after layout, and the area below the printed lines it now needs. */
  lines?: number
  overflow?: PtRect | null
}

/** Lays out an edited line or paragraph (`el.source.para`). */
export function layoutLine(el: TextElement, measure: Measure): LineLayout {
  return el.source?.para ? layoutParagraph(el, measure) : layoutSingleLine(el, measure)
}

/** Patches over printed glyphs (merged where they touch). Editor: all gone glyphs; export: only
 *  those the content-stream editor couldn't remove. */
export function coversFor(src: NonNullable<TextElement['source']>, glyphs: number[]): PtRect[] {
  const covers: PtRect[] = []
  const pad = 0.25
  // Paragraphs: each glyph is patched within its own printed line's band.
  const items = glyphs.map((i) => ({ g: src.glyphs[i], line: lineOfGlyph(src, i) })).sort((p, q) => p.line.baseline - q.line.baseline || p.g.x - q.g.x)
  for (const { g, line } of items) {
    const top = line.coverTop ?? line.box.y - pad
    const bottom = line.coverBottom ?? line.box.y + line.box.height + pad
    const r = { x: g.x - pad, y: top, width: g.adv + 2 * pad, height: bottom - top }
    const last = covers[covers.length - 1]
    if (last && Math.abs(last.y - r.y) < 0.01 && r.x <= last.x + last.width + 0.6) last.width = Math.max(last.width, r.x + r.width - last.x)
    else covers.push(r)
  }
  return covers
}

interface Tok {
  s: number
  e: number
  str: string
  space: boolean
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = []
  const re = /\s+|[^\s]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ s: m.index, e: m.index + m[0].length, str: m[0], space: /^\s/.test(m[0]) })
  return out
}

/** Longest common subsequence of token strings → for each `b` token, its `a` index or -1. */
function lcs(a: Tok[], b: Tok[]): number[] {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].str === b[j].str ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const match = new Array<number>(m).fill(-1)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i].str === b[j].str) {
      match[j] = i
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return match
}

const isIndic = (s: string) => /[ऀ-෿]/.test(s)
/** Shifts below this (1/50 px at 100 %) are float noise: the printed glyph stays. */
const EPS = 0.02

/** A stretch of the new line: printed characters at an offset, or freshly laid-out ones. */
type Piece =
  | { kind: 'src'; from: number; to: number; shift: number; space: boolean }
  | { kind: 'fresh'; x: number; draws: LineDraw[]; carets: number[]; spaces: number }

export function layoutSingleLine(el: TextElement, measure: Measure): LineLayout {
  const src = el.source!
  const dx = el.x - src.box.x
  const dy = el.y - src.box.y
  const text = el.text
  const st = tokenize(src.text)
  const ct = tokenize(text)
  const match = el.override ? new Array<number>(ct.length).fill(-1) : lcs(st, ct)
  const G = src.glyphs
  const n = src.text.length

  // --- Where each printed character starts ------------------------------------------------
  // Ink characters: their glyph's origin (ligatures split evenly). Whitespace: where the previous
  // ink ends — it spans the whole gap to the next ink, which is where the next character starts.
  const charX = new Array<number>(n + 1)
  let inkEnd = src.box.x
  for (let k = 0; k < n; k++) {
    const g = src.charGlyph[k]
    if (g >= 0 && src.text[k].trim()) {
      let first = k
      while (first > 0 && src.charGlyph[first - 1] === g) first--
      let cnt = 1
      while (src.charGlyph[first + cnt] === g) cnt++
      charX[k] = G[g].x + (G[g].adv * (k - first)) / cnt
      inkEnd = Math.max(inkEnd, G[g].x + G[g].adv)
    } else charX[k] = inkEnd
  }
  let lineEnd = src.box.x + src.box.width
  for (const g of G) if (g.uni.trim()) lineEnd = Math.max(lineEnd, g.x + g.adv)
  charX[n] = lineEnd
  /** Start of the next ink character at or after k (where whitespace before it ends). */
  const nextInk = (k: number) => {
    for (let i = k; i < n; i++) if (src.text[i].trim()) return charX[i]
    return lineEnd
  }

  // Main run: the one that draws most characters.
  const counts = new Map<number, number>()
  for (const g of G) counts.set(g.run, (counts.get(g.run) ?? 0) + [...g.uni].length)
  const mainRun = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  const runOfChar = (k: number) => (src.charGlyph[k] >= 0 && src.text[k].trim() ? G[src.charGlyph[k]].run : -1)
  /** Style for new text: the printed text it replaces, else the character before it, else after. */
  const styleFor = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (runOfChar(k) >= 0) return runOfChar(k)
    for (let k = from - 1; k >= 0; k--) if (runOfChar(k) >= 0) return runOfChar(k)
    for (let k = to; k < n; k++) if (runOfChar(k) >= 0) return runOfChar(k)
    return mainRun
  }

  const fallbackChars = new Set<string>()
  /** Lays out new characters in a run's style; `extra` is added after each character (spacing density). */
  const fresh = (str: string, runIdx: number, x0: number, extra: number, report = true) => {
    const run: SourceRun = src.runs[runIdx] ?? src.runs[mainRun]
    const fonts = src.fonts[run?.baseFont ?? '']
    const draws: LineDraw[] = []
    const carets: number[] = []
    let x = x0
    let spaces = 0
    const baseY = src.baseline - (el.override ? 0 : run.rise)
    const chars = [...str]
    for (let k = 0; k < chars.length; ) {
      carets.push(x)
      const ch = chars[k]
      if (ch.length === 2) carets.push(x)
      if (/\s/.test(ch)) {
        x += (el.override ? measure(el.font, el.bold, el.italic, ' ') * el.size : src.spaceWidth) + extra
        spaces++
        k++
        continue
      }
      let hit: [number, number, string] | undefined
      let len = 1
      // Any glyph the font has drawn (embedded or not — a non-embedded font's dictionary still gives
      // the viewer the same glyph and width), never Type3 (no FontFace to show it with).
      if (!el.override && !run.type3 && fonts && !isIndic(ch)) {
        for (let m = Math.min(3, chars.length - k); m >= 1 && !hit; m--) {
          hit = fonts.glyphs[chars.slice(k, k + m).join('')]
          len = m
        }
      }
      if (hit) {
        draws.push({ kind: 'glyph', run: runIdx, code: hit[0], fontChar: hit[2], uni: chars.slice(k, k + len).join(''), x, y: baseY })
        const adv = hit[1] * run.fontMatrix * run.size * run.hScale + run.charSpacing + extra * len
        for (let c = 1; c < len; c++) carets.push(x + (adv * c) / len)
        x += adv
        k += len
        continue
      }
      // Stand-in: one character at a time so editor and export place it identically, except complex
      // scripts, which must be shaped as a whole cluster run.
      let m = 1
      if (isIndic(ch)) while (k + m < chars.length && !/\s/.test(chars[k + m])) m++
      const piece = chars.slice(k, k + m).join('')
      const family = el.override ? el.font : run.family
      const bold = el.override ? el.bold : run.bold
      const italic = el.override ? el.italic : run.italic
      const size = el.override ? el.size : run.size * run.familyScale
      const hScale = el.override ? 1 : run.hScale
      const w = measure(family, bold, italic, piece) * size * hScale + (el.override ? 0 : run.charSpacing * m) + extra * m
      draws.push({ kind: 'text', text: piece, family, bold, italic, size, hScale, color: el.override ? el.color : run.color, x, y: baseY })
      if (report && !el.override && run.embedded) for (const c of piece) fallbackChars.add(c)
      for (let c = 1; c < piece.length; c++) carets.push(x + (w * c) / piece.length)
      x += w
      k += m
    }
    return { draws, carets, width: x - x0, spaces }
  }

  // --- Walk the new text ------------------------------------------------------------------
  const pieces: Piece[] = []
  let pen = n ? nextInk(0) : src.box.x
  let shift = 0
  let prevSrc = -1
  for (let j = 0; j < ct.length; j++) {
    const m = match[j]
    if (m >= 0) {
      if (m !== prevSrc + 1 || pieces.length === 0) shift = pen - charX[st[m].s]
      pieces.push({ kind: 'src', from: st[m].s, to: st[m].e, shift, space: st[m].space })
      pen = (m + 1 < st.length ? charX[st[m + 1].s] : lineEnd) + shift
      prevSrc = m
      continue
    }
    // A stretch of new tokens j..j2 replacing printed tokens a..b (possibly none).
    let j2 = j
    while (j2 + 1 < ct.length && match[j2 + 1] < 0) j2++
    const a = prevSrc + 1
    const b = (j2 + 1 < ct.length ? match[j2 + 1] : st.length) - 1
    const oldS = a <= b ? st[a].s : a < st.length ? st[a].s : n
    const oldE = a <= b ? st[b].e : oldS
    const old = src.text.slice(oldS, oldE)
    const cur = text.slice(ct[j].s, ct[j2].e)
    // Unchanged leading/trailing characters stay printed glyphs (only at glyph boundaries).
    let p = 0
    while (p < old.length && p < cur.length && old[p] === cur[p]) p++
    while (p > 0 && p < old.length && src.charGlyph[oldS + p - 1] >= 0 && src.charGlyph[oldS + p - 1] === src.charGlyph[oldS + p]) p--
    let q = 0
    while (q < old.length - p && q < cur.length - p && old[old.length - 1 - q] === cur[cur.length - 1 - q]) q++
    while (q > 0 && oldE - q > oldS && src.charGlyph[oldE - q] >= 0 && src.charGlyph[oldE - q] === src.charGlyph[oldE - q - 1]) q--
    const segShift = pen - (oldS < n ? charX[oldS] : lineEnd)
    if (p > 0) pieces.push({ kind: 'src', from: oldS, to: oldS + p, shift: segShift, space: false })
    const midS = oldS + p
    const midE = oldE - q
    const mid0 = midS < n ? charX[midS] : lineEnd
    // Where the replaced characters end: the next ink after them (or the line end).
    const mid1 = midE > midS ? (midE < n ? charX[midE] : lineEnd) : mid0
    const runIdx = el.override ? mainRun : styleFor(midS, midE)
    const newMid = cur.slice(p, cur.length - q)
    // Spacing density of what is replaced: printed width minus natural width, per character.
    const oldStr = src.text.slice(midS, midE)
    const oldChars = [...oldStr].length
    const natural = oldChars ? fresh(oldStr, runIdx, 0, 0, false).width : 0
    const extra = oldChars && !el.override ? (mid1 - mid0 - natural) / oldChars : 0
    const midX = mid0 + segShift
    const mid = fresh(newMid, runIdx, midX, extra)
    pieces.push({ kind: 'fresh', x: midX, draws: mid.draws, carets: mid.carets, spaces: mid.spaces })
    const after = midX + mid.width
    shift = after - mid1
    if (q > 0) pieces.push({ kind: 'src', from: midE, to: oldE, shift, space: false })
    pen = b + 1 < st.length ? charX[st[b + 1].s] + shift : q > 0 ? lineEnd + shift : after
    prevSrc = b
    j = j2
  }

  // --- Justified lines: spread what is left over the later word gaps -------------------------
  const isGap = (p: Piece) => (p.kind === 'src' ? p.space : p.spaces > 0)
  const firstChange = pieces.findIndex((p) => p.kind === 'fresh' || Math.abs(p.shift) > EPS)
  if (src.justified && !el.override && firstChange >= 0) {
    const delta = pen - lineEnd
    const gaps = pieces.slice(firstChange + 1).filter(isGap).length
    if (gaps && Math.abs(delta) > 0.05) {
      const per = delta / gaps
      let off = 0
      for (let i = firstChange + 1; i < pieces.length; i++) {
        const p = pieces[i]
        if (isGap(p)) off += per
        if (p.kind === 'src') p.shift -= off
        else {
          p.carets = p.carets.map((c) => c - off)
          for (const d of p.draws) d.x -= off
        }
      }
      pen -= off
    }
  }

  // --- Draws, covers, carets --------------------------------------------------------------
  const draws: LineDraw[] = []
  const carets: number[] = []
  const kept = new Set<number>()
  let changed = text !== src.text || !!el.override
  for (const p of pieces) {
    if (p.kind === 'fresh') {
      carets.push(...p.carets)
      for (const d of p.draws) draws.push({ ...d, x: d.x + dx, y: d.y + dy })
      continue
    }
    const total = p.shift + dx
    const inPlace = Math.abs(total) < EPS && Math.abs(dy) < EPS
    const seen = new Set<number>()
    for (let k = p.from; k < p.to; k++) {
      carets.push(charX[k] + p.shift)
      const gi = src.charGlyph[k]
      if (gi < 0 || seen.has(gi)) continue
      seen.add(gi)
      if (inPlace) {
        kept.add(gi)
        continue
      }
      const g = G[gi]
      if (!g.uni.trim()) continue
      const run = src.runs[g.run]
      draws.push({ kind: 'glyph', run: g.run, code: g.code, fontChar: g.fontChar, uni: g.uni, x: g.x + total, y: src.baseline + dy - run.rise + (g.dy ?? 0), moved: gi })
    }
  }
  carets.push(pen)
  while (carets.length < text.length + 1) carets.push(pen)
  carets.length = text.length + 1
  const caretsOut = carets.map((c) => c + dx)

  // Every printed ink glyph that isn't kept in place gets removed (export) or patched over.
  const gone = G.map((_, i) => i).filter((i) => !kept.has(i) && G[i].uni.trim())
  if (gone.length) changed = true
  const covers = coversFor(src, gone)

  const x0 = Math.min(src.box.x, (n ? nextInk(0) : src.box.x) + dx)
  const x1 = Math.max(src.box.x + src.box.width, pen + dx)
  return {
    changed,
    covers,
    draws,
    carets: caretsOut,
    top: src.box.y + dy,
    bottom: src.box.y + src.box.height + dy,
    bounds: { x: x0, y: Math.min(src.box.y, src.box.y + dy), width: x1 - x0, height: src.box.height + Math.abs(dy) },
    fallbackChars: [...fallbackChars],
    gone,
  }
}

/** Caret index nearest to a page-space point (paragraphs: on the line under `y`). */
export function caretAt(layout: LineLayout, x: number, y?: number): number {
  const bands = layout.caretBands
  // The line whose band is nearest to y.
  let lineTop: number | undefined
  if (bands && y !== undefined) {
    let bestD = Infinity
    for (const b of bands) {
      const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0
      if (d < bestD - 1e-6) {
        bestD = d
        lineTop = b.top
      }
    }
  }
  let best = -1
  for (let i = 0; i < layout.carets.length; i++) {
    if (lineTop !== undefined && bands && Math.abs(bands[i].top - lineTop) > 1e-6) continue
    if (best < 0 || Math.abs(layout.carets[i] - x) < Math.abs(layout.carets[best] - x)) best = i
  }
  return Math.max(0, best)
}

/** Paragraphs: the caret on the line above / below (same x), for arrow keys. */
export function caretVertical(layout: LineLayout, from: number, dir: -1 | 1): number | null {
  const bands = layout.caretBands
  if (!bands) return null
  const b = bands[from]
  const others = [...new Set(bands.map((x) => x.top))].sort((p, q) => p - q)
  const i = others.findIndex((t) => Math.abs(t - b.top) < 1e-6)
  const target = others[i + dir]
  if (target === undefined) return null
  const band = bands.find((x) => Math.abs(x.top - target) < 1e-6)!
  return caretAt(layout, layout.carets[from], (band.top + band.bottom) / 2)
}
