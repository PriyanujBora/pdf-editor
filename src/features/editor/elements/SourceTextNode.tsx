import { memo, useEffect, useMemo, useState } from 'react'
import { Shape } from 'react-konva'
import type Konva from 'konva'
import { cssFont, ensureFontLoaded } from '@/lib/fonts'
import { layoutLine, type LineLayout } from '@/lib/text/line-layout'
import { lineOfGlyph } from '@/lib/text/para-layout'
import { clearMeasureCache, measureCanvas } from '@/lib/text/measure-canvas'
import { useUi } from '@/store/ui'
import type { TextElement } from '@/types'
import { renderedCanvases } from '../actions'
import type { NodeHandlers } from './handlers'

interface Props extends NodeHandlers {
  el: TextElement
  pageId: string
  /** User rotation of the page (copying printed glyphs from the page render needs 0). */
  pageRotation: number
  editing: boolean
  selected: boolean
  draggable: boolean
  onLayout?: (l: LineLayout) => void
}

const CARET = 'oklch(0.56 0.22 268)'
const SELECTION = 'rgba(99,102,241,0.28)'
const OVERFLOW = '#ea580c'

/**
 * An edited existing line (`el.source`). Draws only what differs from the page: patches over
 * printed words that changed or moved, then those words in their new form. While nothing has
 * changed it draws nothing at all, so the pdf.js render underneath stays pixel-identical.
 */
export const SourceTextNode = memo(function SourceTextNode({ el, pageId, pageRotation, editing, selected, draggable, onLayout, ...handlers }: Props) {
  const [fontTick, setFontTick] = useState(0)
  const sel = useUi((s) => (editing ? s.textSel : null))
  const src = el.source!

  // Stand-in fonts this line may need, loaded before measuring.
  useEffect(() => {
    let alive = true
    const wanted = new Map<string, [TextElement['font'], boolean, boolean]>()
    for (const r of src.runs) wanted.set(`${r.family}${+r.bold}${+r.italic}`, [r.family, r.bold, r.italic])
    if (el.override) wanted.set(`${el.font}${+el.bold}${+el.italic}`, [el.font, el.bold, el.italic])
    void Promise.all([...wanted.values()].map(([f, b, i]) => ensureFontLoaded(f, b, i, el.text))).then(() => {
      if (!alive) return
      clearMeasureCache()
      setFontTick((t) => t + 1)
    })
    return () => {
      alive = false
    }
  }, [src, el.override, el.font, el.bold, el.italic, el.text])

  const layout = useMemo(
    () => layoutLine(el, measureCanvas),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [el.text, el.x, el.y, el.override, el.font, el.size, el.bold, el.italic, el.color, el.paraScale, src, fontTick],
  )
  useEffect(() => onLayout?.(layout), [layout, onLayout])

  const b = layout.bounds
  return (
    <Shape
      id={el.id}
      name="element"
      x={el.x}
      y={el.y}
      width={b.width}
      height={b.height}
      draggable={draggable && !editing}
      preventDefault={selected}
      {...handlers}
      sceneFunc={(context, shape) => {
        const c = (context as unknown as { _context: CanvasRenderingContext2D })._context
        c.save()
        c.translate(-el.x, -el.y)
        for (const r of layout.covers) {
          c.fillStyle = src.background
          c.fillRect(r.x, r.y, r.width, r.height)
        }
        const rendered = renderedCanvases.get(pageId)
        for (const d of layout.draws) {
          if (d.kind === 'glyph') {
            const run = src.runs[d.run]
            const k = d.scale ?? 1
            c.fillStyle = run.color
            if (run.embedded) {
              c.save()
              c.translate(d.x, d.y)
              c.scale(run.hScale, 1)
              c.font = `${run.size * k}px "${run.loadedName}"`
              c.textBaseline = 'alphabetic'
              c.fillText(d.fontChar, 0, 0)
              c.restore()
            } else if (d.moved !== undefined && rendered && pageRotation === 0) {
              // No FontFace (Type3 / not embedded): copy the glyph as printed from the page render.
              const g = src.glyphs[d.moved]
              const line = lineOfGlyph(src, d.moved)
              const r = rendered.scale
              const top = line.box.y
              c.drawImage(rendered.canvas, g.x * r, top * r, g.adv * r, line.box.height * r, d.x, d.y + run.rise * k - (line.baseline - top) * k, g.adv * k, line.box.height * k)
            } else {
              c.font = cssFont(run.family, run.size * run.familyScale * k, run.bold, run.italic)
              c.fillText(d.uni, d.x, d.y)
            }
          } else {
            c.fillStyle = d.color
            c.save()
            c.translate(d.x, d.y)
            c.scale(d.hScale, 1)
            c.font = cssFont(d.family, d.size, d.bold, d.italic)
            c.textBaseline = 'alphabetic'
            c.fillText(d.text, 0, 0)
            c.restore()
          }
        }
        const px = 1 / (shape.getAbsoluteScale().x || 1)
        // Paragraph text that now runs past the printed lines: outlined so it never covers
        // what's below unnoticed (the panel offers Shrink to fit).
        if (layout.overflow && (selected || editing)) {
          const o = layout.overflow
          c.strokeStyle = OVERFLOW
          c.lineWidth = 1.5 * px
          c.setLineDash([5 * px, 3 * px])
          c.strokeRect(o.x - 2, o.y, o.width + 4, o.height + 2)
          c.setLineDash([])
        }
        if (editing && sel) {
          const band = (i: number) => layout.caretBands?.[i] ?? { top: layout.top, bottom: layout.bottom }
          const [s0, s1] = sel
          if (s0 === s1) {
            c.fillStyle = CARET
            const b2 = band(Math.min(s0, layout.carets.length - 1))
            c.fillRect((layout.carets[s0] ?? layout.carets.at(-1)!) - px * 0.75, b2.top, px * 1.5, b2.bottom - b2.top)
          } else {
            c.fillStyle = SELECTION
            // One highlight per line the selection touches.
            const lo = Math.min(s0, s1)
            const hi = Math.max(s0, s1)
            let i = lo
            while (i < hi) {
              const b2 = band(i)
              let j = i
              while (j + 1 <= hi && band(j + 1).top === b2.top) j++
              const x0 = layout.carets[i] ?? 0
              const x1 = layout.carets[j] ?? 0
              c.fillRect(Math.min(x0, x1), b2.top, Math.abs(x1 - x0) || px, b2.bottom - b2.top)
              i = j + 1
            }
          }
        }
        c.restore()
      }}
      hitFunc={(context, shape: Konva.Shape) => {
        context.beginPath()
        context.rect(b.x - el.x, b.y - el.y, b.width, b.height)
        context.closePath()
        context.fillStrokeShape(shape)
      }}
    />
  )
})
