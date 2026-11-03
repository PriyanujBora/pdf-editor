import { toast } from 'sonner'
import { downloadBytes, editedFileName, exportPdf } from '@/lib/export/export-client'
import { ImageError, ingestImage } from '@/lib/images'
import { uid } from '@/lib/ids'
import { sampleColors } from '@/lib/pdf/sample'
import { scanDocumentInBackground } from '@/lib/pdf/font-scan'
import type { TextBlock } from '@/lib/pdf/text-blocks'
import { ASCENT } from '@/lib/text-layout'
import { apply, rotate, userRotation } from '@/lib/export/matrix'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { PageItem, TextElement } from '@/types'

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

/** Turns a detected line of existing text into an editable replacement. */
export function editTextBlock(page: PageItem, block: TextBlock) {
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
