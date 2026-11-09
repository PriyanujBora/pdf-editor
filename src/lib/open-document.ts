import { classifyError, cleanupWhenIdle, loadPdfJs, PDFJS_ASSET_OPTIONS, type OpenError } from '@/lib/pdf/pdfjs'
import { clearSaved, loadSaved, saveSource, saveState } from '@/lib/persist'
import { uid } from '@/lib/ids'
import { clearHistory, useDoc } from '@/store/document'
import { NO_SANITIZE, useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { EditorElement, FieldValue, ImageAsset, PageItem, Rotation, SanitizeOptions, SourcePageInfo } from '@/types'

export const MAX_FILE_BYTES = 512 * 1024 * 1024

export class OpenFailure extends Error {
  readonly info: OpenError
  constructor(info: OpenError) {
    super(info.kind)
    this.info = info
  }
}

interface OpenOptions {
  password?: string
  /** The picked file: autosaved as a Blob (no extra copy of its bytes in memory). */
  file?: Blob
  /** When resuming an autosaved session. */
  restore?: {
    pages: PageItem[] | null
    elements: Record<string, EditorElement>
    assets: Record<string, ImageAsset>
    sanitize?: SanitizeOptions
    formValues?: Record<string, FieldValue>
    docs?: { id: string; name: string }[]
  }
}

/**
 * Parses a PDF with pdf.js, reads every page's geometry (with progress), and
 * swaps it into the stores. Throws OpenFailure with a classified reason.
 */
export async function openDocument(bytes: Uint8Array, fileName: string, opts: OpenOptions = {}) {
  const session = useSession.getState()
  const prev = session.pdf
  session.set({ status: 'loading', progress: 0, docs: {} })
  const large = !!opts.file && bytes.length > LARGE_FILE
  // The editor's code loads while pdf.js parses the file (Phase 8: first page sooner).
  void import('@/features/editor/Editor')

  try {
    const pdfjs = await loadPdfJs()
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    const task = pdfjs.getDocument({
      // Large files go to pdf.js without a copy (it takes over the buffer); the app keeps the picked
      // file instead and reads it again when exporting. Small ones are simply copied.
      data: large ? bytes : bytes.slice(),
      password: opts.password,
      ...PDFJS_ASSET_OPTIONS,
      fontExtraProperties: true,
      enableXfa: false,
    })
    const pdf = await task.promise
    cleanupWhenIdle(pdf)

    // Page sizes: the first batch before the editor opens, the rest in the background (large files
    // open as fast as small ones). Until a page's size is known it borrows the first page's.
    const sourcePages: SourcePageInfo[] = new Array(pdf.numPages)
    const BATCH = 16
    const infoOf = async (n: number) => {
      const page = await pdf.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      return {
        view: page.view as [number, number, number, number],
        rotate: (((page.rotate % 360) + 360) % 360) as Rotation,
        width: vp.width,
        height: vp.height,
      }
    }
    const first = Math.min(pdf.numPages, BATCH)
    const head = await Promise.all(Array.from({ length: first }, (_, i) => infoOf(i + 1)))
    head.forEach((info, i) => (sourcePages[i] = info))
    for (let i = first; i < pdf.numPages; i++) sourcePages[i] = { ...head[0] }
    useSession.getState().set({ progress: first / pdf.numPages })

    const restored = opts.restore
    let pages: PageItem[] =
      restored?.pages?.filter((p) => p.doc || p.blank || p.srcIndex < pdf.numPages) ??
      sourcePages.map((_, i) => ({ id: uid('p_'), srcIndex: i, rotation: 0 as Rotation }))

    void prev?.loadingTask.destroy()
    // Per-document caches live in editor-only modules; once loaded, a dynamic
    // import resolves before the new document's pages render.
    await Promise.all([
      import('@/lib/pdf/font-scan').then((m) => m.resetFontScan()),
      import('@/lib/pdf/text-blocks').then((m) => m.clearTextBlockCache()),
      import('@/lib/scan/compose').then((m) => m.clearScanCaches()),
      import('@/lib/scan/pixels').then((m) => m.clearPixelCache()),
      import('@/lib/redact/find').then((m) => m.clearSearchCache()),
      import('@/lib/forms').then((m) => m.clearFormCache()),
    ])
    const encrypted = !!opts.password || (await pdf.getPermissions().catch(() => null)) !== null
    useSession.getState().set({
      status: 'ready',
      encrypted,
      bookmarks: {},
      progress: 1,
      fileName,
      bytes: large ? null : bytes,
      blob: large ? opts.file! : null,
      password: opts.password ?? '',
      pdf,
      sourcePages,
      assets: restored?.assets ?? {},
      sanitize: { ...NO_SANITIZE, ...restored?.sanitize },
      form: { fields: 0, calculated: false, flatten: false },
    })
    // The rest of the page sizes, then bookmarks and form fields — none of it delays the first page.
    pageInfoReady = (async () => {
      for (let start = first + 1; start <= pdf.numPages; start += BATCH) {
        const end = Math.min(pdf.numPages, start + BATCH - 1)
        const infos = await Promise.all(Array.from({ length: end - start + 1 }, (_, k) => infoOf(start + k)))
        if (useSession.getState().pdf !== pdf) return
        // Only a new array when a size really differs from the stand-in (avoids re-laying out).
        const changed = infos.some((inf, k) => {
          const cur = sourcePages[start - 1 + k]
          return cur.width !== inf.width || cur.height !== inf.height || cur.rotate !== inf.rotate || cur.view.some((v, j) => v !== inf.view[j])
        })
        infos.forEach((inf, k) => (sourcePages[start - 1 + k] = inf))
        if (changed) useSession.getState().set({ sourcePages: sourcePages.slice() })
      }
    })().catch(() => {})
    void (async () => {
      const [bookmarks, form] = await Promise.all([bookmarksByPage(pdf).catch(() => ({})), formInfo(pdf).catch(() => ({ fields: 0, calculated: false }))])
      if (useSession.getState().pdf !== pdf) return
      useSession.getState().set({ bookmarks, form: { ...useSession.getState().form, ...form } })
    })()
    // Inserted PDFs of a resumed session; pages of any that can't be read again are dropped.
    if (restored?.docs?.length) {
      const { openInserted } = await import('@/features/editor/page-actions')
      const { loadInsertedDoc } = await import('@/lib/persist')
      const ok = new Set<string>()
      for (const d of restored.docs) {
        const rec = await loadInsertedDoc(d.id).catch(() => undefined)
        if (rec && (await openInserted(d.id, rec.name, rec.bytes).then(() => true, () => false))) ok.add(d.id)
      }
      pages = pages.filter((p) => !p.doc || ok.has(p.doc))
    }
    useDoc.getState().reset(pages, restored?.elements ?? {}, restored?.formValues ?? {})
    clearHistory()
    useUi.getState().set({ selectedId: null, editingId: null, tool: 'select', currentPageId: pages[0]?.id ?? null })

    // The autosave copy is written once the first pages have had their turn.
    if (!restored) void saveSource(fileName, opts.file ?? bytes, 1500).catch(() => {})
  } catch (err) {
    useSession.getState().set({ status: prev ? 'ready' : 'empty', progress: 0 })
    if (err instanceof OpenFailure) throw err
    throw new OpenFailure(classifyError(err))
  }
}

/** Above this, the opened file isn't kept in memory (see openDocument). */
const LARGE_FILE = 32 * 2 ** 20

/** Resolves when every page's size is known (exports wait for it). */
export let pageInfoReady: Promise<void> = Promise.resolve()

/** Bookmark titles per page they point to (pdf.js outline + destinations). */
async function bookmarksByPage(pdf: Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfJs>>['getDocument']>['promise']>) {
  const out: Record<number, string[]> = {}
  const outline = await pdf.getOutline()
  const walk = async (items: typeof outline | null) => {
    for (const it of items ?? []) {
      try {
        const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest
        const ref = Array.isArray(dest) ? dest[0] : null
        if (ref && typeof ref === 'object') {
          const i = await pdf.getPageIndex(ref as { num: number; gen: number })
          ;(out[i] ??= []).push(it.title)
        }
      } catch {
        /* unresolvable destination */
      }
      await walk(it.items)
    }
  }
  await walk(outline)
  return out
}

/** How many form fields the file has, and whether scripts calculate some of them. */
async function formInfo(pdf: PDFDocumentProxy) {
  // pdf.js 6 returns a Map (older versions a plain object).
  const raw = ((await pdf.getFieldObjects()) ?? {}) as unknown
  const fields: [string, { actions?: Record<string, unknown> }[]][] = raw instanceof Map ? [...raw] : Object.entries(raw as object)
  const calcIds = ((await (pdf as unknown as { getCalculationOrderIds?: () => Promise<string[] | null> }).getCalculationOrderIds?.()) ?? []) as string[]
  const calculated = calcIds.length > 0 || fields.some(([, ws]) => ws.some((w) => !!w.actions?.Calculate))
  return { fields: fields.length, calculated }
}

export async function openFile(file: File, password?: string) {
  if (file.size > MAX_FILE_BYTES) {
    throw new OpenFailure({
      kind: 'invalid',
      message: 'That file is larger than 512 MB, which is too big to edit in the browser.',
    })
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  return openDocument(bytes, file.name, { password, file })
}

export async function resumeSaved(password?: string) {
  const saved = await loadSaved()
  if (!saved) throw new OpenFailure({ kind: 'invalid', message: 'The saved session could not be found.' })
  return openDocument(saved.bytes, saved.fileName, {
    password,
    file: saved.blob,
    restore: {
      pages: saved.meta?.pages ?? null,
      elements: saved.meta?.elements ?? {},
      assets: saved.assets,
      sanitize: saved.meta?.sanitize,
      formValues: saved.meta?.formValues,
      docs: saved.meta?.docs,
    },
  })
}

/** Back to the landing page. The autosave is kept so it can be resumed. */
export async function closeDocument() {
  const { pages, elements, formValues } = useDoc.getState()
  const { fileName, status, sanitize, docs } = useSession.getState()
  if (status === 'ready') await saveState({ fileName, pages, elements, sanitize, formValues, docs: Object.entries(docs).map(([id, d]) => ({ id, name: d.name })) }).catch(() => {})
  useSession.getState().close()
  useDoc.getState().reset([], {})
  clearHistory()
}

export const discardSaved = () => clearSaved().catch(() => {})
