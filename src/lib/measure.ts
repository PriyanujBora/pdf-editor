import { cssFont } from '@/lib/fonts'
import { encodeLine, usesOriginal, type EncodedLine } from '@/lib/original-font'
import { boxHeight, splitLines } from '@/lib/text-layout'
import type { TextElement } from '@/types'

let ctx: CanvasRenderingContext2D | null = null
function context() {
  ctx ??= document.createElement('canvas').getContext('2d')!
  return ctx
}

export interface TextMetricsBox {
  lines: string[]
  widths: number[]
  width: number
  height: number
  /** Set when measured with the PDF's original font (glyph by glyph). */
  encoded?: EncodedLine[]
}

type Measurable = Pick<TextElement, 'text' | 'font' | 'size' | 'bold' | 'italic' | 'lineHeight' | 'original' | 'useOriginal'>

/**
 * Measures a text element in page units (points). With `withOriginal`, text
 * the original PDF font can draw is measured from that font's own widths.
 */
export function measureText(el: Measurable, withOriginal = false): TextMetricsBox {
  if (withOriginal && usesOriginal(el)) {
    const lines = splitLines(el.text)
    const encoded = lines.map((l) => encodeLine(l, el.original))
    const widths = encoded.map((e) => (e.width / 1000) * el.size)
    const width = Math.max(el.size * 0.5, ...widths)
    return { lines, widths, width, height: boxHeight(lines.length, el.size, el.lineHeight), encoded }
  }
  const c = context()
  // Measure at a fixed size and scale: avoids tiny-size rounding in some engines.
  const REF = 100
  c.font = cssFont(el.font, REF, el.bold, el.italic)
  const k = el.size / REF
  const lines = splitLines(el.text)
  const widths = lines.map((l) => c.measureText(l).width * k)
  const width = Math.max(el.size * 0.5, ...widths)
  return { lines, widths, width, height: boxHeight(lines.length, el.size, el.lineHeight) }
}
