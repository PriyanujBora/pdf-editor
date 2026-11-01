import { createStore, del, get, set, setMany } from 'idb-keyval'
import type { EditorElement, ImageAsset, PageItem } from '@/types'

/**
 * Autosave to IndexedDB. Everything stays on this device. The password of an
 * encrypted PDF is deliberately *not* stored; resuming asks for it again.
 */
const store = createStore('free-pdf-editor', 'session')

export interface SavedMeta {
  fileName: string
  pages: PageItem[]
  elements: Record<string, EditorElement>
  savedAt: number
  version: 1
}

export async function saveSource(fileName: string, bytes: Uint8Array) {
  await setMany(
    [
      ['pdf', bytes],
      ['assets', {}],
      ['meta', null],
      ['fileName', fileName],
    ],
    store,
  )
}

export async function saveState(meta: Omit<SavedMeta, 'savedAt' | 'version'>) {
  await set('meta', { ...meta, savedAt: Date.now(), version: 1 } satisfies SavedMeta, store)
}

export async function saveAssets(assets: Record<string, ImageAsset>) {
  await set('assets', assets, store)
}

export async function loadSaved() {
  const [bytes, fileName, meta, assets] = await Promise.all([
    get<Uint8Array>('pdf', store),
    get<string>('fileName', store),
    get<SavedMeta | null>('meta', store),
    get<Record<string, ImageAsset>>('assets', store),
  ])
  if (!bytes || !fileName) return null
  return { bytes, fileName, meta: meta ?? null, assets: assets ?? {} }
}

export async function peekSavedName(): Promise<string | null> {
  try {
    return (await get<string>('fileName', store)) ?? null
  } catch {
    return null
  }
}

export async function clearSaved() {
  await Promise.all(['pdf', 'fileName', 'meta', 'assets'].map((k) => del(k, store)))
}
