import { create } from 'zustand'
import { temporal } from 'zundo'
import type { EditorElement, PageItem, Rotation } from '@/types'

/**
 * The undoable part of the app: page order/rotation and editor elements.
 * Everything else (zoom, selection, source bytes, image bytes) lives elsewhere
 * so it never pollutes undo history.
 */
export interface DocState {
  pages: PageItem[]
  elements: Record<string, EditorElement>

  reset: (pages: PageItem[], elements?: Record<string, EditorElement>) => void
  addElement: (el: EditorElement) => void
  updateElement: (id: string, patch: Partial<EditorElement>) => void
  removeElement: (id: string) => void
  movePage: (from: number, to: number) => void
  rotatePage: (pageId: string, delta: 90 | -90) => void
  removePage: (pageId: string) => void
}

type Tracked = Pick<DocState, 'pages' | 'elements'>

/**
 * Coalesce bursts of changes (typing, colour-picker drags, nudges) into a
 * single undo step: record the state *before* the burst, ignore the rest until
 * things go quiet.
 */
function coalesce<T extends (...args: never[]) => void>(fn: T, quietMs = 350): T {
  let armed = true
  let timer: ReturnType<typeof setTimeout> | undefined
  return ((...args: Parameters<T>) => {
    if (armed) {
      fn(...args)
      armed = false
    }
    clearTimeout(timer)
    timer = setTimeout(() => (armed = true), quietMs)
  }) as T
}

export const useDoc = create<DocState>()(
  temporal(
    (set) => ({
      pages: [],
      elements: {},

      reset: (pages, elements = {}) => set({ pages, elements }),

      addElement: (el) => set((s) => ({ elements: { ...s.elements, [el.id]: el } })),

      updateElement: (id, patch) =>
        set((s) => {
          const cur = s.elements[id]
          if (!cur) return s
          return { elements: { ...s.elements, [id]: { ...cur, ...patch } as EditorElement } }
        }),

      removeElement: (id) =>
        set((s) => {
          if (!s.elements[id]) return s
          const next = { ...s.elements }
          delete next[id]
          return { elements: next }
        }),

      movePage: (from, to) =>
        set((s) => {
          if (from === to) return s
          const pages = s.pages.slice()
          const [p] = pages.splice(from, 1)
          pages.splice(to, 0, p)
          return { pages }
        }),

      rotatePage: (pageId, delta) =>
        set((s) => ({
          pages: s.pages.map((p) =>
            p.id === pageId ? { ...p, rotation: (((p.rotation + delta) % 360) + 360) % 360 as Rotation } : p,
          ),
        })),

      removePage: (pageId) =>
        set((s) => {
          if (s.pages.length <= 1) return s
          // Elements on the page are kept (filtered out at render/export) so
          // undo brings the page back with its edits intact.
          return { pages: s.pages.filter((p) => p.id !== pageId) }
        }),
    }),
    {
      limit: 200,
      partialize: (s): Tracked => ({ pages: s.pages, elements: s.elements }),
      equality: (a, b) => a.pages === b.pages && a.elements === b.elements,
      handleSet: (handleSet) => coalesce(handleSet),
    },
  ),
)

export const undo = () => useDoc.temporal.getState().undo()
export const redo = () => useDoc.temporal.getState().redo()
export const clearHistory = () => useDoc.temporal.getState().clear()
