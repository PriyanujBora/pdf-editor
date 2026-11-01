import { useEffect, useState, type RefObject } from 'react'

/**
 * True while the element is within `margin` of its scroll container.
 * The root must be the scroll container itself: rootMargin is ignored for
 * clipping ancestors when the root is the viewport.
 */
export function useInView(ref: RefObject<HTMLElement | null>, rootSelector: string, margin = '100% 0px') {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = el.closest(rootSelector)
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { root, rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, rootSelector, margin])
  return inView
}
