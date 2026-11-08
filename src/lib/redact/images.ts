import type { PDFPageProxy } from 'pdfjs-dist'
import { loadPdfJs } from '@/lib/pdf/pdfjs'
import { pdfToPage, type Mat } from '@/lib/export/matrix'
import type { PtRect, SourcePageInfo } from '@/types'

/**
 * Image pixels under redaction marks (main thread: pdf.js decodes every image format, JBIG2/JPX
 * included). Each page-level image XObject that a mark touches is decoded, the pixels under the marks
 * are painted black, and the result is re-encoded; the export worker swaps it in for that one drawing
 * (matched by its placement). The original image object then only survives if other pages use it.
 */

export interface ImagePatch {
  /** Image unit square → page space (as the export worker computes it). */
  ctm: number[]
  width: number
  height: number
  mime: 'image/png' | 'image/jpeg'
  bytes: Uint8Array
}

interface ImageObj {
  width: number
  height: number
  bitmap?: ImageBitmap
  data?: Uint8ClampedArray | Uint8Array
  kind?: number
}

type M = [number, number, number, number, number, number]
const mm = (m: number[], n: number[]): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]
const toArr = (m: Mat): M => [m.a, m.b, m.c, m.d, m.e, m.f]

function imageData(obj: ImageObj): ImageData | null {
  const { width: w, height: h } = obj
  if (obj.bitmap) {
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(obj.bitmap, 0, 0)
    return ctx.getImageData(0, 0, w, h)
  }
  if (!obj.data) return null
  const out = new ImageData(w, h)
  const d = out.data
  const n = w * h
  if (obj.kind === 3) d.set(obj.data.subarray(0, n * 4))
  else if (obj.kind === 2)
    for (let i = 0; i < n; i++) {
      d[i * 4] = obj.data[i * 3]
      d[i * 4 + 1] = obj.data[i * 3 + 1]
      d[i * 4 + 2] = obj.data[i * 3 + 2]
      d[i * 4 + 3] = 255
    }
  else if (obj.kind === 1) {
    const stride = (w + 7) >> 3
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = obj.data[y * stride + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0
        const i = (y * w + x) * 4
        d[i] = d[i + 1] = d[i + 2] = v
        d[i + 3] = 255
      }
  } else return null
  return out
}

function getObj(page: PDFPageProxy, objId: string): Promise<ImageObj | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000)
    try {
      // Images used on several pages live in commonObjs ("g_…" ids).
      const store = (objId.startsWith('g_') ? page.commonObjs : page.objs) as unknown as { get: (id: string, cb: (o: ImageObj) => void) => void }
      store.get(objId, (o) => {
        clearTimeout(timer)
        resolve(o ?? null)
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

const quadBox = (m: M) => {
  const pts = [
    [m[4], m[5]],
    [m[0] + m[4], m[1] + m[5]],
    [m[2] + m[4], m[3] + m[5]],
    [m[0] + m[2] + m[4], m[1] + m[3] + m[5]],
  ]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}
const touches = (b: ReturnType<typeof quadBox>, r: PtRect) => b.x0 < r.x + r.width && b.x1 > r.x && b.y0 < r.y + r.height && b.y1 > r.y

/** Paints black every pixel whose square overlaps a mark. `pix` maps pixel (u right, v down) → page space. */
function blackOut(img: ImageData, pix: M, rects: PtRect[]): number {
  const { width: w, height: h, data } = img
  const det = pix[0] * pix[3] - pix[1] * pix[2]
  const inv: M = [pix[3] / det, -pix[1] / det, -pix[2] / det, pix[0] / det, (pix[2] * pix[5] - pix[3] * pix[4]) / det, (pix[1] * pix[4] - pix[0] * pix[5]) / det]
  const ap = (m: M, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  let n = 0
  for (const r of rects) {
    const corners = [ap(inv, r.x, r.y), ap(inv, r.x + r.width, r.y), ap(inv, r.x, r.y + r.height), ap(inv, r.x + r.width, r.y + r.height)]
    const u0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))))
    const u1 = Math.min(w, Math.ceil(Math.max(...corners.map((c) => c[0]))))
    const v0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))))
    const v1 = Math.min(h, Math.ceil(Math.max(...corners.map((c) => c[1]))))
    const axis = Math.abs(pix[1]) < 1e-9 && Math.abs(pix[2]) < 1e-9
    // Half a pixel's diagonal in page units: a pixel whose centre is within it of the mark is covered.
    const reach = 0.75 * Math.max(Math.hypot(pix[0], pix[1]), Math.hypot(pix[2], pix[3]))
    for (let v = v0; v < v1; v++)
      for (let u = u0; u < u1; u++) {
        if (!axis) {
          const [x, y] = ap(pix, u + 0.5, v + 0.5)
          if (x < r.x - reach || x > r.x + r.width + reach || y < r.y - reach || y > r.y + r.height + reach) continue
        }
        const i = (v * w + u) * 4
        data[i] = data[i + 1] = data[i + 2] = 0
        data[i + 3] = 255
        n++
      }
  }
  return n
}

async function encode(img: ImageData): Promise<{ mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array }> {
  const c = new OffscreenCanvas(img.width, img.height)
  c.getContext('2d')!.putImageData(img, 0, 0)
  // Photos and scans in many tones → JPEG; flat graphics, bilevel scans and transparency → PNG.
  const d = img.data
  let opaque = true
  const colours = new Set<number>()
  const step = Math.max(1, Math.floor((img.width * img.height) / 40000))
  for (let i = 0; i < img.width * img.height; i += step) {
    if (d[i * 4 + 3] !== 255) opaque = false
    if (colours.size <= 256) colours.add((d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2])
  }
  const jpeg = opaque && colours.size > 256
  const blob = await c.convertToBlob(jpeg ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' })
  return { mime: jpeg ? 'image/jpeg' : 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()) }
}

/** Replacement images for one page's marks (page-level image XObjects only; the worker refuses the rest). */
export async function redactedImages(page: PDFPageProxy, info: SourcePageInfo, rects: PtRect[]): Promise<ImagePatch[]> {
  if (!rects.length) return []
  const { OPS } = await loadPdfJs()
  const ops = await page.getOperatorList()
  const toPage = toArr(pdfToPage(info.view, info.rotate))
  let ctm: M = [1, 0, 0, 1, 0, 0]
  const stack: M[] = []
  let formDepth = 0
  const found: { objId: string; ctm: M; w: number; h: number }[] = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const a = ops.argsArray[i] as unknown[]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mm(ctm, a as number[])
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      formDepth++
      if (Array.isArray(a[0]) && (a[0] as number[]).length === 6) ctm = mm(ctm, a[0] as number[])
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm
      formDepth--
    } else if (formDepth === 0 && fn === OPS.paintImageXObject) {
      const page = mm(toPage, ctm)
      if (rects.some((r) => touches(quadBox(page), r))) found.push({ objId: a[0] as string, ctm: page, w: a[1] as number, h: a[2] as number })
    } else if (formDepth === 0 && fn === OPS.paintImageXObjectRepeat) {
      // [objId, scaleX, scaleY, positions]: one image drawn at many places.
      const [objId, sx, sy, pos] = a as [string, number, number, number[]]
      for (let k = 0; k + 1 < pos.length; k += 2) {
        const page = mm(toPage, mm(ctm, [sx, 0, 0, sy, pos[k], pos[k + 1]]))
        if (rects.some((r) => touches(quadBox(page), r))) found.push({ objId, ctm: page, w: 0, h: 0 })
      }
    }
  }
  const out: ImagePatch[] = []
  for (const f of found) {
    const obj = await getObj(page, f.objId)
    const img = obj && imageData(obj)
    if (!img) continue // no replacement → the worker refuses to download
    // Pixel (u right, v down) → image unit square (v flipped) → page.
    const pix = mm(f.ctm, [1 / img.width, 0, 0, -1 / img.height, 0, 1])
    blackOut(img, pix, rects)
    const enc = await encode(img)
    out.push({ ctm: f.ctm, width: obj!.width, height: obj!.height, ...enc })
  }
  return out
}

