import type * as PdfJs from 'pdfjs-dist'

let loading: Promise<typeof PdfJs> | null = null

/** Lazily loads pdf.js and its worker — neither is in the initial bundle. */
export function loadPdfJs(): Promise<typeof PdfJs> {
  loading ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default
    return lib
  })
  return loading
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
