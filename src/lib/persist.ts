import { createStore, del, get, keys, set, setMany } from 'idb-keyval'
import type { EditorElement, FieldValue, ImageAsset, PageItem, SanitizeOptions } from '@/types'

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
  /** Clean-up options of the Redact panel (version 3). */
  sanitize?: SanitizeOptions
  /** Filled-in form fields (version 4). */
  formValues?: Record<string, FieldValue>
  /** Inserted PDFs (bytes stored under "doc:<id>"). */
  docs?: { id: string; name: string }[]
  /**
   * 2 = text elements may carry `source` (edited printed lines). Version-1 saves load unchanged:
   * their edited lines are cover-based elements, which still render and export as before.
   * 3 = redaction marks (`kind: 'redact'`) and sanitize options.
   */
  version: 1 | 2 | 3 | 4
}

/**
 * The source copy of a newly opened file is written a little later (the first pages render first), and
 * it resets the session's state. Every other write waits for it, so an early autosave isn't wiped and
 * the saved edits never get paired with the previous file.
 */
let sourceWrite: Promise<unknown> = Promise.resolve()

/** Writes the opened file as the autosave source after `delayMs`; later writes queue behind it. */
export function saveSource(fileName: string, bytes: Uint8Array | Blob, delayMs = 0) {
  const run = sourceWrite.then(
    () =>
      new Promise<void>((resolve, reject) =>
        setTimeout(async () => {
          try {
            // A new file: the previous session's inserted PDFs go.
            const old = (await keys(store)).filter((k) => String(k).startsWith('doc:'))
            await Promise.all(old.map((k) => del(k, store)))
            await setMany(
              [
                ['pdf', bytes],
                ['assets', {}],
                ['meta', null],
                ['fileName', fileName],
              ],
              store,
            )
            resolve()
          } catch (e) {
            reject(e)
          }
        }, delayMs),
      ),
  )
  sourceWrite = run.catch(() => {})
  return run
}

export async function saveState(meta: Omit<SavedMeta, 'savedAt' | 'version'>) {
  await sourceWrite
  await set('meta', { ...meta, savedAt: Date.now(), version: 4 } satisfies SavedMeta, store)
}

export async function saveAssets(assets: Record<string, ImageAsset>) {
  await sourceWrite
  await set('assets', assets, store)
}

/** An inserted PDF's bytes (kept until the session is discarded). */
export async function saveInsertedDoc(id: string, name: string, bytes: Uint8Array) {
  await sourceWrite
  await set('doc:' + id, { name, bytes }, store)
}

export async function loadInsertedDoc(id: string) {
  return get<{ name: string; bytes: Uint8Array }>('doc:' + id, store)
}

export async function loadSaved() {
  const [bytes, fileName, meta, assets] = await Promise.all([
    get<Uint8Array | Blob>('pdf', store),
    get<string>('fileName', store),
    get<SavedMeta | null>('meta', store),
    get<Record<string, ImageAsset>>('assets', store),
  ])
  if (!bytes || !fileName) return null
  // Saved as the picked file (a Blob) since Phase 8; older saves hold the bytes.
  const data = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes
  return { bytes: data, blob: bytes instanceof Blob ? bytes : undefined, fileName, meta: meta ?? null, assets: assets ?? {} }
}

export async function peekSavedName(): Promise<string | null> {
  try {
    return (await get<string>('fileName', store)) ?? null
  } catch {
    return null
  }
}

export async function clearSaved() {
  await sourceWrite
  const docs = (await keys(store)).filter((k) => String(k).startsWith('doc:'))
  await Promise.all([...['pdf', 'fileName', 'meta', 'assets'], ...docs].map((k) => del(k, store)))
}
