import { memo, useEffect, useMemo, useState } from 'react'
import { apply, mul, pdfToPage, scale, userRotation } from '@/lib/export/matrix'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { currentValue, pageWidgets, type Widget } from '@/lib/forms'
import type { FieldValue, PageItem, SourcePageInfo } from '@/types'

/**
 * Fill in the PDF's own form fields (Phase 6). Real HTML inputs sit over each widget, so typing, IME,
 * mobile keyboards, Tab order and screen readers just work; the page canvas is rendered without the
 * widgets' printed values (pdf.js ENABLE_FORMS) so nothing shows twice. Values live in the document
 * store (undo, autosave); the export writes them with pdf-lib and redraws only the changed fields.
 */

/** Below 16px, iOS zooms the page when an input gains focus: render at ≥ 16px and scale down. */
const MIN_CSS = 16

const css = (c?: Record<string, number>) => (c ? `rgb(${[0, 1, 2].map((i) => Math.round((c[i] ?? 0) * (c[i] !== undefined && c[i] <= 1 ? 255 : 1))).join(',')})` : '#000')

const Field = memo(function Field({ w, box }: { w: Widget; box: { x: number; y: number; width: number; height: number } }) {
  const value = useDoc((s) => currentValue(w, s.formValues))
  const set = (v: FieldValue) => useDoc.getState().setFormValue(w.fieldName, v)
  const da = w.defaultAppearanceData
  const auto = !da?.fontSize
  const fs = auto ? Math.max(6, Math.min(w.multiLine ? 12 : 14, box.height * 0.62)) : da!.fontSize
  const k = fs / Math.max(MIN_CSS, fs)
  const common = {
    'data-field': w.fieldName,
    'aria-label': w.fieldName,
    disabled: w.readOnly,
    className:
      'absolute m-0 border-0 bg-[rgba(59,91,255,0.08)] p-0 outline-none hover:bg-[rgba(59,91,255,0.14)] focus:bg-[rgba(59,91,255,0.12)] focus:ring-2 focus:ring-brand/60 disabled:bg-transparent',
  } as const
  // Inputs are laid out at k⁻¹ size and scaled down by k so their font is at least 16px.
  const scaled = {
    left: box.x,
    top: box.y,
    width: box.width / k,
    height: box.height / k,
    transform: `scale(${k})`,
    transformOrigin: '0 0',
    fontSize: fs / k,
    lineHeight: 1.15,
    color: css(da?.fontColor),
    fontFamily: /cour/i.test(da?.fontName ?? '') ? 'Cousine, monospace' : /times|tiro|serif/i.test(da?.fontName ?? '') ? 'Tinos, serif' : 'Arimo, sans-serif',
    textAlign: (['left', 'center', 'right'] as const)[w.textAlignment ?? 0] ?? 'left',
    padding: `0 ${2 / k}px`,
  } as const

  if (w.fieldType === 'Tx') {
    const v = typeof value === 'string' ? value : ''
    return w.multiLine ? (
      <textarea {...common} style={{ ...scaled, resize: 'none', paddingTop: 1 / k }} value={v} maxLength={w.maxLen || undefined} onChange={(e) => set(e.target.value)} />
    ) : (
      <input {...common} type={w.password ? 'password' : 'text'} style={scaled} value={v} maxLength={w.maxLen || undefined} onChange={(e) => set(e.target.value)} />
    )
  }
  if (w.fieldType === 'Btn') {
    const on = w.radioButton ? value === w.buttonValue : value !== 'Off'
    const mark = w.radioButton ? '●' : '✓'
    return (
      <button
        {...common}
        type="button"
        role={w.radioButton ? 'radio' : 'checkbox'}
        aria-checked={on}
        style={{ left: box.x, top: box.y, width: box.width, height: box.height, fontSize: Math.min(box.width, box.height) * 0.8, lineHeight: 1, color: css(da?.fontColor) }}
        onClick={() => set(w.radioButton ? (on ? 'Off' : (w.buttonValue ?? 'Off')) : on ? 'Off' : (w.exportValue ?? 'Yes'))}
        className={common.className + ' grid place-items-center'}
      >
        {on ? mark : ''}
      </button>
    )
  }
  if (w.fieldType === 'Ch') {
    const sel = Array.isArray(value) ? value : [value]
    const opts = w.options ?? []
    return w.combo ? (
      <select {...common} style={scaled} value={sel[0] ?? ''} onChange={(e) => set([e.target.value])}>
        {!sel[0] && <option value="" />}
        {opts.map((o) => (
          <option key={o.exportValue} value={o.exportValue}>
            {o.displayValue}
          </option>
        ))}
      </select>
    ) : (
      <select
        {...common}
        multiple
        style={{ ...scaled, overflowY: 'auto' }}
        value={w.multiSelect ? sel : sel.slice(0, 1)}
        onChange={(e) => set(w.multiSelect ? [...e.target.selectedOptions].map((o) => o.value) : [e.target.value])}
      >
        {opts.map((o) => (
          <option key={o.exportValue} value={o.exportValue}>
            {o.displayValue}
          </option>
        ))}
      </select>
    )
  }
  return null
})

interface Props {
  page: PageItem
  info: SourcePageInfo
  zoom: number
}

export function FormLayer({ page, info, zoom }: Props) {
  const [widgets, setWidgets] = useState<Widget[]>([])
  const tool = useUi((s) => s.tool)
  useEffect(() => {
    let alive = true
    void pageWidgets(page.srcIndex).then((w) => alive && setWidgets(w))
    return () => {
      alive = false
    }
  }, [page.srcIndex])

  const toPage = useMemo(() => pdfToPage(info.view, info.rotate), [info])
  const boxes = useMemo(
    () =>
      widgets
        .map((w) => {
          const [x0, y0, x1, y1] = w.rect
          const ps = [apply(toPage, x0, y0), apply(toPage, x1, y1)]
          return { w, box: { x: Math.min(ps[0].x, ps[1].x), y: Math.min(ps[0].y, ps[1].y), width: Math.abs(ps[1].x - ps[0].x), height: Math.abs(ps[1].y - ps[0].y) } }
        })
        // Tab order: top to bottom, then left to right.
        .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x),
    [widgets, toPage],
  )
  if (!boxes.length) return null
  const m = mul(scale(zoom, zoom), userRotation(page.rotation, info.width, info.height))
  return (
    <div
      // The layer itself never takes clicks (the editing overlay is underneath); its fields do, in
      // the Select tool only.
      className={'pointer-events-none absolute top-0 left-0 z-[5] ' + (tool === 'select' ? '[&>*]:pointer-events-auto' : '')}
      data-testid="form-layer"
      style={{
        width: info.width,
        height: info.height,
        transform: `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`,
        transformOrigin: '0 0',
      }}
    >
      {boxes.map(({ w, box }) => (
        <Field key={w.id} w={w} box={box} />
      ))}
    </div>
  )
}
