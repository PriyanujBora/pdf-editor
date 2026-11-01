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

export type FontFamilyId = 'inter' | 'roboto' | 'noto-serif' | 'noto-bengali' | 'noto-devanagari'
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
}

export interface ImageElement extends BaseElement {
  kind: 'image'
  /** Key into the asset store (bytes live outside the undo history). */
  assetId: string
  width: number
  height: number
}

export type EditorElement = TextElement | ImageElement

export interface ImageAsset {
  id: string
  mime: 'image/png' | 'image/jpeg'
  bytes: Uint8Array
  width: number
  height: number
}
