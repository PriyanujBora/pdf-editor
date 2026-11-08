import { useEffect } from 'react'
import { saveAssets, saveState } from '@/lib/persist'
import { deleteSelected } from '@/features/editor/actions'
import { redo, undo, useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'

/** Debounced autosave of the document model and image assets to IndexedDB. */
export function useAutosave() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      const { pages, elements, formValues } = useDoc.getState()
      const { fileName, status, sanitize } = useSession.getState()
      if (status !== 'ready') return
      void saveState({ fileName, pages, elements, sanitize, formValues }).catch(() => {})
    }
    const unsubDoc = useDoc.subscribe((s, prev) => {
      if (s.pages === prev.pages && s.elements === prev.elements && s.formValues === prev.formValues) return
      clearTimeout(timer)
      timer = setTimeout(flush, 600)
    })
    const unsubAssets = useSession.subscribe((s, prev) => {
      if (s.assets !== prev.assets) void saveAssets(s.assets).catch(() => {})
      if (s.sanitize !== prev.sanitize) {
        clearTimeout(timer)
        timer = setTimeout(flush, 600)
      }
    })
    const onHide = () => document.visibilityState === 'hidden' && flush()
    document.addEventListener('visibilitychange', onHide)
    return () => {
      clearTimeout(timer)
      flush()
      unsubDoc()
      unsubAssets()
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [])
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/** Desktop keyboard shortcuts. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const ui = useUi.getState()
      const key = e.key.toLowerCase()

      if (e.key === 'Escape') {
        if (ui.editingId) ui.set({ editingId: null })
        else if (ui.selectedId) ui.select(null)
        else if (ui.tool !== 'select') ui.setTool('select')
        return
      }
      if (mod && (key === '=' || key === '+' || key === '-' || key === '0')) {
        e.preventDefault()
        ui.setZoom(key === '0' ? 1 : ui.zoom * (key === '-' ? 1 / 1.2 : 1.2))
        return
      }
      if (isTyping(e.target)) return

      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        ui.set({ editingId: null })
      } else if (mod && key === 'y') {
        e.preventDefault()
        redo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selectedId) {
        e.preventDefault()
        deleteSelected()
      } else if (!mod && !e.altKey) {
        if (key === 'v') ui.setTool('select')
        else if (key === 't') ui.setTool('text')
        else if (key === 'e') ui.setTool('edit-text')
        else if (key === 'r') ui.setTool('redact')
        else if (key === 's') ui.set({ signOpen: true })
        else if (key === 'a') ui.setTool('annotate')
        else if (ui.selectedId && e.key.startsWith('Arrow')) {
          e.preventDefault()
          const el = useDoc.getState().elements[ui.selectedId]
          if (!el) return
          const step = e.shiftKey ? 10 : 1
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
          useDoc.getState().updateElement(el.id, { x: el.x + dx, y: el.y + dy })
        } else if (key === 'enter' && ui.selectedId && useDoc.getState().elements[ui.selectedId]?.kind === 'text') {
          e.preventDefault()
          ui.startEditing(ui.selectedId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
