import type { FontFamilyId } from '@/types'
import { FAMILY_WIDTHS, WIDTH_CHARS } from './fallback-widths'

/**
 * Which bundled family stands in for a PDF font, for characters the PDF's own font can't draw.
 * Known names map to metric-compatible families (same advance widths). Anything else is chosen by
 * a least-squares fit of the advance widths the PDF actually drew with that font, which also
 * gives a uniform scale so the stand-in is neither wider nor bigger than the original.
 */

export interface FontTraits {
  family: FontFamilyId
  bold: boolean
  italic: boolean
  /** Uniform scale for the stand-in's glyphs. */
  scale: number
}

/** TeX font names: CMR10, SFRM1095, ECBX1200, LMRoman10-Bold, … */
const TEX = /^(cm|sf|ec|tc)[a-z]{1,5}\d{2,4}$|^lm(roman|sans|mono)/i
const SANS: FontFamilyId[] = ['arimo', 'carlito', 'roboto', 'inter']
const SERIF: FontFamilyId[] = ['tinos', 'gelasio', 'noto-serif']
const MONO: FontFamilyId[] = ['cousine']

export function styleFromName(name: string, flags: { bold?: boolean; italic?: boolean; black?: boolean } = {}) {
  const n = name.replace(/^[A-Z]{6}\+/, '')
  let bold = !!flags.bold || !!flags.black || /bold|black|heavy|semibold|demi/i.test(n)
  let italic = !!flags.italic || /italic|oblique|slanted/i.test(n)
  if (TEX.test(n)) {
    bold ||= /^(cm|sf|ec)(bx|b|rb|sx|ssbx|ssdc)/i.test(n)
    italic ||= /^(cm|sf|ec)(ti|it|sl|si|bi|ssi)/i.test(n)
  }
  return { bold, italic }
}

/** Name-based choice; `candidates` are tried by width fit when the name settles nothing. */
function byName(name: string, serifHint: boolean): { family?: FontFamilyId; candidates: FontFamilyId[] } {
  const n = name.replace(/^[A-Z]{6}\+/, '')
  if (/bengali|bangla|kalpurush|siyam|solaiman|vrinda/i.test(n)) return { family: 'noto-bengali', candidates: [] }
  if (/devanagari|mangal|hindi|kokila|aparajita|utsaah/i.test(n)) return { family: 'noto-devanagari', candidates: [] }
  if (TEX.test(n)) {
    if (/^(cm|sf|ec)tt|^lmmono/i.test(n)) return { family: 'cousine', candidates: MONO }
    if (/^(cm|sf|ec)ss|^lmsans/i.test(n)) return { candidates: SANS }
    return { candidates: SERIF }
  }
  if (/arial|helvetica|arimo|liberation ?sans|nimbus ?sans/i.test(n)) return { family: 'arimo', candidates: SANS }
  if (/calibri|carlito/i.test(n)) return { family: 'carlito', candidates: SANS }
  if (/courier|cousine|liberation ?mono|nimbus ?mono/i.test(n)) return { family: 'cousine', candidates: MONO }
  if (/georgia|gelasio/i.test(n)) return { family: 'gelasio', candidates: SERIF }
  if (/times|tinos|liberation ?serif|nimbus ?rom|thorndale/i.test(n)) return { family: 'tinos', candidates: SERIF }
  if (/roboto/i.test(n)) return { family: 'roboto', candidates: SANS }
  if (/^inter\b|inter-/i.test(n)) return { family: 'inter', candidates: SANS }
  if (/mono|consol|menlo|code/i.test(n)) return { candidates: MONO }
  if (/serif|garamond|cambria|minion|palatino|book|baskerville|caslon|century|bodoni|charter|merriweather|lora|libertin|roman/i.test(n) && !/sans/i.test(n))
    return { candidates: SERIF }
  if (/sans|segoe|verdana|tahoma|gothic|grotesk|helv|frutiger|futura|avenir|myriad|lato|montserrat|poppins/i.test(n))
    return { candidates: SANS }
  return { candidates: serifHint ? SERIF : [...SANS, ...SERIF] }
}

/** Least-squares fit: `widths` maps characters to advance widths in 1/1000 em. */
function fit(widths: Map<string, number>, candidates: FontFamilyId[], bold: boolean) {
  let best: { family: FontFamilyId; scale: number; err: number } | null = null
  for (const family of candidates) {
    const row = FAMILY_WIDTHS[family + (bold ? ':b' : '')] ?? FAMILY_WIDTHS[family]
    if (!row) continue
    let sxy = 0
    let syy = 0
    let sxx = 0
    for (const [ch, w] of widths) {
      const i = WIDTH_CHARS.indexOf(ch)
      if (i < 0 || !(w > 0)) continue
      sxy += w * row[i]
      syy += row[i] * row[i]
      sxx += w * w
    }
    if (!syy) continue
    const scale = sxy / syy
    const err = (sxx - 2 * scale * sxy + scale * scale * syy) / sxx
    if (!best || err < best.err) best = { family, scale, err }
  }
  return best
}

const clampScale = (s: number) => Math.min(1.18, Math.max(0.85, s))

/**
 * @param widths advance widths (1/1000 em) the PDF drew with this font, by character
 * @param serifHint pdf.js classified the font as serif
 */
export function chooseFallback(
  name: string,
  widths: Map<string, number>,
  flags: { bold?: boolean; italic?: boolean; black?: boolean; serif?: boolean } = {},
): FontTraits {
  const { bold, italic } = styleFromName(name, flags)
  const named = byName(name, !!flags.serif)
  const usable = [...widths.keys()].filter((c) => WIDTH_CHARS.includes(c)).length
  if (named.family) {
    // A metric-compatible name match needs no scale; still check it against what was drawn.
    if (usable >= 4) {
      const f = fit(widths, [named.family], bold)
      if (f && f.err < 0.004) return { family: named.family, bold, italic, scale: Math.abs(f.scale - 1) < 0.03 ? 1 : clampScale(f.scale) }
      const other = fit(widths, named.candidates, bold)
      if (other && f && other.err < f.err * 0.5) return { family: other.family, bold, italic, scale: clampScale(other.scale) }
    }
    return { family: named.family, bold, italic, scale: 1 }
  }
  const f = usable >= 4 ? fit(widths, named.candidates, bold) : null
  if (f) return { family: f.family, bold, italic, scale: clampScale(f.scale) }
  return { family: named.candidates[0] ?? 'inter', bold, italic, scale: 1 }
}
