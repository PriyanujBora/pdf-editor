/** Small, allocation-light raster helpers for scan matching (main thread). */

export type Plane = Float32Array

let scratch: HTMLCanvasElement | null = null
let sctx: CanvasRenderingContext2D | null = null

function scratchCtx(w: number, h: number) {
  scratch ??= document.createElement('canvas')
  if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w)
    scratch.height = Math.max(scratch.height, h)
    sctx = null
  }
  sctx ??= scratch.getContext('2d', { willReadFrequently: true })!
  return sctx
}

/** Measures text with a CSS font string. */
export function measure(font: string, text: string) {
  const c = scratchCtx(1, 1)
  c.font = font
  return c.measureText(text)
}

/**
 * Coverage (0..1) of words drawn at their natural positions along a baseline,
 * each nudged by its own dx (justified/scanned text spaces words unevenly).
 */
export function renderWords(
  words: string[],
  dxs: number[],
  font: string,
  w: number,
  h: number,
  originX: number,
  baseline: number,
  only?: number,
): Plane {
  const c = scratchCtx(w, h)
  c.clearRect(0, 0, w, h)
  c.font = font
  c.fillStyle = '#fff'
  c.textBaseline = 'alphabetic'
  c.textAlign = 'left'
  let prefix = ''
  for (let i = 0; i < words.length; i++) {
    if (only === undefined || only === i) {
      const x = originX + (prefix ? c.measureText(prefix).width : 0) + (dxs[i] ?? 0)
      c.fillText(words[i], x, baseline)
    }
    prefix += words[i] + ' '
  }
  const data = c.getImageData(0, 0, w, h).data
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255
  return out
}

/** Coverage of individually positioned runs (each with its own CSS font) on one baseline. */
export function renderRuns(
  runs: { text: string; x: number; font: string; weight?: number; dy?: number }[],
  w: number,
  h: number,
  baseline: number,
  /** Extra stroke weight, px per side: printed + scanned ink is heavier than a font outline. */
  weight = 0,
): Plane {
  const c = scratchCtx(w, h)
  c.clearRect(0, 0, w, h)
  c.fillStyle = '#fff'
  c.strokeStyle = '#fff'
  c.lineJoin = 'round'
  c.textBaseline = 'alphabetic'
  c.textAlign = 'left'
  for (const r of runs) {
    const wt = r.weight ?? weight
    c.font = r.font
    const y = baseline + (r.dy ?? 0)
    c.fillText(r.text, r.x, y)
    if (wt > 0.01) {
      c.lineWidth = wt * 2
      c.strokeText(r.text, r.x, y)
    }
  }
  const data = c.getImageData(0, 0, w, h).data
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255
  return out
}

/** Separable Gaussian blur. */
export function blur(src: Plane, w: number, h: number, sigma: number): Plane {
  if (sigma <= 0.05) return src.slice()
  const r = Math.ceil(sigma * 3)
  const k = new Float32Array(r * 2 + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let i = -r; i <= r; i++) v += src[row + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]
      tmp[row + x] = v
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let i = -r; i <= r; i++) v += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]
      out[y * w + x] = v
    }
  }
  return out
}

/** Binary dilation of (a > threshold) by a square of radius r. */
export function dilate(a: Plane, w: number, h: number, r: number, threshold: number): Plane {
  const tmp = new Uint8Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let on = 0
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r) && !on; i++) on = a[y * w + i] > threshold ? 1 : 0
      tmp[y * w + x] = on
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let on = 0
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r) && !on; j++) on = tmp[j * w + x]
      out[y * w + x] = on
    }
  return out
}

/** Mean squared error inside columns [x0, x1) and rows [y0, y1). */
export function mse(a: Plane, b: Plane, w: number, h: number, x0: number, x1: number, y0 = 0, y1 = h) {
  let s = 0
  let n = 0
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const d = a[y * w + x] - b[y * w + x]
      s += d * d
      n++
    }
  return n ? s / n : 0
}

/** Deterministic PRNG so a patch is identical every time it is rebuilt. */
export function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const v = values.slice().sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))]
}

/** Zeroes everything outside rows [y0, y1). */
export function clipRows(a: Plane, w: number, h: number, y0: number, y1: number): Plane {
  for (let y = 0; y < h; y++) if (y < y0 || y >= y1) a.fill(0, y * w, (y + 1) * w)
  return a
}

/** The rows a line's own letters occupy (cap height → descenders), in px. */
export const lineBand = (baseline: number, sizePx: number) =>
  [Math.round(baseline - 0.8 * sizePx), Math.round(baseline + 0.34 * sizePx)] as const
