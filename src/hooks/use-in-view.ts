import { useEffect, useState, type RefObject } from 'react'

/**
 * One IntersectionObserver per (scroll container, margin), shared by every element that asks:
 * a 2,000-page document would otherwise create 4,000 observers (pages + thumbnails).
 */
const pools = new Map<string, { io: IntersectionObserver; subs: Map<Element, (v: boolean) => void> }>()
const rootIds = new WeakMap<Element, number>()
let nextRoot = 1

function pool(root: Element | null, margin: string) {
  if (root && !rootIds.has(root)) rootIds.set(root, nextRoot++)
  const key = `${root ? rootIds.get(root) : 0}|${margin}`
  let p = pools.get(key)
  if (!p) {
    const subs = new Map<Element, (v: boolean) => void>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) subs.get(e.target)?.(e.isIntersecting)
      },
      { root, rootMargin: margin },
    )
    p = { io, subs }
    pools.set(key, p)
  }
  return { p, key }
}

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
    const { p, key } = pool(el.closest(rootSelector), margin)
    p.subs.set(el, setInView)
    p.io.observe(el)
    return () => {
      p.io.unobserve(el)
      p.subs.delete(el)
      // Last one out (e.g. the document closed): drop the observer and its root.
      if (!p.subs.size) {
        p.io.disconnect()
        pools.delete(key)
      }
    }
  }, [ref, rootSelector, margin])
  return inView
}
