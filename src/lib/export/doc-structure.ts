/**
 * Editing the loaded document in place (instead of copying pages into a new one), so everything at
 * document level survives an export: forms, outlines, named destinations, page labels, the structure
 * tree, metadata, attachments, viewer preferences. Worker-only.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from '@cantoo/pdf-lib'

const N = (n: string) => PDFName.of(n)
const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate']

/**
 * One flat /Pages node with the leaves in output order. Inheritable attributes are pushed onto the
 * leaves first. Never use pdf-lib's removePage(): it deletes the page object itself.
 */
export function rebuildPageTree(doc: PDFDocument, pages: PDFPage[], order: number[]) {
  const ctx = doc.context
  const rootRef = doc.catalog.get(N('Pages'))
  const root = doc.catalog.lookup(N('Pages'), PDFDict)
  for (const i of order) {
    const leaf = pages[i].node
    for (const name of INHERITABLE) {
      if (leaf.get(N(name)) !== undefined) continue
      const v = leaf.getInheritableAttribute(N(name))
      if (v !== undefined) leaf.set(N(name), v)
    }
  }
  const kids = ctx.obj([]) as PDFArray
  for (const i of order) {
    pages[i].node.set(N('Parent'), rootRef as PDFRef)
    kids.push(pages[i].ref)
  }
  root.set(N('Kids'), kids)
  root.set(N('Count'), PDFNumber.of(order.length))
  for (const name of [...INHERITABLE, 'Parent']) root.delete(N(name))
}

/**
 * Pages often share one /Resources dictionary (or inherit it). Before drawing on a page, give it its
 * own copy — with its own Font/XObject/ExtGState maps — so additions never leak onto other pages.
 */
export function privateResources(doc: PDFDocument, page: PDFPage) {
  const ctx = doc.context
  const leaf = page.node
  const res = ctx.lookupMaybe(leaf.getInheritableAttribute(N('Resources')), PDFDict)
  const copy = res ? res.clone(ctx) : (ctx.obj({}) as PDFDict)
  for (const sub of ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties']) {
    const d = copy.lookupMaybe(N(sub), PDFDict)
    if (d) copy.set(N(sub), d.clone(ctx))
  }
  leaf.set(N('Resources'), copy)
}

// --- References to deleted pages ------------------------------------------------------

const asRef = (o: PDFObject | undefined) => (o instanceof PDFRef ? o : undefined)
const nameKey = (o: PDFObject | undefined) =>
  o instanceof PDFName ? o.decodeText() : o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined

interface Ctx {
  ctx: PDFContext
  gone: Set<PDFRef>
  named: Map<string, PDFRef | undefined>
}

/** Page a destination points to (explicit array, or a named destination). */
function destPage(c: Ctx, dest: PDFObject | undefined): PDFRef | undefined {
  const d = dest instanceof PDFRef ? c.ctx.lookup(dest) : dest
  if (d instanceof PDFArray) return asRef(d.get(0))
  if (d instanceof PDFDict) return destPage(c, d.get(N('D')))
  const key = nameKey(d)
  return key !== undefined ? c.named.get(key) : undefined
}

/** Page targeted by a GoTo action or a /Dest entry of a dict (outline item, link). */
function targetOf(c: Ctx, item: PDFDict): PDFRef | undefined {
  const dest = item.get(N('Dest'))
  if (dest) return destPage(c, dest)
  const a = c.ctx.lookupMaybe(item.get(N('A')), PDFDict)
  if (a && a.get(N('S')) === N('GoTo')) return destPage(c, a.get(N('D')))
  return undefined
}

/** Walks a name or number tree's leaves; `keep` decides per [key, value] pair. Fixes /Limits. */
function filterTree(c: Ctx, node: PDFDict | undefined, leafKey: 'Names' | 'Nums', keep: (k: PDFObject, v: PDFObject) => boolean) {
  if (!node) return
  const kids = c.ctx.lookupMaybe(node.get(N('Kids')), PDFArray)
  if (kids) for (let i = 0; i < kids.size(); i++) filterTree(c, c.ctx.lookupMaybe(kids.get(i), PDFDict), leafKey, keep)
  const arr = c.ctx.lookupMaybe(node.get(N(leafKey)), PDFArray)
  if (!arr) return
  const out: PDFObject[] = []
  for (let i = 0; i + 1 < arr.size(); i += 2) if (keep(arr.get(i), arr.get(i + 1))) out.push(arr.get(i), arr.get(i + 1))
  node.set(N(leafKey), c.ctx.obj(out))
  if (node.get(N('Limits')) && out.length) node.set(N('Limits'), c.ctx.obj([out[0], out[out.length - 2]]))
}

function collectNamed(c: Ctx, catalog: PDFDict) {
  const old = c.ctx.lookupMaybe(catalog.get(N('Dests')), PDFDict)
  if (old) for (const [k, v] of old.entries()) c.named.set(k.decodeText(), destPage({ ...c, named: new Map() }, v))
  const names = c.ctx.lookupMaybe(catalog.get(N('Names')), PDFDict)
  filterTree(c, c.ctx.lookupMaybe(names?.get(N('Dests')), PDFDict), 'Names', (k, v) => {
    const key = nameKey(k)
    if (key !== undefined) c.named.set(key, destPage({ ...c, named: new Map() }, v))
    return true
  })
}

/** Outline items pointing at deleted pages: dropped, or kept as plain headings if they have children. */
function pruneOutline(c: Ctx, parent: PDFDict): number {
  let ref = parent.get(N('First'))
  const kept: PDFRef[] = []
  while (ref instanceof PDFRef) {
    const item = c.ctx.lookup(ref, PDFDict)
    const next = item.get(N('Next'))
    const visible = item.get(N('First')) ? pruneOutline(c, item) : 0
    const t = targetOf(c, item)
    if (t && c.gone.has(t)) {
      if (item.get(N('First'))) {
        item.delete(N('Dest'))
        item.delete(N('A'))
        kept.push(ref)
      }
    } else kept.push(ref)
    if (item.get(N('Count')) && visible === 0 && !item.get(N('First'))) item.delete(N('Count'))
    ref = next
  }
  if (!kept.length) {
    parent.delete(N('First'))
    parent.delete(N('Last'))
  } else {
    parent.set(N('First'), kept[0])
    parent.set(N('Last'), kept[kept.length - 1])
  }
  kept.forEach((r, i) => {
    const item = c.ctx.lookup(r, PDFDict)
    if (i > 0) item.set(N('Prev'), kept[i - 1])
    else item.delete(N('Prev'))
    if (i < kept.length - 1) item.set(N('Next'), kept[i + 1])
    else item.delete(N('Next'))
  })
  // Count: visible descendants (sign = open/closed).
  let visible = 0
  for (const r of kept) {
    visible += 1
    const item = c.ctx.lookup(r, PDFDict)
    const cnt = item.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0
    if (cnt > 0) visible += cnt
  }
  const own = parent.lookupMaybe(N('Count'), PDFNumber)?.asNumber()
  if (own !== undefined || parent.get(N('Type')) === N('Outlines')) parent.set(N('Count'), PDFNumber.of(own !== undefined && own < 0 ? -visible : visible))
  return visible
}

/** Structure elements (tags) whose content was on deleted pages. Returns whether `node` keeps content. */
function pruneStruct(c: Ctx, node: PDFDict, page: PDFRef | undefined): boolean {
  const pg = asRef(node.get(N('Pg'))) ?? page
  const k = node.get(N('K'))
  if (k === undefined) return !(pg && c.gone.has(pg))
  const kids = k instanceof PDFArray ? k.asArray() : [k]
  const out: PDFObject[] = []
  for (const kid of kids) {
    if (kid instanceof PDFNumber) {
      if (!(pg && c.gone.has(pg))) out.push(kid)
      continue
    }
    const d = c.ctx.lookupMaybe(kid, PDFDict)
    if (!d) continue
    const type = d.get(N('Type'))
    if (type === N('MCR')) {
      const p = asRef(d.get(N('Pg'))) ?? pg
      if (!(p && c.gone.has(p))) out.push(kid)
    } else if (type === N('OBJR')) {
      const p = asRef(d.get(N('Pg'))) ?? pg
      if (!(p && c.gone.has(p))) out.push(kid)
    } else if (pruneStruct(c, d, pg)) out.push(kid)
  }
  if (out.length === kids.length) return true
  if (!out.length) {
    node.delete(N('K'))
    return false
  }
  node.set(N('K'), out.length === 1 && !(k instanceof PDFArray) ? out[0] : c.ctx.obj(out))
  return true
}

/** Form fields whose widgets were all on deleted pages. Returns whether the field survives. */
function pruneField(c: Ctx, field: PDFDict, deadAnnots: Set<PDFRef>, self?: PDFRef): boolean {
  const kids = c.ctx.lookupMaybe(field.get(N('Kids')), PDFArray)
  if (kids) {
    const out: PDFObject[] = []
    for (let i = 0; i < kids.size(); i++) {
      const r = asRef(kids.get(i))
      const d = c.ctx.lookupMaybe(kids.get(i), PDFDict)
      if (d && pruneField(c, d, deadAnnots, r)) out.push(kids.get(i))
    }
    field.set(N('Kids'), c.ctx.obj(out))
    return out.length > 0
  }
  // A terminal field that is its own widget.
  const p = asRef(field.get(N('P')))
  return !((self && deadAnnots.has(self)) || (p && c.gone.has(p)))
}

/** Page labels: every surviving page keeps the label it had; added pages are numbered by position. */
function relabel(c: Ctx, catalog: PDFDict, order: number[], mainCount = Infinity) {
  const labels = c.ctx.lookupMaybe(catalog.get(N('PageLabels')), PDFDict)
  if (!labels) return
  const ranges: { start: number; dict: PDFDict }[] = []
  filterTree(c, labels, 'Nums', (k, v) => {
    const d = c.ctx.lookupMaybe(v, PDFDict)
    if (k instanceof PDFNumber && d) ranges.push({ start: k.asNumber(), dict: d })
    return true
  })
  ranges.sort((a, b) => a.start - b.start)
  const rangeOf = (i: number) => {
    let r = ranges[0]
    for (const x of ranges) if (x.start <= i) r = x
    return r
  }
  const nums: PDFObject[] = []
  let prev: { r: (typeof ranges)[number]; i: number } | null = null
  const ADDED = { start: -1, dict: c.ctx.obj({}) as PDFDict }
  order.forEach((src, j) => {
    if (src >= mainCount) {
      if (!(prev && prev.r === ADDED && src === prev.i + 1)) nums.push(PDFNumber.of(j), c.ctx.obj({ S: 'D', St: j + 1 }))
      prev = { r: ADDED, i: src }
      return
    }
    const r = rangeOf(src)
    if (!r) return
    if (prev && prev.r === r && src === prev.i + 1) {
      prev = { r, i: src }
      return
    }
    const st = (r.dict.lookupMaybe(N('St'), PDFNumber)?.asNumber() ?? 1) + (src - r.start)
    const d = c.ctx.obj({}) as PDFDict
    const s = r.dict.get(N('S'))
    const pfx = r.dict.get(N('P'))
    if (s) d.set(N('S'), s)
    if (pfx) d.set(N('P'), pfx)
    if (st !== 1) d.set(N('St'), PDFNumber.of(st))
    nums.push(PDFNumber.of(j), d)
    prev = { r, i: src }
  })
  catalog.set(N('PageLabels'), c.ctx.obj({ Nums: c.ctx.obj(nums) }))
}

/**
 * Removes every reference to deleted pages, so they really leave the file (garbage collection only
 * drops what nothing points to): outline items, named destinations, links, tags, form fields,
 * the open action; page labels are rewritten for the new order.
 */
export function pruneDeletedPages(doc: PDFDocument, pages: PDFPage[], order: number[], mainCount = pages.length) {
  const ctx = doc.context
  const keepSet = new Set(order)
  const gone = new Set(pages.filter((_, i) => !keepSet.has(i)).map((p) => p.ref))
  const c: Ctx = { ctx, gone, named: new Map() }
  const catalog = doc.catalog
  collectNamed(c, catalog)
  relabel(c, catalog, order, mainCount)
  if (!gone.size) return

  const outlines = ctx.lookupMaybe(catalog.get(N('Outlines')), PDFDict)
  if (outlines) pruneOutline(c, outlines)

  // Named destinations to deleted pages.
  const deadName = (k: PDFObject) => {
    const key = nameKey(k)
    const p = key !== undefined ? c.named.get(key) : undefined
    return !!p && gone.has(p)
  }
  const oldDests = ctx.lookupMaybe(catalog.get(N('Dests')), PDFDict)
  if (oldDests) for (const k of oldDests.keys()) if (deadName(k)) oldDests.delete(k)
  const names = ctx.lookupMaybe(catalog.get(N('Names')), PDFDict)
  filterTree(c, ctx.lookupMaybe(names?.get(N('Dests')), PDFDict), 'Names', (k) => !deadName(k))

  // Annotations on deleted pages, and links on surviving pages that lead to them.
  const deadAnnots = new Set<PDFRef>()
  for (const p of pages) {
    const annots = ctx.lookupMaybe(p.node.get(N('Annots')), PDFArray)
    if (!annots) continue
    if (gone.has(p.ref)) {
      for (const a of annots.asArray()) if (a instanceof PDFRef) deadAnnots.add(a)
      continue
    }
    const out = annots.asArray().filter((a) => {
      const d = ctx.lookupMaybe(a, PDFDict)
      if (!d) return true
      const t = targetOf(c, d)
      return !(t && gone.has(t))
    })
    if (out.length !== annots.size()) p.node.set(N('Annots'), ctx.obj(out))
  }

  // Form fields.
  const form = ctx.lookupMaybe(catalog.get(N('AcroForm')), PDFDict)
  const fields = ctx.lookupMaybe(form?.get(N('Fields')), PDFArray)
  if (form && fields) {
    const out: PDFObject[] = []
    for (const f of fields.asArray()) {
      const d = ctx.lookupMaybe(f, PDFDict)
      if (d && pruneField(c, d, deadAnnots, asRef(f))) out.push(f)
    }
    form.set(N('Fields'), ctx.obj(out))
  }

  // Structure tree + ParentTree entries of deleted pages.
  const tree = ctx.lookupMaybe(catalog.get(N('StructTreeRoot')), PDFDict)
  if (tree) {
    pruneStruct(c, tree, undefined)
    const deadKeys = new Set<number>()
    for (const p of pages) {
      if (!gone.has(p.ref)) continue
      const sp = p.node.lookupMaybe(N('StructParents'), PDFNumber)
      if (sp) deadKeys.add(sp.asNumber())
    }
    for (const a of deadAnnots) {
      const sp = ctx.lookupMaybe(a, PDFDict)?.lookupMaybe(N('StructParent'), PDFNumber)
      if (sp) deadKeys.add(sp.asNumber())
    }
    filterTree(c, ctx.lookupMaybe(tree.get(N('ParentTree')), PDFDict), 'Nums', (k) => !(k instanceof PDFNumber && deadKeys.has(k.asNumber())))
  }

  // Open action.
  const open = catalog.get(N('OpenAction'))
  const openD = open instanceof PDFArray ? asRef(open.get(0)) : open ? targetOf(c, ctx.lookupMaybe(open, PDFDict) ?? (ctx.obj({}) as PDFDict)) : undefined
  if (openD && gone.has(openD)) catalog.delete(N('OpenAction'))
}

/** Structure elements: drop OBJR kids that point at removed annotations. */
function pruneObjr(ctx: PDFContext, node: PDFDict, dead: Set<PDFObject>, depth = 0) {
  if (depth > 200) return
  const k = node.get(N('K'))
  if (k === undefined) return
  const kids = k instanceof PDFArray ? k.asArray() : [k]
  const out = kids.filter((kid) => {
    const d = ctx.lookupMaybe(kid, PDFDict)
    if (!d) return true
    if (d.get(N('Type')) === N('OBJR')) return !dead.has(d.get(N('Obj')) as PDFObject)
    pruneObjr(ctx, d, dead, depth + 1)
    return true
  })
  if (out.length === kids.length) return
  if (!out.length) node.delete(N('K'))
  else node.set(N('K'), out.length === 1 && !(k instanceof PDFArray) ? out[0] : ctx.obj(out))
}

/**
 * Removes annotations everywhere they are referenced: page /Annots, their popups, the form fields they
 * belong to (a removed widget takes its whole field with it, every widget, so the value goes too), the
 * structure tree. Returns how many annotations were removed.
 */
export function removeAnnotations(doc: PDFDocument, pages: PDFPage[], targets: PDFObject[]): number {
  const ctx = doc.context
  const dead = new Set<PDFObject>(targets)
  if (!dead.size) return 0
  const dict = (o: PDFObject | undefined) => ctx.lookupMaybe(o, PDFDict)
  // Widgets → their terminal field; the field and all its widgets go.
  const form = dict(doc.catalog.get(N('AcroForm')))
  const deadFields = new Set<PDFObject>()
  const widgetsOf = (f: PDFObject, out: PDFObject[] = []) => {
    const d = dict(f)
    const kids = d && ctx.lookupMaybe(d.get(N('Kids')), PDFArray)
    if (kids) for (const kid of kids.asArray()) widgetsOf(kid, out)
    else out.push(f)
    return out
  }
  for (const t of [...dead]) {
    const d = dict(t)
    if (!d || d.get(N('Subtype')) !== N('Widget')) continue
    const field = d.get(N('T')) !== undefined || d.get(N('FT')) !== undefined ? t : d.get(N('Parent'))
    if (!field) continue
    deadFields.add(field)
    for (const w of widgetsOf(field)) dead.add(w)
  }
  // Popups of removed annotations, and annotations whose popup parent is removed.
  for (const p of pages) {
    const annots = ctx.lookupMaybe(p.node.get(N('Annots')), PDFArray)
    if (!annots) continue
    for (const a of annots.asArray()) {
      const d = dict(a)
      if (!d) continue
      if (dead.has(a) && d.get(N('Popup'))) dead.add(d.get(N('Popup')) as PDFObject)
      if (d.get(N('Subtype')) === N('Popup') && dead.has(d.get(N('Parent')) as PDFObject)) dead.add(a)
    }
  }
  let removed = 0
  for (const p of pages) {
    const annots = ctx.lookupMaybe(p.node.get(N('Annots')), PDFArray)
    if (!annots) continue
    const out = annots.asArray().filter((a) => !dead.has(a))
    removed += annots.size() - out.length
    if (out.length !== annots.size()) p.node.set(N('Annots'), ctx.obj(out))
  }
  if (form) {
    const prune = (arr: PDFArray | undefined): PDFObject[] | undefined => {
      if (!arr) return undefined
      const out: PDFObject[] = []
      for (const f of arr.asArray()) {
        if (deadFields.has(f) || dead.has(f)) continue
        const d = dict(f)
        const kids = d && ctx.lookupMaybe(d.get(N('Kids')), PDFArray)
        if (kids) {
          const k = prune(kids)!
          if (!k.length) continue
          d.set(N('Kids'), ctx.obj(k))
        }
        out.push(f)
      }
      return out
    }
    const fields = prune(ctx.lookupMaybe(form.get(N('Fields')), PDFArray))
    if (fields) form.set(N('Fields'), ctx.obj(fields))
  }
  const tree = dict(doc.catalog.get(N('StructTreeRoot')))
  if (tree) {
    pruneObjr(ctx, tree, dead)
    const deadKeys = new Set<number>()
    for (const a of dead) {
      const sp = dict(a)?.lookupMaybe(N('StructParent'), PDFNumber)
      if (sp) deadKeys.add(sp.asNumber())
    }
    const c: Ctx = { ctx, gone: new Set(), named: new Map() }
    filterTree(c, dict(tree.get(N('ParentTree'))), 'Nums', (k) => !(k instanceof PDFNumber && deadKeys.has(k.asNumber())))
  }
  return removed
}

/** Mark-and-sweep: pdf-lib writes every object it holds, reachable or not. */
export function collectGarbage(ctx: PDFContext): number {
  const seen = new Set<PDFRef>()
  const stack: PDFObject[] = []
  const t = ctx.trailerInfo
  for (const v of [t.Root, t.Info, t.Encrypt, t.ID]) if (v) stack.push(v as PDFObject)
  while (stack.length) {
    const o = stack.pop()
    if (o instanceof PDFRef) {
      if (seen.has(o)) continue
      seen.add(o)
      const x = ctx.lookup(o)
      if (x) stack.push(x)
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v)
    else if (o instanceof PDFArray) for (const v of o.asArray()) stack.push(v)
    else if (o instanceof PDFStream) stack.push(o.dict)
  }
  let removed = 0
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref)) {
      ctx.delete(ref)
      removed++
    }
  }
  return removed
}

/** Source pages that still have /Annots etc. pointing to `refs` (for tests / sanity checks). */
export function referencesTo(ctx: PDFContext, refs: Set<PDFRef>): number {
  let n = 0
  const visit = (o: PDFObject | undefined, depth: number) => {
    if (!o || depth > 6) return
    if (o instanceof PDFRef) {
      if (refs.has(o)) n++
      return
    }
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) if (k !== N('Parent')) visit(v, depth + 1)
    }
    else if (o instanceof PDFArray) for (const v of o.asArray()) visit(v, depth + 1)
    else if (o instanceof PDFStream) visit(o.dict, depth + 1)
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) if (!refs.has(ref)) visit(obj, 0)
  return n
}
