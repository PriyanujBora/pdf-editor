import { useEffect, useRef } from 'react'
import type { RenderTask } from 'pdfjs-dist'
import { useSession } from '@/store/session'
import { loadPdfJs } from '@/lib/pdf/pdfjs'
import { renderedCanvases } from './actions'

/** iOS Safari refuses canvases above ~16.7 MP. */
const MAX_PIXELS = 16_000_000

interface Props {
  pageId: string
  srcIndex: number
  /** Total rotation to render: original /Rotate + user rotation. */
  rotation: number
  zoom: number
  /** Displayed (user-rotated) page size in points. */
  width: number
  height: number
  /** The file has form fields: they are drawn by the form layer, not on the canvas. */
  forms?: boolean
}

/**
 * Renders a page with pdf.js into an off-DOM canvas and swaps it in when
 * done, so re-renders on zoom never flash blank. Until then the previous
 * canvas is simply stretched by CSS.
 */
export function PageCanvas({ pageId, srcIndex, rotation, zoom, width, height, forms }: Props) {
  const holder = useRef<HTMLDivElement>(null)
  const pdf = useSession((s) => s.pdf)

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    let task: RenderTask | null = null
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    let scale = zoom * dpr
    if (width * height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (width * height))
    const first = !holder.current?.firstChild

    const timer = setTimeout(
      async () => {
        try {
          const page = await pdf.getPage(srcIndex + 1)
          if (cancelled) return
          const viewport = page.getViewport({ scale, rotation: rotation % 360 })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          canvas.className = 'absolute inset-0 size-full'
          canvas.setAttribute('aria-hidden', 'true')
          const { AnnotationMode } = await loadPdfJs()
          task = page.render({ canvas, viewport, annotationMode: forms ? AnnotationMode.ENABLE_FORMS : AnnotationMode.ENABLE })
          await task.promise
          if (cancelled || !holder.current) return
          holder.current.replaceChildren(canvas)
          // Canvas pixels per point of the displayed (rotated) page.
          renderedCanvases.set(pageId, { canvas, scale: canvas.width / width })
        } catch (err) {
          if ((err as Error)?.name !== 'RenderingCancelledException') console.warn('Render failed', err)
        }
      },
      first ? 0 : 160,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
      task?.cancel()
    }
  }, [pdf, pageId, srcIndex, rotation, zoom, width, height, forms])

  useEffect(() => () => void renderedCanvases.delete(pageId), [pageId])

  return <div ref={holder} className="pointer-events-none absolute inset-0" />
}
