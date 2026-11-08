/**
 * Redaction safety net (export worker, after everything else, before encryption): looks for the
 * marked strings in every object of the output — strings anywhere, decoded streams (metadata,
 * attachments, scripts, annotation appearances), marked-content properties — outside the page text
 * itself (that is checked separately on the main thread with pdf.js, which knows the fonts).
 * Matching ignores case and whitespace.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from '@cantoo/pdf-lib'
import { pageContent } from '@/lib/content/remove-text'

const N = (n: string) => PDFName.of(n)
export const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '')

export interface Leak {
  text: string
  where: string
}

const ANNOTS = new Set(
  ['Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound', 'Movie', 'Screen', 'PrinterMark', 'TrapNet', 'Watermark', '3D', 'Redact', 'RichMedia'].map((s) => '/' + s),
)

function texts(bytes: Uint8Array): string[] {
  const out = [new TextDecoder('latin1').decode(bytes), new TextDecoder('utf-8').decode(bytes)]
  if (bytes.length > 1 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || bytes.length % 2 === 0)) out.push(new TextDecoder('utf-16be').decode(bytes))
  return out
}

function decoded(s: PDFStream): Uint8Array | null {
  try {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode()
    return s.getContents()
  } catch {
    return null
  }
}

/** Builds a regex that finds `needle` ignoring case and whitespace. */
function looseRe(needle: string) {
  const chars = [...normalize(needle)].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(chars.join('\\s*'), 'giu')
}

/** Replaces marked strings in bookmark titles and tag texts (alternate text, actual text). */
export function scrubStrings(doc: PDFDocument, needles: string[]): number {
  const ctx = doc.context
  const res = needles.filter((n) => normalize(n).length >= 3).map(looseRe)
  if (!res.length) return 0
  let n = 0
  const fix = (d: PDFDict, key: string) => {
    const v = d.lookup(N(key))
    if (!(v instanceof PDFString || v instanceof PDFHexString)) return
    const t = v.decodeText()
    let u = t
    for (const re of res) u = u.replace(re, (m) => '█'.repeat(Math.min(8, Math.max(3, m.length))))
    if (u !== t) {
      d.set(N(key), PDFHexString.fromText(u))
      n++
    }
  }
  const outline = (d: PDFDict | undefined, depth = 0) => {
    let ref = d?.get(N('First'))
    let guard = 0
    while (ref && guard++ < 100000 && depth < 100) {
      const item = ctx.lookupMaybe(ref, PDFDict)
      if (!item) break
      fix(item, 'Title')
      outline(item, depth + 1)
      ref = item.get(N('Next'))
    }
  }
  outline(ctx.lookupMaybe(doc.catalog.get(N('Outlines')), PDFDict))
  const struct = (d: PDFDict | undefined, depth = 0) => {
    if (!d || depth > 300) return
    for (const k of ['Alt', 'ActualText', 'E', 'T']) fix(d, k)
    const k = d.get(N('K'))
    for (const kid of k instanceof PDFArray ? k.asArray() : k ? [k] : []) struct(ctx.lookupMaybe(kid, PDFDict), depth + 1)
  }
  struct(ctx.lookupMaybe(doc.catalog.get(N('StructTreeRoot')), PDFDict))
  return n
}

/** Where marked strings can still be found in the output (outside the page text). */
export function findLeaks(doc: PDFDocument, pages: PDFPage[], markedPages: PDFPage[], needles: string[]): Leak[] {
  const ctx = doc.context
  const want = [...new Set(needles.map((n) => n.trim()).filter((n) => normalize(n).length >= 3))]
  if (!want.length) return []
  const norm = want.map(normalize)
  const leaks = new Map<string, Leak>()
  const check = (s: string, where: string) => {
    const h = normalize(s)
    norm.forEach((n, i) => {
      if (h.includes(n)) leaks.set(want[i] + '|' + where, { text: want[i], where })
    })
  }

  // Page content streams and the forms they draw: their text is checked with pdf.js instead.
  const content = new Set<PDFObject>()
  const forms = (res: PDFDict | undefined, depth = 0) => {
    const xo = res?.lookupMaybe(N('XObject'), PDFDict)
    if (!xo || depth > 20) return
    for (const [, v] of xo.entries()) {
      const s = ctx.lookup(v)
      if (!(s instanceof PDFStream) || content.has(s) || s.dict.get(N('Subtype')) !== N('Form')) continue
      content.add(s)
      forms(s.dict.lookupMaybe(N('Resources'), PDFDict), depth + 1)
    }
  }
  for (const p of pages) {
    const c = p.node.Contents()
    for (const r of c instanceof PDFArray ? c.asArray() : c ? [c] : []) content.add(ctx.lookup(r) as PDFObject)
    forms(p.node.Resources())
  }
  // Binary streams that can't hold text: fonts and images; Type3 glyph procedures.
  const skip = new Set<PDFObject>()
  const jsStreams = new Set<PDFObject>()
  const annotForms = new Set<PDFObject>()
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : undefined
    if (!d) continue
    for (const k of ['FontFile', 'FontFile2', 'FontFile3']) if (d.get(N(k))) skip.add(ctx.lookup(d.get(N(k))) as PDFObject)
    const cp = d.lookupMaybe(N('CharProcs'), PDFDict)
    if (cp) for (const [, v] of cp.entries()) skip.add(ctx.lookup(v) as PDFObject)
    if (d.get(N('JS'))) jsStreams.add(ctx.lookup(d.get(N('JS'))) as PDFObject)
    const ap = d.lookupMaybe(N('AP'), PDFDict)
    if (ap)
      for (const [, v] of ap.entries()) {
        const x = ctx.lookup(v)
        if (x instanceof PDFStream) annotForms.add(x)
        else if (x instanceof PDFDict) for (const [, w] of x.entries()) annotForms.add(ctx.lookup(w) as PDFObject)
      }
  }

  const info = ctx.trailerInfo.Info
  const label = (ref: PDFRef, o: PDFObject): string => {
    if (info instanceof PDFRef && ref === info) return 'the document properties'
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : undefined
    if (!d) return 'other document data'
    const type = String(d.get(N('Type')) ?? '')
    const sub = String(d.get(N('Subtype')) ?? '')
    if (type === '/Metadata' || sub === '/XML') return 'the XMP metadata'
    if (type === '/EmbeddedFile' || type === '/Filespec' || d.get(N('EF'))) return 'an attachment'
    if (jsStreams.has(o) || d.get(N('JS')) || String(d.get(N('S'))) === '/JavaScript') return 'JavaScript'
    if (sub === '/Widget' || d.get(N('FT')) || (d.get(N('T')) && d.get(N('V')))) return 'a form field'
    if (ANNOTS.has(sub)) return 'a comment or annotation'
    if (annotForms.has(o)) return 'an annotation or form field appearance'
    if (d.get(N('Title')) && (d.get(N('Parent')) || d.get(N('First')))) return 'a bookmark'
    if (type === '/StructElem' || d.get(N('S')) instanceof PDFName) return 'the tags (accessibility text)'
    return 'other document data'
  }
  const walk = (o: PDFObject, where: string, depth = 0) => {
    if (depth > 30) return
    if (o instanceof PDFString || o instanceof PDFHexString) check(o.decodeText(), where)
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) walk(v, where, depth + 1)
    else if (o instanceof PDFArray) for (const v of o.asArray()) walk(v, where, depth + 1)
  }
  for (const [ref, o] of ctx.enumerateIndirectObjects()) {
    const where = label(ref, o)
    if (o instanceof PDFStream) {
      walk(o.dict, where)
      if (content.has(o) || skip.has(o) || o.dict.get(N('Subtype')) === N('Image')) continue
      const b = decoded(o)
      if (b) for (const t of texts(b)) check(t, where)
    } else walk(o, where)
  }
  // Marked-content properties (e.g. /ActualText) inside the content of marked pages.
  for (const p of markedPages) {
    for (const op of pageContent(p).ops) {
      if (op.op !== 'BDC' && op.op !== 'DP') continue
      const props = op.args[1]
      if (props?.t !== 'dict') continue
      for (const v of Object.values(props.v)) if (v.t === 'str') for (const t of texts(v.v)) check(t, 'marked-content text on a page')
    }
  }
  return [...leaks.values()]
}
