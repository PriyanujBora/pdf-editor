import fontkit from '@pdf-lib/fontkit'

/**
 * Adapter around @pdf-lib/fontkit for @cantoo/pdf-lib. Fixes two problems:
 *
 * 1. @cantoo/pdf-lib serialises subsets with `subset.encode()` when that method
 *    exists (the fontkit v2 API). In @pdf-lib/fontkit `encode` is an internal
 *    stream writer, which crashes. We expose only what pdf-lib needs, so it
 *    falls back to `encodeStream()`.
 *
 * 2. The TTF subsetter writes a short-format `loca` table (offsets / 2) for
 *    small subsets but never pads glyph data to an even length. Fonts with
 *    odd-length glyphs (Inter, Noto Serif, …) then get truncated offsets and
 *    render garbage. We pad every copied glyph to 2-byte alignment.
 */
interface ByteBuf extends Uint8Array {
  constructor: { alloc?: (n: number) => ByteBuf }
}
interface TTFSubsetInternals {
  includeGlyph: (g: unknown) => number
  encodeStream: () => unknown
  cff?: unknown
  _addGlyph?: (gid: number) => number
  glyf?: ByteBuf[]
  offset?: number
}

export function patchSubset(s: TTFSubsetInternals) {
  const addGlyph = s._addGlyph?.bind(s)
  if (addGlyph) {
    s._addGlyph = (gid: number) => {
      const idx = addGlyph(gid)
      const buf = s.glyf?.[idx]
      if (buf && buf.length % 2 === 1) {
        const padded = buf.constructor.alloc?.(buf.length + 1) ?? (new Uint8Array(buf.length + 1) as ByteBuf)
        padded.set(buf)
        s.glyf![idx] = padded
        s.offset = (s.offset ?? 0) + 1
      }
      return idx
    }
  }
  return {
    includeGlyph: (g: unknown) => s.includeGlyph(g),
    encodeStream: () => s.encodeStream(),
    get cff() {
      return s.cff
    },
  }
}

type Font = { createSubset: () => TTFSubsetInternals }

export const compatFontkit = {
  create(data: Uint8Array, postscriptName?: string) {
    const font = fontkit.create(data, postscriptName) as unknown as Font
    const createSubset = font.createSubset.bind(font)
    font.createSubset = () => patchSubset(createSubset()) as TTFSubsetInternals
    return font
  },
} as unknown as typeof fontkit
