import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FONT_FAMILIES, cssFont, ensureFontLoaded } from '@/lib/fonts'
import { measureText } from '@/lib/measure'
import { ASCENT } from '@/lib/text-layout'
import { mul, rotate, scale, translate, userRotation } from '@/lib/export/matrix'
import { caretVertical, layoutLine } from '@/lib/text/line-layout'
import { measureCanvas } from '@/lib/text/measure-canvas'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import type { PageItem, TextElement } from '@/types'
import { beginEditSession, endEditSession } from './actions'
import { activeInput } from './active-input'

interface Props {
  el: TextElement
  page: PageItem
  width: number
  height: number
  zoom: number
}

/** Below 16px, iOS zooms the page when an input gains focus. */
const MIN_CSS_FONT = 16


/** Mounted editors per element: StrictMode re-runs effects, which must not end a session. */
const mounted = new Map<string, number>()

/** Mirror the textarea's selection into the UI store, where the canvas draws caret + highlight. */
function syncSelection(ta: HTMLTextAreaElement) {
  const cur = useUi.getState().textSel
  const next: [number, number] = [ta.selectionStart, ta.selectionEnd]
  if (!cur || cur[0] !== next[0] || cur[1] !== next[1]) useUi.getState().set({ textSel: next })
}

/**
 * Inline text editing.
 *
 * Text boxes the user added: a transparent textarea laid exactly over the element (same font,
 * baseline and transform), so typing feels like editing the page.
 *
 * Existing PDF text (`el.source`): the textarea is only an input proxy — keyboard, IME and mobile
 * keyboards type into it, but its text, caret and selection are invisible. The canvas keeps drawing
 * the line with the PDF's own glyphs (lib/text/line-layout.ts) plus our own caret, so nothing
 * changes on screen until the text does, and what you see while typing is what you download.
 */
export function InlineTextEditor({ el, page, width, height, zoom }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [, setTick] = useState(0)
  const proxy = !!el.source
  const m = measureText(el)
  const initialCaret = useRef(useUi.getState().caret)

  useEffect(() => {
    void ensureFontLoaded(el.font, el.bold, el.italic, el.text).then(() => setTick((t) => t + 1))
  }, [el.font, el.bold, el.italic, el.text])

  useLayoutEffect(() => {
    const ta = ref.current
    if (!ta) return
    activeInput.current = ta
    mounted.set(el.id, (mounted.get(el.id) ?? 0) + 1)
    if (proxy) beginEditSession(el.id)
    ta.focus({ preventScroll: true })
    if (proxy) {
      const at = Math.min(initialCaret.current ?? ta.value.length, ta.value.length)
      ta.setSelectionRange(at, at)
    } else if (el.cover && el.text === el.cover.original) ta.select()
    else ta.setSelectionRange(ta.value.length, ta.value.length)
    useUi.getState().set({ caret: null })
    syncSelection(ta)
    const onSel = () => document.activeElement === ta && syncSelection(ta)
    document.addEventListener('selectionchange', onSel)
    return () => {
      document.removeEventListener('selectionchange', onSel)
      if (activeInput.current === ta) activeInput.current = null
      useUi.getState().set({ textSel: null })
      // Unmounting without a blur (tool switch, export, Escape shortcut) still ends the session —
      // unless it was only React re-running effects and the editor is back already.
      mounted.set(el.id, (mounted.get(el.id) ?? 1) - 1)
      if (proxy) setTimeout(() => !mounted.get(el.id) && endEditSession(el.id))
    }
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

  // Characters drawn with a stand-in font, shown right under the line while typing.
  const fallback = useMemo(
    () => (proxy ? layoutLine(el, measureCanvas).fallbackChars : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [proxy, el.text, el.override, el.source],
  )

  const finish = () => {
    const ui = useUi.getState()
    if (ui.editingId !== el.id) return
    if (proxy) {
      ui.set({ editingId: null })
      endEditSession(el.id)
      return
    }
    const cur = useDoc.getState().elements[el.id]
    if (cur?.kind === 'text' && !cur.text.trim() && !cur.cover) {
      useDoc.getState().removeElement(el.id)
      ui.set({ editingId: null, selectedId: null })
    } else ui.set({ editingId: null })
  }

  const lineWidth = proxy ? el.source!.box.width : Math.max(m.width, el.size * 4)
  return (
    <>
      <textarea
        ref={ref}
        value={el.text}
        spellCheck={false}
        autoCapitalize={proxy ? 'off' : 'sentences'}
        aria-label="Edit text"
        placeholder={proxy ? undefined : 'Type here'}
        wrap="off"
        rows={1}
        onChange={(e) => {
          const v = proxy ? e.target.value.replace(/\r?\n/g, ' ') : e.target.value
          useDoc.getState().updateElement(el.id, { text: v })
          syncSelection(e.target)
        }}
        onSelect={(e) => syncSelection(e.currentTarget)}
        onKeyUp={(e) => syncSelection(e.currentTarget)}
        onBlur={finish}
        onKeyDown={(e) => {
          e.stopPropagation()
          const ta = e.currentTarget
          requestAnimationFrame(() => syncSelection(ta))
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey || proxy))) {
            e.preventDefault()
            ref.current?.blur()
            return
          }
          // Paragraphs: the textarea doesn't wrap like the canvas, so up/down follow the canvas lines.
          if (el.source?.para && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.metaKey && !e.ctrlKey) {
            const L = layoutLine(el, measureCanvas)
            const from = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd
            const to = caretVertical(L, from, e.key === 'ArrowUp' ? -1 : 1)
            if (to === null) return
            e.preventDefault()
            if (e.shiftKey) {
              const anchor = ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart
              ta.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward')
            } else ta.setSelectionRange(to, to)
            syncSelection(ta)
          }
        }}
        className={
          proxy
            ? 'pointer-events-none absolute top-0 left-0 z-10 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre text-transparent caret-transparent outline-none selection:bg-transparent'
            : 'absolute top-0 left-0 z-10 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre outline-1 outline-offset-2 outline-brand/70 outline-dashed placeholder:text-muted-foreground/60'
        }
        style={{
          transform: matrix,
          transformOrigin: '0 0',
          font: cssFont(el.font, cssSize, el.bold, el.italic),
          lineHeight: `${el.lineHeight * cssSize}px`,
          color: proxy ? 'transparent' : el.color,
          caretColor: proxy ? 'transparent' : el.color,
          textAlign: el.align,
          width: lineWidth / k + 4,
          height: m.height / k,
          fontKerning: 'normal',
        }}
      />
      {proxy && fallback.length > 0 && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 left-0 z-10 rounded-md bg-popover/95 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-muted-foreground shadow-sm ring-1 ring-border"
          style={{
            transform: `translate(${(el.x) * zoom}px, ${(el.source!.box.y + el.source!.box.height + 2) * zoom}px)`,
            display: page.rotation ? 'none' : undefined,
          }}
        >
          {fallback.map((c) => `“${c}”`).join(' ')} {fallback.length === 1 ? 'isn’t' : 'aren’t'} in this PDF’s font — shown in{' '}
          {FONT_FAMILIES[el.source!.runs[0]?.family ?? el.font].label}
        </div>
      )}
    </>
  )
}
