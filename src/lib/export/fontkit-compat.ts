import fontkit from '@pdf-lib/fontkit'

/**
 * @cantoo/pdf-lib serialises font subsets with `subset.encode()` when that
 * method exists (the @cantoo/fontkit / fontkit v2 API). In @pdf-lib/fontkit
 * `encode` is an internal stream writer instead, which crashes. Exposing only
 * the pieces pdf-lib needs makes it fall back to `encodeStream()`.
 */
type Subset = { includeGlyph: (g: unknown) => number; encodeStream: () => unknown; cff?: unknown }
type Font = { createSubset: () => Subset }

export const compatFontkit = {
  create(data: Uint8Array, postscriptName?: string) {
    const font = fontkit.create(data, postscriptName) as unknown as Font
    const createSubset = font.createSubset.bind(font)
    font.createSubset = () => {
      const s = createSubset()
      return {
        includeGlyph: (g: unknown) => s.includeGlyph(g),
        encodeStream: () => s.encodeStream(),
        get cff() {
          return s.cff
        },
      }
    }
    return font
  },
} as unknown as typeof fontkit
