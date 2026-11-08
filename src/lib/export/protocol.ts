import type { EditorElement, ImageAsset, PageItem, SourcePageInfo } from '@/types'

export interface ExportRequest {
  bytes: Uint8Array
  password: string
  /** Encrypted source: re-encrypt the output with the original passwords and permissions. */
  keepEncryption: boolean
  pages: PageItem[]
  sourcePages: SourcePageInfo[]
  elements: EditorElement[]
  assets: Record<string, ImageAsset>
  /** PNG patch per scan-matched text element id. */
  scanPatches: Record<string, Uint8Array>
  /** Absolute URL of the app root, for fetching fonts from the worker. */
  baseUrl: string
}

/** An edit whose old text could not be removed from the file (it stays, covered by a patch). */
export interface RemovalNote {
  elementId: string
  reason: string
}

export type ExportResponse =
  { type: 'progress'; value: number } | { type: 'done'; bytes: Uint8Array; notes: RemovalNote[] } | { type: 'error'; message: string }
