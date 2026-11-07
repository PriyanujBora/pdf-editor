import { create } from 'zustand'

export type Tool = 'select' | 'text' | 'edit-text'

interface UiState {
  tool: Tool
  zoom: number
  selectedId: string | null
  /** Element whose text is being typed into the inline editor. */
  editingId: string | null
  /** Where the caret goes when editing starts (character index), e.g. the clicked position. */
  caret: number | null
  /** Live selection [start, end] of the inline editor; the canvas draws caret and highlight. */
  textSel: [number, number] | null
  /** Page id most visible in the viewport (drives the thumbnail highlight). */
  currentPageId: string | null
  thumbsOpen: boolean
  propsOpen: boolean
  theme: 'light' | 'dark'

  setTool: (t: Tool) => void
  setZoom: (z: number) => void
  select: (id: string | null) => void
  startEditing: (id: string | null) => void
  set: (patch: Partial<UiState>) => void
}

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 5
export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* storage unavailable */
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const useUi = create<UiState>()((set) => ({
  tool: 'select',
  zoom: 1,
  selectedId: null,
  editingId: null,
  caret: null,
  textSel: null,
  currentPageId: null,
  thumbsOpen: false,
  propsOpen: false,
  theme: initialTheme(),

  setTool: (tool) => set({ tool, editingId: null }),
  setZoom: (z) => set({ zoom: clampZoom(z) }),
  select: (selectedId) => set((s) => ({ selectedId, editingId: s.editingId === selectedId ? s.editingId : null })),
  startEditing: (editingId) => set(editingId ? { editingId, selectedId: editingId } : { editingId }),
  set: (patch) => set(patch),
}))
