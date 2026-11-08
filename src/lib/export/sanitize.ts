/**
 * Document clean-up chosen in the Redact panel (export worker only). Each step removes a kind of
 * hidden information completely — the objects become unreachable and garbage collection drops them.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFStream,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from '@cantoo/pdf-lib'
import { decode, pageContent, tokenize, writeContent, type Splice } from '@/lib/content/remove-text'
import type { SanitizeOptions } from '@/types'
import { removeAnnotations } from './doc-structure'

const N = (n: string) => PDFName.of(n)

const COMMENTS = new Set(
  ['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound', 'Redact'].map(
    (s) => '/' + s,
  ),
)
const SCRIPT_ACTIONS = new Set(['/JavaScript', '/Launch', '/ImportData'])

/** Every dictionary in the document (indirect objects, their nested dicts, stream dicts). */
function* allDicts(doc: PDFDocument): Generator<PDFDict> {
  const seen = new Set<PDFObject>()
  const stack: PDFObject[] = []
  for (const [, o] of doc.context.enumerateIndirectObjects()) stack.push(o)
  while (stack.length) {
    const o = stack.pop()!
    if (seen.has(o)) continue
    seen.add(o)
    if (o instanceof PDFStream) stack.push(o.dict)
    else if (o instanceof PDFDict) {
      yield o
      for (const [, v] of o.entries()) if (v instanceof PDFDict || v instanceof PDFArray) stack.push(v)
    } else if (o instanceof PDFArray) for (const v of o.asArray()) if (v instanceof PDFDict || v instanceof PDFArray) stack.push(v)
  }
}

export interface SanitizeReport {
  /** Human-readable summary of what was removed. */
  removed: string[]
  /** What could not be cleaned (honest UI). */
  notes: string[]
}

export function sanitize(doc: PDFDocument, pages: PDFPage[], opts: SanitizeOptions): SanitizeReport {
  const ctx = doc.context
  const cat = doc.catalog
  const report: SanitizeReport = { removed: [], notes: [] }
  const dict = (o: PDFObject | undefined) => ctx.lookupMaybe(o, PDFDict)
  const names = dict(cat.get(N('Names')))
  const annotsOf = (p: PDFPage) => ctx.lookupMaybe(p.node.get(N('Annots')), PDFArray)?.asArray() ?? []

  if (opts.metadata) {
    let n = 0
    if (ctx.trailerInfo.Info) {
      ctx.trailerInfo.Info = undefined
      n++
    }
    for (const d of allDicts(doc))
      for (const k of ['Metadata', 'PieceInfo', 'SpiderInfo']) if (d.has(N(k))) {
        d.delete(N(k))
        n++
      }
    if (n) report.removed.push('document properties and metadata')
  }

  if (opts.javascript) {
    let n = 0
    if (names?.has(N('JavaScript'))) {
      names.delete(N('JavaScript'))
      n++
    }
    const isScript = (o: PDFObject | undefined) => {
      const a = dict(o)
      return !!a && (SCRIPT_ACTIONS.has(String(a.get(N('S')))) || a.has(N('JS')))
    }
    for (const d of allDicts(doc)) {
      if (d.has(N('AA'))) {
        d.delete(N('AA'))
        n++
      }
      for (const k of ['A', 'OpenAction']) if (isScript(d.get(N(k)))) {
        d.delete(N(k))
        n++
      }
      // Chained actions.
      const next = d.get(N('Next'))
      if (next && (isScript(next) || ctx.lookupMaybe(next, PDFArray))) {
        const arr = ctx.lookupMaybe(next, PDFArray)
        if (arr) {
          const keep = arr.asArray().filter((x) => !isScript(x))
          if (keep.length !== arr.size()) {
            d.set(N('Next'), ctx.obj(keep))
            n++
          }
        } else {
          d.delete(N('Next'))
          n++
        }
      }
    }
    const form = dict(cat.get(N('AcroForm')))
    if (form?.has(N('XFA'))) {
      form.delete(N('XFA'))
      n++
    }
    cat.delete(N('NeedsRendering'))
    if (n) report.removed.push('JavaScript and actions')
  }

  if (opts.attachments) {
    let n = 0
    if (names?.has(N('EmbeddedFiles'))) {
      names.delete(N('EmbeddedFiles'))
      n++
    }
    for (const k of ['AF', 'Collection']) if (cat.has(N(k))) {
      cat.delete(N(k))
      n++
    }
    for (const p of pages) if (p.node.has(N('AF'))) p.node.delete(N('AF'))
    const files = pages.flatMap((p) => annotsOf(p).filter((a) => dict(a)?.get(N('Subtype')) === N('FileAttachment')))
    n += removeAnnotations(doc, pages, files)
    if (n) report.removed.push('attachments')
  }

  if (opts.comments) {
    const marks = pages.flatMap((p) => annotsOf(p).filter((a) => COMMENTS.has(String(dict(a)?.get(N('Subtype'))))))
    if (removeAnnotations(doc, pages, marks)) report.removed.push('comments and markups')
  }

  if (opts.formValues) {
    const form = dict(cat.get(N('AcroForm')))
    let n = 0
    const walk = (f: PDFObject, ft: string | undefined, depth = 0) => {
      const d = dict(f)
      if (!d || depth > 50) return
      const type = d.get(N('FT')) ? String(d.get(N('FT'))) : ft
      const kids = ctx.lookupMaybe(d.get(N('Kids')), PDFArray)
      const widgets = kids ? kids.asArray().filter((k) => !dict(k)?.has(N('T'))) : [f]
      if (kids) for (const k of kids.asArray()) if (dict(k)?.has(N('T'))) walk(k, type, depth + 1)
      const flags = d.lookupMaybe(N('Ff'), PDFNumber)?.asNumber() ?? 0
      if (type === '/Btn') {
        if (flags & (1 << 16)) return // push button: no value
        if (d.get(N('V')) && d.get(N('V')) !== N('Off')) n++
        d.set(N('V'), N('Off'))
        for (const w of widgets) dict(w)?.set(N('AS'), N('Off'))
      } else if (type === '/Tx' || type === '/Ch' || type === '/Sig') {
        for (const k of ['V', 'RV', 'DV']) if (d.has(N(k))) {
          d.delete(N(k))
          n++
        }
        // The appearance shows the value: drop it, the viewer redraws the empty field.
        for (const w of widgets) dict(w)?.delete(N('AP'))
        if (type === '/Ch') d.delete(N('I'))
      }
    }
    for (const f of ctx.lookupMaybe(form?.get(N('Fields')), PDFArray)?.asArray() ?? []) walk(f, undefined)
    if (form) {
      form.set(N('NeedAppearances'), PDFBool.True)
      if (form.has(N('XFA'))) {
        form.delete(N('XFA'))
        n++
      }
    }
    if (n) report.removed.push('form field values')
  }

  if (opts.hiddenLayers) {
    const oc = dict(cat.get(N('OCProperties')))
    if (oc) {
      const d = dict(oc.get(N('D')))
      const on = new Set(ctx.lookupMaybe(d?.get(N('ON')), PDFArray)?.asArray() ?? [])
      const off = new Set(ctx.lookupMaybe(d?.get(N('OFF')), PDFArray)?.asArray() ?? [])
      const baseOff = d?.get(N('BaseState')) === N('OFF')
      const hiddenGroup = (g: PDFObject) => (baseOff ? !on.has(g) : off.has(g))
      let unknown = 0
      // An /OC entry (group or membership dict) → hidden by default?
      const hidden = (o: PDFObject | undefined, self?: PDFObject): boolean => {
        const x = dict(o)
        if (!x) return false
        if (x.get(N('Type')) === N('OCG')) return hiddenGroup(self ?? o!)
        if (x.get(N('Type')) === N('OCMD')) {
          if (x.has(N('VE'))) {
            unknown++
            return false
          }
          const g = x.get(N('OCGs'))
          const groups = ctx.lookupMaybe(g, PDFArray)?.asArray() ?? (g ? [g] : [])
          const vis = groups.map((q) => !hiddenGroup(q))
          const p = String(x.get(N('P')) ?? '/AnyOn')
          const v =
            p === '/AllOn' ? vis.every(Boolean) : p === '/AnyOff' ? vis.some((q) => !q) : p === '/AllOff' ? vis.every((q) => !q) : vis.some(Boolean)
          return groups.length > 0 && !v
        }
        return false
      }
      let n = 0
      let inForms = false
      pages.forEach((page) => {
        // Annotations in hidden layers.
        const dead = annotsOf(page).filter((a) => hidden(dict(a)?.get(N('OC'))))
        n += removeAnnotations(doc, pages, dead)
        // Page content: /OC marked sequences and XObjects in hidden layers.
        const { bytes, ops } = pageContent(page)
        const res = page.node.Resources()
        const props = res?.lookupMaybe(N('Properties'), PDFDict)
        const xobjects = res?.lookupMaybe(N('XObject'), PDFDict)
        const splices: Splice[] = []
        const stack: { op: number; hide: boolean }[] = []
        let hideFrom = -1
        ops.forEach((o, oi) => {
          if (o.op === 'BDC' || o.op === 'BMC') {
            let hide = false
            const [tag, p] = o.args
            if (o.op === 'BDC' && tag?.t === 'name' && tag.v === 'OC') {
              const ref = p?.t === 'name' ? props?.get(N(p.v)) : undefined
              hide = !!ref && hidden(ref, ref)
            }
            stack.push({ op: oi, hide })
            if (hide && hideFrom < 0) hideFrom = oi
          } else if (o.op === 'EMC') {
            const top = stack.pop()
            if (top && top.op === hideFrom) {
              splices.push({ start: ops[hideFrom].start, end: o.end, data: new Uint8Array() })
              hideFrom = -1
            }
          } else if (o.op === 'Do' && hideFrom < 0 && o.args[0]?.t === 'name') {
            const xo = xobjects?.lookup(N(o.args[0].v))
            if (xo instanceof PDFStream && hidden(xo.dict.get(N('OC')))) splices.push({ start: o.start, end: o.end, data: new Uint8Array() })
            else if (xo instanceof PDFStream && xo.dict.get(N('Subtype')) === N('Form') && !inForms) {
              // Layers marked inside a form's own content aren't removed (yet): say so.
              const fprops = xo.dict.lookupMaybe(N('Resources'), PDFDict)?.lookupMaybe(N('Properties'), PDFDict)
              try {
                inForms = tokenize(decode(xo)).some((q) => q.op === 'BDC' && q.args[1]?.t === 'name' && hidden(fprops?.get(N(q.args[1].v)), fprops?.get(N(q.args[1].v))))
              } catch {
                /* undecodable form */
              }
            }
          }
        })
        if (splices.length) {
          writeContent(page, bytes, ops, [], new Set(), new Map(), splices)
          n += splices.length
        }
      })
      cat.delete(N('OCProperties'))
      if (n) report.removed.push('hidden layers')
      if (unknown) report.notes.push('Some layers use visibility expressions that can’t be evaluated; their content was kept.')
      if (inForms) report.notes.push('Some hidden-layer content inside reusable page parts (form XObjects) couldn’t be removed.')
    }
  }
  return report
}
