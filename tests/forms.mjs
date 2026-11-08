// Form filling (Phase 6): fill every kind of field in tests/fixtures/form.pdf through the overlay,
// undo, download (and flatten), then check values, appearances and the rest of the form with pypdf
// and PDFium (tests/tools/forms.py). Needs the dev server and tests/.venv. Run: npm run test:forms
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const URL = process.env.E2E_URL ?? 'http://localhost:5199/'
const OUT = 'tests/out/forms'
const PY = process.platform === 'win32' ? 'tests/.venv/Scripts/python.exe' : 'tests/.venv/bin/python'
await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
let failures = 0

async function test(name, fn, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport, acceptDownloads: true })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !/favicon|DevTools/.test(m.text()) && errors.push(m.text()))
  try {
    await page.goto(URL, { waitUntil: 'networkidle' })
    await page.setInputFiles('input[type=file]', 'tests/fixtures/form.pdf')
    await page.waitForSelector('[data-field="name"]', { timeout: 20000 })
    await fn(page)
    assert.deepEqual(errors, [], 'console errors')
    console.log(`PASS ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${err.message.split('\n').slice(0, 6).join(' ')}`)
    await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }).catch(() => {})
  }
  await page.close()
}
const download = async (page, file) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid=download]')])
  await dl.saveAs(`${OUT}/${file}`)
  return `${OUT}/${file}`
}
const fill = async (page) => {
  await page.fill('[data-field="name"]', 'Grace Hopper ₹')
  await page.fill('[data-field="notes"]', 'Line one\nLine two edited')
  await page.click('[data-field="agree"]')
  await page.locator('[data-field="size"]').nth(2).click()
  await page.selectOption('[data-field="country"]', 'Kenya')
  await page.selectOption('[data-field="languages"]', 'Hindi')
}
const check = (path, args) => {
  const r = spawnSync(PY, ['-W', 'ignore', 'tests/tools/forms.py', path, ...args], { encoding: 'utf8' })
  console.log(r.stdout.replace(/\r/g, '').trim().replace(/^/gm, '    '))
  assert.equal(r.status, 0, 'form checks failed')
}

await test('fill every kind of field, undo, download', async (page) => {
  assert.equal(await page.inputValue('[data-field="name"]'), 'Ada Lovelace')
  await fill(page)
  await page.screenshot({ path: `${OUT}/filled.png` })
  // Undo the last change (list), redo it.
  await page.click('[data-testid=props], body', { position: { x: 5, y: 5 } }).catch(() => {})
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+z')
  assert.deepEqual(await page.evaluate(() => window.__doc.getState().formValues.languages), undefined)
  await page.keyboard.press('Control+y')
  assert.deepEqual(await page.evaluate(() => window.__doc.getState().formValues.languages), ['Hindi'])
  const path = await download(page, 'filled.pdf')
  check(path, ['filled'])
})

await test('flatten when downloading', async (page) => {
  await fill(page)
  await page.evaluate(() => document.activeElement?.blur())
  await page.check('[data-testid=flatten-form]')
  const path = await download(page, 'flattened.pdf')
  check(path, ['flattened'])
})

await test('values survive a reload (autosave)', async (page) => {
  await page.fill('[data-field="name"]', 'Saved Value')
  await page.waitForTimeout(1200)
  await page.reload({ waitUntil: 'networkidle' })
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('[data-field="name"]', { timeout: 20000 })
  assert.equal(await page.inputValue('[data-field="name"]'), 'Saved Value')
})

await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
