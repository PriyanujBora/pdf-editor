// Generates test PDFs into tests/fixtures. Run: npm run fixtures
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  beginText,
  endText,
  setTextRenderingMode,
  TextRenderingMode,
  setFontAndSize,
  setTextMatrix,
  showText,
  PDFArray,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
} from '@cantoo/pdf-lib'
import rawFontkit from '@pdf-lib/fontkit'

// Same adapter as src/lib/export/fontkit-compat.ts.
const fontkit = {
  create(d, ps) {
    const f = rawFontkit.create(d, ps)
    const mk = f.createSubset.bind(f)
    f.createSubset = () => {
      const s = mk()
      // Same fixes as src/lib/export/fontkit-compat.ts (encode() clash + loca padding).
      const add = s._addGlyph.bind(s)
      s._addGlyph = (gid) => {
        const i = add(gid)
        const b = s.glyf[i]
        if (b.length % 2) {
          const p = b.constructor.alloc(b.length + 1)
          p.set(b)
          s.glyf[i] = p
          s.offset += 1
        }
        return i
      }
      return {
        includeGlyph: (g) => s.includeGlyph(g),
        encodeStream: () => s.encodeStream(),
        get cff() {
          return s.cff
        },
      }
    }
    return f
  },
}
import { chromium } from 'playwright'

const OUT = 'tests/fixtures'
await mkdir(OUT, { recursive: true })

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer nec odio. Praesent libero. Sed cursus ante dapibus diam. Sed nisi. Nulla quis sem at nibh elementum imperdiet. Duis sagittis ipsum. Praesent mauris. Fusce nec tellus sed augue semper porta. Mauris massa. Vestibulum lacinia arcu eget nulla.'

function wrap(text, font, size, maxW) {
  const words = text.split(' ')
  const lines = []
  let cur = ''
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w
    if (font.widthOfTextAtSize(t, size) > maxW && cur) {
      lines.push(cur)
      cur = w
    } else cur = t
  }
  if (cur) lines.push(cur)
  return lines
}

// 1. Text-heavy: standard + embedded subset fonts, colours, a rotated page.
{
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle('Text heavy fixture')
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold)
  const times = await doc.embedFont(StandardFonts.TimesRoman)
  const roboto = await doc.embedFont(await readFile('public/fonts/Roboto-Regular.ttf'), { subset: true })

  for (let n = 0; n < 3; n++) {
    const page = doc.addPage([595, 842])
    page.drawText(`Quarterly Report ${n + 1}`, { x: 56, y: 770, size: 28, font: helvB, color: rgb(0.1, 0.25, 0.65) })
    page.drawRectangle({ x: 50, y: 700, width: 495, height: 44, color: rgb(0.93, 0.95, 0.98) })
    page.drawText('Invoice total: $12,480.00 due 30 Nov 2026', {
      x: 60,
      y: 716,
      size: 14,
      font: roboto,
      color: rgb(0.1, 0.1, 0.1),
    })
    let y = 670
    for (let p = 0; p < 4; p++) {
      const font = p % 2 ? times : helv
      for (const line of wrap(LOREM, font, 11, 480)) {
        page.drawText(line, { x: 56, y, size: 11, font, color: rgb(0.13, 0.13, 0.13) })
        y -= 15
      }
      y -= 12
    }
    page.drawText('Important: signed copies must be returned.', {
      x: 56,
      y: y - 10,
      size: 12,
      font: helvB,
      color: rgb(0.75, 0.1, 0.1),
    })
    if (n === 2) page.setRotation(degrees(90))
  }
  await writeFile(`${OUT}/text-heavy.pdf`, await doc.save())
}

// 2. Multi-page: 40 pages of mixed sizes/orientations.
{
  const doc = await PDFDocument.create()
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold)
  const sizes = [
    [595, 842],
    [612, 792],
    [842, 595],
  ]
  for (let i = 0; i < 40; i++) {
    const [w, h] = sizes[i % 3]
    const page = doc.addPage([w, h])
    page.drawRectangle({ x: 20, y: 20, width: w - 40, height: h - 40, borderColor: rgb(0.8, 0.8, 0.85), borderWidth: 2 })
    page.drawText(String(i + 1), { x: w / 2 - 40, y: h / 2 - 30, size: 96, font: helvB, color: rgb(0.2, 0.2, 0.3) })
    page.drawText(`Page ${i + 1} of 40`, { x: 40, y: h - 60, size: 16, font: helvB })
  }
  await writeFile(`${OUT}/multi-page.pdf`, await doc.save())
}

// 3. Scanned: pages that are only raster images (no text layer).
{
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 850, height: 1100 }, deviceScaleFactor: 1.5 })
  const doc = await PDFDocument.create()
  for (let i = 0; i < 2; i++) {
    await page.setContent(`<body style="margin:0;padding:70px;font:17px/1.6 Georgia,serif;background:#f7f4ec;color:#222">
      <h1 style="font:bold 34px Arial">Scanned letter ${i + 1}</h1>
      ${Array.from({ length: 6 }, () => `<p>${LOREM}</p>`).join('')}</body>`)
    const png = await page.screenshot({ type: 'jpeg', quality: 70 })
    const img = await doc.embedJpg(png)
    const p = doc.addPage([612, 792])
    p.drawImage(img, { x: 0, y: 0, width: 612, height: 792 })
  }
  await browser.close()
  await writeFile(`${OUT}/scanned.pdf`, await doc.save())
}

// 3b. Scanned + invisible OCR text layer (render mode 3), like ABBYY/Acrobat OCR output.
{
  const lines = [
    'MEMORANDUM OF UNDERSTANDING',
    'This letter confirms the sanction of the research grant described below.',
    'Principal Investigator: Dr. Ananya Barua, Department of Physics',
    'Total amount sanctioned: Rs. 2,40,000 for a period of one year.',
    'The grant is subject to the terms and conditions listed overleaf.',
  ]
  const top = (i) => 120 + i * 30
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 612, height: 792 }, deviceScaleFactor: 200 / 72 })
  await page.setContent(`<body style="margin:0;width:612px;height:792px;background:#f3f1ea;position:relative;filter:blur(0.25px)">
    <svg width="612" height="792" style="position:absolute;inset:0;opacity:.18"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="2.2" numOctaves="1" seed="4"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>
    ${lines
      .map(
        (t, i) =>
          `<div style="position:absolute;left:72px;top:${top(i)}px;font:${i ? 400 : 700} 13px/1 'Times New Roman',Times,serif;color:#262626">${t}</div>`,
      )
      .join('')}</body>`)
  const jpg = await page.screenshot({ type: 'jpeg', quality: 80 })
  await browser.close()

  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([612, 792])
  p.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 612, height: 792 })
  const key = p.node.newFontDictionary('OCR', helv.ref)
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)]
  lines.forEach((t, i) => {
    // Times baseline ≈ top + 0.891 em
    ops.push(setFontAndSize(key, 13), setTextMatrix(1, 0, 0, 1, 72, 792 - (top(i) + 13 * 0.891)), showText(helv.encodeText(t)))
  })
  ops.push(endText(), popGraphicsState())
  p.pushOperators(...ops)
  await writeFile(`${OUT}/scanned-ocr.pdf`, await doc.save())
}

// 4. Encrypted (user password "secret").
{
  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([400, 300]).drawText('Top secret content', { x: 40, y: 150, size: 24, font: helv })
  doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner' })
  await writeFile(`${OUT}/encrypted.pdf`, await doc.save())
}

// 5. Corrupt.
await writeFile(`${OUT}/corrupt.pdf`, Buffer.from('%PDF-1.7\n' + 'garbage '.repeat(500)))

// --- Fidelity fixtures (npm run test:fidelity): document-level features an export must keep ------

/** Four labelled pages with a unique marker each (to prove deleted pages leave the file). */
async function markedPages(doc, n = 4) {
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const pages = []
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([595, 842])
    p.drawText(`Chapter ${i + 1}`, { x: 72, y: 760, size: 24, font: helv })
    p.drawText(`Unique marker page-${i + 1}-zq${i}x`, { x: 72, y: 720, size: 12, font: helv })
    pages.push(p)
  }
  return { pages, helv }
}

// 10. Form: text, multiline, checkbox, radio, dropdown, list, a calculated field (JavaScript).
{
  const doc = await PDFDocument.create()
  const { pages } = await markedPages(doc, 2)
  const form = doc.getForm()
  const p = pages[0]
  const name = form.createTextField('name')
  name.setText('Ada Lovelace')
  name.addToPage(p, { x: 72, y: 640, width: 220, height: 22 })
  const notes = form.createTextField('notes')
  notes.enableMultiline()
  notes.setText('First line\nSecond line')
  notes.addToPage(p, { x: 72, y: 560, width: 220, height: 60 })
  const agree = form.createCheckBox('agree')
  agree.addToPage(p, { x: 72, y: 520, width: 16, height: 16 })
  agree.check()
  const size = form.createRadioGroup('size')
  for (const [i, v] of ['S', 'M', 'L'].entries()) size.addOptionToPage(v, p, { x: 72 + i * 40, y: 480, width: 16, height: 16 })
  size.select('M')
  const country = form.createDropdown('country')
  country.addOptions(['India', 'Japan', 'Kenya'])
  country.select('Japan')
  country.addToPage(p, { x: 72, y: 430, width: 160, height: 22 })
  const langs = form.createOptionList('languages')
  langs.addOptions(['Bengali', 'English', 'Hindi'])
  langs.select('English')
  langs.addToPage(p, { x: 72, y: 340, width: 160, height: 70 })
  const a = form.createTextField('a')
  a.setText('2')
  a.addToPage(pages[1], { x: 72, y: 640, width: 80, height: 22 })
  const b = form.createTextField('b')
  b.setText('3')
  b.addToPage(pages[1], { x: 72, y: 600, width: 80, height: 22 })
  const total = form.createTextField('total')
  total.setText('5')
  total.addToPage(pages[1], { x: 72, y: 560, width: 80, height: 22 })
  const ctx = doc.context
  const calc = ctx.obj({ S: 'JavaScript', JS: PDFHexString.fromText('AFSimple_Calculate("SUM", new Array ("a", "b"));') })
  total.acroField.dict.set(PDFName.of('AA'), ctx.obj({ C: calc }))
  form.acroForm.dict.set(PDFName.of('CO'), ctx.obj([total.acroField.ref]))
  await writeFile(`${OUT}/form.pdf`, await doc.save())
}

// 11. Bookmarks: nested outline, named + explicit destinations, an internal link, page labels.
{
  const doc = await PDFDocument.create()
  const { pages } = await markedPages(doc, 4)
  const ctx = doc.context
  const dest = (i) => ctx.obj([pages[i].ref, PDFName.of('XYZ'), null, null, null])
  const outlinesRef = ctx.nextRef()
  const refs = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()]
  // Chapter 1 (page 1) › Section 1.1 (page 2, named dest) ; Chapter 2 (page 2) ; Chapter 3 (page 3) › Section 3.1 (page 4)
  const item = (title, parent, d, extra = {}) => ctx.obj({ Title: PDFHexString.fromText(title), Parent: parent, ...d, ...extra })
  ctx.assign(refs[0], item('Chapter 1', outlinesRef, { Dest: dest(0) }, { Next: refs[2], First: refs[1], Last: refs[1], Count: 1 }))
  ctx.assign(refs[1], item('Section 1.1', refs[0], { Dest: PDFHexString.fromText('sec-1-1') }))
  ctx.assign(refs[2], item('Chapter 2', outlinesRef, { A: ctx.obj({ S: 'GoTo', D: dest(1) }) }, { Prev: refs[0], Next: refs[3] }))
  ctx.assign(refs[3], item('Chapter 3', outlinesRef, { Dest: dest(2) }, { Prev: refs[2], First: refs[4], Last: refs[4], Count: 1 }))
  ctx.assign(refs[4], item('Section 3.1', refs[3], { Dest: dest(3) }))
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[3], Count: 6 }))
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef)
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
  doc.catalog.set(
    PDFName.of('Names'),
    ctx.obj({ Dests: ctx.obj({ Names: ctx.obj([PDFHexString.fromText('sec-1-1'), dest(1), PDFHexString.fromText('end'), dest(3)]) }) }),
  )
  // Page labels: i, ii, then 1, 2.
  doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: ctx.obj([0, ctx.obj({ S: 'r' }), 2, ctx.obj({ S: 'D' })]) }))
  // Link on page 1 to the named destination "end" (page 4), and one to page 2.
  const link = (rect, d) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], Dest: d }))
  pages[0].node.set(PDFName.of('Annots'), ctx.obj([link([72, 690, 220, 706], PDFHexString.fromText('end')), link([72, 670, 220, 686], dest(1))]))
  doc.setTitle('Bookmarks fixture')
  doc.setAuthor('Fixture Author')
  doc.setSubject('Outline and destinations')
  await writeFile(`${OUT}/bookmarks.pdf`, await doc.save())
}

// 12. Attachments.
{
  const doc = await PDFDocument.create()
  await markedPages(doc, 2)
  await doc.attach(Buffer.from('hello attachment'), 'notes.txt', { mimeType: 'text/plain', description: 'Notes', creationDate: new Date(0), modificationDate: new Date(0) })
  await doc.attach(Buffer.from('a,b\n1,2\n'), 'data.csv', { mimeType: 'text/csv' })
  await writeFile(`${OUT}/attachments.pdf`, await doc.save())
}

// 13. Encrypted with restricted permissions, one per cipher (user "secret", owner "owner").
for (const algorithm of ['RC4-128', 'AES-128', 'AES-256']) {
  const doc = await PDFDocument.create()
  await markedPages(doc, 3)
  doc.setTitle(`Encrypted ${algorithm}`)
  doc.encrypt({
    userPassword: 'secret',
    ownerPassword: 'owner',
    algorithm,
    allowWeakCryptography: true,
    permissions: { printing: 'lowResolution', modifying: false, copying: false, annotating: true, fillingForms: true },
  })
  await writeFile(`${OUT}/encrypted-${algorithm.toLowerCase()}.pdf`, await doc.save())
}

// 14. Tagged PDF with an outline (Chrome: tagged + document outline from headings).
{
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent(`<!doctype html><html lang="en"><meta charset=utf-8><style>body{font:12pt Arial;margin:48px} h1,h2{break-before:page} h1:first-of-type{break-before:auto}</style>
    ${[1, 2, 3].map((i) => `<h1>Part ${i}</h1><p>Unique marker page-${i}-tg${i}x. ${LOREM}</p><h2>Part ${i}.1</h2><p>${LOREM}</p>`).join('')}`)
  await writeFile(`${OUT}/tagged.pdf`, await page.pdf({ format: 'A4', tagged: true, outline: true }))
  await browser.close()
}

// --- Producer imitations for the edit-stability harness (tests/edit-stability.mjs) ---------------
// File names start with the producer they imitate: the harness reports pass rates per producer.

const fontUrl = async (file) => `data:font/ttf;base64,${(await readFile(`public/fonts/${file}`)).toString('base64')}`

/** Copy of a TTF marked "restricted licence embedding" (OS/2 fsType = 2): Skia must emit Type3. */
async function restricted(file) {
  const b = Buffer.from(await readFile(`public/fonts/${file}`))
  const n = b.readUInt16BE(4)
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16
    if (b.toString('latin1', rec, rec + 4) === 'OS/2') b.writeUInt16BE(2, b.readUInt32BE(rec + 8) + 8)
  }
  return `data:font/ttf;base64,${b.toString('base64')}`
}

// 6. Chrome / Skia print-to-PDF (Google Docs exports through Skia too): one positioned glyph per
//    Td/Tj, Type0 fonts; plus a Canva-style Type3 font.
{
  const faces = {
    Sans: ['Arimo-Regular.ttf', 'Arimo-Bold.ttf'],
    Calibri: ['Carlito-Regular.ttf', 'Carlito-Bold.ttf'],
    Mono: ['Cousine-Regular.ttf'],
    Georgia: ['Gelasio-Regular.ttf'],
    Bengali: ['NotoSansBengali-Regular.ttf'],
    Hindi: ['NotoSansDevanagari-Regular.ttf'],
  }
  let css = ''
  for (const [fam, [reg, bold]] of Object.entries(faces)) {
    css += `@font-face{font-family:${fam};src:url(${await fontUrl(reg)})}`
    if (bold) css += `@font-face{font-family:${fam};font-weight:700;src:url(${await fontUrl(bold)})}`
  }
  css += `@font-face{font-family:Restricted;src:url(${await restricted('Tinos-Regular.ttf')})}`
  const para =
    'The committee reviewed the annual budget proposal in detail and approved the revised allocation for infrastructure, training and community outreach programmes, subject to the usual quarterly reporting requirements.'
  const html = `<!doctype html><meta charset=utf-8><style>${css}
    body{margin:0;padding:56px 64px;font:11pt Sans;color:#222} p{margin:0 0 12px;white-space:nowrap} a{color:#1a0dab}</style>
    <p><b>Name:</b> John Smith, email <a href="https://example.com">john.smith@example.com</a></p>
    <p>Status: <b style="color:#d00">OVERDUE</b> since 3 March 2026, reminder sent</p>
    <p><span style="font-size:15pt">&#9679;</span>&nbsp;&nbsp;Managed a team of five engineers across two sites</p>
    <p>Revenue grew 3x in 2025<sup>1</sup> across all regions</p>
    <p style="letter-spacing:3pt;font-weight:bold;font-size:14pt">QUARTERLY SUMMARY</p>
    <p style="white-space:normal;text-align:justify;width:440px">${para}</p>
    <div style="columns:2;column-gap:28px;width:500px;text-align:justify;font:10pt Georgia;margin-bottom:12px">${para} ${para}</div>
    <p style="font-family:Calibri">Calibri metrics: The committee approved the annual budget</p>
    <p style="font-family:Mono">Courier metrics: The committee approved the annual budget</p>
    <p style="font-family:Georgia">Georgia metrics: The committee approved the annual budget</p>
    <p style="font-family:Restricted;font-size:13pt">Type3 restricted font: The committee approved the annual budget</p>
    <p style="font-family:Bengali">বাংলা: বার্ষিক বাজেট অনুমোদিত হয়েছে</p>
    <p style="font-family:Hindi">हिन्दी: वार्षिक बजट स्वीकृत हुआ</p>`
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await writeFile(`${OUT}/chrome-producer.pdf`, await page.pdf({ format: 'A4', printBackground: true }))
  await browser.close()
}

/** Raw text operators on a page: [op, ...operands]. */
function textOps(page, lines) {
  const num = (v) => (typeof v === 'number' ? PDFNumber.of(v) : v)
  page.pushOperators(...lines.flatMap((ops) => ops.map(([name, ...args]) => PDFOperator.of(name, args.map(num)))))
}

// 7. Word-style output: Type0 (Identity-H) letters with per-glyph TJ kerning, spaces drawn with a
//    separate simple font, every run in its own q/BT…ET/Q with an MCID span, a bold label, a link.
// 8. TeX-style: TJ arrays with kerning and word gaps, no space glyphs.
// 9. Operator corner cases: Tc, Tw, Tz, Ts, Tw-justified lines.
{
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const reg = await doc.embedFont(await readFile('public/fonts/Carlito-Regular.ttf'), { subset: true })
  const bold = await doc.embedFont(await readFile('public/fonts/Carlito-Bold.ttf'), { subset: true })
  const serif = await doc.embedFont(await readFile('public/fonts/Tinos-Regular.ttf'), { subset: true })
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  const R = page.node.newFontDictionary('Reg', reg.ref)
  const B = page.node.newFontDictionary('Bold', bold.ref)
  const S = page.node.newFontDictionary('Serif', serif.ref)
  const H = page.node.newFontDictionary('Helv', helv.ref)
  const lines = []
  let mcid = 0
  /** One Word-style run: kerned TJ for letters; a space is a separate run in Helvetica. */
  const wordRun = (font, key, x, y, text, color = [0, 0, 0]) => {
    const arr = PDFArray.withContext(doc.context)
    ;[...text].forEach((ch, i) => {
      if (i) arr.push(PDFNumber.of(((i * 7) % 5) - 2)) // small kerning, like Word's rounding
      arr.push(font.encodeText(ch))
    })
    lines.push([
      ['BDC', PDFName.of('Span'), doc.context.obj({ MCID: mcid++ })],
      ['q'],
      ['BT'],
      ['Tf', key, 11],
      ['rg', ...color],
      ['Tm', 1, 0, 0, 1, x, y],
      ['TJ', arr],
      ['ET'],
      ['Q'],
      ['EMC'],
    ])
    return x + font.widthOfTextAtSize(text, 11)
  }
  const wordLine = (y, parts) => {
    let x = 72
    parts.forEach(([font, key, text, color], i) => {
      if (i) {
        lines.push([['BT'], ['Tf', H, 11], ['Tm', 1, 0, 0, 1, x, y], ['Tj', helv.encodeText(' ')], ['ET']])
        x += helv.widthOfTextAtSize(' ', 11) - 0.6
      }
      x = wordRun(font, key, x, y, text, color)
    })
  }
  wordLine(780, [[bold, B, 'Name:'], [reg, R, 'John'], [reg, R, 'Smith,'], [reg, R, 'email'], [reg, R, 'john.smith@example.com', [0.02, 0.39, 0.76]]])
  wordLine(760, [[reg, R, 'Status:'], [bold, B, 'OVERDUE', [0.8, 0, 0]], [reg, R, 'since'], [reg, R, '3'], [reg, R, 'March'], [reg, R, '2026']])
  wordLine(740, [[reg, R, 'Invoice'], [reg, R, 'processing'], [reg, R, 'time'], [reg, R, 'fell'], [reg, R, 'by'], [reg, R, '40'], [reg, R, 'percent']])

  // TeX-style lines.
  const tex = (y, words) => {
    const arr = PDFArray.withContext(doc.context)
    words.forEach((w, i) => {
      if (i) arr.push(PDFNumber.of(-333))
      arr.push(serif.encodeText(w.slice(0, 1)))
      if (w.length > 1) {
        arr.push(PDFNumber.of(15))
        arr.push(serif.encodeText(w.slice(1)))
      }
    })
    lines.push([['BT'], ['Tf', S, 10.9], ['Td', 72, y], ['TJ', arr], ['ET']])
  }
  tex(700, ['Electronics', 'and', 'Communication', 'Engineering', 'department'])
  tex(686, ['Indian', 'Institute', 'of', 'Technology,', 'second', 'campus'])

  // Operator corner cases (standard Helvetica, not embedded).
  const str = (t) => helv.encodeText(t)
  const at = (y, ...ops) => lines.push([['BT'], ['Tf', H, 12], ['Td', 72, y], ...ops, ['ET']])
  at(640, ['Tc', 1.5], ['Tj', str('Character spacing with Tc on this line')], ['Tc', 0])
  at(615, ['Tw', 6], ['Tj', str('Word spacing with Tw six on this line')], ['Tw', 0])
  at(590, ['Tz', 75], ['Tj', str('Horizontal scaling Tz seventy five here')], ['Tz', 100])
  at(565, ['Tj', str('Energy E = mc')], ['Ts', 5], ['Tf', H, 8], ['Tj', str('2')], ['Ts', 0], ['Tf', H, 12], ['Tj', str(' holds here')])
  for (const [i, t] of ['Justified by word spacing: the board approved', 'the revised allocation for outreach work'].entries()) {
    const nat = helv.widthOfTextAtSize(t, 12)
    at(530 - i * 16, ['Tw', (420 - nat) / (t.split(' ').length - 1)], ['Tj', str(t)], ['Tw', 0])
  }
  textOps(page, lines)
  page.drawText('Plain reference line in Helvetica twelve', { x: 72, y: 470, size: 12, font: helv })
  await writeFile(`${OUT}/word-style.pdf`, await doc.save())
}

// --- Redaction (npm run test:redaction) -----------------------------------------------------------
// Everything a careless redaction leaks: live text under a drawn black box ("Manafort-style"),
// personal data in the text, an image and a vector drawing to black out, a comment, a form value,
// a mailto link, a hidden layer, metadata + XMP, JavaScript, an attachment, a bookmark, OCR text.
{
  const browser = await chromium.launch()
  const shot = await browser.newPage({ viewport: { width: 120, height: 60 } })
  // Left half green, right half pure red: no red pixel may survive the redaction.
  await shot.setContent('<body style="margin:0;display:flex"><div style="width:60px;height:60px;background:#00b050"></div><div style="width:60px;height:60px;background:#ff0000"></div></body>')
  const png = await shot.screenshot({ type: 'png' })
  const scanPage = await browser.newPage({ viewport: { width: 612, height: 792 }, deviceScaleFactor: 1.5 })
  await scanPage.setContent(`<body style="margin:0;background:#f4f2ea;font:16px Georgia,serif;color:#222;padding:80px">
    <p style="margin:0 0 0">Invisible OCR line mentions John Q. Sample here.</p><p>Second scanned line stays readable.</p></body>`)
  const jpg = await scanPage.screenshot({ type: 'jpeg', quality: 80 })
  await browser.close()

  const doc = await PDFDocument.create()
  const ctx = doc.context
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([595, 842])
  const line = (t, y, size = 12) => p.drawText(t, { x: 72, y, size, font: helv })
  line('Case file 2026-114', 780, 18)
  line('Name: John Q. Sample', 740)
  line('Email: john.sample@example.com', 720)
  line('PAN: ABCDE1234F', 700)
  line('Card: 4111 1111 1111 1111', 680)
  line('Phone: +91 98765 43210', 660)
  line('Unrelated paragraph stays exactly as it was.', 640)
  // Manafort-style: a black rectangle drawn over text that is still in the file.
  line('Wire to account 99-ZEBRA-7731 today.', 600)
  p.drawRectangle({ x: 125, y: 596, width: 140, height: 16, color: rgb(0, 0, 0) })
  p.drawImage(await doc.embedPng(png), { x: 72, y: 480, width: 120, height: 60 })
  // A vector "signature" with distinctive coordinates.
  p.drawSvgPath('M 301.37 0 C 320 -30, 340 20, 360 -10 S 390 -20, 398.61 5', { x: 0, y: 530, borderColor: rgb(0.1, 0.1, 0.5), borderWidth: 1.5 })
  // Hidden layer (switched off by default).
  const ocg = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFHexString.fromText('Internal notes') }))
  p.node.Resources().set(PDFName.of('Properties'), ctx.obj({ oc1: ocg }))
  const hidden = ctx.flateStream(`/OC /oc1 BDC BT /${p.node.newFontDictionary('HL', helv.ref).decodeText()} 12 Tf 72 420 Td (HIDDEN-LAYER-QX9 secret) Tj ET EMC`)
  p.node.addContentStream(ctx.register(hidden))
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocg], D: ctx.obj({ OFF: [ocg], Order: [ocg] }) }))
  // A comment, a form field, a mailto link over the email line.
  const comment = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 760, 520, 780], Contents: PDFHexString.fromText('Reviewer note about John Q. Sample'), Open: false }),
  )
  const mailto = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [110, 716, 260, 732], Border: [0, 0, 0], A: ctx.obj({ S: 'URI', URI: PDFHexString.fromText('mailto:john.sample@example.com') }) }),
  )
  const form = doc.getForm()
  const applicant = form.createTextField('applicant')
  applicant.setText('John Q. Sample')
  applicant.addToPage(p, { x: 300, y: 380, width: 200, height: 22 })
  p.node.Annots().push(comment)
  p.node.Annots().push(mailto)
  // Metadata, XMP, JavaScript, attachment, bookmark.
  doc.setTitle('Report on John Q. Sample')
  doc.setAuthor('Agent K')
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Report on John Q. Sample</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })))
  const js = ctx.register(ctx.obj({ S: 'JavaScript', JS: PDFHexString.fromText("app.alert('Hello John Q. Sample');") }))
  doc.catalog.set(PDFName.of('OpenAction'), js)
  await doc.attach(Buffer.from('John Q. Sample secret notes'), 'notes.txt', { mimeType: 'text/plain' })
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ JavaScript: ctx.obj({ Names: [PDFHexString.fromText('greet'), js] }) }))
  const outlines = ctx.nextRef()
  const item = ctx.register(ctx.obj({ Title: PDFHexString.fromText('Profile of John Q. Sample'), Parent: outlines, Dest: [p.ref, PDFName.of('Fit')] }))
  ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }))
  doc.catalog.set(PDFName.of('Outlines'), outlines)
  // Page 2: a "scan" with an invisible OCR layer.
  const p2 = doc.addPage([612, 792])
  p2.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 612, height: 792 })
  const ocr = p2.node.newFontDictionary('OCR', helv.ref)
  p2.pushOperators(
    pushGraphicsState(),
    beginText(),
    setTextRenderingMode(TextRenderingMode.Invisible),
    setFontAndSize(ocr, 16),
    setTextMatrix(1, 0, 0, 1, 80, 792 - 80 - 14),
    showText(helv.encodeText('Invisible OCR line mentions John Q. Sample here.')),
    endText(),
    popGraphicsState(),
  )
  await writeFile(`${OUT}/redaction.pdf`, await doc.save({ updateFieldAppearances: true }))

  // Something that can't be redacted: an inline image. The download must be refused.
  const blocked = await PDFDocument.create()
  const bp = blocked.addPage([400, 300])
  bp.drawText('An inline image is below.', { x: 40, y: 250, size: 12, font: await blocked.embedFont(StandardFonts.Helvetica) })
  bp.node.addContentStream(blocked.context.register(blocked.context.flateStream('q 80 0 0 80 40 120 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q')))
  await writeFile(`${OUT}/redaction-blocked.pdf`, await blocked.save())
}

// --- Paragraph reflow (npm run test:paragraphs) ---------------------------------------------------
// Two-column article, a justified legal clause, a bulleted list with hanging indents, a paragraph
// mixing bold and regular, and a Bengali paragraph — printed by Chrome with bundled fonts embedded.
{
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const face = async (fam, file, weight = 400) => `@font-face{font-family:${fam};font-weight:${weight};src:url(${await fontUrl(file)})}`
  const css = [
    await face('Arimo', 'Arimo-Regular.ttf'),
    await face('Arimo', 'Arimo-Bold.ttf', 700),
    await face('Tinos', 'Tinos-Regular.ttf'),
    await face('Bengali', 'NotoSansBengali-Regular.ttf'),
  ].join('')
  const col = 'Rivers carry sediment from the mountains to the plains, where it settles and builds fertile soil. Farmers have relied on these floods for centuries, planting after the water recedes.'
  const col2 = 'Modern dams change this rhythm. Less sediment reaches the delta, and the coastline slowly retreats while the reservoirs upstream fill with silt year after year.'
  await page.setContent(`<!doctype html><meta charset=utf-8><style>${css}
    body{margin:0;padding:48px 56px;font:11pt/1.45 Arimo;color:#111}
    h2{font:700 13pt Arimo;margin:0 0 6px}
    .cols{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-bottom:18px}
    .cols p{margin:0 0 8px}
    .legal{font:10.5pt/1.5 Tinos;text-align:justify;margin:0 0 18px}
    ul{margin:0 0 18px;padding-left:22px} li{margin:0 0 4px}
    .mixed{margin:0 0 18px} .bn{font:12pt/1.7 Bengali;margin:0}
  </style>
  <h2>Two columns</h2>
  <div class=cols><div><p id=c1>${col}</p></div><div><p id=c2>${col2}</p></div></div>
  <p class=legal id=legal>The Licensee shall not, without the prior written consent of the Licensor, assign, transfer, sublicense or otherwise dispose of any of its rights or obligations under this Agreement, and any purported assignment in breach of this clause shall be void and of no effect whatsoever.</p>
  <ul><li>First item explains the setup in enough words that it wraps onto a second line, so the hanging indent of the bullet is visible here.</li><li>Second item is a little shorter but is still long enough that it wraps onto another line of text below it.</li></ul>
  <p class=mixed id=mixed>This paragraph mixes <b>bold words</b> with regular ones, so an edit must keep the <b>emphasis</b> where it was while the rest of the sentence reflows normally.</p>
  <p class=bn id=bn>নদী পাহাড় থেকে পলি বয়ে নিয়ে আসে এবং সমভূমিতে উর্বর মাটি তৈরি করে। কৃষকেরা বহু শতাব্দী ধরে এই বন্যার উপর নির্ভর করে চাষাবাদ করে আসছেন।</p>`)
  await page.evaluate(() => document.fonts.ready)
  await writeFile(`${OUT}/paragraphs.pdf`, await page.pdf({ format: 'A4', printBackground: true }))
  await browser.close()
}

console.log('fixtures written to', OUT)
