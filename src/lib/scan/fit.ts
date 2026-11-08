import type { PDFPageProxy } from 'pdfjs-dist'
import { ensureFontLoaded, FONT_FAMILIES } from '@/lib/fonts'
import { largestImageWidth } from '@/lib/pdf/font-scan'
import type { TextBlock } from '@/lib/pdf/text-blocks'
import { ASCENT } from '@/lib/text-layout'
import type { FontFamilyId, PtRect, ScanMatch, SourcePageInfo } from '@/types'
import { blur, clipRows, dilate, lineBand, measure, mse, renderRuns, renderWords, type Plane } from './raster'
import { analyze, paperModel, toHex } from './source'
import { scanPixels } from './pixels'

/**
 * Fits a scanned line by re-drawing it: render the line's own (OCR) text in
 * candidate fonts and adjust size, baseline, per-word position, ink spread and
 * scanner contrast until the rendering matches the scan's pixels. The fitted
 * numbers then draw the edited text so it looks printed and scanned too.
 */

export type FitResult =
  | {
      ok: true
      match: ScanMatch
      font: FontFamilyId
      bold: boolean
      /** Element geometry/style derived from the fit. */
      size: number
      color: string
      x: number
      y: number
    }
  | { ok: false; reason: 'not-scan' | 'faint' | 'busy' | 'no-match' }

export const cssFace = (font: FontFamilyId, bold: boolean, px: number, italic = false) =>
  `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${px}px "${FONT_FAMILIES[font].css}"`

export const splitWords = (text: string) => text.split(/\s+/).filter(Boolean)

/** Scan resolution in px/pt from the page's largest image (0 when not a scan). */
export function scanScale(key: string, info: SourcePageInfo) {
  const imgW = largestImageWidth(key)
  const viewW = info.view[2] - info.view[0]
  if (imgW < 400 || viewW <= 0) return 0
  return Math.min(4, Math.max(1.5, imgW / viewW))
}

/** Patch region around a line: room to the right for longer replacements. */
export function lineRegion(block: TextBlock, info: SourcePageInfo): PtRect {
  const s = block.size
  const x0 = Math.max(0, block.x - 0.8 * s)
  const x1 = Math.min(info.width, block.x + block.width * 1.5 + 2 * s)
  const y0 = Math.max(0, block.baseline - 1.3 * s)
  const y1 = Math.min(info.height, block.baseline + 0.6 * s)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

interface FaceFit {
  font: FontFamilyId
  bold: boolean
  sizePx: number
  originX: number
  baseline: number
  dxs: number[]
  bolds: boolean[]
  err: number
}

export async function fitScanLine(
  page: PDFPageProxy,
  info: SourcePageInfo,
  key: string,
  block: TextBlock,
): Promise<FitResult> {
  const approx = scanScale(key, info)
  if (!approx) return { ok: false, reason: 'not-scan' }
  // The scan's own pixels (no resampling), on its pixel grid.
  const px = await scanPixels(page, key, info, lineRegion(block, info), approx)
  const { region, img, scale } = px
  const { width: w, height: h } = img
  const pad = 0.4 * block.size * scale
  const lx0 = Math.max(0, Math.round((block.x - region.x) * scale - pad))
  const lx1 = Math.min(w, Math.round((block.x + block.width - region.x) * scale + pad))
  const an = analyze(img, lx0, lx1)
  if (an.contrast < 60) return { ok: false, reason: 'faint' }
  const T = an.target
  const pm = paperModel(img, (i) => T[i] < 0.04 && i % w >= lx0 && i % w < lx1)
  if (pm.std > 16) return { ok: false, reason: 'busy' }

  // Ink extent (columns) and the x-height band's bottom (baseline guess).
  let first = -1
  let last = -1
  for (let x = lx0; x < lx1; x++) {
    let m = 0
    for (let y = 0; y < h; y++) m = Math.max(m, T[y * w + x])
    if (m > 0.5) {
      if (first < 0) first = x
      last = x
    }
  }
  if (first < 0 || last - first < 4) return { ok: false, reason: 'no-match' }
  const dens = new Float32Array(h)
  for (let y = 0; y < h; y++) for (let x = first; x <= last; x++) dens[y] += T[y * w + x]
  const maxD = Math.max(...dens)
  let guess = h - 1
  for (let y = h - 1; y >= 0; y--)
    if (dens[y] > 0.35 * maxD) {
      guess = y + 1
      break
    }

  const words = splitWords(block.text)
  // Score only this line's own band (cap height → descenders): tight line
  // spacing puts the neighbours' descenders/ascenders inside the region.
  const band = lineBand

  const fitFace = async (font: FontFamilyId, bold: boolean): Promise<FaceFit> => {
    await ensureFontLoaded(font, bold, false, block.text)
    const m100 = measure(cssFace(font, bold, 100), words.join(' '))
    const inkW100 = m100.actualBoundingBoxLeft + m100.actualBoundingBoxRight
    const sizePx = ((last - first + 1) / Math.max(1, inkW100)) * 100
    const face = cssFace(font, bold, sizePx)
    const originX = first + measure(face, words.join(' ')).actualBoundingBoxLeft
    const zeros = words.map(() => 0)

    let baseline = guess
    let bestErr = Infinity
    for (let dy = -4; dy <= 4; dy++) {
      const r = blur(renderWords(words, zeros, face, w, h, originX, guess + dy), w, h, 1)
      const [b0, b1] = band(guess + dy, sizePx)
      const e = mse(r, T, w, h, lx0, lx1, b0, b1) / (meanSquare(T, w, h, lx0, lx1, b0, b1) || 1)
      if (e < bestErr) {
        bestErr = e
        baseline = guess + dy
      }
    }
    // Per-word alignment by 1-D search (no re-render per shift).
    const dxs = zeros.slice()
    for (let i = 0; i < words.length; i++) {
      // Justified lines stretch spaces: offsets accumulate, so start from the previous word's.
      if (i > 0) dxs[i] = dxs[i - 1]
      const wi = blur(renderWords(words, dxs, face, w, h, originX, baseline, i), w, h, 1)
      let a = w
      let b = 0
      for (let x = 0; x < w; x++)
        for (let y = 0; y < h; y++)
          if (wi[y * w + x] > 0.05) {
            a = Math.min(a, x)
            b = Math.max(b, x)
            break
          }
      if (a > b) continue
      let best = 0
      let bestE = Infinity
      const [b0, b1] = band(baseline, sizePx)
      for (let s = -8; s <= 8; s++) {
        let e = 0
        for (let y = Math.max(0, b0); y < Math.min(h, b1); y++)
          for (let x = Math.max(0, a - 8); x <= Math.min(w - 1, b + 8); x++) {
            const sx = x - s
            const v = sx >= 0 && sx < w ? wi[y * w + sx] : 0
            const d = v - T[y * w + x]
            e += d * d
          }
        if (e < bestE) {
          bestE = e
          best = s
        }
      }
      dxs[i] += best
    }
    // Per-word weight: lines often mix regular and bold ("total of **Rs. 1,50,000**").
    const bolds = words.map(() => bold)
    let prefix = ''
    const xs = words.map((wd) => {
      const x = originX + (prefix ? measure(face, prefix).width : 0)
      prefix += wd + ' '
      return x
    })
    if (!bold) {
      await ensureFontLoaded(font, true, false, block.text)
      const [b0, b1] = band(baseline, sizePx)
      // Weight is stroke thickness, i.e. ink mass. Scanning fattens every
      // stroke, so compare words with each other: bold words carry clearly
      // more ink (relative to a regular rendering) than their neighbours.
      const q: number[] = []
      const boldRatio: number[] = []
      for (let i = 0; i < words.length; i++) {
        const reg = renderRuns([{ text: words[i], x: xs[i] + dxs[i], font: cssFace(font, false, sizePx) }], w, h, baseline)
        const bld = renderRuns([{ text: words[i], x: xs[i] + dxs[i], font: cssFace(font, true, sizePx) }], w, h, baseline)
        const [c0, c1] = colSpan(bld, w, h)
        let mt = 0
        let mr = 0
        let mb = 0
        for (let y = Math.max(0, b0); y < Math.min(h, b1); y++)
          for (let x = Math.max(0, c0 - 2); x <= Math.min(w - 1, c1 + 2); x++) {
            const k = y * w + x
            mt += T[k]
            mr += reg[k]
            mb += bld[k]
          }
        q.push(mr > 0 ? mt / mr : 0)
        boldRatio.push(mr > 0 ? mb / mr : 1)
      }
      const medQ = median(q.filter((v) => v > 0))
      const medB = median(boldRatio)
      for (let i = 0; i < words.length; i++) bolds[i] = q[i] > medQ * (1 + 0.5 * (medB - 1))
    }
    const runs = words.map((t, i) => ({ text: t, x: xs[i] + dxs[i], font: cssFace(font, bolds[i], sizePx) }))
    const r = blur(renderRuns(runs, w, h, baseline), w, h, 1)
    const [b0, b1] = band(baseline, sizePx)
    return {
      font,
      bold,
      sizePx,
      originX,
      baseline,
      dxs,
      bolds,
      err: mse(r, T, w, h, lx0, lx1, b0, b1) / (meanSquare(T, w, h, lx0, lx1, b0, b1) || 1),
    }
  }

  // Serif or sans? Then the closest family, then regular or bold.
  const serif = await fitFace('tinos', false)
  const sans = await fitFace('roboto', false)
  let best = serif.err <= sans.err ? serif : sans
  const alt = await fitFace(best === serif ? 'noto-serif' : 'inter', false)
  if (alt.err < best.err) best = alt
  const bold = await fitFace(best.font, true)
  if (bold.err < best.err * 0.97) best = bold
  // Quality gate: correlation of slightly blurred maps forgives sub-pixel
  // offsets (which inflate pixel error on long justified lines) but still
  // rejects a wrong typeface, handwriting or decorative lettering.
  const quality = (f: FaceFit) => {
    let pre = ''
    const runs = words.map((t, i) => {
      const x = f.originX + (pre ? measure(cssFace(f.font, f.bold, f.sizePx), pre).width : 0) + f.dxs[i]
      pre += t + ' '
      return { text: t, x, font: cssFace(f.font, f.bolds[i], f.sizePx) }
    })
    const [b0, b1] = band(f.baseline, f.sizePx)
    return ncc(
      blur(renderRuns(runs, w, h, f.baseline), w, h, 1.5),
      blur(T, w, h, 1.5),
      w,
      lx0,
      lx1,
      Math.max(0, b0),
      Math.min(h, b1),
    )
  }
  const score = quality(best)
  if (score < MIN_QUALITY) return { ok: false, reason: 'no-match' }

  // Style by direct pixel comparison, after aligning every word to a quarter
  // pixel in x and y (which also absorbs slight skew). Exact alignment is
  // what stops pixel error from rewarding blur. Knobs: weight = heavier
  // printed ink, blur = edge softness, contrast = edge firmness.
  const face = cssFace(best.font, best.bold, best.sizePx)
  const [sb0, sb1] = band(best.baseline, best.sizePx)
  const grow = Math.max(2, Math.round(best.sizePx * 0.1))
  type Run = { text: string; x: number; font: string; dy: number; weight?: number }
  const natural = (() => {
    let pre = ''
    return words.map((t) => {
      const x = best.originX + (pre ? measure(face, pre).width : 0)
      pre += t + ' '
      return x
    })
  })()
  const runs: Run[] = words.map((t, i) => ({
    text: t,
    x: natural[i] + best.dxs[i],
    font: cssFace(best.font, best.bolds[i], best.sizePx),
    dy: 0,
  }))

  // Sub-pixel alignment per word, on a small local crop (fast).
  const SUB = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75]
  for (const run of runs) {
    const full = renderRuns([run], w, h, best.baseline)
    const [c0, c1] = colSpan(full, w, h)
    if (c0 > c1) continue
    const bx0 = Math.max(0, c0 - 6)
    const bx1 = Math.min(w, c1 + 7)
    const by0 = Math.max(0, sb0)
    const by1 = Math.min(h, sb1)
    const bw = bx1 - bx0
    const bh = by1 - by0
    const tLocal = new Float32Array(bw * bh)
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) tLocal[y * bw + x] = T[(y + by0) * w + x + bx0]
    let bestE = Infinity
    let ex = 0
    let ey = 0
    for (const sx of SUB)
      for (const sy of SUB.slice(1, 6)) {
        const a = blur(renderRuns([{ ...run, x: run.x - bx0 + sx, dy: sy }], bw, bh, best.baseline - by0), bw, bh, 1)
        let e = 0
        for (let k = 0; k < a.length; k++) e += (a[k] - tLocal[k]) ** 2
        if (e < bestE) {
          bestE = e
          ex = sx
          ey = sy
        }
      }
    run.x += ex
    run.dy = ey
  }

  const all = words.map((_, i) => i)
  // Main style from regular words; bold words get their own weight below.
  const boldIdx = best.bold ? [] : all.filter((i) => best.bolds[i])
  const regIdx = all.filter((i) => !boldIdx.includes(i))
  const mainRuns = (regIdx.length ? regIdx : all).map((i) => runs[i])
  const footIdx = (rs: Run[]) => {
    const f = clipRows(dilate(blur(renderRuns(rs, w, h, best.baseline), w, h, 1), w, h, grow, 0.03), w, h, sb0, sb1)
    const idx: number[] = []
    for (let k = 0; k < f.length; k++) if (f[k] && k % w >= lx0 && k % w < lx1) idx.push(k)
    return idx
  }
  const mainFoot = footIdx(mainRuns)
  // Scanner model: optical blur, then the scanner's response curve —
  // measured, not assumed: for each level of rendered coverage, the mean
  // scanned darkness at those (aligned) pixels. That conditional mean is
  // also the pixel-error-optimal mapping, so only blur and weight are searched.
  // Tone comes from the measured curve; blur and weight are chosen to match
  // what the eye sees — edge steepness and total ink — because pixel error
  // always prefers soft edges wherever the outlines differ slightly.
  const tEdge = edgeStat(T, w, mainFoot)
  const tMass = mainFoot.reduce((s, k) => s + T[k], 0)
  let style = { sigma: 1, weight: 0, curve: identityCurve(), cost: Infinity }
  for (const weight of [0, 0.25, 0.5, 0.75, 1]) {
    const rw = renderRuns(mainRuns, w, h, best.baseline, weight)
    for (const sigma of [0.3, 0.45, 0.6, 0.8, 1, 1.2]) {
      const a = blur(rw, w, h, sigma)
      const curve = fitCurve(a, T, mainFoot)
      const m = a.map((v) => applyCurve(curve, v))
      const mass = mainFoot.reduce((s, k) => s + m[k], 0)
      let e = 0
      for (const k of mainFoot) e += (m[k] - T[k]) ** 2
      const cost = (edgeStat(m, w, mainFoot) / tEdge - 1) ** 2 + (mass / tMass - 1) ** 2 + (0.15 * e) / (tMass || 1)
      if (cost < style.cost) style = { sigma, weight, curve, cost }
    }
  }

  // Bold words: printed bold is often lighter than the font's Bold face, so
  // choose between Bold (+ a little weight) and Regular thickened to match.
  let boldStyle: { bold: boolean; weight: number } | undefined
  if (boldIdx.length) {
    const bRuns = boldIdx.map((i) => runs[i])
    const bFoot = footIdx(bRuns)
    let bs = { bold: true, weight: 0, cost: Infinity }
    const options: [boolean, number[]][] = [
      [true, [0, 0.2, 0.4]],
      [false, [0.3, 0.5, 0.7, 0.9, 1.1, 1.4, 1.7]],
    ]
    for (const [bold, weights] of options)
      for (const weight of weights) {
        const rs = bRuns.map((r) => ({ ...r, font: cssFace(best.font, bold, best.sizePx), weight }))
        const a = blur(renderRuns(rs, w, h, best.baseline), w, h, style.sigma)
        let mass = 0
        let tm = 0
        for (const k of bFoot) {
          mass += applyCurve(style.curve, a[k])
          tm += T[k]
        }
        const cost = (mass / tm - 1) ** 2
        if (cost < bs.cost) bs = { bold, weight, cost }
      }
    boldStyle = { bold: bs.bold, weight: bs.weight }
  }
  // Offsets now include the sub-pixel refinement.
  const refinedDxs = runs.map((r, i) => Math.round((r.x - natural[i]) * 100) / 100)
  const dys = runs.map((r) => r.dy)

  const size = best.sizePx / scale
  const baselinePt = region.y + best.baseline / scale
  return {
    ok: true,
    font: best.font,
    bold: best.bold,
    size: Math.round(size * 100) / 100,
    color: toHex(an.ink),
    x: region.x + best.originX / scale,
    y: baselinePt - ASCENT * size,
    match: {
      region,
      lineBox: { x: block.x, y: block.y, width: block.width, height: block.height },
      scale,
      oldText: words.join(' '),
      fitFont: best.font,
      fitBold: best.bold,
      fitSizePx: best.sizePx,
      originX: best.originX,
      baseline: best.baseline,
      dxs: refinedDxs,
      dys,
      bolds: best.bolds,
      sigma: style.sigma,
      weight: style.weight,
      curve: style.curve,
      boldStyle,
      paper: toHex(an.paper),
    },
  }
}

function meanSquare(a: Plane, w: number, h: number, x0: number, x1: number, y0 = 0, y1 = h) {
  let s = 0
  let n = 0
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
    for (let x = x0; x < x1; x++) {
      s += a[y * w + x] ** 2
      n++
    }
  return n ? s / n : 0
}

/** First/last column with ink (> 0.05). */
export function colSpan(a: Plane, w: number, h: number): [number, number] {
  let c0 = w
  let c1 = -1
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++)
      if (a[y * w + x] > 0.05) {
        c0 = Math.min(c0, x)
        c1 = Math.max(c1, x)
        break
      }
  return [c0, c1]
}

/** Mean gradient magnitude across stroke edges (pixels in the 0.25–0.75 transition). */
function edgeStat(a: Plane, w: number, idx: number[]) {
  let g = 0
  let n = 0
  for (const k of idx) {
    const v = a[k]
    if (v < 0.25 || v > 0.75) continue
    const gx = (a[k + 1] ?? v) - (a[k - 1] ?? v)
    const gy = (a[k + w] ?? v) - (a[k - w] ?? v)
    g += Math.hypot(gx, gy) / 2
    n++
  }
  return n ? g / n : 1
}

const CURVE_BINS = 24

const identityCurve = () => Array.from({ length: CURVE_BINS + 1 }, (_, i) => i / CURVE_BINS)

/**
 * Response curve by histogram matching: maps rendered coverage so that its
 * distribution over the line's letters equals the scan's. Unlike a per-pixel
 * fit it is insensitive to slight misalignment or outline differences, so
 * stroke cores stay as dark as the scan's and edges keep their spread.
 */
function fitCurve(a: Plane, T: Plane, idx: number[]): number[] {
  const av = idx.map((k) => a[k]).sort((x, y) => x - y)
  const tv = idx.map((k) => T[k]).sort((x, y) => x - y)
  const n = av.length
  const out: number[] = []
  let j = 0
  for (let b = 0; b <= CURVE_BINS; b++) {
    const x = b / CURVE_BINS
    while (j < n && av[j] <= x) j++
    // Rank of x among rendered values → same rank among scanned values.
    const q = n ? Math.max(0, j - 1) / Math.max(1, n - 1) : x
    out.push(Math.round((n ? tv[Math.round(q * (n - 1))] : x) * 1000) / 1000)
  }
  for (let b = 1; b < out.length; b++) out[b] = Math.max(out[b], out[b - 1])
  out[0] = 0 // no coverage → paper
  return out
}

export function applyCurve(curve: number[] | undefined, v: number) {
  if (!curve) return v
  const x = Math.min(1, Math.max(0, v)) * (curve.length - 1)
  const i = Math.floor(x)
  const f = x - i
  return i >= curve.length - 1 ? curve[curve.length - 1] : curve[i] * (1 - f) + curve[i + 1] * f
}

/** Below this correlation the edit would look pasted on: fall back to a plain patch. */
const MIN_QUALITY = 0.8

/** Normalized cross-correlation inside a window. */
function ncc(a: Plane, b: Plane, w: number, x0: number, x1: number, y0: number, y1: number) {
  let sa = 0
  let sb = 0
  let n = 0
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      sa += a[y * w + x]
      sb += b[y * w + x]
      n++
    }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const u = a[y * w + x] - ma
      const v = b[y * w + x] - mb
      num += u * v
      da += u * u
      db += v * v
    }
  return da && db ? num / Math.sqrt(da * db) : 0
}

function median(v: number[]) {
  if (!v.length) return 0
  const a = v.slice().sort((x, y) => x - y)
  return a[a.length >> 1]
}
