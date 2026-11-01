import { uid } from '@/lib/ids'
import type { ImageAsset } from '@/types'

const MAX_EDGE = 4096

function sniff(b: Uint8Array): ImageAsset['mime'] | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  return null
}

/** EXIF orientation of a JPEG (1 = upright), without a dependency. */
function jpegOrientation(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let off = 2
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off)
    const len = v.getUint16(off + 2)
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10
      const le = v.getUint16(tiff) === 0x4949
      const ifd = tiff + v.getUint32(tiff + 4, le)
      const n = v.getUint16(ifd, le)
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12
        if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le)
      }
      return 1
    }
    if ((marker & 0xff00) !== 0xff00) break
    off += 2 + len
  }
  return 1
}

async function reencode(bitmap: ImageBitmap, mime: ImageAsset['mime'], maxEdge: number) {
  const k = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * k)
  const h = Math.round(bitmap.height * k)
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h)
  const blob = await canvas.convertToBlob({ type: mime, quality: 0.92 })
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h }
}

export class ImageError extends Error {}

/**
 * Validates a PNG/JPEG, bakes in EXIF rotation and caps huge images, so the
 * bytes we embed look exactly like what the browser shows.
 */
export async function ingestImage(file: File): Promise<ImageAsset> {
  let bytes = new Uint8Array(await file.arrayBuffer())
  const mime = sniff(bytes)
  if (!mime) throw new ImageError('Only PNG and JPG images are supported.')

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { imageOrientation: 'from-image' })
  } catch {
    throw new ImageError('That image couldn’t be read. It may be damaged.')
  }
  let { width, height } = bitmap
  const rotated = mime === 'image/jpeg' && jpegOrientation(bytes) !== 1
  if (rotated || Math.max(width, height) > MAX_EDGE) {
    const r = await reencode(bitmap, mime, MAX_EDGE)
    bytes = r.bytes
    width = r.width
    height = r.height
  }
  bitmap.close()
  return { id: uid('img_'), mime, bytes, width, height }
}

const urls = new Map<string, HTMLImageElement>()

/** Cached decoded <img> for an asset, for drawing on the canvas. */
export function assetImage(asset: ImageAsset): Promise<HTMLImageElement> {
  const cached = urls.get(asset.id)
  if (cached?.complete) return Promise.resolve(cached)
  const img = cached ?? new Image()
  if (!cached) {
    img.src = URL.createObjectURL(new Blob([asset.bytes as BlobPart], { type: asset.mime }))
    urls.set(asset.id, img)
  }
  return img.decode().then(() => img)
}
