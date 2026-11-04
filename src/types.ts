import type { OriginalFont } from '@/lib/original-font'

/**
 * Editable document model.
 *
 * Coordinate space ("page space"): PDF points (1/72 in), origin at the
 * top-left of the page *as displayed with its original /Rotate applied*,
 * x to the right, y downwards. This is exactly pdf.js' viewport space at
 * scale 1. User page rotations (thumbnail sidebar) rotate the whole page,
 * elements included, so elements never need re-mapping when a page turns.
 */

export type Rotation = 0 | 90 | 180 | 270

/** Static facts about a page of the *source* PDF (never changes). */
export interface SourcePageInfo {
  /** pdf.js `page.view`: [x0, y0, x1, y1] in PDF user space. */
  view: [number, number, number, number]
  /** Original /Rotate of the page. */
  rotate: Rotation
  /** Display size at scale 1 (already swapped for 90/270). */
  width: number
  height: number
}

/** A page in the edited document, in output order. */
export interface PageItem {
  id: string
  /** 0-based index into the source PDF. */
  srcIndex: number
  /** Extra clockwise rotation chosen by the user. */
  rotation: Rotation
}

export type FontFamilyId = 'inter' | 'roboto' | 'tinos' | 'noto-serif' | 'noto-bengali' | 'noto-devanagari'
export type TextAlign = 'left' | 'center' | 'right'

interface BaseElement {
  id: string
  pageId: string
  /** Top-left of the element's box, page space. */
  x: number
  y: number
  /** Clockwise degrees around (x, y). */
  rotation: number
}

export interface PtRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How an edit on a scanned page was matched to the scan (see lib/scan/).
 * The patch image is never stored: it is rebuilt deterministically from the
 * page render + these numbers + the element's current text and style, so
 * undo/redo and autosave stay small and consistent.
 */
export interface ScanMatch {
  /** Patch area, page space (pt). */
  region: PtRect
  /** The original OCR line (hides its detection outline). */
  lineBox: PtRect
  /** Scan resolution, px per pt. */
  scale: number
  /** Text as printed (OCR), and how it was fitted — used to erase it. */
  oldText: string
  fitFont: FontFamilyId
  fitBold: boolean
  fitSizePx: number
  /** Line start and baseline in region pixels. */
  originX: number
  baseline: number
  /** Per-word horizontal offsets (px) measured on the old text. */
  dxs: number[]
  /** Per-word baseline offsets (px): sub-pixel alignment, slight skew. */
  dys?: number[]
  /** Per-word weight detected on the old text (lines often mix regular and bold). */
  bolds?: boolean[]
  /** Ink spread (Gaussian sigma, px) and extra stroke weight (px per side). */
  sigma: number
  weight?: number
  /** Measured scanner response: rendered coverage (0..1, evenly spaced) → scanned darkness. */
  curve: number[]
  /** How bold words are drawn: Bold face, or Regular thickened (printed bold is often lighter). */
  boldStyle?: { bold: boolean; weight: number }
  /** Sampled paper colour (fallback cover). */
  paper: string
}

/** Region of original page content hidden under a replacement text. */
export interface Cover {
  x: number
  y: number
  width: number
  height: number
  /** Fill colour sampled from the page background, #rrggbb. */
  color: string
  /** The text that was there, for reference. */
  original: string
}

export interface TextElement extends BaseElement {
  kind: 'text'
  text: string
  font: FontFamilyId
  /** Font size in points. */
  size: number
  /** #rrggbb */
  color: string
  bold: boolean
  italic: boolean
  align: TextAlign
  /** Line advance as a multiple of `size`. */
  lineHeight: number
  /** Present when this text replaces existing PDF text. */
  cover?: Cover
  /**
   * The PDF's own font for this text (edited lines only). When `useOriginal`
   * is set and every character is available in it, it is used instead of
   * `font` — which stays the bundled fallback (and the inline-editor font).
   */
  original?: OriginalFont
  useOriginal?: boolean
  /** Edit on a scanned page, drawn into the scan instead of on top of it. */
  scan?: ScanMatch
}

export interface ImageElement extends BaseElement {
  kind: 'image'
  /** Key into the asset store (bytes live outside the undo history). */
  assetId: string
  width: number
  height: number
}

export type { OriginalFont }

export type EditorElement = TextElement | ImageElement

export interface ImageAsset {
  id: string
  mime: 'image/png' | 'image/jpeg'
  bytes: Uint8Array
  width: number
  height: number
}
