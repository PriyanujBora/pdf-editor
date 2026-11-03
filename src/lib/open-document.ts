import { classifyError, loadPdfJs, PDFJS_ASSET_OPTIONS, type OpenError } from '@/lib/pdf/pdfjs'
import { clearSaved, loadSaved, saveSource, saveState } from '@/lib/persist'
import { uid } from '@/lib/ids'
import { clearHistory, useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { EditorElement, ImageAsset, PageItem, Rotation, SourcePageInfo } from '@/types'

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
  /** When resuming an autosaved session. */
  restore?: { pages: PageItem[] | null; elements: Record<string, EditorElement>; assets: Record<string, ImageAsset> }
}

/**
 * Parses a PDF with pdf.js, reads every page's geometry (with progress), and
 * swaps it into the stores. Throws OpenFailure with a classified reason.
 */
export async function openDocument(bytes: Uint8Array, fileName: string, opts: OpenOptions = {}) {
  const session = useSession.getState()
  const prev = session.pdf
  session.set({ status: 'loading', progress: 0 })

  try {
    const pdfjs = await loadPdfJs()
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      password: opts.password,
      ...PDFJS_ASSET_OPTIONS,
      fontExtraProperties: true,
      enableXfa: false,
    })
    const pdf = await task.promise

    const sourcePages: SourcePageInfo[] = new Array(pdf.numPages)
    let done = 0
    const BATCH = 16
    for (let start = 1; start <= pdf.numPages; start += BATCH) {
      const end = Math.min(pdf.numPages, start + BATCH - 1)
      const jobs: Promise<void>[] = []
      for (let n = start; n <= end; n++) {
        jobs.push(
          pdf.getPage(n).then((page) => {
            const vp = page.getViewport({ scale: 1 })
            sourcePages[n - 1] = {
              view: page.view as [number, number, number, number],
              rotate: (((page.rotate % 360) + 360) % 360) as Rotation,
              width: vp.width,
              height: vp.height,
            }
            done++
          }),
        )
      }
      await Promise.all(jobs)
      useSession.getState().set({ progress: done / pdf.numPages })
    }

    const restored = opts.restore
    const pages: PageItem[] =
      restored?.pages?.filter((p) => p.srcIndex < pdf.numPages) ??
      sourcePages.map((_, i) => ({ id: uid('p_'), srcIndex: i, rotation: 0 as Rotation }))

    void prev?.loadingTask.destroy()
    // Per-document caches live in editor-only modules; once loaded, a dynamic
    // import resolves before the new document's pages render.
    await Promise.all([
      import('@/lib/pdf/font-scan').then((m) => m.resetFontScan()),
      import('@/lib/pdf/text-blocks').then((m) => m.clearTextBlockCache()),
    ])
    useSession.getState().set({
      status: 'ready',
      progress: 1,
      fileName,
      bytes,
      password: opts.password ?? '',
      pdf,
      sourcePages,
      assets: restored?.assets ?? {},
    })
    useDoc.getState().reset(pages, restored?.elements ?? {})
    clearHistory()
    useUi.getState().set({ selectedId: null, editingId: null, tool: 'select', currentPageId: pages[0]?.id ?? null })

    if (!restored) await saveSource(fileName, bytes).catch(() => {})
  } catch (err) {
    useSession.getState().set({ status: prev ? 'ready' : 'empty', progress: 0 })
    if (err instanceof OpenFailure) throw err
    throw new OpenFailure(classifyError(err))
  }
}

export async function openFile(file: File, password?: string) {
  if (file.size > MAX_FILE_BYTES) {
    throw new OpenFailure({
      kind: 'invalid',
      message: 'That file is larger than 512 MB, which is too big to edit in the browser.',
    })
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  return openDocument(bytes, file.name, { password })
}

export async function resumeSaved(password?: string) {
  const saved = await loadSaved()
  if (!saved) throw new OpenFailure({ kind: 'invalid', message: 'The saved session could not be found.' })
  return openDocument(saved.bytes, saved.fileName, {
    password,
    restore: { pages: saved.meta?.pages ?? null, elements: saved.meta?.elements ?? {}, assets: saved.assets },
  })
}

/** Back to the landing page. The autosave is kept so it can be resumed. */
export async function closeDocument() {
  const { pages, elements } = useDoc.getState()
  const { fileName, status } = useSession.getState()
  if (status === 'ready') await saveState({ fileName, pages, elements }).catch(() => {})
  useSession.getState().close()
  useDoc.getState().reset([], {})
  clearHistory()
}

export const discardSaved = () => clearSaved().catch(() => {})
