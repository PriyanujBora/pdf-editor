/**
 * Writes the user's form values into the file (export worker, Phase 6). Only fields whose value
 * changed are touched; their appearance is redrawn in the field's own /DA font when that is a
 * standard font and can encode the value, else in a bundled font for the value's script (so ₹ or
 * Bengali still show). Calculation scripts are kept as they are (not run here). Optional flatten.
 */
import {
  degrees,
  PDFName,
  type PDFPage,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  type PDFDocument,
  type PDFFont,
} from '@cantoo/pdf-lib'
import { fontRuns } from '@/lib/fonts'
import type { FieldElement, FieldValue, FontFamilyId } from '@/types'
import { apply, type Mat } from './matrix'

const STD: [RegExp, StandardFonts][] = [
  [/^(cour|courier)/i, StandardFonts.Courier],
  [/^(tiro|times|tibo|tiit)/i, StandardFonts.TimesRoman],
  [/^(helv|helvetica|arial)/i, StandardFonts.Helvetica],
]

/**
 * New fields on a flat form (Phase 6): real text fields and check boxes at the boxes the user kept,
 * transparent (the printed line or box stays the visual), upright on rotated pages, unique names.
 */
export async function createFields(doc: PDFDocument, items: { page: PDFPage; toPdf: Mat; rotate: number; el: FieldElement }[]) {
  if (!items.length) return
  const form = doc.getForm()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const taken = new Set(form.getFields().map((f) => f.getName()))
  for (const { page, toPdf, rotate, el } of items) {
    const ps = [apply(toPdf, el.x, el.y), apply(toPdf, el.x + el.width, el.y + el.height)]
    const box = { x: Math.min(ps[0].x, ps[1].x), y: Math.min(ps[0].y, ps[1].y), width: Math.abs(ps[1].x - ps[0].x), height: Math.abs(ps[1].y - ps[0].y) }
    let name = el.name.trim().replace(/\./g, ' ') || 'Field'
    const base = name
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`
    taken.add(name)
    const field = el.fieldType === 'checkbox' ? form.createCheckBox(name) : form.createTextField(name)
    if (field instanceof PDFTextField && el.multiline) field.enableMultiline()
    field.addToPage(page, { ...box, borderWidth: 0, rotate: degrees(rotate) })
    // No white background or border: the printed form stays visible.
    for (const w of field.acroField.getWidgets()) {
      const mk = w.getAppearanceCharacteristics()
      mk?.dict.delete(PDFName.of('BG'))
      mk?.dict.delete(PDFName.of('BC'))
    }
    if (field instanceof PDFTextField) field.updateAppearances(helv)
    else field.updateAppearances()
  }
}

export async function fillForm(
  doc: PDFDocument,
  values: Record<string, FieldValue>,
  flatten: boolean,
  bundled: (family: FontFamilyId) => Promise<PDFFont>,
): Promise<{ changed: number; notes: string[] }> {
  const notes: string[] = []
  if (!Object.keys(values).length && !flatten) return { changed: 0, notes }
  const form = doc.getForm()
  const std = new Map<StandardFonts, PDFFont>()
  const standard = async (f: StandardFonts) => {
    let font = std.get(f)
    if (!font) std.set(f, (font = await doc.embedFont(f)))
    return font
  }
  let changed = 0
  for (const [name, v] of Object.entries(values)) {
    const field = form.getFieldMaybe(name)
    if (!field) continue
    try {
      if (field instanceof PDFTextField) {
        const s = Array.isArray(v) ? v.join(', ') : v
        if ((field.getText() ?? '') === s) continue
        const max = field.getMaxLength()
        field.setText(max ? s.slice(0, max) : s)
        // The field's own /DA font when it's a standard font that can show the value.
        const da = field.acroField.getDefaultAppearance() ?? ''
        const daFont = /\/([^\s/]+)\s+[\d.]+\s+Tf/.exec(da)?.[1] ?? 'Helv'
        let font: PDFFont | null = null
        const stdName = STD.find(([re]) => re.test(daFont))?.[1] ?? StandardFonts.Helvetica
        const f0 = await standard(stdName)
        // Standard fonts only cover WinAnsi (pdf-lib would silently drop the rest).
        const covered = new Set(f0.getCharacterSet())
        if ([...s.replace(/[\r\n]/g, '')].every((ch) => covered.has(ch.codePointAt(0)!))) font = f0
        else {
          const family = fontRuns(s, 'arimo').find((r) => r.font !== 'arimo')?.font ?? 'arimo'
          font = await bundled(family)
        }
        field.updateAppearances(font)
        changed++
      } else if (field instanceof PDFCheckBox) {
        const on = (Array.isArray(v) ? v[0] : v) !== 'Off'
        if (on === field.isChecked()) continue
        if (on) field.check()
        else field.uncheck()
        changed++
      } else if (field instanceof PDFRadioGroup) {
        const s = Array.isArray(v) ? v[0] : v
        if ((field.getSelected() ?? 'Off') === s) continue
        if (s === 'Off') field.clear()
        else if (field.getOptions().includes(s)) field.select(s)
        else continue
        changed++
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const want = (Array.isArray(v) ? v : [v]).filter((x) => field.getOptions().includes(x))
        const have = field.getSelected()
        if (want.length === have.length && want.every((x, i) => x === have[i])) continue
        if (!want.length) field.clear()
        else if (field instanceof PDFDropdown) field.select(want[0])
        else field.select(want)
        field.updateAppearances(await standard(StandardFonts.Helvetica))
        changed++
      }
    } catch (err) {
      notes.push(`“${name}”: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (flatten) form.flatten({ updateFieldAppearances: false })
  return { changed, notes }
}
