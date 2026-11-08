import { create } from 'zustand'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/** A PDF inserted into the open one (Phase 6 "Insert PDF"). */
export interface InsertedDoc {
  name: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
  sourcePages: SourcePageInfo[]
}
import type { ImageAsset, SanitizeOptions, SourcePageInfo } from '@/types'

export const NO_SANITIZE: SanitizeOptions = {
  metadata: false,
  javascript: false,
  attachments: false,
  hiddenLayers: false,
  comments: false,
  formValues: false,
}

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
  /** Clean-up applied on download (Redact panel). */
  sanitize: SanitizeOptions
  /** Form fields in the file, whether some are calculated by scripts, and the flatten choice. */
  form: { fields: number; calculated: boolean; flatten: boolean }
  pdf: PDFDocumentProxy | null
  sourcePages: SourcePageInfo[]
  /** Inserted PDFs by id (pages refer to them with PageItem.doc). */
  docs: Record<string, InsertedDoc>
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
  sanitize: NO_SANITIZE,
  form: { fields: 0, calculated: false, flatten: false },
  pdf: null,
  sourcePages: [],
  docs: {},
  assets: {},

  set: (patch) => set(patch),
  addAsset: (a) => set((s) => ({ assets: { ...s.assets, [a.id]: a } })),
  close: () => {
    void get().pdf?.loadingTask.destroy()
    for (const d of Object.values(get().docs)) void d.pdf.loadingTask.destroy()
    set({ status: 'empty', progress: 0, fileName: '', bytes: null, password: '', encrypted: false, bookmarks: {}, notRemoved: {}, sanitize: NO_SANITIZE, form: { fields: 0, calculated: false, flatten: false }, pdf: null, sourcePages: [], docs: {}, assets: {} })
  },
}))
