import { cssFont } from '@/lib/fonts'
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
}

type Measurable = Pick<TextElement, 'text' | 'font' | 'size' | 'bold' | 'italic' | 'lineHeight'>

/** Measures a text element in page units (points). */
export function measureText(el: Measurable): TextMetricsBox {
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
