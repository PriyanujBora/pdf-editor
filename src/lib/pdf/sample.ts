/**
 * Colour sampling from a rendered page canvas: background (for covering the
 * original text) and ink (to match the original text colour).
 */

const hex = (r: number, g: number, b: number) =>
  '#' +
  [r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')

export interface Sample {
  background: string
  ink: string
}

/** `rect` is in canvas pixels. */
export function sampleColors(canvas: HTMLCanvasElement, rect: { x: number; y: number; w: number; h: number }): Sample {
  const fallback = { background: '#ffffff', ink: '#000000' }
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const w = Math.min(canvas.width - x, Math.ceil(rect.w))
  const h = Math.min(canvas.height - y, Math.ceil(rect.h))
  if (w < 2 || h < 2) return fallback
  let data: Uint8ClampedArray
  try {
    data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, w, h).data
  } catch {
    return fallback
  }

  // Background: most common colour (4-bit buckets) along the border.
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  const add = (i: number) => {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    e.n++
    e.r += r
    e.g += g
    e.b += b
    buckets.set(key, e)
  }
  for (let i = 0; i < w; i++) {
    add(i * 4)
    add(((h - 1) * w + i) * 4)
  }
  for (let j = 0; j < h; j++) {
    add(j * w * 4)
    add((j * w + w - 1) * 4)
  }
  let best = { n: 0, r: 255, g: 255, b: 255 }
  for (const e of buckets.values()) if (e.n > best.n) best = e
  const bg = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n }

  // Ink: the pixels furthest from the background (skips anti-aliased edges).
  const dists: { d: number; i: number }[] = []
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(data[i] - bg.r) + Math.abs(data[i + 1] - bg.g) + Math.abs(data[i + 2] - bg.b)
    if (d > 60) dists.push({ d, i })
  }
  if (!dists.length) return { background: hex(bg.r, bg.g, bg.b), ink: bg.r + bg.g + bg.b > 384 ? '#000000' : '#ffffff' }
  dists.sort((p, q) => q.d - p.d)
  const top = dists.slice(0, Math.max(1, Math.ceil(dists.length * 0.25)))
  // Per-channel median: robust to the coloured fringes of subpixel (LCD)
  // anti-aliasing that Chrome applies on pdf.js' opaque canvases.
  const median = (off: number) => {
    const v = top.map(({ i }) => data[i + off]).sort((p, q) => p - q)
    return v[v.length >> 1]
  }
  let [r, g, b] = [median(0), median(1), median(2)]
  // Anti-aliasing lifts pure black/white slightly; snap near-neutral extremes.
  const neutral = Math.max(r, g, b) - Math.min(r, g, b) < 12
  if (neutral && r + g + b < 3 * 12) [r, g, b] = [0, 0, 0]
  // Very dark with a faint tint is LCD fringing on black text, not a colour.
  else if (!neutral && Math.max(r, g, b) < 40 && Math.max(r, g, b) - Math.min(r, g, b) < 32) [r, g, b] = [0, 0, 0]
  if (neutral && r + g + b > 3 * 240) [r, g, b] = [255, 255, 255]
  let [br, bgc, bb] = [bg.r, bg.g, bg.b]
  if (Math.max(br, bgc, bb) - Math.min(br, bgc, bb) < 6 && br + bgc + bb > 3 * 248) [br, bgc, bb] = [255, 255, 255]
  return { background: hex(br, bgc, bb), ink: hex(r, g, b) }
}
