import type { ImagePatch } from '@/lib/redact/images'
import type { EditorElement, FieldValue, ImageAsset, PageItem, SanitizeOptions, SourcePageInfo } from '@/types'

export interface ExportRequest {
  bytes: Uint8Array
  password: string
  /** Encrypted source: re-encrypt the output with the original passwords and permissions. */
  keepEncryption: boolean
  pages: PageItem[]
  /** Geometry of each output page's source (same order as `pages`). */
  infos: SourcePageInfo[]
  /** Inserted PDFs the pages use (PageItem.doc). */
  docs: Record<string, { bytes: Uint8Array; name: string }>
  elements: EditorElement[]
  assets: Record<string, ImageAsset>
  /** PNG patch per scan-matched text element id. */
  scanPatches: Record<string, Uint8Array>
  /** Redacted copies of the images under redaction marks, per page id. */
  imagePatches: Record<string, ImagePatch[]>
  sanitize: SanitizeOptions
  /** Filled-in form fields, and whether to flatten the form into the pages. */
  formValues: Record<string, FieldValue>
  flattenForm: boolean
  /** Absolute URL of the app root, for fetching fonts from the worker. */
  baseUrl: string
}

/** An edit whose old text could not be removed from the file (it stays, covered by a patch). */
export interface RemovalNote {
  elementId: string
  reason: string
}

export interface RedactionReport {
  /** Something under a mark couldn't be removed (output page number + what). Blocks the download. */
  problems: string[]
  /** Marked text still found elsewhere in the file. Blocks the download. */
  leaks: { text: string; where: string }[]
  removed: { glyphs: number; images: number; paths: number; annotations: number }
  /** What the clean-up removed, and what it couldn't. */
  sanitized: string[]
  sanitizeNotes: string[]
}

export type ExportResponse =
  | { type: 'progress'; value: number }
  | { type: 'done'; bytes: Uint8Array; notes: RemovalNote[]; redaction?: RedactionReport; formNotes?: string[] }
  | { type: 'error'; message: string }
