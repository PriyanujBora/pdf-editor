/**
 * Compress (export worker, Phase 6): images drawn at a higher resolution than the chosen target are
 * resampled and re-encoded as JPEG, in place (the image object keeps its reference, so every page
 * using it follows). Only formats we decode exactly: JPEG (gray/RGB) and plain 8-bit RGB/gray Flate.
 * CMYK, indexed, masks, predictors, /Decode arrays are left alone, and a result that isn't at least
 * 10 % smaller is thrown away. Everything else in the file is untouched.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, type PDFDocument, type PDFPage } from '@cantoo/pdf-lib'
import { interpret, pageContent, type Collect, type DrawnGlyph, type Forms } from '@/lib/content/remove-text'

const N = (n: string) => PDFName.of(n)

export interface CompressOptions {
  /** Target resolution of images as drawn (pixels per inch). */
  dpi: number
  /** JPEG quality 0…1. */
  quality: number
}

export interface CompressReport {
  images: number
  /** Image bytes before and after (only the images that were replaced). */
  before: number
  after: number
}

function filterOf(d: PDFDict): string[] {
  const f = d.lookup(N('Filter'))
  if (f instanceof PDFName) return [f.decodeText()]
  if (f instanceof PDFArray) return f.asArray().map((x) => String(x).replace('/', ''))
  return []
}

async function decodeToCanvas(s: PDFRawStream): Promise<OffscreenCanvas | null> {
  const d = s.dict
  const w = (d.lookup(N('Width')) as PDFNumber | undefined)?.asNumber?.() ?? 0
  const h = (d.lookup(N('Height')) as PDFNumber | undefined)?.asNumber?.() ?? 0
  if (!w || !h || d.has(N('Decode')) || String(d.lookup(N('ImageMask'))) === 'true') return null
  const cs = d.lookup(N('ColorSpace'))
  const csName = cs instanceof PDFName ? cs.decodeText() : cs instanceof PDFArray && String(cs.get(0)) === '/ICCBased' ? `ICC${(cs.lookup(1) as { dict?: PDFDict })?.dict?.lookup(N('N'))}` : ''
  const comps = csName === 'DeviceRGB' || csName === 'ICC3' ? 3 : csName === 'DeviceGray' || csName === 'ICC1' ? 1 : 0
  if (!comps) return null
  const filters = filterOf(d)
  if (filters.length === 1 && filters[0] === 'DCTDecode') {
    const bmp = await createImageBitmap(new Blob([s.contents as BlobPart], { type: 'image/jpeg' }))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    c.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close()
    return c
  }
  if (filters.length === 1 && filters[0] === 'FlateDecode' && !d.has(N('DecodeParms')) && (d.lookup(N('BitsPerComponent')) as PDFNumber | undefined)?.asNumber?.() === 8) {
    const raw = decodePDFRawStream(s).decode()
    if (raw.length < w * h * comps) return null
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(w, h)
    for (let i = 0, j = 0; i < w * h; i++, j += comps) {
      img.data[i * 4] = raw[j]
      img.data[i * 4 + 1] = raw[comps === 3 ? j + 1 : j]
      img.data[i * 4 + 2] = raw[comps === 3 ? j + 2 : j]
      img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return c
  }
  return null
}

export async function compressImages(doc: PDFDocument, pages: PDFPage[], toPage: (p: PDFPage) => [number, number, number, number, number, number], opts: CompressOptions): Promise<CompressReport> {
  const ctx = doc.context
  const report: CompressReport = { images: 0, before: 0, after: 0 }
  // Largest drawn size of every image (points), over every use on the kept pages.
  const drawn = new Map<PDFRef, number>()
  for (const page of pages) {
    const { ops } = pageContent(page)
    const collect: Collect = { images: [], paths: [], unknownText: 0 }
    interpret(ctx, ops, page.node.Resources(), toPage(page), 'page', [] as DrawnGlyph[], new Map() as Forms, false, collect)
    for (const im of collect.images) {
      if (im.kind !== 'xobject' || !im.ref) continue
      const m = im.ctm
      const size = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]))
      drawn.set(im.ref, Math.max(drawn.get(im.ref) ?? 0, size))
    }
  }
  for (const [ref, pts] of drawn) {
    const s = ctx.lookup(ref)
    if (!(s instanceof PDFRawStream)) continue
    const w = (s.dict.lookup(N('Width')) as PDFNumber | undefined)?.asNumber?.() ?? 0
    const h = (s.dict.lookup(N('Height')) as PDFNumber | undefined)?.asNumber?.() ?? 0
    const longest = Math.max(w, h)
    const target = Math.ceil((pts / 72) * opts.dpi)
    if (!longest || longest <= target * 1.15 || longest < 64) continue
    let canvas: OffscreenCanvas | null = null
    try {
      canvas = await decodeToCanvas(s)
    } catch {
      canvas = null
    }
    if (!canvas) continue
    const k = target / longest
    const out = new OffscreenCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)))
    const octx = out.getContext('2d')!
    octx.imageSmoothingQuality = 'high'
    octx.drawImage(canvas, 0, 0, out.width, out.height)
    const blob = await out.convertToBlob({ type: 'image/jpeg', quality: opts.quality })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const old = s.contents.length
    if (bytes.length > 0.9 * old) continue
    const dict = ctx.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: out.width,
      Height: out.height,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
      Length: bytes.length,
    }) as PDFDict
    // A soft mask scales with the unit square, so it can stay as it is.
    const smask = s.dict.get(N('SMask'))
    if (smask) dict.set(N('SMask'), smask)
    for (const key of ['Interpolate', 'Intent', 'OC', 'Metadata']) {
      const v = s.dict.get(N(key))
      if (v) dict.set(N(key), v)
    }
    ctx.assign(ref, PDFRawStream.of(dict, bytes))
    report.images++
    report.before += old
    report.after += bytes.length
  }
  return report
}
