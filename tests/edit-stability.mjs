// Edit-stability harness: on every editable line of every fixture and corpus file,
//   1. enter edit mode, change nothing, leave → editor pixels identical, no element, no undo step
//   2. while editing → editor pixels identical to before the click (caret excepted)
//   3. replace one word with a same-length word (its letters reversed) → in the export every other
//      word keeps its exact pixels; the new word has the original glyph height
//   4. insert a character the PDF's font lacks (₹) → words before it untouched, words after it move by
//      one constant offset with their own font, only the ₹ uses a stand-in
//   5. size: glyph heights of new/moved glyphs within 2 % of the originals
//   6. removed: in the export, the edited line's text no longer contains the old word (it was removed
//      from the content stream, not just covered) and does contain the new one
// Needs the dev server (`npm run dev -- --port 5199`) and the PDF tools venv (tests/tools/README.md).
// Run: npm run test:edit-stability [-- file-filter]
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const URL = process.env.E2E_URL ?? 'http://localhost:5199/'
const OUT = 'tests/out/stability'
const PY = process.env.PDF_TOOLS_PY ?? (existsSync('tests/.venv/Scripts/python.exe') ? 'tests/.venv/Scripts/python.exe' : 'tests/.venv/bin/python')
const MAX_LINES = +(process.env.MAX_LINES ?? 60)
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null

const files = [
  ...['text-heavy.pdf', 'chrome-producer.pdf', 'word-style.pdf'].map((f) => `tests/fixtures/${f}`),
  ...(existsSync('tests/corpus') ? readdirSync('tests/corpus').filter((f) => f.endsWith('.pdf')).map((f) => `tests/corpus/${f}`) : []),
].filter((f) => !filter || filter.test(f))

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const TA = 'textarea[aria-label="Edit text"]'
const report = []

for (const file of files) {
  const name = path.basename(file, '.pdf')
  const dir = `${OUT}/${name}`
  await mkdir(dir, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.setInputFiles('input[type=file]', file)
  await page.waitForSelector('[data-page-id] canvas', { timeout: 30000 })
  const zoom = 1.5
  await page.evaluate((z) => window.__ui.getState().setZoom(z), zoom)
  await page.waitForTimeout(1200)

  const blocks = await page.evaluate(async () => {
    const tb = await import('/src/lib/pdf/text-blocks.ts')
    const p = await window.__session.getState().pdf.getPage(1)
    return (await tb.getTextBlocks(p, '0'))
      .filter((b) => b.source && !b.ocr)
      .map((b) => ({ text: b.text, box: b.source.box, baseline: b.source.baseline, justified: b.source.justified, charGlyph: b.source.charGlyph, glyphs: b.source.glyphs.map((g) => [g.x, g.adv]) }))
  })
  const lines = blocks.filter((b) => b.box.width > 4).slice(0, MAX_LINES)

  const locate = async (b) => {
    await page.evaluate(
      ({ y, zoom }) => {
        const v = document.querySelector('[data-testid=viewer]')
        const el = document.querySelector('[data-page-id]')
        v.scrollTop = el.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop + y * zoom - v.clientHeight * 0.4
      },
      { y: b.box.y, zoom },
    )
    await page.waitForTimeout(250)
    const pb = await page.locator('[data-page-id]').first().boundingBox()
    const vb = await page.locator('[data-testid=viewer]').boundingBox()
    const r = { x: pb.x + b.box.x * zoom, y: pb.y + b.box.y * zoom, w: b.box.width * zoom, h: b.box.height * zoom }
    // Stay clear of the viewer's overlay scrollbar, which fades in and out.
    const right = Math.min(vb.x + vb.width - 24, pb.x + pb.width)
    const x = Math.max(vb.x, r.x - 6)
    return { r, clip: { x, y: Math.max(0, r.y - 4), width: Math.max(4, Math.min(right, r.x + r.w + 6) - x), height: r.h + 8 } }
  }
  const away = () => page.mouse.move(2, 2)
  const reset = () =>
    page.evaluate(() => {
      const t = window.__doc.temporal.getState()
      while (window.__doc.temporal.getState().pastStates.length) t.undo()
      window.__ui.getState().set({ selectedId: null, editingId: null })
    })
  const clickLine = async (r, at = 0.5) => {
    await page.evaluate(() => window.__ui.getState().set({ selectedId: null, editingId: null }))
    await page.mouse.click(r.x + Math.max(2, r.w * at), r.y + r.h / 2)
    await page.waitForSelector(TA, { timeout: 8000 })
  }

  // Checks 1 + 2 (editor).
  const editor = []
  for (const [i, b] of lines.entries()) {
    try {
      const { r, clip } = await locate(b)
      await away()
      await page.waitForTimeout(120)
      await page.screenshot({ path: `${dir}/${i}-a.png`, clip })
      await clickLine(r)
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${dir}/${i}-b.png`, clip })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      const st = await page.evaluate(() => ({
        els: Object.keys(window.__doc.getState().elements).length,
        undo: window.__doc.temporal.getState().pastStates.length,
      }))
      await away()
      await page.waitForTimeout(150)
      await page.screenshot({ path: `${dir}/${i}-c.png`, clip })
      editor.push({ i, ...st })
    } catch (err) {
      editor.push({ i, error: err.message.split('\n')[0] })
    }
  }

  // Check 3: reverse one word per line (same glyphs, same width) → one export.
  const c3 = []
  await reset()
  for (const [i, b] of lines.entries()) {
    const words = [...b.text.matchAll(/[\p{L}]{4,}/gu)].filter((m) => !/[ऀ-෿]/.test(m[0]) && new Set(m[0]).size > 1)
    const w = words[Math.floor(words.length / 2)]
    if (!w) continue
    const rev = [...w[0]].reverse().join('')
    if (rev === w[0]) continue
    try {
      const { r } = await locate(b)
      await clickLine(r)
      const next = b.text.slice(0, w.index) + rev + b.text.slice(w.index + w[0].length)
      await page.fill(TA, next)
      await page.keyboard.press('Escape')
      const gi = b.charGlyph.slice(w.index, w.index + w[0].length).filter((g) => g >= 0)
      const x0 = Math.min(...gi.map((g) => b.glyphs[g][0]))
      const x1 = Math.max(...gi.map((g) => b.glyphs[g][0] + b.glyphs[g][1]))
      c3.push({ i, box: b.box, baseline: b.baseline, word: { x0, x1 }, n: [...w[0]].length, old: w[0], new: rev })
    } catch (err) {
      c3.push({ i, error: err.message.split('\n')[0] })
    }
  }
  const exportTo = async (p) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid=download]')])
    await dl.saveAs(p)
  }
  await exportTo(`${dir}/c3.pdf`)

  // Check 4: insert "₹" before the second word → one export.
  const c4 = []
  await reset()
  for (const [i, b] of lines.entries()) {
    const m = /\s+(?=\S)/.exec(b.text)
    if (!m || /[ऀ-෿]/.test(b.text)) continue
    const at = m.index + m[0].length
    try {
      const { r } = await locate(b)
      await clickLine(r)
      await page.fill(TA, b.text.slice(0, at) + '₹' + b.text.slice(at))
      await page.keyboard.press('Escape')
      const g = b.charGlyph.slice(at).find((g) => g >= 0)
      c4.push({ i, box: b.box, baseline: b.baseline, justified: b.justified, insertX: b.glyphs[g][0], after: [...b.text.slice(at)].filter((c) => c.trim()).length })
    } catch (err) {
      c4.push({ i, error: err.message.split('\n')[0] })
    }
  }
  await exportTo(`${dir}/c4.pdf`)
  await ctx.close()
  const spec = { file, name, dir, lines: lines.map((b) => ({ text: b.text })), editor, c3, c4, errors }
  await writeFile(`${dir}/spec.json`, JSON.stringify(spec, null, 1))
  report.push(`${dir}/spec.json`)
  console.log(`${name}: ${lines.length} lines`)
}
await browser.close()

const out = execFileSync(PY, ['-I', 'tests/tools/stability.py', ...report], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
process.stdout.write(out)
if (/^RESULT FAIL/m.test(out)) process.exitCode = 1
