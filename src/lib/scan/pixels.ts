import type { PDFPageProxy } from 'pdfjs-dist'
import { apply, mul, pdfToPage, scale as scaleM, translate, type Mat } from '@/lib/export/matrix'
import { pageImage } from '@/lib/pdf/font-scan'
import type { PtRect, SourcePageInfo } from '@/types'
import { renderRegion } from './source'

/**
 * The scan's own pixels for a page rectangle, snapped to the image's pixel
 * grid. Rendering the page instead would resample the image (a sub-pixel
 * offset and smoothing), and the fit would learn blur that isn't in the
 * scan — every viewer shows the real pixels. Falls back to rendering for
 * rotated/skewed page images.
 */

interface ImageObj {
  width: number
  height: number
  bitmap?: ImageBitmap
  data?: Uint8ClampedArray | Uint8Array
  kind?: number
}

const decoded = new Map<string, Promise<HTMLCanvasElement | null>>()

export function clearPixelCache() {
  decoded.clear()
}

function toCanvas(obj: ImageObj): HTMLCanvasElement | null {
  const c = document.createElement('canvas')
  c.width = obj.width
  c.height = obj.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  if (obj.bitmap) {
    ctx.drawImage(obj.bitmap, 0, 0)
    return c
  }
  if (!obj.data) return null
  const out = ctx.createImageData(obj.width, obj.height)
  const d = out.data
  const n = obj.width * obj.height
  if (obj.kind === 3) d.set(obj.data.subarray(0, n * 4))
  else if (obj.kind === 2)
    for (let i = 0; i < n; i++) {
      d[i * 4] = obj.data[i * 3]
      d[i * 4 + 1] = obj.data[i * 3 + 1]
      d[i * 4 + 2] = obj.data[i * 3 + 2]
      d[i * 4 + 3] = 255
    }
  else if (obj.kind === 1) {
    // 1 bit per pixel, rows padded to whole bytes (bilevel scans: CCITT/JBIG2).
    const stride = (obj.width + 7) >> 3
    for (let y = 0; y < obj.height; y++)
      for (let x = 0; x < obj.width; x++) {
        const v = obj.data[y * stride + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0
        const i = (y * obj.width + x) * 4
        d[i] = d[i + 1] = d[i + 2] = v
        d[i + 3] = 255
      }
  } else return null
  ctx.putImageData(out, 0, 0)
  return c
}

function imageCanvas(page: PDFPageProxy, objId: string) {
  let p = decoded.get(objId)
  if (!p) {
    p = new Promise<HTMLCanvasElement | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000)
      try {
        const objs = page.objs as unknown as { get: (id: string, cb: (o: ImageObj) => void) => void }
        objs.get(objId, (o) => {
          clearTimeout(timer)
          try {
            resolve(o ? toCanvas(o) : null)
          } catch {
            resolve(null)
          }
        })
      } catch {
        clearTimeout(timer)
        resolve(null)
      }
    })
    decoded.set(objId, p)
  }
  return p
}

/** Image pixel (u right, v down) → page space, when the image is axis-aligned. */
function imageToPage(info: SourcePageInfo, ctm: number[], w: number, h: number): Mat | null {
  const [a, b, c, d, e, f] = ctm
  const user: Mat = { a, b, c, d, e, f }
  const m = mul(pdfToPage(info.view, info.rotate), mul(user, mul(translate(0, 1), scaleM(1 / w, -1 / h))))
  const axisAligned = Math.abs(m.b) < 1e-6 * Math.abs(m.a) && Math.abs(m.c) < 1e-6 * Math.abs(m.d)
  if (!axisAligned || m.a <= 0 || m.d <= 0) return null
  // Square pixels only (otherwise fall back).
  if (Math.abs(m.a - m.d) > 0.02 * m.a) return null
  return m
}

export interface RegionPixels {
  img: ImageData
  /** The rectangle actually covered, on the image's pixel grid (page space). */
  region: PtRect
  /** Pixels per point. */
  scale: number
}

export async function scanPixels(
  page: PDFPageProxy,
  srcIndex: number,
  info: SourcePageInfo,
  want: PtRect,
  fallbackScale: number,
): Promise<RegionPixels> {
  const im = pageImage(String(srcIndex))
  const m = im && imageToPage(info, im.ctm, im.width, im.height)
  const canvas = im && m ? await imageCanvas(page, im.objId) : null
  if (im && m && canvas) {
    const eps = 1e-6
    const u0 = Math.max(0, Math.floor((want.x - m.e) / m.a + eps))
    const v0 = Math.max(0, Math.floor((want.y - m.f) / m.d + eps))
    const u1 = Math.min(im.width, Math.ceil((want.x + want.width - m.e) / m.a - eps))
    const v1 = Math.min(im.height, Math.ceil((want.y + want.height - m.f) / m.d - eps))
    if (u1 > u0 && v1 > v0) {
      const img = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(u0, v0, u1 - u0, v1 - v0)
      const tl = apply(m, u0, v0)
      return { img, region: { x: tl.x, y: tl.y, width: (u1 - u0) * m.a, height: (v1 - v0) * m.d }, scale: 1 / m.a }
    }
  }
  // Fallback: render the page area (pixel-grid snapped at the given scale).
  const s = fallbackScale
  const x0 = Math.floor(want.x * s) / s
  const y0 = Math.floor(want.y * s) / s
  const region = {
    x: x0,
    y: y0,
    width: Math.ceil((want.x + want.width) * s) / s - x0,
    height: Math.ceil((want.y + want.height) * s) / s - y0,
  }
  return { img: await renderRegion(page, info.rotate, region, s), region, scale: s }
}
