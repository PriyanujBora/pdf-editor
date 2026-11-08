import { useSession } from '@/store/session'
import type { FieldValue } from '@/types'

/** A form widget as pdf.js reports it (page.getAnnotations), the fields we use. */
export interface Widget {
  id: string
  fieldType: 'Tx' | 'Btn' | 'Ch' | 'Sig'
  fieldName: string
  fieldValue: FieldValue | null
  rect: number[]
  checkBox?: boolean
  radioButton?: boolean
  pushButton?: boolean
  exportValue?: string
  buttonValue?: string
  options?: { exportValue: string; displayValue: string }[]
  combo?: boolean
  multiSelect?: boolean
  multiLine?: boolean
  password?: boolean
  readOnly?: boolean
  hidden?: boolean
  maxLen?: number
  textAlignment?: number | null
  defaultAppearanceData?: { fontSize: number; fontName: string; fontColor: Record<string, number> }
}

const cache = new Map<string, Promise<Widget[]>>()
export const clearFormCache = () => cache.clear()

/** Fillable widgets of a source page (hidden fields and push buttons excluded). */
export function pageWidgets(srcIndex: number): Promise<Widget[]> {
  const key = String(srcIndex)
  let p = cache.get(key)
  if (!p) {
    const pdf = useSession.getState().pdf
    p = pdf
      ? pdf
          .getPage(srcIndex + 1)
          .then((pg) => pg.getAnnotations())
          .then((as) => (as as unknown as (Widget & { subtype: string })[]).filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && !a.pushButton))
          .catch(() => [])
      : Promise.resolve([])
    cache.set(key, p)
  }
  return p
}

/** Value shown for a field: what the user set, else what the file has. */
export function currentValue(w: Widget, values: Record<string, FieldValue>): FieldValue {
  const v = values[w.fieldName]
  if (v !== undefined) return v
  if (w.fieldType === 'Ch') return Array.isArray(w.fieldValue) ? w.fieldValue : w.fieldValue ? [w.fieldValue] : []
  if (w.fieldType === 'Btn') return typeof w.fieldValue === 'string' && w.fieldValue ? w.fieldValue : 'Off'
  return typeof w.fieldValue === 'string' ? w.fieldValue : ''
}
