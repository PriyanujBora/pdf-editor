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

export type FontFamilyId =
  | 'inter'
  | 'roboto'
  | 'tinos'
  | 'noto-serif'
  | 'noto-bengali'
  | 'noto-devanagari'
  | 'arimo'
  | 'carlito'
  | 'cousine'
  | 'gelasio'
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

/**
 * A style run of an existing line, as the PDF drew it (captured from the pdf.js operator list).
 * Lengths are page-space points.
 */
export interface SourceRun {
  /** pdf.js font id in this session (its FontFace, when `embedded`). */
  loadedName: string
  /** /BaseFont, used by the export to find the font dictionary again. */
  baseFont: string
  /** Type0 with 2-byte codes / Type3 (glyph procedures, no FontFace). */
  composite: boolean
  type3: boolean
  /** The font program is in the file (pdf.js registered a FontFace for it). */
  embedded: boolean
  /** Font size (vertical scale) and the horizontal scale of glyph shapes (Tz, stretched matrices). */
  size: number
  hScale: number
  /** Glyph space → em (0.001 for all but Type3). */
  fontMatrix: number
  /** Tc and Tw. */
  charSpacing: number
  wordSpacing: number
  /** Baseline shift (Ts or a raised superscript), + = up. */
  rise: number
  color: string
  /** Fill opacity as printed; flattened into `color` against the page background when editing starts. */
  alpha?: number
  bold: boolean
  italic: boolean
  /** Type3 fonts often have no /BaseFont: a few (char code, width) pairs identify the font dictionary. */
  widthSig?: [number, number][]
  /** Bundled, metric-compatible family for characters this font can't draw, and its scale. */
  family: FontFamilyId
  familyScale: number
}

/** One glyph of an existing line. */
export interface SourceGlyph {
  /** The characters it stands for (two or three for ligatures). */
  uni: string
  /** Origin x (page space) and advance, spacing included. */
  x: number
  adv: number
  run: number
  /** Char code in its font, and pdf.js' char for drawing with the font's FontFace. */
  code: number
  fontChar: string
  /** Advance width in glyph units (× run.fontMatrix → em), spacing excluded. */
  w: number
}

/** An existing line of text as printed: what an edit is compared against. */
export interface SourceLine {
  /** Text as printed; spaces the PDF didn't draw are inferred from gaps. */
  text: string
  /** Glyph index for every character of `text` (-1 = inferred space). */
  charGlyph: number[]
  glyphs: SourceGlyph[]
  runs: SourceRun[]
  /** Baseline (page space, without rise) and the line's ink box. */
  baseline: number
  box: PtRect
  /** Width of a space on this line (measured word gap when the font has no space glyph). */
  spaceWidth: number
  /** Word gaps were stretched to fill the column: edits keep the right edge. */
  justified: boolean
  /**
   * Vertical extent of patches (page space). The line box uses the font's full ascent/descent, which
   * in tightly set paragraphs overlaps the neighbouring lines; patches stop half-way into that overlap.
   */
  coverTop?: number
  coverBottom?: number
  /** Sampled page colour behind the line, for patches over changed words. */
  background: string
  /** Glyphs each font has drawn in this document (keyed by /BaseFont), for typing new text. */
  fonts: Record<string, OriginalFont>
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
  /**
   * Edit of an existing vector line. `text` is compared with `source.text`: unchanged words keep
   * the PDF's own glyphs and positions, changed words are laid out fresh in the style of the text
   * they replace (see lib/text/line-layout.ts). `x`/`y` start at `source.box`; moving the element
   * moves the whole line.
   */
  source?: SourceLine
  /** Set once the user restyles the line: every word is then drawn with the fields above. */
  override?: boolean
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
