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
  /** `merge: false` forces a separate undo step (drag/transform ends). */
  updateElement: (id: string, patch: Partial<EditorElement>, opts?: { merge?: boolean }) => void
  removeElement: (id: string) => void
  movePage: (from: number, to: number) => void
  rotatePage: (pageId: string, delta: 90 | -90) => void
  removePage: (pageId: string) => void
}

type Tracked = Pick<DocState, 'pages' | 'elements'>

/**
 * Undo granularity. Discrete actions (add, delete, drag, page ops) each get
 * their own undo step. Repeated updates of the *same fields of the same
 * element* in quick succession (typing, colour-picker drags, arrow nudges)
 * merge into one step.
 */
let mergeKey: string | null = null
const MERGE_WINDOW_MS = 1000

function mergeBursts<T extends (...args: never[]) => void>(record: T): T {
  let lastKey: string | null = null
  let lastAt = 0
  return ((...args: Parameters<T>) => {
    const key = mergeKey
    mergeKey = null
    const now = Date.now()
    const merge = key !== null && key === lastKey && now - lastAt < MERGE_WINDOW_MS
    lastKey = key
    lastAt = now
    if (!merge) record(...args)
  }) as T
}

export const useDoc = create<DocState>()(
  temporal(
    (set) => ({
      pages: [],
      elements: {},

      reset: (pages, elements = {}) => set({ pages, elements }),

      addElement: (el) => set((s) => ({ elements: { ...s.elements, [el.id]: el } })),

      updateElement: (id, patch, opts) => {
        mergeKey = opts?.merge === false ? null : id + ':' + Object.keys(patch).sort().join(',')
        set((s) => {
          const cur = s.elements[id]
          if (!cur) return s
          return { elements: { ...s.elements, [id]: { ...cur, ...patch } as EditorElement } }
        })
      },

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
      handleSet: (handleSet) => mergeBursts(handleSet),
    },
  ),
)

export const undo = () => useDoc.temporal.getState().undo()
export const redo = () => useDoc.temporal.getState().redo()
export const clearHistory = () => useDoc.temporal.getState().clear()
