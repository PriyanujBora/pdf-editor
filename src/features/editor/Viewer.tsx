import { useEffect, useLayoutEffect, useRef } from 'react'
import Konva from 'konva'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { clampZoom, useUi } from '@/store/ui'
import { PageView } from './PageView'

const PAGE_GAP = 16

interface Anchor {
  pageId: string
  fx: number
  fy: number
  cx: number
  cy: number
}

/** Smallest zoom at which the widest page fits the container. */
export function fitWidthZoom(container: HTMLElement) {
  const { sourcePages } = useSession.getState()
  const pages = useDoc.getState().pages
  const avail = container.clientWidth - (container.clientWidth < 640 ? 24 : 64)
  const widest = Math.max(
    1,
    ...pages.map((p) => {
      const s = sourcePages[p.srcIndex]
      return p.rotation % 180 ? s.height : s.width
    }),
  )
  return clampZoom(Math.min(1.5, avail / widest))
}

export let scrollToPage: (pageId: string) => void = () => {}
export let fitWidth: () => void = () => {}

export function Viewer() {
  const ref = useRef<HTMLDivElement>(null)
  const anchor = useRef<Anchor | null>(null)
  const pages = useDoc((s) => s.pages)
  const zoom = useUi((s) => s.zoom)

  // Fit to width when a document opens.
  useLayoutEffect(() => {
    const el = ref.current
    if (el) useUi.getState().setZoom(fitWidthZoom(el))
  }, [])

  useEffect(() => {
    scrollToPage = (pageId) => {
      ref.current?.querySelector(`[data-page-id="${pageId}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    fitWidth = () => ref.current && useUi.getState().setZoom(fitWidthZoom(ref.current))
  }, [])

  /** Remember which point of which page sits under (cx, cy). */
  const setAnchor = (cx: number, cy: number) => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    let target: HTMLElement | null = null
    for (const p of el.querySelectorAll<HTMLElement>('[data-page-id]')) {
      const r = p.getBoundingClientRect()
      if (r.bottom >= cy) {
        target = p
        break
      }
    }
    if (!target) return
    const r = target.getBoundingClientRect()
    anchor.current = {
      pageId: target.dataset.pageId!,
      fx: (cx - r.left) / r.width,
      fy: (cy - r.top) / r.height,
      cx: cx - box.left,
      cy: cy - box.top,
    }
  }

  // After a zoom change, scroll so the anchored point stays put.
  useLayoutEffect(() => {
    const el = ref.current
    const a = anchor.current
    if (!el || !a) return
    anchor.current = null
    const page = el.querySelector<HTMLElement>(`[data-page-id="${a.pageId}"]`)
    if (!page) return
    const box = el.getBoundingClientRect()
    const r = page.getBoundingClientRect()
    el.scrollLeft += r.left - box.left + a.fx * r.width - a.cx
    el.scrollTop += r.top - box.top + a.fy * r.height - a.cy
  }, [zoom])

  // Ctrl/⌘ + wheel (and trackpad pinch, which arrives as ctrl+wheel).
  useEffect(() => {
    const el = ref.current!
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const ui = useUi.getState()
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))
      setAnchor(e.clientX, e.clientY)
      ui.setZoom(ui.zoom * factor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Two-finger pinch on touch screens.
  useEffect(() => {
    const el = ref.current!
    let start: { dist: number; zoom: number } | null = null
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return
      start = { dist: dist(e.touches), zoom: useUi.getState().zoom }
      // Cancel any element drag the first finger began.
      Konva.stages.forEach((s) => s.find('*').forEach((n) => n.isDragging() && n.stopDrag()))
    }
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return
      e.preventDefault()
      const m = mid(e.touches)
      setAnchor(m.x, m.y)
      useUi.getState().setZoom(start.zoom * (dist(e.touches) / start.dist))
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) start = null
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  // Track the page in the middle of the viewport.
  useEffect(() => {
    const el = ref.current!
    let raf = 0
    const update = () => {
      raf = 0
      const box = el.getBoundingClientRect()
      const mid = box.top + box.height * 0.4
      for (const p of el.querySelectorAll<HTMLElement>('[data-page-id]')) {
        const r = p.getBoundingClientRect()
        if (r.bottom + PAGE_GAP / 2 >= mid) {
          if (useUi.getState().currentPageId !== p.dataset.pageId) useUi.getState().set({ currentPageId: p.dataset.pageId })
          return
        }
      }
    }
    const onScroll = () => (raf ||= requestAnimationFrame(update))
    el.addEventListener('scroll', onScroll, { passive: true })
    update()
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [pages])

  return (
    <div
      ref={ref}
      data-testid="viewer"
      className="relative h-full overflow-auto overscroll-contain bg-workspace [touch-action:pan-x_pan-y]"
      onPointerDown={(e) => {
        // Clicking the grey workspace (not a page) clears the selection.
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.workspace) useUi.getState().select(null)
      }}
    >
      <div
        data-workspace="1"
        className="mx-auto flex w-max min-w-full flex-col items-center px-3 py-4 sm:px-8 sm:py-8"
        style={{ gap: PAGE_GAP }}
      >
        {pages.map((p, i) => (
          <PageView key={p.id} page={p} index={i} zoom={zoom} />
        ))}
      </div>
    </div>
  )
}
