/**
 * Removes printed glyphs from a page's content stream — really removes them, so copying, searching
 * and text extraction no longer find the old text (Phase 3; the spike is in PLAN.md §6).
 *
 * - The content is tokenized keeping every operator's byte span; only the text-showing operators that
 *   draw removed glyphs are rewritten, everything else is spliced back byte for byte (inline images,
 *   comments and odd syntax survive).
 * - Text state and CTM are tracked like a viewer does, so each glyph's page-space origin is known and
 *   can be matched against the glyphs the editor captured from pdf.js.
 * - A removed glyph becomes a TJ adjustment equal to its advance, so every following glyph keeps its
 *   exact position: n = −(w0·1000 + (Tc + Tw')·1000/Tfs) (TJ numbers skip Tc/Tw, so those are folded in).
 * - Form XObjects drawn by the page are interpreted too; one that needs editing is cloned for this page
 *   (others may share it) under a new resource name.
 * - Marked-content /ActualText, /Alt, /E around removed glyphs is dropped (it would still "contain" the
 *   old words for extractors).
 * - Not removable (the caller keeps a patch and warns): text used as a clip (Tr ≥ 4), vertical writing,
 *   CMaps other than Identity, fonts without widths, nested forms, font size 0.
 * Worker-only.
 */
import {
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFPage,
} from '@cantoo/pdf-lib'
import { Encodings, Font, FontNames } from '@cantoo/pdf-lib/standard-fonts'

const N = (n: string) => PDFName.of(n)
type M = [number, number, number, number, number, number]
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]

// --- Tokenizer that keeps byte spans ----------------------------------------------------

type Operand =
  | { t: 'num'; v: number; raw: string }
  | { t: 'name'; v: string }
  | { t: 'str'; v: Uint8Array }
  | { t: 'arr'; v: Operand[] }
  | { t: 'dict'; v: Record<string, Operand> }
  | { t: 'kw'; v: string }

interface Op {
  op: string
  args: Operand[]
  start: number
  end: number
}

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37])

export function tokenize(bytes: Uint8Array): Op[] {
  let i = 0
  const n = bytes.length
  const ops: Op[] = []
  let args: Operand[] = []
  let argStart = -1
  const skip = () => {
    for (;;) {
      if (i < n && WS.has(bytes[i])) i++
      else if (bytes[i] === 37) while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++
      else break
    }
  }
  const obj = (): Operand => {
    const b = bytes[i]
    if (b === 47) {
      let s = ''
      i++
      while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) s += String.fromCharCode(bytes[i++])
      return { t: 'name', v: s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) }
    }
    if (b === 40) {
      i++
      let depth = 1
      const out: number[] = []
      while (i < n) {
        const c = bytes[i++]
        if (c === 92) {
          const e = bytes[i++]
          const esc = ({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 } as Record<number, number>)[e]
          if (esc !== undefined) out.push(esc)
          else if (e >= 48 && e <= 55) {
            let v = e - 48
            for (let k = 0; k < 2 && bytes[i] >= 48 && bytes[i] <= 55; k++) v = v * 8 + (bytes[i++] - 48)
            out.push(v & 255)
          } else if (e === 13) {
            if (bytes[i] === 10) i++
          } else if (e !== 10) out.push(e)
        } else if (c === 40) {
          depth++
          out.push(c)
        } else if (c === 41) {
          if (--depth === 0) break
          out.push(c)
        } else out.push(c)
      }
      return { t: 'str', v: Uint8Array.from(out) }
    }
    if (b === 60 && bytes[i + 1] === 60) {
      i += 2
      const d: Record<string, Operand> = {}
      for (;;) {
        skip()
        if (i >= n || (bytes[i] === 62 && bytes[i + 1] === 62)) {
          i += 2
          break
        }
        const k = obj()
        skip()
        d[k.t === 'name' ? k.v : String(k.v)] = obj()
      }
      return { t: 'dict', v: d }
    }
    if (b === 60) {
      i++
      let h = ''
      while (i < n && bytes[i] !== 62) {
        const c = bytes[i++]
        if (!WS.has(c)) h += String.fromCharCode(c)
      }
      i++
      if (h.length % 2) h += '0'
      const out = new Uint8Array(h.length / 2)
      for (let k = 0; k < out.length; k++) out[k] = parseInt(h.substr(k * 2, 2), 16)
      return { t: 'str', v: out }
    }
    if (b === 91) {
      i++
      const a: Operand[] = []
      for (;;) {
        skip()
        if (i >= n || bytes[i] === 93) {
          i++
          break
        }
        a.push(obj())
      }
      return { t: 'arr', v: a }
    }
    let s = ''
    while (i < n && !WS.has(bytes[i]) && !DELIM.has(bytes[i])) s += String.fromCharCode(bytes[i++])
    if (s === '') {
      i++
      return { t: 'kw', v: '' }
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { t: 'num', v: parseFloat(s), raw: s }
    return { t: 'kw', v: s }
  }
  for (;;) {
    skip()
    if (i >= n) break
    const start = i
    const o = obj()
    if (o.t === 'kw' && !['true', 'false', 'null', ''].includes(o.v)) {
      if (o.v === 'BI') {
        // Inline image: kept verbatim. "ID", one whitespace, data, whitespace + "EI".
        while (i < n && !(bytes[i] === 73 && bytes[i + 1] === 68 && WS.has(bytes[i + 2] ?? 32) && WS.has(bytes[i - 1]))) i++
        i += 3
        while (i < n && !(WS.has(bytes[i - 1]) && bytes[i] === 69 && bytes[i + 1] === 73 && (i + 2 >= n || WS.has(bytes[i + 2]) || DELIM.has(bytes[i + 2])))) i++
        i += 2
        ops.push({ op: 'BI', args: [], start, end: i })
      } else ops.push({ op: o.v, args, start: argStart < 0 ? start : argStart, end: i })
      args = []
      argStart = -1
    } else {
      if (argStart < 0) argStart = start
      args.push(o)
    }
  }
  return ops
}

const hexStr = (b: ArrayLike<number>) => '<' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') + '>'
const fmt = (v: number) => (Math.abs(v) < 1e-7 ? '0' : (+v.toFixed(5)).toString())
function serialize(o: Operand): string {
  switch (o.t) {
    case 'num':
      return o.raw
    case 'name':
      return '/' + o.v.replace(/[^!-~]|[()<>[\]{}/%#]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    case 'str':
      return hexStr(o.v)
    case 'arr':
      return '[' + o.v.map(serialize).join(' ') + ']'
    case 'dict':
      return '<<' + Object.entries(o.v).map(([k, v]) => serialize({ t: 'name', v: k }) + ' ' + serialize(v)).join(' ') + '>>'
    case 'kw':
      return o.v
  }
}

// --- Fonts ----------------------------------------------------------------------------

interface FontInfo {
  baseFont: string
  bytes: 1 | 2
  /** Advance in text-space units per 1 unit of font size (w × FontMatrix), spacing excluded. */
  width: (code: number) => number
  type3: boolean
  /** Why glyphs of this font can't be removed (undefined = fine). */
  problem?: string
}

const STD14 = new Set<string>(Object.values(FontNames))
// WinAnsi code → glyph name (unicodeMappings is private in the typings, public at runtime).
const winAnsiNames = new Map(
  Object.values((Encodings.WinAnsi as unknown as { unicodeMappings: Record<string, [number, string]> }).unicodeMappings).map(([code, name]) => [code, name]),
)

function fontInfo(ctx: PDFContext, dict: PDFDict): FontInfo {
  const subtype = String(dict.get(N('Subtype')) ?? '')
  const baseFont = (dict.lookup(N('BaseFont')) as PDFName | undefined)?.decodeText?.() ?? ''
  const num = (o: unknown) => (o instanceof PDFNumber ? o.asNumber() : undefined)
  if (subtype === '/Type0') {
    const enc = dict.get(N('Encoding'))
    const cid = dict.lookupMaybe(N('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict)
    const dw = num(cid?.lookup(N('DW'))) ?? 1000
    const W = new Map<number, number>()
    const warr = cid?.lookupMaybe(N('W'), PDFArray)
    if (warr) {
      for (let k = 0; k < warr.size(); ) {
        const first = num(warr.lookup(k)) ?? 0
        const next = warr.lookup(k + 1)
        if (next instanceof PDFArray) {
          for (let j = 0; j < next.size(); j++) W.set(first + j, num(next.lookup(j)) ?? dw)
          k += 2
        } else {
          const last = num(next) ?? first
          const w = num(warr.lookup(k + 2)) ?? dw
          for (let c = first; c <= last && c - first < 65536; c++) W.set(c, w)
          k += 3
        }
      }
    }
    const problem = enc === N('Identity-H') ? undefined : enc === N('Identity-V') ? 'vertical text' : 'CMap encoding'
    return { baseFont, bytes: 2, width: (c) => (W.get(c) ?? dw) / 1000, type3: false, problem }
  }
  const first = num(dict.lookup(N('FirstChar'))) ?? 0
  const widths = dict.lookupMaybe(N('Widths'), PDFArray)
  const fd = dict.lookupMaybe(N('FontDescriptor'), PDFDict)
  const missing = num(fd?.lookup(N('MissingWidth'))) ?? 0
  if (subtype === '/Type3') {
    const fm = dict.lookupMaybe(N('FontMatrix'), PDFArray)
    const f = fm ? fm.asArray().map((x) => num(ctx.lookup(x)) ?? 0) : [0.001, 0, 0, 0.001]
    const arr = widths ? widths.asArray().map((x) => num(ctx.lookup(x)) ?? 0) : []
    return { baseFont, bytes: 1, width: (c) => (arr[c - first] ?? 0) * f[0], type3: true, problem: Math.abs(f[1]) > 1e-9 || Math.abs(f[2]) > 1e-9 ? 'skewed Type3 font' : undefined }
  }
  if (widths) {
    const arr = widths.asArray().map((x) => num(ctx.lookup(x)) ?? 0)
    return { baseFont, bytes: 1, width: (c) => (arr[c - first] ?? missing) / 1000, type3: false }
  }
  if (STD14.has(baseFont)) {
    const afm = Font.load(baseFont as FontNames)
    const diff = new Map<number, string>()
    // /Encoding is a name (WinAnsiEncoding) or a dict with /Differences.
    const encObj = dict.lookup(N('Encoding'))
    const enc = encObj instanceof PDFDict ? encObj : undefined
    const d = enc?.lookupMaybe(N('Differences'), PDFArray)
    if (d) {
      let code = 0
      for (const x of d.asArray()) {
        const v = ctx.lookup(x)
        if (v instanceof PDFNumber) code = v.asNumber()
        else if (v instanceof PDFName) diff.set(code++, v.decodeText())
      }
    }
    return { baseFont, bytes: 1, width: (c) => (afm.getWidthOfGlyph(diff.get(c) ?? winAnsiNames.get(c) ?? 'space') ?? 0) / 1000, type3: false }
  }
  return { baseFont, bytes: 1, width: () => 0, type3: false, problem: 'font without widths' }
}

// --- Interpreter ----------------------------------------------------------------------

/** A glyph as drawn by the content: where (page space) and how it was shown. */
export interface DrawnGlyph {
  /** 'page' or the index of the `Do` operator (in page content) that drew the form. */
  stream: 'page' | number
  op: number
  item: number
  k: number
  code: number
  x: number
  y: number
  font: FontInfo
  w: number
  tc: number
  tw: number
  tfs: number
  mode: number
  /** Indices of enclosing BDC operators (same stream). */
  marks: number[]
  nested: boolean
  /** Where new text for this glyph can go in the page content: after its text object (ET), or after
   *  the Do that drew its form. With the CTM there (page-space based) and the clip (page space). */
  anchor: { op: number; ctm: M; clip: Clip }
}

/** Clip as a page-space rectangle; null = none; 'unknown' = a non-rectangular clip. */
type Clip = [number, number, number, number] | null | 'unknown'

interface GState {
  clip: Clip
  ctm: M
  tc: number
  tw: number
  th: number
  tl: number
  ts: number
  tfs: number
  font: FontInfo | null
  mode: number
}

function decode(s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode()
  if (s instanceof PDFContentStream) return s.getUnencodedContents()
  return s.getContents()
}

function interpret(
  ctx: PDFContext,
  ops: Op[],
  resources: PDFDict | undefined,
  ctm0: M,
  stream: 'page' | number,
  out: DrawnGlyph[],
  forms: Map<number, { name: string; xo: PDFStream; ops: Op[]; bytes: Uint8Array }>,
  nested: boolean,
) {
  const fontCache = new Map<string, FontInfo | null>()
  const fontNamed = (name: string) => {
    if (fontCache.has(name)) return fontCache.get(name)!
    const d = resources?.lookupMaybe(N('Font'), PDFDict)?.lookupMaybe(N(name), PDFDict)
    const f = d ? fontInfo(ctx, d) : null
    fontCache.set(name, f)
    return f
  }
  let g: GState = { clip: null, ctm: ctm0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tfs: 0, font: null, mode: 0 }
  let pathRect: [number, number, number, number] | null = null
  let pathComplex = false
  let btStart = -1
  const pending: DrawnGlyph[] = []
  const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const stack: GState[] = []
  const marks: number[] = []
  let tm: M = [1, 0, 0, 1, 0, 0]
  let tlm: M = tm
  const num = (o: Operand | undefined) => (o && o.t === 'num' ? o.v : 0)
  ops.forEach((o, oi) => {
    const a = o.args
    switch (o.op) {
      case 'q':
        stack.push({ ...g })
        break
      case 'Q':
        g = stack.pop() ?? g
        break
      case 'cm':
        g.ctm = mul(g.ctm, a.map(num) as M)
        break
      case 'BT':
        tm = tlm = [1, 0, 0, 1, 0, 0]
        btStart = oi
        break
      case 'ET':
        // New text for glyphs of this text object can be inserted right after it (page level).
        for (const dg of pending) if (dg.stream === 'page') dg.anchor = { op: oi, ctm: g.ctm, clip: g.clip }
        pending.length = 0
        btStart = -1
        break
      case 're': {
        const [x, y, w, h] = a.map(num)
        if (pathRect || pathComplex) pathComplex = true
        else {
          const pts = [apply(g.ctm, x, y), apply(g.ctm, x + w, y), apply(g.ctm, x, y + h), apply(g.ctm, x + w, y + h)]
          const xs = pts.map((p) => p[0])
          const ys = pts.map((p) => p[1])
          pathRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        }
        break
      }
      case 'm':
      case 'l':
      case 'c':
      case 'v':
      case 'y':
      case 'h':
        pathComplex = true
        break
      case 'W':
      case 'W*': {
        if (pathComplex || !pathRect) g.clip = 'unknown'
        else if (g.clip === null) g.clip = pathRect
        else if (g.clip !== 'unknown') {
          const c = g.clip
          g.clip = [Math.max(c[0], pathRect[0]), Math.max(c[1], pathRect[1]), Math.min(c[2], pathRect[2]), Math.min(c[3], pathRect[3])]
        }
        break
      }
      case 'n':
      case 'f':
      case 'F':
      case 'f*':
      case 'S':
      case 's':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        pathRect = null
        pathComplex = false
        break
      case 'Tf':
        g.font = a[0]?.t === 'name' ? fontNamed(a[0].v) : null
        g.tfs = num(a[1])
        break
      case 'gs': {
        const gsd = a[0]?.t === 'name' ? resources?.lookupMaybe(N('ExtGState'), PDFDict)?.lookupMaybe(N(a[0].v), PDFDict) : undefined
        const f = gsd?.lookupMaybe(N('Font'), PDFArray)
        if (f) {
          const fd = ctx.lookupMaybe(f.get(0), PDFDict)
          g.font = fd ? fontInfo(ctx, fd) : null
          g.tfs = (ctx.lookup(f.get(1)) as PDFNumber | undefined)?.asNumber?.() ?? g.tfs
        }
        break
      }
      case 'Tc':
        g.tc = num(a[0])
        break
      case 'Tw':
        g.tw = num(a[0])
        break
      case 'Tz':
        g.th = num(a[0]) / 100
        break
      case 'TL':
        g.tl = num(a[0])
        break
      case 'Ts':
        g.ts = num(a[0])
        break
      case 'Tr':
        g.mode = num(a[0])
        break
      case 'Td':
        tm = tlm = mul(tlm, [1, 0, 0, 1, num(a[0]), num(a[1])])
        break
      case 'TD':
        g.tl = -num(a[1])
        tm = tlm = mul(tlm, [1, 0, 0, 1, num(a[0]), num(a[1])])
        break
      case 'Tm':
        tm = tlm = a.map(num) as M
        break
      case 'T*':
        tm = tlm = mul(tlm, [1, 0, 0, 1, 0, -g.tl])
        break
      case 'BDC':
      case 'BMC':
        marks.push(oi)
        break
      case 'EMC':
        marks.pop()
        break
      case "'":
      case '"':
      case 'Tj':
      case 'TJ': {
        if (o.op === '"') {
          g.tw = num(a[0])
          g.tc = num(a[1])
        }
        if (o.op === "'" || o.op === '"') tm = tlm = mul(tlm, [1, 0, 0, 1, 0, -g.tl])
        const items = o.op === 'TJ' ? (a[0]?.t === 'arr' ? a[0].v : []) : [a[a.length - 1]]
        const f = g.font
        items.forEach((it, ii) => {
          if (!it) return
          if (it.t === 'num') {
            tm = mul(tm, [1, 0, 0, 1, (-it.v / 1000) * g.tfs * g.th, 0])
            return
          }
          if (it.t !== 'str' || !f) return
          for (let k = 0; k + f.bytes <= it.v.length; k += f.bytes) {
            const code = f.bytes === 2 ? (it.v[k] << 8) | it.v[k + 1] : it.v[k]
            const w0 = f.width(code)
            const space = f.bytes === 1 && code === 32
            const tx = (w0 * g.tfs + g.tc + (space ? g.tw : 0)) * g.th
            const user = mul(g.ctm, tm)
            const rec: DrawnGlyph = {
              stream,
              op: oi,
              item: ii,
              k,
              code,
              x: user[2] * g.ts + user[4],
              y: user[3] * g.ts + user[5],
              font: f,
              w: w0,
              tc: g.tc,
              tw: space ? g.tw : 0,
              tfs: g.tfs,
              mode: g.mode,
              marks: marks.slice(),
              nested,
              anchor: { op: stream === 'page' ? -1 : stream, ctm: g.ctm, clip: g.clip },
            }
            out.push(rec)
            if (stream === 'page' && btStart >= 0) pending.push(rec)
            tm = mul(tm, [1, 0, 0, 1, tx, 0])
          }
        })
        break
      }
      case 'Do': {
        if (a[0]?.t !== 'name') break
        const xo = resources?.lookupMaybe(N('XObject'), PDFDict)?.lookup(N(a[0].v))
        if (!(xo instanceof PDFStream) || xo.dict.get(N('Subtype')) !== N('Form')) break
        const fm = xo.dict.lookupMaybe(N('Matrix'), PDFArray)
        const matrix = (fm ? fm.asArray().map((x) => (ctx.lookup(x) as PDFNumber).asNumber()) : [1, 0, 0, 1, 0, 0]) as M
        const bytes = decode(xo)
        const fops = tokenize(bytes)
        const res = xo.dict.lookupMaybe(N('Resources'), PDFDict) ?? resources
        if (stream === 'page') forms.set(oi, { name: a[0].v, xo, ops: fops, bytes })
        const before = out.length
        interpret(ctx, fops, res, mul(g.ctm, matrix), stream === 'page' ? oi : stream, out, forms, stream !== 'page')
        // Text drawn by a form: new text goes right after the Do, in the page's coordinate state here.
        if (stream === 'page') for (let k = before; k < out.length; k++) out[k].anchor = { op: oi, ctm: g.ctm, clip: g.clip }
        break
      }
    }
  })
}

// --- Rewriting ------------------------------------------------------------------------

/** Raw splice: replace bytes [start, end) (start === end inserts). */
interface Splice {
  start: number
  end: number
  data: Uint8Array
}

function rewrite(bytes: Uint8Array, ops: Op[], glyphs: DrawnGlyph[], drop: Set<DrawnGlyph>, extra: Splice[] = []): Uint8Array {
  const byOp = new Map<number, DrawnGlyph[]>()
  for (const g of glyphs) {
    let l = byOp.get(g.op)
    if (!l) byOp.set(g.op, (l = []))
    l.push(g)
  }
  const edits: { start: number; end: number; text: string }[] = []
  // Marked content whose /ActualText (or /Alt, /E) would still spell the removed words.
  const marksToClean = new Set<number>()
  for (const g of drop) for (const m of g.marks) marksToClean.add(m)
  for (const mi of marksToClean) {
    const o = ops[mi]
    const props = o.args[1]
    if (o.op !== 'BDC' || !props || props.t !== 'dict') continue
    const cleaned = { ...props.v }
    let touched = false
    for (const key of ['ActualText', 'Alt', 'E']) if (key in cleaned) {
      delete cleaned[key]
      touched = true
    }
    if (touched) edits.push({ start: o.start, end: o.end, text: `${serialize(o.args[0])} ${serialize({ t: 'dict', v: cleaned })} BDC` })
  }
  for (const [oi, gl] of byOp) {
    if (!gl.some((g) => drop.has(g))) continue
    const o = ops[oi]
    const items = o.op === 'TJ' ? (o.args[0]?.t === 'arr' ? o.args[0].v : []) : [o.args[o.args.length - 1]]
    const out: string[] = []
    let pending = 0
    let buf: number[] = []
    const flush = () => {
      if (!buf.length) return
      if (Math.abs(pending) > 1e-7) out.push(fmt(pending))
      pending = 0
      out.push(hexStr(buf))
      buf = []
    }
    items.forEach((it, ii) => {
      if (!it) return
      if (it.t === 'num') {
        flush()
        pending += it.v
        return
      }
      if (it.t !== 'str') return
      for (const g of gl.filter((g) => g.item === ii)) {
        const raw = it.v.subarray(g.k, g.k + g.font.bytes)
        if (drop.has(g)) {
          flush()
          pending -= g.w * 1000 + ((g.tc + g.tw) * 1000) / g.tfs
        } else buf.push(...raw)
      }
    })
    flush()
    if (Math.abs(pending) > 1e-7) out.push(fmt(pending))
    let prefix = ''
    if (o.op === "'") prefix = 'T* '
    if (o.op === '"') prefix = `${serialize(o.args[0])} Tw ${serialize(o.args[1])} Tc T* `
    edits.push({ start: o.start, end: o.end, text: `${prefix}[${out.join(' ')}] TJ` })
  }
  const enc = new TextEncoder()
  const all: Splice[] = [...edits.map((e) => ({ start: e.start, end: e.end, data: enc.encode(e.text) })), ...extra].sort(
    (p, q) => p.start - q.start || p.end - q.end,
  )
  const parts: Uint8Array[] = []
  let pos = 0
  for (const e of all) {
    parts.push(bytes.subarray(pos, e.start), e.data)
    pos = e.end
  }
  parts.push(bytes.subarray(pos))
  const total = parts.reduce((s, p) => s + p.length, 0)
  const res = new Uint8Array(total)
  let w = 0
  for (const p of parts) {
    res.set(p, w)
    w += p.length
  }
  return res
}

// --- Public API -----------------------------------------------------------------------

/** A printed glyph to remove: its page-space origin (with rise) and char code. */
export interface GlyphTarget {
  x: number
  y: number
  code: number
}
/** Remove every glyph whose origin lies in a page-space rectangle (scan edits, legacy patches). */
export interface RegionTarget {
  rect: { x: number; y: number; width: number; height: number }
  /** Only invisible text (OCR layers, Tr 3/7). */
  invisibleOnly: boolean
}

export interface RemovalResult {
  /** Per glyph target: removed from the file. */
  glyphs: boolean[]
  /** Per region target: every matching glyph removed. */
  regions: boolean[]
  reasons: string[]
}

/** Where new text replacing a glyph target can be inserted, keeping reading order. */
export interface Anchor {
  op: number
  ctm: M
  clip: Clip
}

export interface RemovalPlan {
  result: RemovalResult
  /** Insertion point for glyph target `ti` (undefined: append at the end of the page). */
  anchorOf(ti: number): Anchor | undefined
  /** Rewrites the content: removed glyphs gone, `inserts` (default-user-space content) spliced in. */
  commit(inserts: { anchor: Anchor; bytes: Uint8Array }[]): void
}

const inv = (m: M): M => {
  const det = m[0] * m[3] - m[1] * m[2]
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

/** Does a clip (page space) leave a page-space rectangle fully visible? */
export function clipAllows(clip: Clip, r: { x: number; y: number; width: number; height: number }) {
  if (clip === null) return true
  if (clip === 'unknown') return false
  return clip[0] <= r.x + 0.5 && clip[1] <= r.y + 0.5 && clip[2] >= r.x + r.width - 0.5 && clip[3] >= r.y + r.height - 0.5
}

/**
 * Plans the removal of the targets from the page's content (and the Form XObjects it draws).
 * `toPage` maps PDF user space to page space (pdf.js viewport at scale 1). Call before anything is
 * drawn on the page, after it has private Resources; then `commit` exactly once.
 */
export function planRemoval(page: PDFPage, toPage: M, glyphTargets: GlyphTarget[], regions: RegionTarget[]): RemovalPlan {
  const ctx = page.doc.context
  const leaf = page.node
  const res: RemovalResult = { glyphs: glyphTargets.map(() => false), regions: regions.map(() => true), reasons: [] }
  if (!glyphTargets.length && !regions.length) return { result: res, anchorOf: () => undefined, commit: () => {} }
  const contents = leaf.Contents()
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : contents ? [contents] : []
  const parts = streams.filter((x): x is PDFStream => x instanceof PDFStream).map(decode)
  const bytes = new Uint8Array(parts.reduce((n, q) => n + q.length + 1, 0))
  let off = 0
  for (const q of parts) {
    bytes.set(q, off)
    off += q.length
    bytes[off++] = 10
  }
  const ops = tokenize(bytes)
  const resources = leaf.Resources()
  const glyphs: DrawnGlyph[] = []
  const forms = new Map<number, { name: string; xo: PDFStream; ops: Op[]; bytes: Uint8Array }>()
  interpret(ctx, ops, resources, toPage, 'page', glyphs, forms, false)

  const drop = new Set<DrawnGlyph>()
  const matched: (DrawnGlyph | undefined)[] = glyphTargets.map(() => undefined)
  const unusable = (g: DrawnGlyph): string | undefined =>
    g.font.problem ?? (g.mode >= 4 ? 'text used as a clipping path' : g.nested ? 'text in a nested form' : !g.tfs ? 'font size 0' : undefined)
  // Glyph targets: nearest drawn glyph with the same code at (almost) the same origin.
  glyphTargets.forEach((t, ti) => {
    let best: DrawnGlyph | undefined
    let bestD = 0.6
    for (const g of glyphs) {
      if (g.code !== t.code || drop.has(g)) continue
      const d = Math.hypot(g.x - t.x, g.y - t.y)
      if (d < bestD) {
        bestD = d
        best = g
      }
    }
    if (!best) {
      res.reasons.push('glyph not found in the content')
      return
    }
    const why = unusable(best)
    if (why) {
      res.reasons.push(why)
      return
    }
    drop.add(best)
    matched[ti] = best
    res.glyphs[ti] = true
  })
  regions.forEach((r, ri) => {
    for (const g of glyphs) {
      if (g.x < r.rect.x || g.x > r.rect.x + r.rect.width || g.y < r.rect.y || g.y > r.rect.y + r.rect.height) continue
      if (r.invisibleOnly && g.mode !== 3 && g.mode !== 7) continue
      const why = unusable(g)
      if (why) {
        res.regions[ri] = false
        res.reasons.push(why)
      } else drop.add(g)
    }
  })

  return {
    result: res,
    anchorOf: (ti) => {
      const a = matched[ti]?.anchor
      return a && a.op >= 0 ? a : undefined
    },
    commit: (inserts) => {
      if (!drop.size && !inserts.length) return
      const enc = new TextEncoder()
      const extra: Splice[] = []
      // Forms that need edits: a clone for this page under a new name; the page's Do points to it.
      for (const [doOp, f] of forms) {
        const fg = glyphs.filter((g) => g.stream === doOp)
        if (!fg.some((g) => drop.has(g))) continue
        const xobjects = resources?.lookupMaybe(N('XObject'), PDFDict)
        if (!xobjects) continue
        const newBytes = rewrite(f.bytes, f.ops, fg, drop)
        const dict = f.xo.dict.clone(ctx)
        for (const k of ['Length', 'Filter', 'DecodeParms']) dict.delete(N(k))
        const clone = ctx.flateStream(newBytes, Object.fromEntries([...dict.entries()].map(([k, v]) => [k.decodeText(), v])))
        const name = `${f.name}E${doOp}`
        xobjects.set(N(name), ctx.register(clone))
        extra.push({ start: ops[doOp].start, end: ops[doOp].end, data: enc.encode(`/${name} Do`) })
      }
      // New text in reading order: right after the text object (or form) it replaces. The content
      // there may run under another CTM: undo it so our default-user-space operators land right.
      for (const { anchor, bytes: b } of inserts) {
        const u = mul(inv(anchor.ctm), toPage)
        const head = enc.encode('\nq ' + u.map(fmt).join(' ') + ' cm\n')
        const tail = enc.encode('\nQ\n')
        const data = new Uint8Array(head.length + b.length + tail.length)
        data.set(head)
        data.set(b, head.length)
        data.set(tail, head.length + b.length)
        extra.push({ start: ops[anchor.op].end, end: ops[anchor.op].end, data })
      }
      const out = rewrite(
        bytes,
        ops,
        glyphs.filter((g) => g.stream === 'page'),
        drop,
        extra,
      )
      // Keep /Contents an array (pdf-lib appends to it later) and isolate this content's graphics
      // state from whatever gets appended after it.
      const wrapped = new Uint8Array(out.length + 6)
      wrapped.set(enc.encode('q\n'))
      wrapped.set(out, 2)
      wrapped.set(enc.encode('\nQ\n'), out.length + 2)
      leaf.set(N('Contents'), ctx.obj([ctx.register(ctx.flateStream(wrapped))]))
    },
  }
}

/** One-shot (tests): plan and commit without inserted content. */
export function removeText(page: PDFPage, toPage: M, glyphTargets: GlyphTarget[], regions: RegionTarget[]): RemovalResult {
  const plan = planRemoval(page, toPage, glyphTargets, regions)
  plan.commit([])
  return plan.result
}
