/**
 * Text box geometry shared by the editor canvas and the export worker.
 * Both sides place each line's *baseline* at the same offset, and both use
 * the same font files, so glyphs land in the same spot on screen and in the
 * PDF. Lines are only broken on explicit newlines (auto-width boxes).
 */

/** Baseline of the first line, as a fraction of font size below the box top. */
export const ASCENT = 0.9
/** Space below the last baseline, as a fraction of font size. */
export const DESCENT = 0.3

export function splitLines(text: string) {
  return text.split(/\r\n|\r|\n/)
}

export function baselineOffset(lineIndex: number, size: number, lineHeight: number) {
  return size * (ASCENT + lineIndex * lineHeight)
}

export function boxHeight(lineCount: number, size: number, lineHeight: number) {
  return size * (ASCENT + Math.max(0, lineCount - 1) * lineHeight + DESCENT)
}

export function alignOffset(align: 'left' | 'center' | 'right', boxWidth: number, lineWidth: number) {
  if (align === 'center') return (boxWidth - lineWidth) / 2
  if (align === 'right') return boxWidth - lineWidth
  return 0
}
