import type { PDFPageProxy } from 'pdfjs-dist'
import type { PtRect } from '@/types'
import { percentile, type Plane } from './raster'

/** Renders a page-space rectangle at `scale` px/pt (the scan's own resolution). */
export async function renderRegion(page: PDFPageProxy, rotate: number, r: PtRect, scale: number): Promise<ImageData> {
  const w = Math.max(1, Math.ceil(r.width * scale))
  const h = Math.max(1, Math.ceil(r.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const viewport = page.getViewport({ scale, rotation: rotate, offsetX: -r.x * scale, offsetY: -r.y * scale })
  await page.render({ canvas, viewport }).promise
  return canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h)
}

export interface Analysis {
  w: number
  h: number
  lum: Plane
  /** Ink coverage 0..1 relative to the local paper/ink levels. */
  target: Plane
  paper: [number, number, number]
  ink: [number, number, number]
  contrast: number
}

/** Paper and ink levels measured inside columns [x0, x1), then an ink-coverage map. */
export function analyze(img: ImageData, x0: number, x1: number): Analysis {
  const { width: w, height: h, data } = img
  const lum = new Float32Array(w * h)
  for (let i = 0; i < lum.length; i++) lum[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
  const win: number[] = []
  for (let y = 0; y < h; y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) win.push(y * w + x)
  const lums = win.map((i) => lum[i])
  const pHi = percentile(lums, 55)
  const pLo = percentile(lums, 3)
  const med = (idx: number[], c: number) =>
    percentile(
      idx.map((i) => data[i * 4 + c]),
      50,
    )
  const paperIdx = win.filter((i) => lum[i] >= pHi)
  const inkIdx = win.filter((i) => lum[i] <= pLo)
  const paper: [number, number, number] = [med(paperIdx, 0), med(paperIdx, 1), med(paperIdx, 2)]
  const ink: [number, number, number] = [med(inkIdx, 0), med(inkIdx, 1), med(inkIdx, 2)]
  const pl = (paper[0] + paper[1] + paper[2]) / 3
  const il = (ink[0] + ink[1] + ink[2]) / 3
  const span = Math.max(1, pl - il)
  const target = new Float32Array(w * h)
  for (let i = 0; i < target.length; i++) target[i] = Math.min(1, Math.max(0, (pl - lum[i]) / span))
  return { w, h, lum, target, paper, ink, contrast: pl - il }
}

/**
 * Smooth paper colour (least-squares plane per channel over clean pixels)
 * and the residuals, i.e. the paper's real grain.
 */
export function paperModel(img: ImageData, clean: (i: number) => boolean) {
  const { width: w, height: h, data } = img
  // Normal equations for v = a + b·x + c·y.
  const S = new Float64Array(9)
  const B = [new Float64Array(3), new Float64Array(3), new Float64Array(3)]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!clean(i)) continue
      const f = [1, x, y]
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) S[r * 3 + c] += f[r] * f[c]
        for (let ch = 0; ch < 3; ch++) B[ch][r] += f[r] * data[i * 4 + ch]
      }
    }
  const coef = B.map((b) => solve3(S, b))
  const plane = (x: number, y: number, ch: number) => coef[ch][0] + coef[ch][1] * x + coef[ch][2] * y
  const residuals: number[] = []
  let sq = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!clean(i)) continue
      for (let ch = 0; ch < 3; ch++) {
        const r = data[i * 4 + ch] - plane(x, y, ch)
        residuals.push(r)
        sq += r * r
      }
    }
  const std = residuals.length ? Math.sqrt(sq / residuals.length) : 0
  return { plane, residuals, std }
}

function solve3(m: Float64Array, b: Float64Array): [number, number, number] {
  const [a, b1, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-9) {
    const n = m[0] || 1
    return [b[0] / n, 0, 0]
  }
  const inv = [
    (e * i - f * h) / det,
    (c * h - b1 * i) / det,
    (b1 * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b1 * g - a * h) / det,
    (a * e - b1 * d) / det,
  ]
  return [
    inv[0] * b[0] + inv[1] * b[1] + inv[2] * b[2],
    inv[3] * b[0] + inv[4] * b[1] + inv[5] * b[2],
    inv[6] * b[0] + inv[7] * b[1] + inv[8] * b[2],
  ]
}

export const toHex = (c: [number, number, number]) =>
  '#' +
  c
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
