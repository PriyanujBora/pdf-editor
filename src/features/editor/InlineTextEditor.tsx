import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FONT_FAMILIES, cssFont, ensureFontLoaded } from '@/lib/fonts'
import { measureText } from '@/lib/measure'
import { ASCENT } from '@/lib/text-layout'
import { mul, rotate, scale, translate, userRotation } from '@/lib/export/matrix'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import type { PageItem, TextElement } from '@/types'

interface Props {
  el: TextElement
  page: PageItem
  width: number
  height: number
  zoom: number
}

/** Below 16px, iOS zooms the page when an input gains focus. */
const MIN_CSS_FONT = 16

/**
 * A transparent textarea laid exactly over the text element (same font, same
 * baseline, same transform), so typing feels like editing the page itself.
 */
export function InlineTextEditor({ el, page, width, height, zoom }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [, setTick] = useState(0)
  const m = measureText(el)

  useEffect(() => {
    void ensureFontLoaded(el.font, el.bold, el.italic, el.text).then(() => setTick((t) => t + 1))
  }, [el.font, el.bold, el.italic, el.text])

  useLayoutEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.focus({ preventScroll: true })
    if (el.cover && el.text === el.cover.original) ta.select()
    else ta.setSelectionRange(ta.value.length, ta.value.length)
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cssSize = Math.max(MIN_CSS_FONT, el.size)
  const k = el.size / cssSize
  const f = FONT_FAMILIES[el.font]
  // CSS puts the baseline at half-leading + ascent; we want it at ASCENT·size.
  const cssBaseline = ((el.lineHeight - (f.ascent + f.descent)) / 2 + f.ascent) * el.size
  const dy = ASCENT * el.size - cssBaseline

  const matrix = useMemo(() => {
    const t = mul(
      mul(mul(scale(zoom, zoom), userRotation(page.rotation, width, height)), translate(el.x, el.y)),
      mul(rotate(el.rotation), mul(translate(0, dy), scale(k, k))),
    )
    return `matrix(${t.a},${t.b},${t.c},${t.d},${t.e},${t.f})`
  }, [zoom, page.rotation, width, height, el.x, el.y, el.rotation, dy, k])

  const finish = () => {
    const ui = useUi.getState()
    if (ui.editingId !== el.id) return
    const cur = useDoc.getState().elements[el.id]
    if (cur?.kind === 'text' && !cur.text.trim() && !cur.cover) {
      useDoc.getState().removeElement(el.id)
      ui.set({ editingId: null, selectedId: null })
    } else ui.set({ editingId: null })
  }

  return (
    <textarea
      ref={ref}
      value={el.text}
      spellCheck={false}
      autoCapitalize="sentences"
      aria-label="Edit text"
      placeholder="Type here"
      wrap="off"
      rows={1}
      onChange={(e) => useDoc.getState().updateElement(el.id, { text: e.target.value })}
      onBlur={finish}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          ref.current?.blur()
        }
      }}
      className="absolute top-0 left-0 z-10 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre outline-1 outline-offset-2 outline-brand/70 outline-dashed placeholder:text-muted-foreground/60"
      style={{
        transform: matrix,
        transformOrigin: '0 0',
        font: cssFont(el.font, cssSize, el.bold, el.italic),
        lineHeight: `${el.lineHeight * cssSize}px`,
        color: el.color,
        caretColor: el.color,
        textAlign: el.align,
        width: Math.max(m.width, el.size * 4) / k + 4,
        height: m.height / k,
        fontKerning: 'normal',
      }}
    />
  )
}
