// Paragraph reflow (Phase 5): click a printed paragraph, edit it, download, and check the export with
// PDFium (tests/tools/paragraphs.py): new text in order, inside the column, justified lines full,
// hanging indents kept, bold words still bold, Bengali clusters whole, neighbours untouched.
// Needs the dev server (npm run dev -- --port 5199) and tests/.venv. Run: npm run test:paragraphs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const URL = process.env.E2E_URL ?? 'http://localhost:5199/'
const FIX = 'tests/fixtures/paragraphs.pdf'
const OUT = 'tests/out/paragraphs'
const PY = process.platform === 'win32' ? 'tests/.venv/Scripts/python.exe' : 'tests/.venv/bin/python'
const TA = 'textarea[aria-label="Edit text"]'
await mkdir(OUT, { recursive: true })

const locate = (phrase) => JSON.parse(execFileSync(PY, ['-W', 'ignore', 'tests/tools/paragraphs.py', 'locate', FIX, phrase], { encoding: 'utf8' }))
const browser = await chromium.launch()
const spec = []
let failures = 0

async function withPage(fn) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !/favicon|DevTools/.test(m.text()) && errors.push(m.text()))
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.setInputFiles('input[type=file]', FIX)
  await page.waitForSelector('[data-page-id] canvas')
  await page.waitForTimeout(700)
  try {
    await fn(page)
    assert.deepEqual(errors, [], 'console errors')
  } finally {
    await page.close()
  }
}
const screen = async (page, x, y) => {
  const box = await page.locator('[data-page-id]').first().boundingBox()
  const z = await page.evaluate(() => window.__ui.getState().zoom)
  return { x: box.x + x * z, y: box.y + y * z }
}
const clickPhrase = async (page, phrase, alt = false) => {
  const b = locate(phrase)
  assert.ok(b, `phrase not found: ${phrase}`)
  const p = await screen(page, (b.x + b.x1) / 2, (b.y + b.y1) / 2)
  if (alt) await page.keyboard.down('Alt')
  await page.mouse.click(p.x, p.y)
  if (alt) await page.keyboard.up('Alt')
  await page.waitForSelector(TA, { timeout: 8000 })
  return page.evaluate(() => {
    const id = window.__ui.getState().editingId
    const el = window.__doc.getState().elements[id]
    return { id, text: el.text, box: el.source.box, lines: el.source.para?.lines.length ?? 1, align: el.source.para?.align ?? null, right: el.source.para?.right, left: el.source.para?.left }
  })
}
const download = async (page, name) => {
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__ui.getState().set({ selectedId: null, editingId: null }))
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid=download]')])
  const path = `${OUT}/${name}.pdf`
  await dl.saveAs(path)
  return path
}

async function test(name, fn) {
  try {
    await withPage(fn)
    console.log(`PASS ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${err.message.split('\n').slice(0, 6).join(' ')}`)
  }
}

const region = (el) => [el.box.x, el.box.y, Math.max(el.box.x + el.box.width, el.right ?? 0), el.box.y + el.box.height]
const colTwo = () => {
  const a = locate('Modern dams')
  const b = locate('year after year.')
  return [a.x, a.y, 560, b.y1]
}

await test('two columns: a paragraph stays in its column, the other column is untouched', async (page) => {
  const el = await clickPhrase(page, 'Rivers carry')
  assert.equal(el.lines, 4, 'left column paragraph has 4 lines')
  assert.equal(el.align, 'left')
  const text = el.text.replace('sediment from the mountains', 'fine sediment from the high mountains')
  await page.fill(TA, text)
  await page.screenshot({ path: `${OUT}/two-columns-editing.png` })
  const out = await download(page, 'two-columns')
  spec.push({ name: 'two columns', src: FIX, out, region: region(el), text, within: el.box.y + el.box.height + 18, other: [colTwo()] })
})

await test('justified clause: reflowed lines stay justified', async (page) => {
  const el = await clickPhrase(page, 'The Licensee')
  assert.equal(el.align, 'justify')
  assert.equal(el.lines, 3)
  const text = el.text.replace('prior written consent', 'prior express written consent')
  await page.fill(TA, text)
  const out = await download(page, 'justified')
  spec.push({ name: 'justified', src: FIX, out, region: region(el), text, justify: true })
})

await test('bulleted list: each item is a paragraph with its hanging indent', async (page) => {
  const el = await clickPhrase(page, 'First item')
  assert.equal(el.lines, 2, 'list item has 2 lines')
  const hang = locate('First item').x
  const text = el.text.replace('explains the setup', 'carefully explains the whole setup')
  await page.fill(TA, text)
  const out = await download(page, 'list')
  const two = locate('Second item')
  spec.push({ name: 'bulleted list', src: FIX, out, region: [el.box.x, el.box.y, el.right ?? el.box.x + el.box.width, el.box.y + el.box.height], text, hanging: hang, other: [[two.x - 20, two.y, 560, two.y1 + 18]] })
})

await test('mixed bold and regular: emphasis stays on its words', async (page) => {
  const el = await clickPhrase(page, 'This paragraph mixes')
  assert.equal(el.lines, 2)
  const text = el.text.replace('with regular ones', 'with many plain regular ones')
  await page.fill(TA, text)
  const out = await download(page, 'mixed')
  spec.push({ name: 'mixed bold', src: FIX, out, region: region(el), text, bold: ['bold words', 'emphasis'] })
})

await test('Bengali paragraph: clusters stay whole across new line breaks', async (page) => {
  const el = await clickPhrase(page, 'নদী')
  assert.equal(el.lines, 2)
  // Chrome's Bengali ToUnicode reorders vowel signs, so the captured text isn't the visual text:
  // insert a new first word and compare with the source's own extraction.
  const text = 'নতুন ' + el.text
  await page.fill(TA, text)
  await page.screenshot({ path: `${OUT}/bengali-editing.png` })
  const out = await download(page, 'bengali')
  const font = JSON.parse(execFileSync(PY, ['-W', 'ignore', 'tests/tools/paragraphs.py', 'font', FIX, 'নদী'], { encoding: 'utf8' }))
  spec.push({ name: 'bengali', src: FIX, out, region: region(el), text, prefix: 'নতুন', bengali: true, font })
})

await test('overflow is outlined and Shrink to fit keeps it inside the paragraph', async (page) => {
  const el = await clickPhrase(page, 'Rivers carry')
  const text = el.text + ' Over the decades this has shaped entire villages, markets and festivals along the banks.'
  await page.fill(TA, text)
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid=para-overflow]')
  await page.screenshot({ path: `${OUT}/overflow.png` })
  await page.click('[data-testid=shrink-to-fit]')
  await page.waitForTimeout(200)
  assert.equal(await page.locator('[data-testid=para-overflow]').count(), 0, 'still overflowing after Shrink to fit')
  const out = await download(page, 'shrunk')
  spec.push({ name: 'shrink to fit', src: FIX, out, region: region(el), text, within: el.box.y + el.box.height, other: [colTwo()] })
})

await test('clicking a paragraph and leaving changes nothing; Alt-click edits one line', async (page) => {
  await clickPhrase(page, 'The Licensee')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  const st = await page.evaluate(() => ({ n: Object.keys(window.__doc.getState().elements).length, undo: window.__doc.temporal.getState().pastStates.length }))
  assert.deepEqual(st, { n: 0, undo: 0 })
  const line = await clickPhrase(page, 'The Licensee', true)
  assert.equal(line.lines, 1, 'Alt-click should edit a single line')
  assert.equal(line.align, null)
})

await writeFile(`${OUT}/spec.json`, JSON.stringify(spec, null, 1))
await browser.close()
const r = spawnSync(PY, ['-W', 'ignore', 'tests/tools/paragraphs.py', 'check', `${OUT}/spec.json`], { encoding: 'utf8' })
console.log(r.stdout.replace(/\r/g, '').trim())
if (r.status !== 0) failures++
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
