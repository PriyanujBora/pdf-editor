import { cssFont } from '@/lib/fonts'
import type { Measure } from './line-layout'

let ctx: CanvasRenderingContext2D | null = null
const cache = new Map<string, number>()

/**
 * Editor-side measuring of bundled fonts for the line layout (em units). The export measures the
 * same font files with fontkit; both are per-character advance widths, so positions agree.
 * Cached per font + text; call `clearMeasureCache()` once a font finishes loading.
 */
export const measureCanvas: Measure = (family, bold, italic, text) => {
  const key = `${family}|${+bold}|${+italic}|${text}`
  let w = cache.get(key)
  if (w === undefined) {
    ctx ??= document.createElement('canvas').getContext('2d')!
    ctx.font = cssFont(family, 100, bold, italic)
    w = ctx.measureText(text).width / 100
    cache.set(key, w)
  }
  return w
}

export function clearMeasureCache() {
  cache.clear()
}
