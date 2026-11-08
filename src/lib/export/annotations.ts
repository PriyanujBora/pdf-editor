/**
 * Writes the user's annotations as standard PDF annotations (export worker, Phase 6): Highlight,
 * Underline, StrikeOut (with QuadPoints), Text (sticky note), Ink, Square and Line with an arrow
 * head — each with an appearance stream, so PDFium, pdf.js, Preview and Acrobat draw them the same,
 * and other apps can still edit, reply to or delete them.
 */
import { PDFHexString, PDFName, PDFNumber, PDFString, type PDFObject, type PDFPage } from '@cantoo/pdf-lib'
import type { AnnotElement } from '@/types'
import { apply, type Mat } from './matrix'

const N = (n: string) => PDFName.of(n)
const f = (v: number) => (Math.abs(v) < 1e-6 ? '0' : (+v.toFixed(3)).toString())

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const pdfDate = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

export function addAnnotation(page: PDFPage, toPdf: Mat, el: AnnotElement) {
  const ctx = page.doc.context
  // Element geometry (relative to its box) → PDF user space.
  const P = (x: number, y: number) => apply(toPdf, el.x + x, el.y + y)
  const [r, g, b] = rgb(el.color)
  const sw = el.strokeWidth ?? 2
  const ops: string[] = []
  const pts: { x: number; y: number }[] = []
  const extra: Record<string, unknown> = {}
  let subtype = ''
  let resources: Record<string, PDFObject> | undefined
  const quad = (q: { x: number; y: number; width: number; height: number }) => {
    // Upper-left, upper-right, lower-left, lower-right as read (QuadPoints order Acrobat uses).
    const c = [P(q.x, q.y), P(q.x + q.width, q.y), P(q.x, q.y + q.height), P(q.x + q.width, q.y + q.height)]
    pts.push(...c)
    return c
  }
  switch (el.type) {
    case 'highlight': {
      subtype = 'Highlight'
      resources = { ExtGState: ctx.obj({ GS0: ctx.obj({ BM: 'Multiply', ca: 0.45, CA: 0.45 }) }) }
      ops.push('/GS0 gs', `${f(r)} ${f(g)} ${f(b)} rg`)
      const qp: number[] = []
      for (const q of el.quads ?? []) {
        const [ul, ur, ll, lr] = quad(q)
        qp.push(ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y)
        ops.push(`${f(ul.x)} ${f(ul.y)} m ${f(ur.x)} ${f(ur.y)} l ${f(lr.x)} ${f(lr.y)} l ${f(ll.x)} ${f(ll.y)} l h f`)
      }
      extra.QuadPoints = qp
      break
    }
    case 'underline':
    case 'strike': {
      subtype = el.type === 'underline' ? 'Underline' : 'StrikeOut'
      ops.push(`${f(r)} ${f(g)} ${f(b)} RG`)
      const qp: number[] = []
      for (const q of el.quads ?? []) {
        const [ul, ur, ll, lr] = quad(q)
        qp.push(ul.x, ul.y, ur.x, ur.y, ll.x, ll.y, lr.x, lr.y)
        const t = el.type === 'underline' ? 0.9 : 0.55
        const a = P(q.x, q.y + q.height * t)
        const z = P(q.x + q.width, q.y + q.height * t)
        ops.push(`${f(Math.max(0.8, q.height * 0.07))} w ${f(a.x)} ${f(a.y)} m ${f(z.x)} ${f(z.y)} l S`)
      }
      extra.QuadPoints = qp
      break
    }
    case 'note': {
      subtype = 'Text'
      const c = [P(0, 0), P(el.width, 0), P(el.width, el.height), P(0, el.height)]
      pts.push(...c)
      ops.push(`${f(r)} ${f(g)} ${f(b)} rg 0.35 G 0.6 w`, `${c.map((p, i) => `${f(p.x)} ${f(p.y)} ${i ? 'l' : 'm'}`).join(' ')} h B`, '0.3 G 1 w')
      for (const t of [0.3, 0.5, 0.7]) {
        const a = P(el.width * 0.22, el.height * t)
        const z = P(el.width * 0.78, el.height * t)
        ops.push(`${f(a.x)} ${f(a.y)} m ${f(z.x)} ${f(z.y)} l S`)
      }
      extra.Name = N('Comment')
      extra.Open = false
      break
    }
    case 'ink': {
      subtype = 'Ink'
      ops.push(`${f(r)} ${f(g)} ${f(b)} RG ${f(sw)} w 1 J 1 j`)
      const list: number[][] = []
      for (const s of el.points ?? []) {
        const abs: number[] = []
        for (let i = 0; i + 1 < s.length; i += 2) {
          const p = P(s[i], s[i + 1])
          abs.push(p.x, p.y)
          pts.push(p)
        }
        list.push(abs)
        ops.push(abs.map((v, i) => (i % 2 ? `${f(v)} ${i === 1 ? 'm' : 'l'}` : f(v))).join(' ') + ' S')
      }
      extra.InkList = list
      extra.BS = ctx.obj({ W: sw })
      break
    }
    case 'rect': {
      subtype = 'Square'
      const c = [P(sw / 2, sw / 2), P(el.width - sw / 2, sw / 2), P(el.width - sw / 2, el.height - sw / 2), P(sw / 2, el.height - sw / 2)]
      pts.push(P(0, 0), P(el.width, el.height), P(el.width, 0), P(0, el.height))
      ops.push(`${f(r)} ${f(g)} ${f(b)} RG ${f(sw)} w`, `${c.map((p, i) => `${f(p.x)} ${f(p.y)} ${i ? 'l' : 'm'}`).join(' ')} h S`)
      extra.BS = ctx.obj({ W: sw })
      break
    }
    case 'arrow': {
      subtype = 'Line'
      const [x0, y0, x1, y1] = el.points?.[0] ?? [0, 0, 0, 0]
      const a = P(x0, y0)
      const z = P(x1, y1)
      // Arrow head in user space.
      const len = sw * 4 + 4
      const ang = Math.atan2(z.y - a.y, z.x - a.x)
      const h1 = { x: z.x - len * Math.cos(ang - 0.45), y: z.y - len * Math.sin(ang - 0.45) }
      const h2 = { x: z.x - len * Math.cos(ang + 0.45), y: z.y - len * Math.sin(ang + 0.45) }
      pts.push(a, z, h1, h2)
      ops.push(
        `${f(r)} ${f(g)} ${f(b)} RG ${f(r)} ${f(g)} ${f(b)} rg ${f(sw)} w 1 J 1 j`,
        `${f(a.x)} ${f(a.y)} m ${f(z.x)} ${f(z.y)} l S`,
        `${f(z.x)} ${f(z.y)} m ${f(h1.x)} ${f(h1.y)} l ${f(h2.x)} ${f(h2.y)} l h f`,
      )
      extra.L = [a.x, a.y, z.x, z.y]
      extra.LE = [N('None'), N('ClosedArrow')]
      extra.IC = [r, g, b]
      extra.BS = ctx.obj({ W: sw })
      break
    }
  }
  if (!pts.length) return
  const pad = el.type === 'ink' || el.type === 'rect' || el.type === 'arrow' ? sw : 0.5
  const rect = [Math.min(...pts.map((p) => p.x)) - pad, Math.min(...pts.map((p) => p.y)) - pad, Math.max(...pts.map((p) => p.x)) + pad, Math.max(...pts.map((p) => p.y)) + pad]
  // Appearance: drawn in user-space coordinates, BBox = Rect and an identity matrix map it 1:1.
  const ap = ctx.register(
    ctx.flateStream(ops.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: rect, ...(resources ? { Resources: ctx.obj(resources) } : {}) }),
  )
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: rect,
    C: [r, g, b],
    F: el.type === 'note' ? 28 : 4,
    P: page.ref,
    M: PDFString.of(pdfDate()),
    CreationDate: PDFString.of(pdfDate()),
    NM: PDFString.of(el.id),
    AP: ctx.obj({ N: ap }),
    ...extra,
  })
  if (el.note) dict.set(N('Contents'), PDFHexString.fromText(el.note))
  if (el.type === 'highlight' || el.type === 'underline' || el.type === 'strike') dict.set(N('CA'), PDFNumber.of(1))
  page.node.addAnnot(ctx.register(dict))
}
