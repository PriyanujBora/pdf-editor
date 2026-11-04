import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import type { ExportRequest, ExportResponse } from './protocol'

/** Builds the edited PDF in a dedicated worker. Nothing leaves the device. */
export async function exportPdf(onProgress?: (v: number) => void): Promise<Uint8Array> {
  const s = useSession.getState()
  const d = useDoc.getState()
  if (!s.bytes) throw new Error('No document open')

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
