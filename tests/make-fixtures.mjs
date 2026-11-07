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

console.log('fixtures written to', OUT)
