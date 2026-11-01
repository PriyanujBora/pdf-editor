import type { EditorElement, ImageAsset, PageItem, SourcePageInfo } from '@/types'

export interface ExportRequest {
  bytes: Uint8Array
  password: string
  pages: PageItem[]
  sourcePages: SourcePageInfo[]
  elements: EditorElement[]
  assets: Record<string, ImageAsset>
  /** Absolute URL of the app root, for fetching fonts from the worker. */
  baseUrl: string
}

export type ExportResponse =
  { type: 'progress'; value: number } | { type: 'done'; bytes: Uint8Array } | { type: 'error'; message: string }
