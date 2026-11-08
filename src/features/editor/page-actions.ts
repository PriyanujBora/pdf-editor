import { toast } from 'sonner'
import { downloadBytes, exportPdf } from '@/lib/export/export-client'
import { uid } from '@/lib/ids'
import { sourceOf } from '@/lib/page-source'
import { cleanupWhenIdle, loadPdfJs, PDFJS_ASSET_OPTIONS } from '@/lib/pdf/pdfjs'
import { saveInsertedDoc } from '@/lib/persist'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { EditorElement, PageItem, Rotation, SourcePageInfo } from '@/types'

/** Index after which new pages go: after the page in view. */
function insertionIndex() {
  const { pages } = useDoc.getState()
  const cur = useUi.getState().currentPageId
  const i = pages.findIndex((p) => p.id === cur)
  return i < 0 ? pages.length : i + 1
}

export async function readPageInfos(pdf: { numPages: number; getPage: (n: number) => Promise<{ view: number[]; rotate: number; getViewport: (o: { scale: number }) => { width: number; height: number } }> }) {
  const out: SourcePageInfo[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const p = await pdf.getPage(n)
    const vp = p.getViewport({ scale: 1 })
    out.push({ view: p.view as [number, number, number, number], rotate: (((p.rotate % 360) + 360) % 360) as Rotation, width: vp.width, height: vp.height })
  }
  return out
}

/** Opens a PDF with pdf.js as an inserted document (no password support: say so). */
export async function openInserted(id: string, name: string, bytes: Uint8Array) {
  const pdfjs = await loadPdfJs()
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), ...PDFJS_ASSET_OPTIONS, fontExtraProperties: true, enableXfa: false }).promise
  cleanupWhenIdle(pdf)
  const sourcePages = await readPageInfos(pdf)
  useSession.setState((s) => ({ docs: { ...s.docs, [id]: { name, bytes, pdf, sourcePages } } }))
  return sourcePages
}

export async function insertPdf(file: File) {
  const id = uid('d_')
  const t = toast.loading(`Adding ${file.name}…`)
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const infos = await openInserted(id, file.name, bytes)
    void saveInsertedDoc(id, file.name, bytes).catch(() => {})
    const items: PageItem[] = infos.map((_, i) => ({ id: uid('p_'), srcIndex: i, rotation: 0, doc: id }))
    useDoc.getState().insertPages(insertionIndex(), items)
    toast.success(`Added ${items.length} ${items.length === 1 ? 'page' : 'pages'} from ${file.name}`, { id: t })
  } catch (err) {
    const msg = String((err as Error)?.name ?? err)
    toast.error(/Password/i.test(msg) ? 'That PDF is password-protected' : 'Couldn’t add that PDF', {
      id: t,
      description: /Password/i.test(msg) ? 'Open it on its own, remove the protection, then add it here.' : 'It may be damaged or not a PDF.',
    })
  }
}

let picker: HTMLInputElement | null = null
export function pickPdfToInsert() {
  if (!picker) {
    picker = document.createElement('input')
    picker.type = 'file'
    picker.accept = 'application/pdf,.pdf'
    picker.onchange = () => {
      const f = picker!.files?.[0]
      if (f) void insertPdf(f)
      picker!.value = ''
    }
  }
  picker.click()
}

/** A blank page the size of the page in view. */
export function addBlankPage() {
  const { pages } = useDoc.getState()
  const cur = pages.find((p) => p.id === useUi.getState().currentPageId) ?? pages[0]
  const info = cur ? sourceOf(cur).info : { width: 595, height: 842 }
  const item: PageItem = { id: uid('p_'), srcIndex: -1, rotation: 0, blank: { width: Math.round(info.width * 100) / 100, height: Math.round(info.height * 100) / 100 } }
  useDoc.getState().insertPages(insertionIndex(), [item])
}

/** Duplicate a page as it is now: same source page, rotation and everything added on it. */
export function duplicatePage(pageId: string) {
  const d = useDoc.getState()
  const i = d.pages.findIndex((p) => p.id === pageId)
  if (i < 0) return
  const copy: PageItem = { ...d.pages[i], id: uid('p_') }
  const els: EditorElement[] = Object.values(d.elements)
    .filter((e) => e.pageId === pageId)
    .map((e) => ({ ...e, id: uid(e.id.slice(0, 2)), pageId: copy.id }) as EditorElement)
  d.insertPages(i + 1, [copy], els)
}

/** "1-3, 5, 8-" → page indices (0-based) of the current order; null when invalid. */
export function parseRanges(s: string, n: number): number[] | null {
  const out: number[] = []
  for (const part of s.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*(?:-\s*(\d*))?$/.exec(part)
    if (!m) return null
    const a = m[1] ? +m[1] : 1
    const b = part.includes('-') ? (m[2] ? +m[2] : n) : a
    if (a < 1 || b > n || a > b) return null
    for (let k = a; k <= b; k++) out.push(k - 1)
  }
  return out.length ? out : null
}

const base = () => useSession.getState().fileName.replace(/\.pdf$/i, '')

/** Downloads the chosen pages (with their edits) as a new PDF. */
export async function extractPages(indices: number[], label: string) {
  const pages = useDoc.getState().pages
  const t = toast.loading('Preparing your PDF…')
  try {
    const { bytes } = await exportPdf(undefined, { pages: indices.map((i) => pages[i]), keepEncryption: false })
    downloadBytes(bytes, `${base()}-${label}.pdf`)
    toast.success('Downloaded', { id: t })
  } catch (err) {
    toast.error('Export failed. ' + (err instanceof Error ? err.message : ''), { id: t })
  }
}

/** One file per group of `every` pages. */
export async function splitEvery(every: number) {
  const pages = useDoc.getState().pages
  for (let start = 0; start < pages.length; start += every) {
    const idx = Array.from({ length: Math.min(every, pages.length - start) }, (_, k) => start + k)
    const label = idx.length === 1 ? `p${idx[0] + 1}` : `p${idx[0] + 1}-${idx[idx.length - 1] + 1}`
    await extractPages(idx, label)
  }
}
