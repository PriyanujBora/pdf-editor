/**
 * Output pages in order (export worker, Phase 6 "Pages"): pages of the opened file (a page used twice
 * is duplicated), blank pages, and pages of inserted PDFs. The opened file stays the document that is
 * edited in place (its forms, outlines, tags, metadata survive); inserted pages are copied in with:
 * - links: rewritten to page indices before copying (so pdf-lib's copier doesn't drag in every page
 *   a link points to), then to the copied pages — links to pages that weren't inserted are dropped;
 * - outline: the inserted file's bookmarks, under one bookmark named after the file;
 * - form fields: their top-level fields join the AcroForm; clashing names get " (2)", " (3)"…
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFString,
  type PDFObject,
} from '@cantoo/pdf-lib'
import type { PageItem } from '@/types'

const N = (n: string) => PDFName.of(n)
const nameKey = (o: PDFObject | undefined) =>
  o instanceof PDFName ? o.decodeText() : o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined

export interface Assembled {
  /** The page object for each output page (req.pages order). */
  pageOf: PDFPage[]
  /** Every page object (opened file's first); \`order\` indexes into it. */
  all: PDFPage[]
  order: number[]
  /** Pages of the opened file come first in \`all\`. */
  mainCount: number
}

/** Named destinations of a document → page ref. */
function namedDests(doc: PDFDocument): Map<string, PDFRef> {
  const ctx = doc.context
  const out = new Map<string, PDFRef>()
  const pageOfDest = (d: PDFObject | undefined): PDFRef | undefined => {
    const x = d instanceof PDFRef ? ctx.lookup(d) : d
    if (x instanceof PDFArray) return x.get(0) instanceof PDFRef ? (x.get(0) as PDFRef) : undefined
    if (x instanceof PDFDict) return pageOfDest(x.get(N('D')))
    return undefined
  }
  const old = ctx.lookupMaybe(doc.catalog.get(N('Dests')), PDFDict)
  if (old) for (const [k, v] of old.entries()) {
    const p = pageOfDest(v)
    if (p) out.set(k.decodeText(), p)
  }
  const walk = (node: PDFDict | undefined, depth = 0) => {
    if (!node || depth > 30) return
    const kids = ctx.lookupMaybe(node.get(N('Kids')), PDFArray)
    if (kids) for (let i = 0; i < kids.size(); i++) walk(ctx.lookupMaybe(kids.get(i), PDFDict), depth + 1)
    const names = ctx.lookupMaybe(node.get(N('Names')), PDFArray)
    if (names)
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const k = nameKey(names.get(i))
        const p = pageOfDest(names.get(i + 1))
        if (k !== undefined && p) out.set(k, p)
      }
  }
  walk(ctx.lookupMaybe(ctx.lookupMaybe(doc.catalog.get(N('Names')), PDFDict)?.get(N('Dests')), PDFDict))
  return out
}

/** Page index a destination (explicit, named, or a GoTo action) leads to, in `doc`. */
function destIndex(doc: PDFDocument, refIndex: Map<PDFRef, number>, names: Map<string, PDFRef>, d: PDFObject | undefined): number | undefined {
  const ctx = doc.context
  const x = d instanceof PDFRef ? ctx.lookup(d) : d
  if (x instanceof PDFArray) {
    const p = x.get(0)
    return p instanceof PDFRef ? refIndex.get(p) : p instanceof PDFNumber ? p.asNumber() : undefined
  }
  if (x instanceof PDFDict) return destIndex(doc, refIndex, names, x.get(N('D')))
  const k = nameKey(x)
  const r = k !== undefined ? names.get(k) : undefined
  return r ? refIndex.get(r) : undefined
}

/** Prepares an inserted document for copying pages out of it (mutates that copy only). */
function prepareInserted(src: PDFDocument) {
  const ctx = src.context
  const pages = src.getPages()
  const refIndex = new Map(pages.map((p, i) => [p.ref, i] as const))
  const names = namedDests(src)
  for (const p of pages) {
    const annots = p.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const a = ctx.lookupMaybe(annots.get(i), PDFDict)
      if (!a) continue
      // The page back-pointer and tags would pull other pages / the structure tree along.
      a.delete(N('P'))
      a.delete(N('StructParent'))
      if (a.get(N('Subtype')) !== N('Link')) continue
      const act = ctx.lookupMaybe(a.get(N('A')), PDFDict)
      const dest = a.get(N('Dest')) ?? (act && act.get(N('S')) === N('GoTo') ? act.get(N('D')) : undefined)
      if (dest === undefined) continue
      const idx = destIndex(src, refIndex, names, dest)
      a.delete(N('A'))
      // Page index as a number for now; mapped to the copied page afterwards (or the link dropped).
      a.set(N('Dest'), ctx.obj([idx ?? -1, N('XYZ'), PDFNull, PDFNull, PDFNull]))
    }
    p.node.delete(N('StructParents'))
  }
  return { refIndex, names }
}

/** A second copy of a page of the opened file, sharing its content streams (they're never edited in place). */
function duplicatePage(doc: PDFDocument, page: PDFPage): PDFPage {
  const ctx = doc.context
  const leaf = page.node.clone(ctx)
  leaf.delete(N('StructParents'))
  const ref = ctx.register(leaf)
  const annots = page.node.Annots()
  if (annots) {
    const out: PDFObject[] = []
    for (let i = 0; i < annots.size(); i++) {
      const a = ctx.lookupMaybe(annots.get(i), PDFDict)
      if (!a) continue
      // A widget that is its own field can't appear twice under one name; popups belong to their parent.
      if (a.get(N('Subtype')) === N('Popup') || (a.get(N('Subtype')) === N('Widget') && a.get(N('T')) !== undefined)) continue
      const c = a.clone(ctx)
      c.set(N('P'), ref)
      c.delete(N('StructParent'))
      c.delete(N('Popup'))
      const cref = ctx.register(c)
      out.push(cref)
      const parent = ctx.lookupMaybe(c.get(N('Parent')), PDFDict)
      parent?.lookupMaybe(N('Kids'), PDFArray)?.push(cref)
    }
    leaf.set(N('Annots'), ctx.obj(out))
  }
  return PDFPage.of(leaf, ref, doc)
}

export async function assemblePages(doc: PDFDocument, items: PageItem[], docs: Record<string, { bytes: Uint8Array; name: string }>): Promise<Assembled> {
  const ctx = doc.context
  const main = doc.getPages()
  const all: PDFPage[] = [...main]
  const pageOf: PDFPage[] = []
  const used = new Set<number>()
  const loaded = new Map<string, { src: PDFDocument; prep: ReturnType<typeof prepareInserted>; copied: Map<number, PDFPage>; every: PDFPage[] }>()
  for (const item of items) {
    let p: PDFPage
    if (item.blank) p = doc.addPage([item.blank.width, item.blank.height])
    else if (item.doc) {
      let l = loaded.get(item.doc)
      if (!l) {
        const src = await PDFDocument.load(docs[item.doc].bytes, { updateMetadata: false })
        l = { src, prep: prepareInserted(src), copied: new Map(), every: [] }
        loaded.set(item.doc, l)
      }
      const [c] = await doc.copyPages(l.src, [item.srcIndex])
      p = doc.addPage(c)
      if (!l.copied.has(item.srcIndex)) l.copied.set(item.srcIndex, p)
      l.every.push(p)
    } else if (used.has(item.srcIndex)) p = duplicatePage(doc, main[item.srcIndex])
    else {
      p = main[item.srcIndex]
      used.add(item.srcIndex)
    }
    if (!all.includes(p)) all.push(p)
    pageOf.push(p)
  }

  // Inserted files: links, bookmarks, form fields.
  const form = loaded.size ? ensureAcroForm(doc) : null
  const taken = new Set<string>()
  for (const f of ctx.lookupMaybe(form?.get(N('Fields')), PDFArray)?.asArray() ?? []) {
    const t = nameKey(ctx.lookupMaybe(f, PDFDict)?.get(N('T')))
    if (t !== undefined) taken.add(t)
  }
  for (const [id, l] of loaded) {
    const roots = new Set<PDFRef>()
    for (const p of l.every) {
      const annots = p.node.Annots()
      if (!annots) continue
      const keep: PDFObject[] = []
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i)
        const a = ctx.lookupMaybe(ref, PDFDict)
        if (!a) continue
        a.set(N('P'), p.ref)
        if (a.get(N('Subtype')) === N('Link') && a.get(N('Dest')) instanceof PDFArray) {
          const d = a.get(N('Dest')) as PDFArray
          const k = d.get(0) instanceof PDFNumber ? (d.get(0) as PDFNumber).asNumber() : -1
          const target = l.copied.get(k)
          if (!target) continue // the page it led to wasn't inserted
          d.set(0, target.ref)
        }
        if (a.get(N('Subtype')) === N('Widget')) {
          let r = ref instanceof PDFRef ? ref : undefined
          let cur: PDFDict | undefined = a
          for (let guard = 0; cur && guard < 30; guard++) {
            const parent = cur.get(N('Parent'))
            if (!(parent instanceof PDFRef)) break
            r = parent
            cur = ctx.lookupMaybe(parent, PDFDict)
          }
          if (r) roots.add(r)
        }
        keep.push(ref)
      }
      p.node.set(N('Annots'), ctx.obj(keep))
    }
    // Fields: unique top-level names.
    const fields = form!.lookup(N('Fields'), PDFArray)
    for (const r of roots) {
      const f = ctx.lookup(r, PDFDict)
      const base = nameKey(f.get(N('T'))) ?? 'field'
      let name = base
      for (let n = 2; taken.has(name); n++) name = `${base} (${n})`
      taken.add(name)
      if (name !== base) f.set(N('T'), PDFHexString.fromText(name))
      fields.push(r)
    }
    // Bookmarks of the inserted file, under one named after it.
    const srcOutline = l.src.context.lookupMaybe(l.src.catalog.get(N('Outlines')), PDFDict)
    const children = srcOutline ? copyOutline(l.src, srcOutline, l.prep, l.copied) : []
    const first = [...l.copied.values()][0]
    if (first) appendOutline(doc, docs[id].name.replace(/\.pdf$/i, ''), first, children)
  }
  return { pageOf, all, order: pageOf.map((p) => all.indexOf(p)), mainCount: main.length }
}

function ensureAcroForm(doc: PDFDocument): PDFDict {
  const ctx = doc.context
  let form = ctx.lookupMaybe(doc.catalog.get(N('AcroForm')), PDFDict)
  if (!form) {
    form = ctx.obj({ Fields: [] }) as PDFDict
    doc.catalog.set(N('AcroForm'), ctx.register(form))
  }
  if (!form.lookupMaybe(N('Fields'), PDFArray)) form.set(N('Fields'), ctx.obj([]))
  return form
}

interface OutlineItem {
  title: string
  page?: PDFPage
  children: OutlineItem[]
}

function copyOutline(src: PDFDocument, node: PDFDict, prep: ReturnType<typeof prepareInserted>, copied: Map<number, PDFPage>, depth = 0): OutlineItem[] {
  const ctx = src.context
  const out: OutlineItem[] = []
  let ref = node.get(N('First'))
  for (let guard = 0; ref && guard < 10000 && depth < 30; guard++) {
    const item = ctx.lookupMaybe(ref, PDFDict)
    if (!item) break
    const title = nameKey(item.lookup(N('Title'))) ?? ''
    const act = ctx.lookupMaybe(item.get(N('A')), PDFDict)
    const dest = item.get(N('Dest')) ?? (act && act.get(N('S')) === N('GoTo') ? act.get(N('D')) : undefined)
    const idx = dest !== undefined ? destIndex(src, prep.refIndex, prep.names, dest) : undefined
    const children = copyOutline(src, item, prep, copied, depth + 1)
    const page = idx !== undefined ? copied.get(idx) : undefined
    // Items leading to pages that weren't inserted stay only as headings of their children.
    if (page || children.length) out.push({ title, page, children })
    ref = item.get(N('Next'))
  }
  return out
}

/** Appends a top-level bookmark (with children) to the document's outline. */
function appendOutline(doc: PDFDocument, title: string, page: PDFPage, children: OutlineItem[]) {
  const ctx = doc.context
  let root = ctx.lookupMaybe(doc.catalog.get(N('Outlines')), PDFDict)
  let rootRef = doc.catalog.get(N('Outlines'))
  if (!root || !(rootRef instanceof PDFRef)) {
    root = ctx.obj({ Type: 'Outlines' }) as PDFDict
    rootRef = ctx.register(root)
    doc.catalog.set(N('Outlines'), rootRef)
  }
  const build = (parentRef: PDFRef, items: OutlineItem[]): PDFRef[] => {
    const refs = items.map(() => ctx.nextRef())
    items.forEach((it, i) => {
      const d = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parentRef }) as PDFDict
      if (it.page) d.set(N('Dest'), ctx.obj([it.page.ref, N('XYZ'), PDFNull, PDFNull, PDFNull]))
      if (i > 0) d.set(N('Prev'), refs[i - 1])
      if (i < refs.length - 1) d.set(N('Next'), refs[i + 1])
      const kids = build(refs[i], it.children)
      if (kids.length) {
        d.set(N('First'), kids[0])
        d.set(N('Last'), kids[kids.length - 1])
        d.set(N('Count'), PDFNumber.of(-kids.length)) // closed
      }
      ctx.assign(refs[i], d)
    })
    return refs
  }
  const top = ctx.nextRef()
  const kids = build(top, children)
  const item = ctx.obj({ Title: PDFHexString.fromText(title), Parent: rootRef, Dest: ctx.obj([page.ref, N('XYZ'), PDFNull, PDFNull, PDFNull]) }) as PDFDict
  if (kids.length) {
    item.set(N('First'), kids[0])
    item.set(N('Last'), kids[kids.length - 1])
    item.set(N('Count'), PDFNumber.of(-kids.length))
  }
  const last = root.get(N('Last'))
  if (last instanceof PDFRef) {
    ctx.lookup(last, PDFDict).set(N('Next'), top)
    item.set(N('Prev'), last)
  } else root.set(N('First'), top)
  root.set(N('Last'), top)
  ctx.assign(top, item)
  const cnt = root.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0
  root.set(N('Count'), PDFNumber.of(Math.abs(cnt) + 1))
}
