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

console.log('fixtures written to', OUT)
