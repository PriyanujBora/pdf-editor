import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ImageAsset, SourcePageInfo } from '@/types'

/** Non-undoable data about the open file. */
interface SessionState {
  status: 'empty' | 'loading' | 'ready'
  /** 0..1 while loading page metadata. */
  progress: number
  fileName: string
  /** Original bytes, kept for export and autosave. pdf.js gets a copy. */
  bytes: Uint8Array | null
  /** Password used to open the file ('' when none). */
  password: string
  /** The file is password-protected (an open password, or only an owner password). */
  encrypted: boolean
  /** Bookmark titles that point at each source page (index → titles). */
  bookmarks: Record<number, string[]>
  /** Edits whose old text the last download could not remove (element id → reason). */
  notRemoved: Record<string, string>
  pdf: PDFDocumentProxy | null
  sourcePages: SourcePageInfo[]
  assets: Record<string, ImageAsset>

  set: (patch: Partial<SessionState>) => void
  addAsset: (a: ImageAsset) => void
  close: () => void
}

export const useSession = create<SessionState>()((set, get) => ({
  status: 'empty',
  progress: 0,
  fileName: '',
  bytes: null,
  password: '',
  encrypted: false,
  bookmarks: {},
  notRemoved: {},
  pdf: null,
  sourcePages: [],
  assets: {},

  set: (patch) => set(patch),
  addAsset: (a) => set((s) => ({ assets: { ...s.assets, [a.id]: a } })),
  close: () => {
    void get().pdf?.loadingTask.destroy()
    set({ status: 'empty', progress: 0, fileName: '', bytes: null, password: '', encrypted: false, bookmarks: {}, notRemoved: {}, pdf: null, sourcePages: [], assets: {} })
  },
}))
