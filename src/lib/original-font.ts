/**
 * Re-using a font that is already in the PDF.
 *
 * Embedded fonts are usually subsets, so we only trust glyphs we have *seen*
 * the document draw with that font (pdf.js operator lists tell us the char
 * code, the Unicode text and the width of each one). Text made only of those
 * glyphs can be drawn with the original font resource, in the editor (via the
 * FontFace pdf.js already loaded) and in the export (same char codes, same
 * font dictionary). Anything else falls back to a bundled font.
 *
 * Pure module: used by the editor and the export worker.
 */

/** [char code, advance width in 1/1000 em, pdf.js font char] */
export type GlyphEntry = [number, number, string]

export interface OriginalFont {
  /** /BaseFont of the font dictionary, e.g. "QGSGQP+SFRM1095". */
  baseFont: string
  /** Type0 font with 2-byte (Identity-H) codes. */
  composite: boolean
  /** Unicode text (1–3 chars for ligatures) → glyph. */
  glyphs: Record<string, GlyphEntry>
  /** Width of a space in 1/1000 em when the font has no space glyph (TeX). */
  spaceGap: number
}

export type EncodedItem = { code: number; width: number; fontChar: string } | { gap: number }

export interface EncodedLine {
  items: EncodedItem[]
  /** Advance in 1/1000 em. */
  width: number
  missing: string[]
}

const MAX_KEY = 3

export function encodeLine(line: string, f: OriginalFont): EncodedLine {
  const items: EncodedItem[] = []
  const missing: string[] = []
  let width = 0
  const chars = [...line]
  for (let i = 0; i < chars.length;) {
    let hit: GlyphEntry | undefined
    let len = 0
    // Longest match first, so ligature glyphs ("fi") are reused.
    for (let n = Math.min(MAX_KEY, chars.length - i); n >= 1 && !hit; n--) {
      hit = f.glyphs[chars.slice(i, i + n).join('')]
      len = n
    }
    if (hit) {
      items.push({ code: hit[0], width: hit[1], fontChar: hit[2] })
      width += hit[1]
    } else if (/\s/.test(chars[i])) {
      items.push({ gap: f.spaceGap })
      width += f.spaceGap
      len = 1
    } else {
      missing.push(chars[i])
      len = 1
    }
    i += len
  }
  return { items, width, missing }
}

/** Characters of `text` the original font can't draw (deduplicated). */
export function missingGlyphs(text: string, f: OriginalFont): string[] {
  const out = new Set<string>()
  for (const line of text.split(/\r\n|\r|\n/)) for (const c of encodeLine(line, f).missing) out.add(c)
  return [...out]
}

/** True when this text element should be drawn with its original PDF font. */
export function usesOriginal(el: { original?: OriginalFont; useOriginal?: boolean; text: string }): el is {
  original: OriginalFont
  useOriginal: true
  text: string
} {
  return !!el.original && !!el.useOriginal && missingGlyphs(el.text, el.original).length === 0
}

export function displayFontName(baseFont: string) {
  return baseFont.replace(/^[A-Z]{6}\+/, '')
}
