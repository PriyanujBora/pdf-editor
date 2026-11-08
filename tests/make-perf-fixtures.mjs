// Big PDFs for the performance budgets (npm run test:perf). Run: npm run fixtures:perf
// Writes tests/fixtures/perf-*.pdf (gitignored): 500-page text, 2,000-page text, ~50 MB and ~150 MB scans.
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib'
import { chromium } from 'playwright'

const OUT = 'tests/fixtures'
await mkdir(OUT, { recursive: true })
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer nec odio. Praesent libero. Sed cursus ante dapibus diam.'

async function textPdf(pages, lines, file) {
  const doc = await PDFDocument.create()
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595, 842])
    p.drawText(`Page ${i + 1}`, { x: 56, y: 790, size: 16, font: helv })
    for (let l = 0; l < lines; l++) p.drawText(`${l + 1}. ${LOREM}`, { x: 56, y: 760 - l * 16, size: 9.5, font: helv })
  }
  await writeFile(`${OUT}/${file}`, await doc.save({ useObjectStreams: true }))
}

await textPdf(500, 42, 'perf-500.pdf')
await textPdf(2000, 12, 'perf-2000.pdf')

// A noisy A4 "scan" at 300 dpi barely compresses: a few MB of JPEG per page.
const browser = await chromium.launch()
const page = await browser.newPage()
const jpg = Buffer.from(
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(2480, 3508)
    const ctx = c.getContext('2d')
    const img = ctx.createImageData(c.width, c.height)
    let s = 12345
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const v = 200 + (s % 56)
      img.data[i] = img.data[i + 1] = v
      img.data[i + 2] = v - 10
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    ctx.fillStyle = '#222'
    ctx.font = '48px serif'
    for (let y = 300; y < 3300; y += 90) ctx.fillText('Scanned page — lorem ipsum dolor sit amet, consectetur adipiscing elit.', 200, y)
    const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    return [...new Uint8Array(await b.arrayBuffer())]
  }),
)
await browser.close()

async function scanPdf(targetMB, file) {
  const doc = await PDFDocument.create()
  const n = Math.max(1, Math.round((targetMB * 1e6) / jpg.length))
  for (let i = 0; i < n; i++) {
    const img = await doc.embedJpg(jpg)
    doc.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 })
  }
  await writeFile(`${OUT}/${file}`, await doc.save())
  console.log(file, n, 'pages', ((await stat(`${OUT}/${file}`)).size / 1e6).toFixed(1), 'MB')
}
await scanPdf(50, 'perf-scan-50.pdf')
await scanPdf(150, 'perf-scan-150.pdf')
console.log('perf fixtures written; jpeg per page', (jpg.length / 1e6).toFixed(2), 'MB')
