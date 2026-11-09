import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { pdfPageOf, sourceOf } from '@/lib/page-source'
import type { PageItem } from '@/types'
import type { ImagePatch } from '@/lib/redact/images'
import type { ExportRequest, ExportResponse, RedactionReport, RemovalNote } from './protocol'

export interface ExportResult {
  bytes: Uint8Array
  notes: RemovalNote[]
  /** Present when the download redacts or cleans up; non-empty problems/leaks = no file (bytes empty). */
  redaction?: RedactionReport
  /** Form fields that couldn't be written (name: reason). */
  formNotes?: string[]
  /** What Compress did. */
  compress?: { images: number; before: number; after: number }
}

/** True when the download would be the original file: no edits, same pages in the same order. */
export function isUnchanged() {
  const s = useSession.getState()
  const d = useDoc.getState()
  const pageIds = new Set(d.pages.map((p) => p.id))
  const hasEdits = Object.values(d.elements).some((el) => pageIds.has(el.pageId))
  const samePages = d.pages.length === s.sourcePages.length && d.pages.every((p, i) => p.srcIndex === i && p.rotation === 0 && !p.doc && !p.blank)
  const cleanUp = Object.values(s.sanitize).some(Boolean)
  const form = Object.keys(d.formValues).length > 0 || s.form.flatten
  return !hasEdits && samePages && !cleanUp && !form
}

/**
 * Builds the edited PDF in a dedicated worker. Nothing leaves the device.
 * With no changes at all the original bytes are returned untouched (perfect fidelity, protection
 * included) — unless the user chose to remove the password protection.
 */
export async function exportPdf(
  onProgress?: (v: number) => void,
  opts: { keepEncryption?: boolean; forceRebuild?: boolean; pages?: PageItem[]; compress?: { dpi: number; quality: number } | null } = {},
): Promise<ExportResult> {
  // Large files: page sizes may still be loading in the background.
  await (await import('@/lib/open-document')).pageInfoReady
  const s = useSession.getState()
  const d0 = useDoc.getState()
  // Extract / split: the same export with a subset of the pages.
  const d = opts.pages ? { ...d0, pages: opts.pages } : d0
  const source = await s.sourceBytes()
  const keepEncryption = s.encrypted && opts.keepEncryption !== false
  if (!opts.pages && !opts.compress && isUnchanged() && (keepEncryption || !s.encrypted) && !opts.forceRebuild && !(import.meta.env.DEV && (window as { __forceRebuild?: boolean }).__forceRebuild)) {
    onProgress?.(1)
    return { bytes: s.bytes ? source.slice() : source, notes: [] }
  }

  const pageIds = new Set(d.pages.map((p) => p.id))
  const elements = Object.values(d.elements).filter((el) => pageIds.has(el.pageId))
  const used = new Set(elements.flatMap((el) => (el.kind === 'image' ? [el.assetId] : [])))
  const assets = Object.fromEntries(Object.entries(s.assets).filter(([id]) => used.has(id)))

  // Scan-matched patches are rendered here (they need the page render + canvas).
  const scanPatches: Record<string, Uint8Array> = {}
  const scanEls = elements.filter((el) => el.kind === 'text' && el.scan)
  if (scanEls.length) {
    const { patchPng, isScanText } = await import('@/lib/scan/compose')
    for (const el of scanEls) if (el.kind === 'text' && isScanText(el)) scanPatches[el.id] = await patchPng(el)
  }

  // Images under redaction marks are decoded and blacked out here (pdf.js reads every image format).
  const imagePatches: Record<string, ImagePatch[]> = {}
  const marked = new Set(elements.flatMap((el) => (el.kind === 'redact' ? [el.pageId] : [])))
  if (marked.size && s.pdf) {
    const { redactedImages } = await import('@/lib/redact/images')
    for (const page of d.pages) {
      if (!marked.has(page.id)) continue
      const rects = elements.flatMap((el) => (el.kind === 'redact' && el.pageId === page.id ? [el] : []))
      const pg = await pdfPageOf(page)
      if (pg) imagePatches[page.id] = await redactedImages(pg, sourceOf(page).info, rects)
    }
  }

  const req: ExportRequest = {
    scanPatches,
    imagePatches,
    sanitize: s.sanitize,
    formValues: d.formValues,
    flattenForm: s.form.flatten && s.form.fields > 0,
    compress: opts.compress ?? null,
    bytes: source,
    password: s.password,
    keepEncryption,
    pages: d.pages,
    infos: d.pages.map((p) => sourceOf(p).info),
    docs: Object.fromEntries(
      [...new Set(d.pages.flatMap((p) => (p.doc ? [p.doc] : [])))].map((id) => [id, { bytes: s.docs[id].bytes, name: s.docs[id].name }]),
    ),
    elements,
    assets,
    baseUrl: new URL(import.meta.env.BASE_URL, location.href).href,
  }

  const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<ExportResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ExportResponse>) => {
      const m = e.data
      if (m.type === 'progress') onProgress?.(m.value)
      else {
        worker.terminate()
        if (m.type === 'done') resolve({ bytes: m.bytes, notes: m.notes, redaction: m.redaction, formNotes: m.formNotes, compress: m.compress })
        else reject(new Error(m.message))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'Export failed'))
    }
    worker.postMessage(req)
  })
}

export function downloadBytes(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function editedFileName(name: string) {
  const base = name.replace(/\.pdf$/i, '')
  return `${base}-edited.pdf`
}
