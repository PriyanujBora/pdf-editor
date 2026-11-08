import type { PtRect, SourceLine, SourcePara, SourceRun, TextElement } from '@/types'
import { coversFor, layoutSingleLine, type LineDraw, type LineLayout, type Measure } from './line-layout'

/**
 * Paragraph edits (Phase 5): the paragraph's lines merged into one source, so the editor canvas,
 * text removal and export treat it like an edited line. Layout, in order of preference:
 *  1. nothing changed → nothing drawn;
 *  2. the change stays inside one line and that line still fits (and frees no room for the next
 *     line's first word) → that line is laid out exactly like a line edit, the rest stay printed;
 *  3. otherwise the text reflows from the first changed line (greedy, breaks at spaces only so
 *     Indic clusters stay whole) in the paragraph's column, alignment and leading — until a line
 *     break falls where the printed one did, after which the printed lines stay as they are.
 * Lines beyond the printed ones are an overflow: reported so the UI can outline it and offer
 * "Shrink to fit" (`paraScale`).
 */

const EPS = 0.02
const isIndic = (s: string) => /[ऀ-෿]/.test(s)

export interface ParaInfo {
  align: SourcePara['align']
  left: number
  right: number
  firstLeft: number
  leading: number
}

/** Joins the pieces of one printed row (left to right) into one line. */
export function mergeRow(pieces: SourceLine[]): SourceLine {
  if (pieces.length === 1) return pieces[0]
  const ps = pieces.slice().sort((p, q) => p.box.x - q.box.x)
  let text = ''
  const charGlyph: number[] = []
  const glyphs: SourceLine['glyphs'] = []
  const runs: SourceRun[] = []
  const fonts: SourceLine['fonts'] = {}
  ps.forEach((l, k) => {
    if (k && l.box.x - (ps[k - 1].box.x + ps[k - 1].box.width) > 0.15 * (l.runs[0]?.size ?? 10)) {
      text += ' '
      charGlyph.push(-1)
    }
    const go = glyphs.length
    const ro = runs.length
    text += l.text
    charGlyph.push(...l.charGlyph.map((g) => (g < 0 ? -1 : g + go)))
    glyphs.push(...l.glyphs.map((g) => ({ ...g, run: g.run + ro })))
    runs.push(...l.runs)
    Object.assign(fonts, l.fonts)
  })
  const x0 = Math.min(...ps.map((l) => l.box.x))
  const y0 = Math.min(...ps.map((l) => l.box.y))
  const x1 = Math.max(...ps.map((l) => l.box.x + l.box.width))
  const y1 = Math.max(...ps.map((l) => l.box.y + l.box.height))
  const tops = ps.map((l) => l.coverTop).filter((v): v is number => v !== undefined)
  const bottoms = ps.map((l) => l.coverBottom).filter((v): v is number => v !== undefined)
  return {
    ...ps[0],
    text,
    charGlyph,
    glyphs,
    runs,
    box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    spaceWidth: Math.min(...ps.map((l) => l.spaceWidth)),
    justified: ps.some((l) => l.justified),
    coverTop: tops.length ? Math.max(...tops) : undefined,
    coverBottom: bottoms.length ? Math.min(...bottoms) : undefined,
    fonts,
  }
}

/** Merges printed lines into one source line with paragraph info (top to bottom). */
export function mergeLines(lines: SourceLine[], info: ParaInfo): SourceLine {
  const starts: SourcePara['starts'] = []
  let text = ''
  const charGlyph: number[] = []
  const glyphs: SourceLine['glyphs'] = []
  const runs: SourceRun[] = []
  const fonts: SourceLine['fonts'] = {}
  lines.forEach((l, k) => {
    if (k) {
      // A line ending in a hyphen before a lowercase letter joins without a space.
      const join = /[-‐]$/.test(text) && /^\p{Ll}/u.test(l.text) ? '' : ' '
      text += join
      for (let j = 0; j < join.length; j++) charGlyph.push(-1)
    }
    starts.push({ char: text.length, glyph: glyphs.length, run: runs.length })
    const go = glyphs.length
    const ro = runs.length
    text += l.text
    charGlyph.push(...l.charGlyph.map((g) => (g < 0 ? -1 : g + go)))
    glyphs.push(...l.glyphs.map((g) => ({ ...g, run: g.run + ro })))
    runs.push(...l.runs)
    Object.assign(fonts, l.fonts)
  })
  const x0 = Math.min(...lines.map((l) => l.box.x))
  const y0 = Math.min(...lines.map((l) => l.box.y))
  const x1 = Math.max(...lines.map((l) => l.box.x + l.box.width))
  const y1 = Math.max(...lines.map((l) => l.box.y + l.box.height))
  const spaces = lines.map((l) => l.spaceWidth).filter((w) => w > 0)
  return {
    text,
    charGlyph,
    glyphs,
    runs,
    baseline: lines[0].baseline,
    box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    // Word gaps of justified lines are stretched: the narrowest is closest to a natural space.
    spaceWidth: spaces.length ? Math.min(...spaces) : lines[0].spaceWidth,
    justified: info.align === 'justify',
    coverTop: lines[0].coverTop,
    coverBottom: lines[lines.length - 1].coverBottom,
    background: lines[0].background,
    fonts,
    para: { lines, starts, ...info },
  }
}

/** The printed line (of a paragraph source) a merged glyph index belongs to. */
export function lineOfGlyph(src: SourceLine, gi: number): SourceLine {
  const p = src.para
  if (!p) return src
  let k = 0
  while (k + 1 < p.starts.length && p.starts[k + 1].glyph <= gi) k++
  return p.lines[k]
}

/** Baseline (without rise) of a merged glyph, its own vertical offset included. */
export const glyphBaseline = (src: SourceLine, gi: number) => lineOfGlyph(src, gi).baseline + (src.glyphs[gi].dy ?? 0)

type Item =
  | { t: 'word'; c: number; len: number; w: number; glyphs: { gi: number; dx: number }[]; run: number }
  | { t: 'glyph'; c: number; len: number; run: number; code: number; fontChar: string; uni: string; w: number; moved?: number }
  | { t: 'text'; c: number; len: number; run: number; text: string; w: number; family: TextElement['font']; bold: boolean; italic: boolean; size: number; hScale: number; color: string }
  | { t: 'space'; c: number; w: number }
  | { t: 'break'; c: number }

export function layoutParagraph(el: TextElement, measure: Measure): LineLayout {
  const src = el.source!
  const P = src.para!
  const lines = P.lines
  const n = lines.length
  const dx = el.x - src.box.x
  const dy = el.y - src.box.y
  const scale = el.paraScale ?? 1
  const old = src.text
  const cur = el.text
  const moved = Math.abs(dx) > EPS || Math.abs(dy) > EPS
  const restyle = !!el.override || Math.abs(scale - 1) > 1e-6
  const lineEnd = (k: number) => P.starts[k].char + lines[k].text.length
  // A real space is the code a font uses for most of its blank glyphs; other glyphs mapped to blanks
  // are ink the capture couldn't name (e.g. vowel signs in some Bengali PDFs).
  const spaceCode = new Map<string, number>()
  {
    const counts = new Map<string, Map<number, number>>()
    for (const g of src.glyphs) {
      if (!g.uni || g.uni.trim()) continue
      const f = src.runs[g.run]?.loadedName ?? ''
      let m = counts.get(f)
      if (!m) counts.set(f, (m = new Map()))
      m.set(g.code, (m.get(g.code) ?? 0) + 1)
    }
    for (const [f, m] of counts) spaceCode.set(f, [...m].sort((p, q) => q[1] - p[1])[0][0])
  }
  /** Printed ink: anything but a real space. */
  const isInk = (gi: number) => {
    const g = src.glyphs[gi]
    if (!g.uni || g.uni.trim()) return true
    return spaceCode.get(src.runs[g.run]?.loadedName ?? '') !== g.code
  }
  const lineOfChar = (c: number) => {
    let k = 0
    while (k + 1 < n && P.starts[k + 1].char <= c) k++
    return k
  }

  // Changed stretch: common prefix / suffix.
  let a = 0
  while (a < old.length && a < cur.length && old[a] === cur[a]) a++
  let s = 0
  while (s < old.length - a && s < cur.length - a && old[old.length - 1 - s] === cur[cur.length - 1 - s]) s++
  const bOld = old.length - s
  const delta = cur.length - old.length

  /** Carets of a printed line, as printed (layout of the unchanged line). */
  const printedCarets = (k: number) => layoutSingleLine({ ...el, override: false, text: lines[k].text, source: lines[k], x: lines[k].box.x, y: lines[k].box.y }, measure).carets
  const unscaled = Math.abs(scale - 1) < 1e-6
  const baselineOf = (k: number) =>
    unscaled
      ? k < n
        ? lines[k].baseline + dy
        : lines[n - 1].baseline + dy + (k - n + 1) * P.leading
      : lines[0].baseline + dy + k * P.leading * scale
  const band = (k: number) => {
    const ref = lines[Math.min(k, n - 1)]
    const s0 = unscaled ? 1 : scale
    return { top: baselineOf(k) - (ref.baseline - ref.box.y) * s0, bottom: baselineOf(k) + (ref.box.y + ref.box.height - ref.baseline) * s0 }
  }

  const draws: LineDraw[] = []
  const carets: number[] = new Array(cur.length + 1).fill(NaN)
  const caretLine: number[] = new Array(cur.length + 1).fill(0)
  const gone: number[] = []
  const fallbackChars = new Set<string>()
  let lineCount = n
  /** Kept printed line k at new-text offset `shift` (chars). */
  const keepLine = (k: number, shift: number) => {
    const cs = printedCarets(k)
    for (let j = 0; j < cs.length; j++) {
      const ci = P.starts[k].char + j + shift
      if (ci < 0 || ci > cur.length) continue
      carets[ci] = cs[j] + dx
      caretLine[ci] = k
    }
  }
  const goneLine = (k: number) => {
    // Everything but real spaces: glyphs the capture couldn't map to text (pre-base vowel forms)
    // are ink too, and they move with their word.
    for (let g = P.starts[k].glyph; g < (k + 1 < n ? P.starts[k + 1].glyph : src.glyphs.length); g++) {
      const u = src.glyphs[g].uni
      if (u.trim() || !u || isInk(g)) gone.push(g)
    }
  }

  const finish = (): LineLayout => {
    // Fill carets of joiners / anything not set: the previous caret.
    let lastX = carets.find((c) => !isNaN(c)) ?? src.box.x
    let lastLine = 0
    for (let i = 0; i <= cur.length; i++) {
      if (isNaN(carets[i])) {
        carets[i] = lastX
        caretLine[i] = lastLine
      }
      lastX = carets[i]
      lastLine = caretLine[i]
    }
    const bands = caretLine.map(band)
    const allBands = Array.from({ length: lineCount }, (_, k) => band(k))
    const covers = coversFor(src, gone)
    let x0 = src.box.x
    let x1 = src.box.x + src.box.width
    for (const c of carets) {
      x0 = Math.min(x0, c)
      x1 = Math.max(x1, c)
    }
    const top = Math.min(src.box.y, allBands[0].top)
    const bottom = Math.max(src.box.y + src.box.height, allBands[allBands.length - 1].bottom)
    let overflow: PtRect | null = null
    if (lineCount > n) {
      const o0 = band(n - 1).bottom
      overflow = { x: Math.min(P.left, P.firstLeft) + dx, y: o0, width: P.right - Math.min(P.left, P.firstLeft), height: allBands[allBands.length - 1].bottom - o0 }
    }
    return {
      changed: cur !== old || restyle || moved || gone.length > 0,
      covers,
      draws,
      carets,
      caretBands: bands,
      top: allBands[0].top,
      bottom: allBands[allBands.length - 1].bottom,
      bounds: { x: x0, y: top, width: x1 - x0, height: bottom - top },
      fallbackChars: [...fallbackChars],
      gone,
      lines: lineCount,
      overflow,
    }
  }

  // 1. Unchanged.
  if (!moved && !restyle && cur === old) {
    for (let k = 0; k < n; k++) keepLine(k, 0)
    return finish()
  }

  const L0 = lineOfChar(a)
  const L1 = lineOfChar(Math.max(a, bOld - 1))
  const inline = a >= P.starts[L0].char && bOld <= lineEnd(L0) && L0 === L1

  // 2. A change inside one line that still fits.
  if (!moved && !restyle && inline && (P.align === 'left' || P.align === 'justify')) {
    const k = L0
    const line = lines[k]
    const text = cur.slice(P.starts[k].char, lineEnd(k) + delta)
    const base = { ...el, override: false, text, source: line, x: line.box.x, y: line.box.y }
    const LL = layoutSingleLine(base, measure)
    const natural = line.justified ? layoutSingleLine({ ...base, source: { ...line, justified: false } }, measure) : LL
    const end = natural.carets[natural.carets.length - 1]
    const was = printedCarets(k)
    const wasEnd = was[was.length - 1]
    let room = false
    if (k + 1 < n && end < wasEnd - 0.5) {
      const nx = lines[k + 1]
      const m = /^\S+/.exec(nx.text)
      if (m) {
        const gs = nx.charGlyph.slice(0, m[0].length).filter((g) => g >= 0).map((g) => nx.glyphs[g])
        const w = gs.length ? Math.max(...gs.map((g) => g.x + g.adv)) - Math.min(...gs.map((g) => g.x)) : 0
        room = end + src.spaceWidth + w <= P.right + 0.5
      }
    }
    if (end <= P.right + 0.5 && !room) {
      for (let j = 0; j < n; j++) if (j !== k) keepLine(j, P.starts[j].char > a ? delta : 0)
      const { glyph: go, run: ro } = P.starts[k]
      for (const d of LL.draws) draws.push(d.kind === 'glyph' ? { ...d, run: d.run + ro, ...(d.moved !== undefined ? { moved: d.moved + go } : {}) } : d)
      gone.push(...LL.gone.map((g) => g + go))
      LL.carets.forEach((c, j) => {
        carets[P.starts[k].char + j] = c
        caretLine[P.starts[k].char + j] = k
      })
      for (const c of LL.fallbackChars) fallbackChars.add(c)
      return finish()
    }
  }

  // 3. Reflow from the first changed line (from the top when moved or restyled).
  let start = moved || restyle ? 0 : L0
  // A change in a line's first word may let it move up to the line before.
  if (start > 0 && !moved && !restyle) {
    const fw = /^\S*/.exec(lines[start].text)![0].length
    if (a <= P.starts[start].char + fw) start--
  }
  for (let k = 0; k < start; k++) keepLine(k, 0)
  const from = P.starts[start].char

  const G = src.glyphs
  const counts = new Map<number, number>()
  for (const g of G) counts.set(g.run, (counts.get(g.run) ?? 0) + [...g.uni].length)
  const mainRun = [...counts].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0
  const runAt = (o: number) => {
    for (let k = o; k >= 0; k--) if (src.charGlyph[k] >= 0 && old[k].trim()) return G[src.charGlyph[k]].run
    for (let k = o + 1; k < old.length; k++) if (src.charGlyph[k] >= 0 && old[k].trim()) return G[src.charGlyph[k]].run
    return mainRun
  }
  const freshRun = a < bOld ? runAt(a) : runAt(Math.max(0, a - 1))
  // Reflowed text keeps printed text in whole words: the unchanged prefix ends, and the unchanged
  // suffix starts, at a word boundary (so "নতুন নদী" for "নদী" keeps নদী as printed).
  let aW = a
  while (aW > from && !/\s/.test(cur[aW - 1])) aW--
  // With the prefix shortened the common suffix may reach further back.
  let sW = 0
  while (sW < old.length - aW && sW < cur.length - aW && old[old.length - 1 - sW] === cur[cur.length - 1 - sW]) sW++
  while (sW > 0 && cur.length - sW > aW && !/\s/.test(cur[cur.length - sW - 1])) sW--
  const bNewW = cur.length - sW
  /** Old index of a new character, or -1 for new text. */
  const oldIndex = (c: number) => (c < aW ? c : c >= bNewW ? c - delta : -1)
  const glyphChars = new Map<number, number>()
  for (const g of src.charGlyph) if (g >= 0) glyphChars.set(g, (glyphChars.get(g) ?? 0) + 1)
  const space = el.override ? measure(el.font, el.bold, el.italic, ' ') * el.size : src.spaceWidth * scale

  // Every printed glyph of a line belongs to one printed word — also glyphs the text capture couldn't
  // map to characters (pre-base vowel forms, cluster parts): those join the nearest word on their line.
  const wordGlyphs = new Map<number, number[]>()
  const wordOfGlyph = new Map<number, number>()
  {
    const re = /\S+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(old))) {
      const gs = [...new Set(src.charGlyph.slice(m.index, m.index + m[0].length).filter((g) => g >= 0))]
      if (!gs.length) continue
      wordGlyphs.set(m.index, gs)
      for (const g of gs) wordOfGlyph.set(g, m.index)
    }
    const spans = [...wordGlyphs].map(([w, gs]) => ({ w, line: lineOfGlyph(src, gs[0]), x0: Math.min(...gs.map((g) => G[g].x)), x1: Math.max(...gs.map((g) => G[g].x + G[g].adv)) }))
    G.forEach((g, gi) => {
      if (wordOfGlyph.has(gi) || !isInk(gi)) return
      const line = lineOfGlyph(src, gi)
      // Inside a word's span → that word; otherwise the next word to the right (pre-base vowel
      // forms are drawn before their consonant), else the nearest one to the left.
      const same = spans.filter((s2) => s2.line === line)
      const best =
        same.find((s2) => g.x >= s2.x0 - 0.01 && g.x < s2.x1) ??
        same.filter((s2) => s2.x0 >= g.x).sort((p, q) => p.x0 - q.x0)[0] ??
        same.filter((s2) => s2.x1 <= g.x).sort((p, q) => q.x1 - p.x1)[0]
      if (best) {
        wordGlyphs.get(best.w)!.push(gi)
        wordOfGlyph.set(gi, best.w)
      }
    })
  }
  /** Right edge of a printed word: the same for its width and for the gaps around it. */
  const wordRight = (set: number[]) => {
    const ink = set.filter(isInk)
    return Math.max(...(ink.length ? ink : set).map((g) => G[g].x + G[g].adv - src.runs[G[g].run].charSpacing))
  }
  /** Printed gap between the words around an old space, when both stay unchanged on one line. */
  const printedGap = (o: number) => {
    let p = o - 1
    while (p >= 0 && /\s/.test(old[p])) p--
    let q = o + 1
    while (q < old.length && /\s/.test(old[q])) q++
    const pw = [...wordGlyphs].find(([w]) => w <= p && p < w + (/\S+/.exec(old.slice(w))?.[0].length ?? 0))
    const qw = wordGlyphs.get(q)
    if (!pw || !qw) return null
    const l = lineOfGlyph(src, pw[1][0])
    if (l !== lineOfGlyph(src, qw[0])) return null
    return Math.min(...qw.map((g) => G[g].x)) - wordRight(pw[1])
  }

  // Items of the text to lay out.
  const items: Item[] = []
  const chars = cur.slice(from)
  for (let i = 0; i < chars.length; ) {
    const c = from + i
    const ch = chars[i]
    if (ch === '\n') {
      items.push({ t: 'break', c })
      i++
      continue
    }
    if (/\s/.test(ch)) {
      // A space the capture inferred from a narrow gap (complex scripts, letter-spaced text) keeps
      // that gap between unchanged words; real word spaces get the natural width.
      const o2 = oldIndex(c)
      const inferred = o2 >= 0 && (src.charGlyph[o2] < 0 || isInk(src.charGlyph[o2]))
      const gap = !el.override && inferred && oldIndex(c - 1) === o2 - 1 && oldIndex(c + 1) === o2 + 1 ? printedGap(o2) : null
      items.push({ t: 'space', c, w: gap !== null && gap < space / scale ? Math.max(gap, -space / scale) * scale : space })
      i++
      continue
    }
    const o = oldIndex(c)
    const gi = o >= 0 ? src.charGlyph[o] : -1
    // A whole printed word that comes along unchanged moves as one piece: every glyph at its printed
    // offset (kerning, reordered and positioned marks of complex scripts stay exactly as printed).
    if (!el.override && o >= 0 && (o === 0 || /\s/.test(old[o - 1]) || src.charGlyph[o - 1] < 0) && (i === 0 || /\s/.test(chars[i - 1]))) {
      let len = 0
      while (i + len < chars.length && !/\s/.test(chars[i + len]) && oldIndex(c + len) === o + len) len++
      const end = o + len
      const wordEnds = (i + len >= chars.length || /\s/.test(chars[i + len])) && (end >= old.length || /\s/.test(old[end]) || src.charGlyph[end] < 0)
      const set = wordGlyphs.get(o)
      if (len && wordEnds && set && /^\S+/.exec(old.slice(o))![0].length === len) {
        const line = lineOfGlyph(src, set[0])
        if (set.every((g) => lineOfGlyph(src, g) === line)) {
          const g0 = Math.min(...set)
          const x0 = Math.min(...set.map((g) => G[g].x))
          const x1 = wordRight(set)
          items.push({ t: 'word', c, len, w: (x1 - x0) * scale, glyphs: set.map((g) => ({ gi: g, dx: (G[g].x - x0) * scale })), run: G[g0].run })
          i += len
          continue
        }
      }
    }
    if (!el.override && gi >= 0) {
      // The printed glyph, if all of its characters (ligatures) come along unchanged.
      let len = 1
      while (i + len < chars.length && oldIndex(c + len) === o + len && src.charGlyph[o + len] === gi) len++
      if (len === glyphChars.get(gi)) {
        const g = G[gi]
        const run = src.runs[g.run]
        const w = (g.w * run.fontMatrix * run.size * run.hScale + run.charSpacing) * scale
        items.push({ t: 'glyph', c, len, run: g.run, code: g.code, fontChar: g.fontChar, uni: g.uni, w, moved: gi })
        i += len
        continue
      }
    }
    // New text in the style it replaces.
    const runIdx = o >= 0 ? runAt(o) : freshRun
    const run = src.runs[runIdx] ?? src.runs[mainRun]
    const fonts = src.fonts[run?.baseFont ?? '']
    let hit: [number, number, string] | undefined
    let len = 1
    if (!el.override && !run.type3 && fonts && !isIndic(ch)) {
      for (let m = Math.min(3, chars.length - i); m >= 1 && !hit; m--) {
        if (/\s/.test(chars.slice(i, i + m))) continue
        hit = fonts.glyphs[chars.slice(i, i + m)]
        len = m
      }
    }
    if (hit) {
      const w = (hit[1] * run.fontMatrix * run.size * run.hScale + run.charSpacing) * scale
      items.push({ t: 'glyph', c, len, run: runIdx, code: hit[0], fontChar: hit[2], uni: chars.slice(i, i + len), w })
      i += len
      continue
    }
    let m = 1
    if (isIndic(ch)) while (i + m < chars.length && !/\s/.test(chars[i + m])) m++
    else if (ch.length === 1 && /[\uD800-\uDBFF]/.test(ch)) m = 2
    const piece = chars.slice(i, i + m)
    const family = el.override ? el.font : run.family
    const bold = el.override ? el.bold : run.bold
    const italic = el.override ? el.italic : run.italic
    const size = (el.override ? el.size : run.size * run.familyScale) * scale
    const hScale = el.override ? 1 : run.hScale
    const w = measure(family, bold, italic, piece) * size * hScale + (el.override ? 0 : run.charSpacing * [...piece].length * scale)
    items.push({ t: 'text', c, len: m, run: runIdx, text: piece, w, family, bold, italic, size, hScale, color: el.override ? el.color : run.color })
    if (!el.override && run.embedded) for (const x of piece) fallbackChars.add(x)
    i += m
  }

  // Printed glyphs that stay neighbours keep their printed offsets: kerning, and in complex scripts
  // the positioned marks (a vowel sign sits on its consonant, not after it).
  for (let i = 0; i + 1 < items.length; i++) {
    const p = items[i]
    const q = items[i + 1]
    if (p.t !== 'glyph' || q.t !== 'glyph' || p.moved === undefined || q.moved === undefined) continue
    if (oldIndex(q.c) !== oldIndex(p.c) + p.len || lineOfGlyph(src, p.moved) !== lineOfGlyph(src, q.moved)) continue
    const d = G[q.moved].x - G[p.moved].x
    const size = src.runs[p.run].size
    if (d > -0.5 * size && d < 2 * size) p.w = d * scale
  }

  // Greedy breaking at spaces.
  const colLeft = Math.min(P.left, P.firstLeft, ...lines.map((l) => l.box.x))
  const lineLeft = (k: number) => (k === 0 ? P.firstLeft : P.left)
  const avail = (k: number) => P.right - (P.align === 'center' || P.align === 'right' ? colLeft : lineLeft(k))
  type Row = { items: Item[]; hard: boolean; start: number; next: number }
  const rows: Row[] = []
  let row: Item[] = []
  let width = 0
  let rowStart = from
  let syncAt = -1
  const closeRow = (hard: boolean, next: number) => {
    // Trailing spaces don't count.
    while (row.length && row[row.length - 1].t === 'space') row.pop()
    rows.push({ items: row, hard, start: rowStart, next })
    row = []
    width = 0
    rowStart = next
    // Back in step with the printed lines? Then the rest stays as printed.
    const ln = start + rows.length
    if (!moved && !restyle && ln < n && next >= bNewW && next - delta === P.starts[ln].char) syncAt = ln
  }
  const words: Item[][] = []
  {
    let w: Item[] = []
    for (const it of items) {
      if (it.t === 'space' || it.t === 'break') {
        if (w.length) words.push(w)
        words.push([it])
        w = []
      } else w.push(it)
    }
    if (w.length) words.push(w)
  }
  for (const w of words) {
    if (syncAt >= 0) break
    const first = w[0]
    if (first.t === 'break') {
      closeRow(true, first.c + 1)
      continue
    }
    if (first.t === 'space') {
      if (row.length) {
        row.push(first)
        width += first.w
      }
      continue
    }
    const ww = w.reduce((t, it) => t + (it.t === 'break' ? 0 : it.w), 0)
    if (row.length && width + ww > avail(start + rows.length) + 0.5) {
      closeRow(false, first.c)
      if (syncAt >= 0) break
    }
    row.push(...w)
    width += ww
  }
  if (syncAt < 0 && (row.length || !rows.length)) closeRow(false, cur.length)

  // Positions.
  rows.forEach((r, ri) => {
    const k2 = start + ri
    const y = baselineOf(k2)
    const w = r.items.reduce((t, it) => t + (it.t === 'break' ? 0 : it.w), 0)
    let x = P.align === 'center' ? (colLeft + P.right) / 2 - w / 2 : P.align === 'right' ? P.right - w : lineLeft(k2)
    x += dx
    const lastOfPara = ri === rows.length - 1 && syncAt < 0
    const gaps = r.items.filter((it) => it.t === 'space').length
    const extra = P.align === 'justify' && !lastOfPara && !r.hard && gaps ? (avail(k2) - w) / gaps : 0
    const at = (c: number, xx: number) => {
      carets[c] = xx
      caretLine[c] = k2
    }
    for (const it of r.items) {
      if (it.t === 'break') continue
      at(it.c, x)
      if (it.t === 'space') {
        x += it.w + extra
        continue
      }
      if (it.t === 'word') {
        for (const { gi, dx: gx } of it.glyphs) {
          const g = G[gi]
          if (!isInk(gi)) continue // real spaces
          const run = src.runs[g.run]
          draws.push({ kind: 'glyph', run: g.run, code: g.code, fontChar: g.fontChar, uni: g.uni, x: x + gx, y: y + ((g.dy ?? 0) - run.rise) * scale, moved: gi, ...(scale !== 1 ? { scale } : {}) })
        }
        const o = oldIndex(it.c)
        for (let j = 1; j < it.len; j++) {
          const g = src.charGlyph[o + j]
          at(it.c + j, g >= 0 ? x + (G[g].x - G[it.glyphs[0].gi].x) * scale : x + (it.w * j) / it.len)
        }
        x += it.w
        continue
      }
      const run = src.runs[it.run]
      const ry = y - (el.override ? 0 : run.rise * scale)
      if (it.t === 'glyph')
        draws.push({
          kind: 'glyph',
          run: it.run,
          code: it.code,
          fontChar: it.fontChar,
          uni: it.uni,
          x,
          y: ry + (it.moved !== undefined ? (G[it.moved].dy ?? 0) * scale : 0),
          ...(it.moved !== undefined ? { moved: it.moved } : {}),
          ...(scale !== 1 ? { scale } : {}),
        })
      else draws.push({ kind: 'text', text: it.text, family: it.family, bold: it.bold, italic: it.italic, size: it.size, hScale: it.hScale, color: it.color, x, y: ry })
      for (let j = 1; j < it.len; j++) at(it.c + j, x + (it.w * j) / it.len)
      x += it.w
    }
    // After the row's last character: its caret, and the dropped spaces / break before the next row.
    const last = r.items[r.items.length - 1]
    const endIdx = last ? last.c + (last.t === 'space' || last.t === 'break' ? 1 : last.len) : r.start
    for (let c = endIdx; c < r.next; c++) at(c, x)
    if (ri === rows.length - 1 && r.next >= cur.length) at(cur.length, x)
  })
  for (let k2 = start; k2 < (syncAt >= 0 ? syncAt : n); k2++) goneLine(k2)
  if (syncAt >= 0) for (let k2 = syncAt; k2 < n; k2++) keepLine(k2, delta)
  lineCount = Math.max(n, start + rows.length)
  return finish()
}
