import { toast } from 'sonner'
import { downloadBytes, editedFileName, exportPdf } from '@/lib/export/export-client'
import { ImageError, ingestImage } from '@/lib/images'
import { uid } from '@/lib/ids'
import { sampleColors } from '@/lib/pdf/sample'
import { originalFontFor, refreshOriginal, scanDocumentInBackground } from '@/lib/pdf/font-scan'
import { caretAt, layoutLine } from '@/lib/text/line-layout'
import { measureCanvas } from '@/lib/text/measure-canvas'
import { fitScanLine } from '@/lib/scan/fit'
import type { TextBlock } from '@/lib/pdf/text-blocks'
import { ASCENT } from '@/lib/text-layout'
import { apply, rotate, userRotation } from '@/lib/export/matrix'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { EditorElement, OriginalFont, PageItem, PtRect, TextElement } from '@/types'

/** Last rendered canvas per page, used to sample colours. */
export const renderedCanvases = new Map<string, { canvas: HTMLCanvasElement; scale: number }>()

export function pageSize(page: PageItem) {
  const info = useSession.getState().sourcePages[page.srcIndex]
  return { width: info.width, height: info.height }
}

/**
 * New elements on a page the user rotated get the opposite rotation, so
 * they appear upright on screen. Returns that rotation and a helper mapping
 * a screen-space offset into page space.
 */
function uprightOn(page: PageItem | undefined) {
  const rotation = page ? (360 - page.rotation) % 360 : 0
  const m = rotate(rotation)
  return { rotation, offset: (dx: number, dy: number) => apply(m, dx, dy) }
}

export function createTextAt(pageId: string, x: number, y: number) {
  const prev = Object.values(useDoc.getState().elements).findLast((e): e is TextElement => e.kind === 'text' && !e.cover)
  const size = prev?.size ?? 16
  const up = uprightOn(useDoc.getState().pages.find((p) => p.id === pageId))
  // Put the tapped point at the middle of the first line.
  const o = up.offset(0, -size * 0.6)
  const el: TextElement = {
    id: uid('t_'),
    kind: 'text',
    pageId,
    x: x + o.x,
    y: y + o.y,
    rotation: up.rotation,
    text: '',
    font: prev?.font ?? 'inter',
    size,
    color: prev?.color ?? '#111111',
    bold: false,
    italic: false,
    align: 'left',
    lineHeight: 1.2,
  }
  useDoc.getState().addElement(el)
  useUi.getState().set({ tool: 'select', selectedId: el.id, editingId: el.id })
}

const SCAN_FALLBACK: Record<string, string> = {
  faint: 'the text here is too faint',
  busy: 'the background here is too busy',
  'no-match': 'no bundled font is close enough',
}

let fitting: string | null = null

/** Edit a line of OCR text on a scanned page by drawing into the scan itself. */
async function editScanBlock(page: PageItem, block: TextBlock) {
  if (fitting === block.id) return
  fitting = block.id
  const { pdf, sourcePages } = useSession.getState()
  const info = sourcePages[page.srcIndex]
  let toastId: string | number | undefined
  const slow = setTimeout(() => (toastId = toast.loading('Matching the scan…')), 250)
  try {
    const fit = pdf ? await fitScanLine(await pdf.getPage(page.srcIndex + 1), info, page.srcIndex, block) : null
    clearTimeout(slow)
    if (!fit?.ok) {
      const why = fit && !fit.ok ? SCAN_FALLBACK[fit.reason] : undefined
      if (why) toast(`Couldn’t blend into the scan: ${why}`, { id: toastId, description: 'Using a plain patch instead.' })
      else if (toastId !== undefined) toast.dismiss(toastId)
      editVectorBlock(page, block)
      return
    }
    if (toastId !== undefined) toast.dismiss(toastId)
    const el: TextElement = {
      id: uid('t_'),
      kind: 'text',
      pageId: page.id,
      x: fit.x,
      y: fit.y,
      rotation: 0,
      text: block.text,
      font: fit.font,
      size: fit.size,
      color: fit.color,
      bold: fit.bold,
      italic: false,
      align: 'left',
      lineHeight: 1.2,
      scan: fit.match,
    }
    useDoc.getState().addElement(el)
    useUi.getState().set({ selectedId: el.id, editingId: el.id })
  } catch (err) {
    clearTimeout(slow)
    console.warn('scan fit failed', err)
    if (toastId !== undefined) toast.dismiss(toastId)
    editVectorBlock(page, block)
  } finally {
    fitting = null
  }
}

/** Turns a detected line of existing text into an editable replacement. */
export function editTextBlock(page: PageItem, block: TextBlock, at?: { x: number; y: number }, all: TextBlock[] = []) {
  if (block.ocr) void editScanBlock(page, block)
  else if (block.source) editSourceLine(page, block, at, all)
  else editVectorBlock(page, block)
}

// --- Edit sessions -------------------------------------------------------------
//
// Clicking a line must not change the document. Editing a source line runs as a session with undo
// tracking paused: if the line ends up exactly as printed, the draft element is dropped and nothing
// is recorded; otherwise the whole session becomes a single undo step.

let session: { id: string; pre: { pages: PageItem[]; elements: Record<string, EditorElement> } } | null = null

export function isNoOpEdit(el: EditorElement | undefined): boolean {
  if (!el || el.kind !== 'text' || !el.source) return false
  const b = el.source.box
  return el.text === el.source.text && !el.override && Math.abs(el.x - b.x) < 0.005 && Math.abs(el.y - b.y) < 0.005
}

export function beginEditSession(id: string) {
  if (session?.id === id) return
  if (session) endEditSession(session.id)
  const d = useDoc.getState()
  session = { id, pre: { pages: d.pages, elements: d.elements } }
  useDoc.temporal.getState().pause()
}

export function endEditSession(id: string) {
  if (!session || session.id !== id) return
  const { pre } = session
  session = null
  const doc = useDoc.getState()
  if (isNoOpEdit(doc.elements[id])) {
    doc.removeElement(id)
    const ui = useUi.getState()
    if (ui.selectedId === id) ui.set({ selectedId: null })
  }
  const t = useDoc.temporal.getState()
  t.resume()
  const now = useDoc.getState()
  const keys = new Set([...Object.keys(pre.elements), ...Object.keys(now.elements)])
  const same = now.pages === pre.pages && [...keys].every((k) => now.elements[k] === pre.elements[k])
  if (!same) useDoc.temporal.setState((st) => ({ pastStates: [...st.pastStates, pre].slice(-200), futureStates: [] }))
}

/** Page colour behind a page-space rectangle (for patches over changed words). */
function sampleBackground(page: PageItem, r: PtRect): { background: string; ink: string } {
  const rendered = renderedCanvases.get(page.id)
  if (!rendered) return { background: '#ffffff', ink: '#000000' }
  const { width, height } = pageSize(page)
  const m = userRotation(page.rotation, width, height)
  const p1 = apply(m, r.x, r.y)
  const p2 = apply(m, r.x + r.width, r.y + r.height)
  const k = rendered.scale
  return sampleColors(rendered.canvas, {
    x: Math.min(p1.x, p2.x) * k,
    y: Math.min(p1.y, p2.y) * k,
    w: Math.abs(p2.x - p1.x) * k,
    h: Math.abs(p2.y - p1.y) * k,
  })
}

/** Edit an existing vector line: nothing changes on the page until the text does. */
function editSourceLine(page: PageItem, block: TextBlock, at: { x: number; y: number } | undefined, all: TextBlock[]) {
  const line = block.source!
  // Where boxes of neighbouring lines overlap, split the band where the ink is: descenders reach
  // ~0.23 em below a baseline, ascenders ~0.76 em above one. Patches stay on this line's side.
  const pad = 0.25
  let coverTop = line.box.y - pad
  let coverBottom = line.box.y + line.box.height + pad
  for (const o of all) {
    const b = o.source?.box
    if (!b || o === block || b.x >= line.box.x + line.box.width || b.x + b.width <= line.box.x) continue
    // Only genuine neighbours: pieces of the same row (or a merged superscript) are not.
    if (Math.abs(o.baseline - line.baseline) < 0.6 * Math.max(line.size, o.size)) continue
    const oBottom = b.y + b.height
    if (o.baseline < line.baseline && oBottom > coverTop)
      coverTop = Math.max(coverTop, Math.min(line.baseline - 0.5 * line.size, o.baseline + 0.23 * o.size))
    if (o.baseline > line.baseline && b.y < coverBottom)
      coverBottom = Math.min(coverBottom, Math.max(line.baseline + 0.15 * line.size, o.baseline - 0.76 * o.size))
  }
  const sp = Math.max(1, line.size * 0.08)
  const { background } = sampleBackground(page, {
    x: line.box.x - sp,
    y: line.box.y - sp,
    width: line.box.width + 2 * sp,
    height: line.box.height + 2 * sp,
  })
  // Glyphs each font has drawn anywhere in the document so far (more pages scanned → more).
  const fonts: Record<string, OriginalFont> = {}
  for (const r of line.runs) {
    if (r.type3 || fonts[r.baseFont]) continue
    const f = originalFontFor(r.loadedName)
    if (f) fonts[r.baseFont] = refreshOriginal(f)
  }
  // Semi-transparent text (Canva & co. grey via opacity): flatten against the page colour.
  const flat = (hex: string, alpha = 1) => {
    if (alpha >= 0.999) return hex
    const c = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
    return '#' + [0, 1, 2].map((i) => Math.round(c(hex, i) * alpha + c(background, i) * (1 - alpha)).toString(16).padStart(2, '0')).join('')
  }
  const runs = line.runs.map((r) => ({ ...r, color: flat(r.color, r.alpha), alpha: 1 }))
  const { size, family, bold, italic, ...rest } = { ...line, runs }
  const color = runs.find((r) => r.color)?.color ?? line.color
  const el: TextElement = {
    id: uid('t_'),
    kind: 'text',
    pageId: page.id,
    x: line.box.x,
    y: line.box.y,
    rotation: 0,
    text: line.text,
    font: family,
    size: Math.round(size * 100) / 100,
    color,
    bold,
    italic,
    align: 'left',
    lineHeight: 1.2,
    source: { ...rest, background, fonts, coverTop, coverBottom },
  }
  const caret = at ? caretAt(layoutLine(el, measureCanvas), at.x) : el.text.length
  beginEditSession(el.id)
  useDoc.getState().addElement(el)
  useUi.getState().set({ selectedId: el.id, editingId: el.id, caret })
  const pdf = useSession.getState().pdf
  if (pdf) scanDocumentInBackground(pdf)
}

/** Replacement drawn on top: background-coloured cover + new text. */
function editVectorBlock(page: PageItem, block: TextBlock) {
  const rendered = renderedCanvases.get(page.id)
  let colors = { background: '#ffffff', ink: '#000000' }
  const pad = Math.max(1, block.size * 0.08)
  const cover = { x: block.x - pad, y: block.y - pad, width: block.width + 2 * pad, height: block.height + 2 * pad }
  if (rendered) {
    const { width, height } = pageSize(page)
    const m = userRotation(page.rotation, width, height)
    const p1 = apply(m, cover.x, cover.y)
    const p2 = apply(m, cover.x + cover.width, cover.y + cover.height)
    const k = rendered.scale
    colors = sampleColors(rendered.canvas, {
      x: Math.min(p1.x, p2.x) * k,
      y: Math.min(p1.y, p2.y) * k,
      w: Math.abs(p2.x - p1.x) * k,
      h: Math.abs(p2.y - p1.y) * k,
    })
  }
  const el: TextElement = {
    id: uid('t_'),
    kind: 'text',
    pageId: page.id,
    x: block.x,
    y: block.baseline - ASCENT * block.size,
    rotation: 0,
    text: block.text,
    font: block.font,
    size: Math.round(block.size * 100) / 100,
    color: colors.ink,
    bold: block.bold,
    italic: block.italic,
    align: 'left',
    lineHeight: 1.2,
    cover: { ...cover, color: colors.background, original: block.text },
    // Use the PDF's own font by default when it has the glyphs.
    ...(block.original ? { original: block.original, useOriginal: true } : {}),
  }
  useDoc.getState().addElement(el)
  useUi.getState().set({ selectedId: el.id, editingId: el.id })
  const pdf = useSession.getState().pdf
  if (pdf && block.original) scanDocumentInBackground(pdf)
}

export async function addImage(file: File) {
  const ui = useUi.getState()
  const pages = useDoc.getState().pages
  const page = pages.find((p) => p.id === ui.currentPageId) ?? pages[0]
  if (!page) return
  try {
    const asset = await ingestImage(file)
    useSession.getState().addAsset(asset)
    const { width: pw, height: ph } = pageSize(page)
    const k = Math.min(1, (pw * 0.5) / asset.width, (ph * 0.5) / asset.height)
    const w = asset.width * k
    const h = asset.height * k
    const id = uid('i_')
    // Centre on the page, upright on screen even if the page is rotated.
    const up = uprightOn(page)
    const o = up.offset(-w / 2, -h / 2)
    useDoc.getState().addElement({
      id,
      kind: 'image',
      pageId: page.id,
      assetId: asset.id,
      x: pw / 2 + o.x,
      y: ph / 2 + o.y,
      width: w,
      height: h,
      rotation: up.rotation,
    })
    useUi.getState().set({ tool: 'select', selectedId: id, editingId: null })
  } catch (err) {
    toast.error(err instanceof ImageError ? err.message : 'That image couldn’t be added.')
  }
}

export function deleteSelected() {
  const { selectedId } = useUi.getState()
  if (!selectedId) return
  useDoc.getState().removeElement(selectedId)
  useUi.getState().set({ selectedId: null, editingId: null, propsOpen: false })
}

let exporting = false
export async function downloadPdf() {
  if (exporting) return
  exporting = true
  useUi.getState().set({ editingId: null })
  const id = toast.loading('Preparing your PDF…')
  try {
    const bytes = await exportPdf((v) => toast.loading(`Preparing your PDF… ${Math.round(v * 100)}%`, { id }))
    downloadBytes(bytes, editedFileName(useSession.getState().fileName))
    toast.success('Downloaded', { id, duration: 2500 })
  } catch (err) {
    console.error(err)
    toast.error('Export failed. ' + (err instanceof Error ? err.message : ''), { id })
  } finally {
    exporting = false
  }
}

let pickImageInput: HTMLInputElement | null = null
export function pickImage() {
  if (!pickImageInput) {
    pickImageInput = document.createElement('input')
    pickImageInput.type = 'file'
    pickImageInput.accept = 'image/png,image/jpeg,.png,.jpg,.jpeg'
    pickImageInput.onchange = () => {
      const f = pickImageInput!.files?.[0]
      if (f) void addImage(f)
      pickImageInput!.value = ''
    }
  }
  pickImageInput.click()
}
