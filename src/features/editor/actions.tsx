import { LockKeyhole } from 'lucide-react'
import { toast } from 'sonner'
import { choose } from './choice'
import { blockedReasons, confirmRedaction, explain, liveMarks, redactionConflicts } from './redact-download'
import { downloadBytes, editedFileName, exportPdf } from '@/lib/export/export-client'
import { ImageError, ingestImage } from '@/lib/images'
import { uid } from '@/lib/ids'
import { sampleColors } from '@/lib/pdf/sample'
import { originalFontFor, refreshOriginal, scanDocumentInBackground } from '@/lib/pdf/font-scan'
import { caretAt, layoutLine } from '@/lib/text/line-layout'
import { mergeLines, mergeRow } from '@/lib/text/para-layout'
import { paragraphOf } from '@/lib/text/paragraphs'
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
/**
 * Edits an existing line — or, by default, the whole paragraph it belongs to (Phase 5);
 * `lineOnly` (Alt-click, or "Edit this line only") edits just the line.
 */
export function editTextBlock(page: PageItem, block: TextBlock, at?: { x: number; y: number }, all: TextBlock[] = [], opts: { lineOnly?: boolean } = {}) {
  if (block.ocr) void editScanBlock(page, block)
  else if (block.source) {
    const para = opts.lineOnly ? null : paragraphOf(all, all.indexOf(block))
    if (para) editSourcePara(page, para.members.map((row) => row.map((i) => all[i])), para, at, all)
    else editSourceLine(page, block, at, all)
  } else editVectorBlock(page, block)
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
/** A detected line made ready for editing: patch bands, page colour, fonts, flattened opacity. */
function prepareLine(page: PageItem, block: TextBlock, all: TextBlock[]) {
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
  return { source: { ...rest, background, fonts, coverTop, coverBottom } as NonNullable<TextElement['source']>, size, family, bold, italic, color }
}

function startSourceEdit(el: TextElement, at: { x: number; y: number } | undefined) {
  const caret = at ? caretAt(layoutLine(el, measureCanvas), at.x, at.y) : el.text.length
  beginEditSession(el.id)
  useDoc.getState().addElement(el)
  useUi.getState().set({ selectedId: el.id, editingId: el.id, caret })
  const pdf = useSession.getState().pdf
  if (pdf) scanDocumentInBackground(pdf)
}

function editSourceLine(page: PageItem, block: TextBlock, at: { x: number; y: number } | undefined, all: TextBlock[]) {
  const { source, size, family, bold, italic, color } = prepareLine(page, block, all)
  const el: TextElement = {
    id: uid('t_'),
    kind: 'text',
    pageId: page.id,
    x: source.box.x,
    y: source.box.y,
    rotation: 0,
    text: source.text,
    font: family,
    size: Math.round(size * 100) / 100,
    color,
    bold,
    italic,
    align: 'left',
    lineHeight: 1.2,
    source,
  }
  startSourceEdit(el, at)
}

/** "Shrink to fit": the largest text scale (≥ 50 %) at which the paragraph fits its printed lines. */
export function shrinkToFit(el: TextElement) {
  const n = el.source?.para?.lines.length
  if (!n) return
  const fits = (k: number) => (layoutLine({ ...el, paraScale: k }, measureCanvas).lines ?? n) <= n
  if (!fits(0.5)) {
    toast('This paragraph doesn’t fit even at half size', { description: 'Shorten the text, or let it run on.' })
    return
  }
  let lo = 0.5
  let hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  useDoc.getState().updateElement(el.id, { paraScale: Math.floor(lo * 1000) / 1000 }, { merge: false })
}

/** Switch an unchanged paragraph edit to editing one of its lines only. */
export function editParagraphLine(el: TextElement, k: number) {
  const line = el.source?.para?.lines[k]
  if (!line) return
  useUi.getState().set({ editingId: null })
  endEditSession(el.id)
  if (useDoc.getState().elements[el.id]) useDoc.getState().removeElement(el.id)
  const run = line.runs[0]
  const next: TextElement = {
    ...el,
    id: uid('t_'),
    x: line.box.x,
    y: line.box.y,
    text: line.text,
    size: Math.round((run?.size ?? el.size) * 100) / 100,
    lineHeight: 1.2,
    align: 'left',
    paraScale: undefined,
    source: line,
  }
  startSourceEdit(next, undefined)
}

/** Edit a whole printed paragraph: its lines merged into one source (see lib/text/para-layout.ts). */
function editSourcePara(
  page: PageItem,
  rows: TextBlock[][],
  info: { align: TextElement['align'] | 'justify'; left: number; right: number; firstLeft: number; leading: number },
  at: { x: number; y: number } | undefined,
  all: TextBlock[],
) {
  const prepared = rows.map((row) => row.map((b) => prepareLine(page, b, all)))
  const source = mergeLines(
    prepared.map((row) => mergeRow(row.map((p) => p.source))),
    { align: info.align, left: info.left, right: info.right, firstLeft: info.firstLeft, leading: info.leading },
  )
  const main = prepared[0][0]
  const el: TextElement = {
    id: uid('t_'),
    kind: 'text',
    pageId: page.id,
    x: source.box.x,
    y: source.box.y,
    rotation: 0,
    text: source.text,
    font: main.family,
    size: Math.round(main.size * 100) / 100,
    color: main.color,
    bold: main.bold,
    italic: main.italic,
    align: info.align === 'justify' ? 'left' : info.align,
    lineHeight: Math.round((info.leading / main.size) * 100) / 100,
    source,
  }
  startSourceEdit(el, at)
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
  const marks = liveMarks()
  const cleanUp = Object.values(useSession.getState().sanitize).some(Boolean)
  if (marks.length || cleanUp) {
    const conflicts = redactionConflicts(marks)
    if (conflicts.length) {
      await explain('Can’t redact yet', 'Some things on the marked pages can’t be redacted:', conflicts)
      exporting = false
      return
    }
    if (!(await confirmRedaction(marks))) {
      exporting = false
      return
    }
  }
  // Password-protected input: the user decides whether the download stays protected.
  let keepEncryption = true
  if (useSession.getState().encrypted) {
    const pick = await choose({
      title: 'Keep the password protection?',
      icon: <LockKeyhole className="size-5" />,
      description: (
        <>
          The original is password-protected. Keeping protection saves your download with the same passwords and
          permissions. Your password is only used on this device and never stored.
        </>
      ),
      options: [
        { value: 'keep', label: 'Keep protection' },
        { value: 'remove', label: 'Remove protection', variant: 'outline' },
      ],
    })
    if (!pick) {
      exporting = false
      return
    }
    keepEncryption = pick === 'keep'
  }
  const id = toast.loading('Preparing your PDF…')
  try {
    const { bytes, notes, redaction } = await exportPdf((v) => toast.loading(`Preparing your PDF… ${Math.round(v * 100)}%`, { id }), { keepEncryption })
    useSession.getState().set({ notRemoved: Object.fromEntries(notes.map((n) => [n.elementId, n.reason])) })
    if (redaction && (redaction.problems.length || redaction.leaks.length)) {
      toast.error('Nothing was downloaded', { id, duration: 5000 })
      await explain('Nothing was downloaded', 'The redaction couldn’t be completed safely:', blockedReasons(redaction))
      return
    }
    if (marks.length) {
      // Open the result again with an independent reader and make sure nothing marked survived.
      toast.loading('Checking the redacted file…', { id })
      const s = useSession.getState()
      const { verifyRedaction } = await import('@/lib/redact/verify')
      const v = await verifyRedaction(bytes, keepEncryption && s.encrypted ? s.password : '', useDoc.getState().pages, s.sourcePages, marks, s.pdf!)
      if (v.problems.length) {
        toast.error('Nothing was downloaded', { id, duration: 5000 })
        await explain('Nothing was downloaded', 'The check after redacting found something that should be gone:', v.problems)
        return
      }
    }
    downloadBytes(bytes, editedFileName(useSession.getState().fileName))
    const extra = redaction?.sanitizeNotes.length ? ' ' + redaction.sanitizeNotes.join(' ') : ''
    if (marks.length && !notes.length)
      toast.success('Redacted and verified: 0 matches remain', {
        id,
        duration: 8000,
        description:
          `Checked the text under ${marks.length === 1 ? 'the mark' : `all ${marks.length} marks`}, the marked words throughout the file, and its metadata, attachments, comments and form fields.` +
          (redaction?.sanitized.length ? ` Also removed: ${redaction.sanitized.join(', ')}.` : '') +
          extra,
      })
    else if (cleanUp && !notes.length)
      toast.success('Downloaded', {
        id,
        duration: 6000,
        description: (redaction?.sanitized.length ? `Removed: ${redaction.sanitized.join(', ')}.` : 'There was nothing to clean up.') + extra,
      })
    else if (notes.length)
      // Honest at the moment it matters: the old words are still inside the downloaded file.
      toast.warning(notes.length === 1 ? 'One edit couldn’t remove the old text' : `${notes.length} edits couldn’t remove the old text`, {
        id,
        duration: 12000,
        description: `It’s covered on the page but still in the file (${notes[0].reason}). Don’t rely on these edits to hide information.`,
      })
    else toast.success('Downloaded', { id, duration: 2500 })
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
