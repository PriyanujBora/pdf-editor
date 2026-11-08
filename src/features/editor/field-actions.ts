import { toast } from 'sonner'
import { detectFields } from '@/lib/fields/detect'
import { uid } from '@/lib/ids'
import { pdfPageOf, sourceOf } from '@/lib/page-source'
import { searchLines } from '@/lib/redact/find'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import type { FieldElement, PageItem } from '@/types'

function currentPage(): PageItem | undefined {
  const { pages } = useDoc.getState()
  return pages.find((p) => p.id === useUi.getState().currentPageId) ?? pages[0]
}

const names = () => new Set(Object.values(useDoc.getState().elements).flatMap((e) => (e.kind === 'field' ? [e.name] : [])))

/** Finds the form fields a flat form expects on the page in view and adds them, ready to adjust. */
export async function detectOnCurrentPage() {
  const page = currentPage()
  if (!page) return
  const pg = await pdfPageOf(page)
  if (!pg) {
    toast('Nothing to detect on a blank page')
    return
  }
  const src = sourceOf(page)
  const lines = await searchLines(pg, src.key)
  const found = await detectFields(pg, src.info.rotate, lines, src.info.width)
  // Skip spots that already have a field.
  const existing = Object.values(useDoc.getState().elements).filter((e): e is FieldElement => e.kind === 'field' && e.pageId === page.id)
  const fresh = found.filter((f) => !existing.some((e) => Math.abs(e.x - f.rect.x) < 4 && Math.abs(e.y - f.rect.y) < 4))
  const taken = names()
  const els: FieldElement[] = fresh.map((f) => {
    let name = f.name
    for (let n = 2; taken.has(name); n++) name = `${f.name} ${n}`
    taken.add(name)
    return { id: uid('f_'), kind: 'field', pageId: page.id, fieldType: f.fieldType, name, x: f.rect.x, y: f.rect.y, width: f.rect.width, height: f.rect.height, rotation: 0, ...(f.multiline ? { multiline: true } : {}) }
  })
  useDoc.getState().addElements(els)
  if (els.length)
    toast.success(`Found ${els.length} ${els.length === 1 ? 'field' : 'fields'}`, {
      description: 'Move, resize, rename or delete them. They become real form fields when you download.',
    })
  else toast('No fields found on this page', { description: 'Add them yourself with “Add text field” or “Add check box”.' })
}

/** A field in the middle of the page in view. */
export function addField(fieldType: FieldElement['fieldType']) {
  const page = currentPage()
  if (!page) return
  const { width, height } = sourceOf(page).info
  const w = fieldType === 'checkbox' ? 14 : 180
  const h = fieldType === 'checkbox' ? 14 : 18
  const taken = names()
  const base = fieldType === 'checkbox' ? 'Check box' : 'Text field'
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`
  const el: FieldElement = { id: uid('f_'), kind: 'field', pageId: page.id, fieldType, name, x: (width - w) / 2, y: (height - h) / 2, width: w, height: h, rotation: 0 }
  useDoc.getState().addElement(el)
  useUi.getState().set({ selectedId: el.id, tool: 'select' })
}
