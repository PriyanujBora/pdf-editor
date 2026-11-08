/**
 * Applies redaction marks to a page's content (Phase 4), export worker only. Under the marks:
 * - text: every glyph whose box is mostly under a mark (≥ 25 % of it, or its centre) is removed
 *   exactly like edited text (TJ adjustment, nothing else moves), visible or invisible (OCR layers);
 * - images: a page-level image XObject a mark touches is swapped for its redacted copy (decoded and
 *   painted on the main thread, see lib/redact/images.ts), under a new name on this page only;
 * - drawings: painted paths that lie entirely under a mark are deleted (operators and coordinates);
 *   paths that only cross a mark stay, covered by the box.
 * Anything under a mark that can't be removed is reported as a problem and the caller refuses to
 * download: clip text, text in fonts we can't read, inline images, stencil masks, images inside forms.
 */
import { PDFName, PDFDict, type PDFObject, type PDFPage, type PDFRef } from '@cantoo/pdf-lib'
import { area, glyphUnder, overlap, type Box } from '@/lib/redact/geometry'
import { interpret, pageContent, writeContent, type Collect, type DrawnGlyph, type Forms, type M, type Splice } from './remove-text'

const N = (n: string) => PDFName.of(n)
export type { Box }

export interface ImageSwap {
  ctm: number[]
  ref: PDFRef
}

export interface RedactPageResult {
  problems: string[]
  glyphs: number
  images: number
  paths: number
}

const inside = (a: Box, r: Box) => a[0] >= r[0] - 0.01 && a[1] >= r[1] - 0.01 && a[2] <= r[2] + 0.01 && a[3] <= r[3] + 0.01

function quadBox(m: M): Box {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]]
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const sameM = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 1e-3 * Math.max(1, Math.abs(v)))

export function redactPage(page: PDFPage, toPage: M, rects: Box[], swaps: ImageSwap[]): RedactPageResult {
  const ctx = page.doc.context
  const res: RedactPageResult = { problems: [], glyphs: 0, images: 0, paths: 0 }
  const problem = (p: string) => !res.problems.includes(p) && res.problems.push(p)
  const { bytes, ops } = pageContent(page)
  const resources = page.node.Resources()
  const glyphs: DrawnGlyph[] = []
  const forms: Forms = new Map()
  const collect: Collect = { images: [], paths: [], unknownText: 0 }
  interpret(ctx, ops, resources, toPage, 'page', glyphs, forms, false, collect)
  if (collect.unknownText) problem('text in a font that can’t be read')

  const drop = new Set<DrawnGlyph>()
  for (const g of glyphs) {
    if (!glyphUnder(g.box, rects)) continue
    const why = g.font.problem ?? (g.mode >= 4 ? 'text used as a clipping path' : g.nested ? 'text in a nested form' : !g.tfs ? 'text with font size 0' : undefined)
    if (why) problem(why)
    else drop.add(g)
  }
  res.glyphs = drop.size

  const pageExtra: Splice[] = []
  const formExtra = new Map<number, Splice[]>()
  const enc = new TextEncoder()
  const xobjects = resources?.lookupMaybe(N('XObject'), PDFDict)
  let k = 0
  for (const im of collect.images) {
    const b = quadBox(im.ctm)
    if (!rects.some((r) => area(overlap(b, r)) > 1e-4)) continue
    if (im.kind === 'inline') problem('an inline image')
    else if (im.kind === 'mask') problem('a stencil-mask image')
    else if (im.stream !== 'page' || im.nested) problem('an image inside a form XObject')
    else {
      const swap = swaps.find((s) => sameM(s.ctm, im.ctm))
      if (!swap || !xobjects) {
        problem('an image that couldn’t be decoded')
        continue
      }
      let name: string
      do name = `RdIm${++k}`
      while (xobjects.has(N(name)))
      xobjects.set(N(name), swap.ref)
      pageExtra.push({ start: ops[im.op].start, end: ops[im.op].end, data: enc.encode(`/${name} Do`) })
      res.images++
    }
  }

  // A swapped image whose name nothing on the page draws any more leaves this page's resources, or
  // the original (with the pixels under the mark) would stay reachable and ship in the file.
  if (xobjects && res.images) {
    const swapped = new Set(pageExtra.map((s) => s.start))
    const stillUsed = new Set(
      ops.filter((o, oi) => o.op === 'Do' && o.args[0]?.t === 'name' && !swapped.has(ops[oi].start)).map((o) => (o.args[0] as { v: string }).v),
    )
    // Forms without resources of their own draw from the page's.
    for (const im of collect.images) if (im.stream !== 'page') stillUsed.add(im.name)
    for (const im of collect.images)
      if (im.stream === 'page' && im.kind === 'xobject' && swapped.has(ops[im.op].start) && !stillUsed.has(im.name)) xobjects.delete(N(im.name))
  }

  for (const p of collect.paths) {
    if (!rects.some((r) => inside(p.box, r))) continue
    const list = p.stream === 'page' ? ops : forms.get(p.stream)?.ops
    if (!list) continue
    const splice = { start: list[p.start].start, end: list[p.end].end, data: new Uint8Array() }
    if (p.stream === 'page') pageExtra.push(splice)
    else {
      let l = formExtra.get(p.stream)
      if (!l) formExtra.set(p.stream, (l = []))
      l.push(splice)
    }
    res.paths++
  }

  if (res.problems.length) return res
  if (drop.size || pageExtra.length || formExtra.size) writeContent(page, bytes, ops, glyphs, drop, forms, pageExtra, formExtra)
  return res
}

/** Annotations (and form widgets) on the page whose rectangle touches a mark. */
export function annotationsUnder(page: PDFPage, toPage: M, rects: Box[]): PDFObject[] {
  const ctx = page.doc.context
  const annots = page.node.Annots()
  if (!annots) return []
  const out: PDFObject[] = []
  for (const a of annots.asArray()) {
    const d = ctx.lookupMaybe(a, PDFDict)
    const r = d?.lookup(N('Rect'))
    const arr = (r as { asArray?: () => unknown[] } | undefined)?.asArray?.()
    if (!d || !arr || arr.length < 4) continue
    const [x0, y0, x1, y1] = arr.map((v) => (ctx.lookup(v as never) as { asNumber?: () => number } | undefined)?.asNumber?.() ?? 0)
    const pts = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ].map(([x, y]) => [toPage[0] * x + toPage[2] * y + toPage[4], toPage[1] * x + toPage[3] * y + toPage[5]])
    const b: Box = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
    if (rects.some((m) => b[0] < m[2] && b[2] > m[0] && b[1] < m[3] && b[3] > m[1]) ) out.push(a)
  }
  return out
}
