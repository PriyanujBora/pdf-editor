import { createStore, del, get, set } from 'idb-keyval'
import { uid } from '@/lib/ids'

/**
 * Signatures (Phase 6): drawn, typed or uploaded, always turned into a transparent PNG that is placed
 * like an image. Saved signatures stay in this browser's IndexedDB only — never in the document
 * autosave, never uploaded.
 */

export interface SavedSignature {
  id: string
  png: Uint8Array
  width: number
  height: number
  createdAt: number
}

const store = createStore('free-pdf-editor-signatures', 'signatures')

export async function listSignatures(): Promise<SavedSignature[]> {
  try {
    return ((await get<SavedSignature[]>('all', store)) ?? []).sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export async function saveSignature(s: Omit<SavedSignature, 'id' | 'createdAt'>) {
  const all = await listSignatures()
  // The same picture twice is kept once.
  if (all.some((x) => x.png.length === s.png.length && x.png.every((b, i) => b === s.png[i]))) return
  await set('all', [{ ...s, id: uid('sig_'), createdAt: Date.now() }, ...all].slice(0, 12), store)
}

export async function deleteSignature(id: string) {
  const all = (await listSignatures()).filter((s) => s.id !== id)
  if (all.length) await set('all', all, store)
  else await del('all', store)
}

/** Crops a canvas to its ink (alpha > 8) plus a small margin and encodes it as PNG. */
export async function trimToPng(canvas: HTMLCanvasElement, margin = 6): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { width: w, height: h } = canvas
  const d = ctx.getImageData(0, 0, w, h).data
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return null
  x0 = Math.max(0, x0 - margin)
  y0 = Math.max(0, y0 - margin)
  x1 = Math.min(w - 1, x1 + margin)
  y1 = Math.min(h - 1, y1 + margin)
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext('2d')!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'))
  if (!blob) return null
  return { png: new Uint8Array(await blob.arrayBuffer()), width: out.width, height: out.height }
}

/**
 * Uploaded photo or scan of a signature: paper → transparent by luminance, ink kept in its own
 * colour, with a soft edge so strokes don't look cut out. `threshold` 0…1 (lighter than it = paper).
 */
export function removeBackground(img: CanvasImageSource & { width: number; height: number }, threshold: number, maxSide = 1600): HTMLCanvasElement {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.width * k))
  c.height = Math.max(1, Math.round(img.height * k))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, c.width, c.height)
  const im = ctx.getImageData(0, 0, c.width, c.height)
  const d = im.data
  const soft = 0.08
  for (let i = 0; i < d.length; i += 4) {
    const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255
    const a = Math.max(0, Math.min(1, (threshold - l) / soft))
    d[i + 3] = Math.round(a * (d[i + 3] ?? 255))
  }
  ctx.putImageData(im, 0, 0)
  return c
}

/** Typed-signature faces (lazy: fetched the first time the Type tab opens). */
export const SCRIPT_FONTS = [
  { id: 'signature-script', label: 'Flowing', family: 'Signature Script', file: 'SignatureScript-Regular.ttf' },
  { id: 'great-vibes', label: 'Formal', family: 'Great Vibes', file: 'GreatVibes-Regular.ttf' },
] as const

const loaded = new Map<string, Promise<void>>()
export function loadScriptFont(f: (typeof SCRIPT_FONTS)[number]): Promise<void> {
  let p = loaded.get(f.id)
  if (!p) {
    const face = new FontFace(f.family, `url(${import.meta.env.BASE_URL}fonts/${f.file})`)
    p = face.load().then((ff) => void document.fonts.add(ff))
    loaded.set(f.id, p)
  }
  return p
}

/** A typed signature as a transparent canvas (2× for crisp placement). */
export function renderTyped(text: string, family: string, color: string): HTMLCanvasElement {
  const size = 120
  const c = document.createElement('canvas')
  const probe = c.getContext('2d')!
  probe.font = `${size}px "${family}"`
  const w = Math.ceil(probe.measureText(text).width + size)
  c.width = Math.max(10, w)
  c.height = Math.ceil(size * 1.8)
  const ctx = c.getContext('2d')!
  ctx.font = `${size}px "${family}"`
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, size / 2, size * 1.25)
  return c
}
