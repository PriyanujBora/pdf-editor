/** Shared by the export worker (what to remove) and the check afterwards (what must be gone). */

/** Page-space rectangle [x0, y0, x1, y1]. */
export type Box = [number, number, number, number]

export const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
export const overlap = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]

/** Glyph box used for redaction: advance × (0.8 em above, 0.25 em below the baseline incl. rise). */
export const glyphRedactBox = (x: number, baseline: number, width: number, size: number): Box => [x, baseline - 0.8 * size, x + width, baseline + 0.25 * size]

/** A glyph is redacted when a mark covers its centre, or a quarter of its box. */
export function glyphUnder(box: Box, rects: Box[]) {
  const cx = (box[0] + box[2]) / 2
  const cy = (box[1] + box[3]) / 2
  const a = area(box)
  return rects.some((r) => (cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]) || (a > 0 && area(overlap(box, r)) >= 0.25 * a))
}
