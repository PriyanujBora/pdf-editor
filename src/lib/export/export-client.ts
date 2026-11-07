import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import type { ExportRequest, ExportResponse } from './protocol'

/** True when the download would be the original file: no edits, same pages in the same order. */
export function isUnchanged() {
  const s = useSession.getState()
  const d = useDoc.getState()
  const pageIds = new Set(d.pages.map((p) => p.id))
  const hasEdits = Object.values(d.elements).some((el) => pageIds.has(el.pageId))
  const samePages = d.pages.length === s.sourcePages.length && d.pages.every((p, i) => p.srcIndex === i && p.rotation === 0)
  return !hasEdits && samePages
}

/**
 * Builds the edited PDF in a dedicated worker. Nothing leaves the device.
 * With no changes at all the original bytes are returned untouched (perfect fidelity, protection
 * included) — unless the user chose to remove the password protection.
 */
export async function exportPdf(onProgress?: (v: number) => void, opts: { keepEncryption?: boolean; forceRebuild?: boolean } = {}): Promise<Uint8Array> {
  const s = useSession.getState()
  const d = useDoc.getState()
  if (!s.bytes) throw new Error('No document open')
  const keepEncryption = s.encrypted && opts.keepEncryption !== false
  if (isUnchanged() && (keepEncryption || !s.encrypted) && !opts.forceRebuild && !(import.meta.env.DEV && (window as { __forceRebuild?: boolean }).__forceRebuild)) {
    onProgress?.(1)
    return s.bytes.slice()
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

  const req: ExportRequest = {
    scanPatches,
    bytes: s.bytes,
    password: s.password,
    keepEncryption,
    pages: d.pages,
    sourcePages: s.sourcePages,
    elements,
    assets,
    baseUrl: new URL(import.meta.env.BASE_URL, location.href).href,
  }

  const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<Uint8Array>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ExportResponse>) => {
      const m = e.data
      if (m.type === 'progress') onProgress?.(m.value)
      else {
        worker.terminate()
        if (m.type === 'done') resolve(m.bytes)
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
