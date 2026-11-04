import type { FontFamilyId } from '@/types'

/**
 * Bundled font registry, shared by the editor (CSS @font-face, see index.css)
 * and the export worker (fetches the same TTF files and embeds subsets).
 */
export interface FontFamilyDef {
  id: FontFamilyId
  label: string
  /** CSS family name registered in index.css. */
  css: string
  file: string
  hasItalic: boolean
  /** hhea ascent/descent in em — used to align the HTML text editor's baseline. */
  ascent: number
  descent: number
}

export const FONT_FAMILIES: Record<FontFamilyId, FontFamilyDef> = {
  inter: { id: 'inter', label: 'Inter', css: 'PDF Inter', file: 'Inter', hasItalic: true, ascent: 0.9688, descent: 0.2412 },
  roboto: { id: 'roboto', label: 'Roboto', css: 'PDF Roboto', file: 'Roboto', hasItalic: true, ascent: 0.9277, descent: 0.2441 },
  tinos: {
    id: 'tinos',
    label: 'Tinos (Times)',
    css: 'PDF Tinos',
    file: 'Tinos',
    hasItalic: true,
    ascent: 0.8911,
    descent: 0.2163,
  },
  'noto-serif': {
    id: 'noto-serif',
    label: 'Noto Serif',
    css: 'PDF Noto Serif',
    file: 'NotoSerif',
    hasItalic: true,
    ascent: 1.069,
    descent: 0.293,
  },
  'noto-bengali': {
    id: 'noto-bengali',
    label: 'Noto Sans Bengali',
    css: 'PDF Noto Sans Bengali',
    file: 'NotoSansBengali',
    hasItalic: false,
    ascent: 0.917,
    descent: 0.408,
  },
  'noto-devanagari': {
    id: 'noto-devanagari',
    label: 'Noto Sans Devanagari',
    css: 'PDF Noto Sans Devanagari',
    file: 'NotoSansDevanagari',
    hasItalic: false,
    ascent: 0.896,
    descent: 0.408,
  },
}

export const FONT_LIST = Object.values(FONT_FAMILIES)

/** Synthetic-oblique shear used when italic is requested but the face has none. */
export const OBLIQUE_SHEAR = 0.2

export function fontFileUrl(id: FontFamilyId, bold: boolean, italic: boolean, base = '/') {
  const f = FONT_FAMILIES[id]
  const it = italic && f.hasItalic
  const variant = (bold ? 'Bold' : '') + (it ? 'Italic' : '') || 'Regular'
  return `${base}fonts/${f.file}-${variant}.ttf`
}

export type Script = 'latin' | 'bengali' | 'devanagari'

export function scriptOf(cp: number): Script | null {
  if (cp >= 0x0980 && cp <= 0x09ff) return 'bengali'
  if ((cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff) || (cp >= 0x1cd0 && cp <= 0x1cff)) return 'devanagari'
  // Spaces, digits, punctuation, joiners and dandas are script-neutral.
  if (cp <= 0x40 || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7f) || cp === 0x200c || cp === 0x200d || cp === 0x25cc)
    return null
  return 'latin'
}

const SCRIPT_FONT: Record<Exclude<Script, 'latin'>, FontFamilyId> = {
  bengali: 'noto-bengali',
  devanagari: 'noto-devanagari',
}

/**
 * Splits a line into runs that each use one font: the chosen family for
 * Latin, the matching Noto face for Bengali / Devanagari. Neutral characters
 * stick to the run they're in.
 */
export function fontRuns(text: string, primary: FontFamilyId): { text: string; font: FontFamilyId }[] {
  const runs: { text: string; font: FontFamilyId }[] = []
  let cur: FontFamilyId | null = null
  let buf = ''
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!)
    const f: FontFamilyId | null = s === null ? null : s === 'latin' ? primary : SCRIPT_FONT[s]
    if (f === null || f === cur || cur === null) {
      if (cur === null && f !== null) cur = f
      buf += ch
      continue
    }
    runs.push({ text: buf, font: cur })
    cur = f
    buf = ch
  }
  if (buf) runs.push({ text: buf, font: cur ?? primary })
  return runs
}

/** Best bundled family for a string (used when detecting existing text). */
export function familyForText(text: string, fallback: FontFamilyId): FontFamilyId {
  for (const ch of text) {
    const s = scriptOf(ch.codePointAt(0)!)
    if (s === 'bengali') return 'noto-bengali'
    if (s === 'devanagari') return 'noto-devanagari'
  }
  return fallback
}

/** CSS font shorthand for canvas measuring/drawing. */
export function cssFont(id: FontFamilyId, size: number, bold: boolean, italic: boolean) {
  const f = FONT_FAMILIES[id]
  const fallbacks = ['PDF Noto Sans Bengali', 'PDF Noto Sans Devanagari'].filter((n) => n !== f.css)
  return `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${size}px "${f.css}", ${fallbacks.map((n) => `"${n}"`).join(', ')}, sans-serif`
}

/** Resolves once the font faces needed to draw `text` are loaded. */
export async function ensureFontLoaded(id: FontFamilyId, bold: boolean, italic: boolean, text: string) {
  if (!('fonts' in document)) return
  const fams = new Set(fontRuns(text || 'a', id).map((r) => r.font))
  await Promise.all(
    [...fams].map((fam) => document.fonts.load(cssFont(fam, 16, bold, italic).replace(/,.*$/, ''), text || 'a').catch(() => [])),
  )
}
