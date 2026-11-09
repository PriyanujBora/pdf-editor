import type * as PdfJs from 'pdfjs-dist'

let loading: Promise<typeof PdfJs> | null = null

/**
 * Lazily loads pdf.js and starts its worker — neither is in the initial bundle. The worker is one
 * long-lived port shared by every document (pdf.js never tears down a port it was given), so it is
 * started once — ideally while the landing page is idle — and every open after that is warm.
 */
export function loadPdfJs(): Promise<typeof PdfJs> {
  loading ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    try {
      lib.GlobalWorkerOptions.workerPort = new Worker(worker.default, { type: 'module' })
    } catch {
      /* falls back to pdf.js creating its own worker per document */
    }
    return lib
  })
  return loading
}

/**
 * pdf.js keeps decoded page data in its worker until the document is cleaned up (a 150 MB scan holds
 * ~600 MB after a scroll through it). Every page call of the document is counted; once nothing has
 * been in flight for a while, `cleanup(true)` releases it (loaded fonts stay: the editor draws with
 * them). pdf.js forbids cleaning up while a page renders, hence the counting.
 */
export function cleanupWhenIdle(pdf: PdfJs.PDFDocumentProxy, idleMs = 2500) {
  let active = 0
  let renders = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    clearTimeout(timer)
    if (active) return
    // While scrolling through big pages nothing is ever idle for long: after a few renders, clean up
    // at the next quiet moment instead.
    timer = setTimeout(
      () => {
        if (active) return
        renders = 0
        void pdf.cleanup(true).catch(() => {})
      },
      renders >= 3 ? 0 : idleMs,
    )
  }
  const track = <T>(p: Promise<T>): Promise<T> => {
    active++
    clearTimeout(timer)
    return p.finally(() => {
      active--
      settle()
    })
  }
  const getPage = pdf.getPage.bind(pdf)
  const wrapped = new WeakSet<object>()
  pdf.getPage = (n: number) =>
    track(getPage(n)).then((page) => {
      if (wrapped.has(page)) return page
      wrapped.add(page)
      const render = page.render.bind(page)
      page.render = (params) => {
        const task = render(params)
        renders++
        void track(task.promise).catch(() => {})
        return task
      }
      for (const m of ['getOperatorList', 'getTextContent', 'getAnnotations'] as const) {
        const orig = (page[m] as (...a: unknown[]) => Promise<unknown>).bind(page)
        ;(page as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => track(orig(...a))
      }
      return page
    })
}

const base = import.meta.env.BASE_URL

export const PDFJS_ASSET_OPTIONS = {
  cMapUrl: `${base}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  wasmUrl: `${base}pdfjs/wasm/`,
  iccUrl: `${base}pdfjs/iccs/`,
} as const

export type OpenError = { kind: 'password'; retry: boolean } | { kind: 'invalid'; message: string }

/** Maps pdf.js exceptions to something we can show a human. */
export function classifyError(err: unknown): OpenError {
  const e = err as { name?: string; code?: number; message?: string }
  if (e?.name === 'PasswordException') {
    // code 2 = INCORRECT_PASSWORD, 1 = NEED_PASSWORD
    return { kind: 'password', retry: e.code === 2 }
  }
  if (e?.name === 'InvalidPDFException') {
    return { kind: 'invalid', message: 'This file doesn’t look like a valid PDF. It may be damaged or incomplete.' }
  }
  if (e?.name === 'MissingPDFException' || e?.name === 'ResponseException') {
    return { kind: 'invalid', message: 'The file could not be read.' }
  }
  return {
    kind: 'invalid',
    message: 'This PDF couldn’t be opened. It may be corrupt or use features we don’t support yet.',
  }
}
