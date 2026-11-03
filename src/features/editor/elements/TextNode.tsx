import { memo, useEffect, useMemo, useState } from 'react'
import { Shape } from 'react-konva'
import type Konva from 'konva'
import { cssFont, ensureFontLoaded } from '@/lib/fonts'
import { measureText } from '@/lib/measure'
import { usesOriginal } from '@/lib/original-font'
import { useOriginalFaces } from '@/lib/pdf/font-scan'
import { alignOffset, baselineOffset } from '@/lib/text-layout'
import type { TextElement } from '@/types'
import type { NodeHandlers } from './handlers'

interface Props extends NodeHandlers {
  el: TextElement
  hidden: boolean
  draggable: boolean
  selected: boolean
}

/**
 * Draws a text element with the same baseline layout the exporter uses
 * (see lib/text-layout.ts), so the canvas preview matches the PDF.
 */
export const TextNode = memo(function TextNode({ el, hidden, draggable, selected, ...handlers }: Props) {
  const [fontTick, setFontTick] = useState(0)
  useEffect(() => {
    let alive = true
    void ensureFontLoaded(el.font, el.bold, el.italic, el.text).then(() => alive && setFontTick((t) => t + 1))
    return () => {
      alive = false
    }
  }, [el.font, el.bold, el.italic, el.text])

  // The PDF's own font, once pdf.js has loaded it in this session.
  const face = useOriginalFaces((s) => (el.original ? s.faces[el.original.baseFont] : undefined))
  const original = !!face && usesOriginal(el)
  const m = useMemo(
    () => measureText(el, original),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [el.text, el.font, el.size, el.bold, el.italic, el.lineHeight, el.original, original, fontTick],
  )

  return (
    <Shape
      id={el.id}
      name="element"
      x={el.x}
      y={el.y}
      rotation={el.rotation}
      width={m.width}
      height={m.height}
      visible={!hidden}
      draggable={draggable}
      preventDefault={selected}
      {...handlers}
      sceneFunc={(context, shape) => {
        const c = (context as unknown as { _context: CanvasRenderingContext2D })._context
        c.fillStyle = el.color
        c.textBaseline = 'alphabetic'
        c.textAlign = 'left'
        if (m.encoded && face) {
          // Original font: place each glyph by the PDF's own widths, exactly
          // like a PDF viewer (and like the export, which reuses the codes).
          c.font = `${el.size}px "${face}"`
          m.encoded.forEach((line, i) => {
            let x = alignOffset(el.align, m.width, m.widths[i])
            const y = baselineOffset(i, el.size, el.lineHeight)
            for (const it of line.items) {
              if ('gap' in it) x += (it.gap / 1000) * el.size
              else {
                c.fillText(it.fontChar, x, y)
                x += (it.width / 1000) * el.size
              }
            }
          })
        } else {
          c.font = cssFont(el.font, el.size, el.bold, el.italic)
          m.lines.forEach((line, i) => {
            if (line) c.fillText(line, alignOffset(el.align, m.width, m.widths[i]), baselineOffset(i, el.size, el.lineHeight))
          })
        }
        if (!el.text) {
          // Keep empty boxes discoverable.
          c.strokeStyle = 'rgba(99,102,241,0.6)'
          c.setLineDash([3, 3])
          c.lineWidth = 1 / (shape.getAbsoluteScale().x || 1)
          c.strokeRect(0, 0, m.width, m.height)
        }
      }}
      hitFunc={(context, shape: Konva.Shape) => {
        context.beginPath()
        context.rect(0, 0, m.width, m.height)
        context.closePath()
        context.fillStrokeShape(shape)
      }}
    />
  )
})
