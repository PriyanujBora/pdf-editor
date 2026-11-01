import { memo, useEffect, useMemo, useState } from 'react'
import { Shape } from 'react-konva'
import type Konva from 'konva'
import { cssFont, ensureFontLoaded } from '@/lib/fonts'
import { measureText } from '@/lib/measure'
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

  const m = useMemo(
    () => measureText(el),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [el.text, el.font, el.size, el.bold, el.italic, el.lineHeight, fontTick],
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
        c.font = cssFont(el.font, el.size, el.bold, el.italic)
        c.fillStyle = el.color
        c.textBaseline = 'alphabetic'
        c.textAlign = 'left'
        m.lines.forEach((line, i) => {
          if (line) c.fillText(line, alignOffset(el.align, m.width, m.widths[i]), baselineOffset(i, el.size, el.lineHeight))
        })
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
