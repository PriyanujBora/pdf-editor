// Redaction checks (Phase 4): marks made through the UI, the download, then independent readers
// (pdftotext, pypdf, PDFium, pikepdf raw object scan, Ghostscript) confirm nothing marked survived.
// Needs the dev server (npm run dev -- --port 5199) and tests/.venv (see tests/tools/README.md).
// Run: npm run fixtures && npm run test:redaction
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const URL = process.env.E2E_URL ?? 'http://localhost:5199/'
const FIX = 'tests/fixtures'
const OUT = 'tests/out'
const PY = process.platform === 'win32' ? 'tests/.venv/Scripts/python.exe' : 'tests/.venv/bin/python'
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
let failures = 0

async function test(name, viewport, fn, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: !!opts.touch, isMobile: !!opts.touch, acceptDownloads: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !/favicon|DevTools/.test(m.text()) && errors.push(m.text()))
  const t0 = Date.now()
  try {
    await page.goto(URL, { waitUntil: 'networkidle' })
    await fn(page)
    assert.deepEqual(errors, [], 'console errors')
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${err.message.split('\n').slice(0, 12).join(' ')}`, errors.length ? errors : '')
    await page.screenshot({ path: `${OUT}/FAIL-redact-${name.replace(/\W+/g, '_')}.png` }).catch(() => {})
  }
  await ctx.close()
}

const open = async (page, file) => {
  await page.setInputFiles('input[type=file]', `${FIX}/${file}`)
  await page.waitForSelector('[data-page-id] canvas', { timeout: 30000 })
  await page.waitForTimeout(400)
}
const marks = (page) => page.evaluate(() => Object.values(window.__doc.getState().elements).filter((e) => e.kind === 'redact'))
const pagePoint = async (page, i, x, y) => {
  const box = await page.locator('[data-page-id]').nth(i).boundingBox()
  const zoom = await page.evaluate(() => window.__ui.getState().zoom)
  return { x: box.x + x * zoom, y: box.y + y * zoom }
}
/** Drags out an area mark from page-space (x0, y0) to (x1, y1). */
const dragMark = async (page, i, x0, y0, x1, y1) => {
  const a = await pagePoint(page, i, x0, y0)
  const b = await pagePoint(page, i, x1, y1)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(150)
}
const find = async (page, query, presets = []) => {
  await page.fill('[data-testid=redact-query]', query)
  for (const p of presets) await page.click(`[data-testid=preset-${p}]`)
  await page.click('[data-testid=redact-find]')
  await page.waitForSelector('[data-testid=redact-results]', { timeout: 30000 })
  const txt = await page.textContent('[data-testid=redact-results]')
  for (const p of presets) await page.click(`[data-testid=preset-${p}]`) // toggle back off
  return txt
}
/** Download through the confirmation; returns the saved path, or null if no file came. */
const redactDownload = async (page, name) => {
  const dl = page.waitForEvent('download', { timeout: 60000 }).catch(() => null)
  await page.click('[data-testid=download]')
  await page.getByRole('button', { name: /Redact and download|Clean up and download/ }).click()
  const blocked = page.waitForSelector('[data-testid=blocked-reasons]', { timeout: 60000 }).then(() => 'blocked', () => null)
  const winner = await Promise.race([dl, blocked])
  if (winner === 'blocked' || !winner) return null
  const path = `${OUT}/${name}`
  await winner.saveAs(path)
  return path
}

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

await test('find & redact, areas, clean-up → verified download', DESKTOP, async (page) => {
  await open(page, 'redaction.pdf')
  await page.click('[data-tool=redact]')
  await page.waitForSelector('[data-testid=redact-panel]')

  let res = await find(page, 'John Q. Sample')
  assert.match(res, /2 matches on 2 pages/, res)
  await page.click('[data-testid=redact-mark-all]')
  res = await find(page, '', ['email', 'pan', 'card', 'phone'])
  assert.match(res, /4 matches on 1 page/, res)
  await page.click('[data-testid=redact-mark-all]')
  assert.equal((await marks(page)).length, 6)
  // Undo removes a whole "Mark all" in one step; redo brings it back.
  await page.keyboard.press('Control+z')
  assert.equal((await marks(page)).length, 2)
  await page.keyboard.press('Control+y')
  assert.equal((await marks(page)).length, 6)

  await dragMark(page, 0, 120, 228, 270, 248) // "Manafort" text under a drawn black box
  await dragMark(page, 0, 130, 298, 196, 366) // red half of the image
  await dragMark(page, 0, 290, 258, 410, 346) // the vector signature
  assert.equal((await marks(page)).length, 9)
  await page.screenshot({ path: `${OUT}/redact-marks.png` })

  for (const k of ['metadata', 'javascript', 'attachments', 'hiddenLayers', 'comments', 'formValues']) await page.check(`[data-testid=sanitize-${k}]`)
  const path = await redactDownload(page, 'redacted.pdf')
  const toasts = await page.locator('[data-sonner-toast]').allTextContents()
  assert.ok(toasts.some((t) => t.includes('Redacted and verified: 0 matches remain')), 'no verified toast: ' + JSON.stringify(toasts))
  await page.screenshot({ path: `${OUT}/redact-verified.png` })
  const out = spawnSync(PY, ['tests/tools/redaction.py', path], { encoding: 'utf8' }).stdout
  console.log(out.trim().replace(/^/gm, '    '))
  assert.match(out, /^RESULT PASS/m)
})

await test('leaks elsewhere in the file block the download', DESKTOP, async (page) => {
  await open(page, 'redaction.pdf')
  await page.click('[data-tool=redact]')
  await find(page, 'John Q. Sample')
  await page.click('[data-testid=redact-mark-all]')
  const path = await redactDownload(page, 'should-not-exist.pdf')
  assert.equal(path, null, 'a file was downloaded although the name is still in the metadata')
  const why = await page.textContent('[data-testid=blocked-reasons]')
  for (const where of ['document properties', 'attachment', 'JavaScript', 'comment', 'form field']) assert.ok(why.includes(where), `no reason mentions ${where}: ${why}`)
  await page.screenshot({ path: `${OUT}/redact-blocked-leaks.png` })
})

await test('what can’t be removed blocks the download (inline image)', DESKTOP, async (page) => {
  await open(page, 'redaction-blocked.pdf')
  await page.click('[data-tool=redact]')
  await dragMark(page, 0, 30, 90, 130, 190)
  assert.equal((await marks(page)).length, 1)
  const path = await redactDownload(page, 'should-not-exist.pdf')
  assert.equal(path, null)
  assert.match(await page.textContent('[data-testid=blocked-reasons]'), /inline image/)
})

await test('phone: tap a word to mark it, Find opens the panel', PHONE, async (page) => {
  await open(page, 'redaction.pdf')
  await page.click('[data-tool=more]')
  await page.click('[role=menuitem][data-tool=redact]')
  // "John" on the Name line: baseline at y 102, "Name: " is 38.7 pt wide in Helvetica 12.
  const q = await pagePoint(page, 0, 120, 98)
  await page.touchscreen.tap(q.x, q.y)
  await page.waitForTimeout(400)
  const m = await marks(page)
  assert.equal(m.length, 1, 'tap made no mark')
  assert.equal(m[0].text, 'John')
  await page.click('[data-tool=props]')
  await page.waitForSelector('[data-testid=redact-panel]')
  await page.screenshot({ path: `${OUT}/redact-phone.png` })
}, { touch: true })

await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
