// Smoke test of the *production build* as served by `wrangler dev` (real
// _headers / CSP, service worker). Run: npm run build && npx wrangler dev
// then: node tests/prod-smoke.mjs [url]
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const URL = process.argv[2] ?? 'http://localhost:8787/'
await mkdir('tests/out', { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const page = await ctx.newPage()
const problems = []
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
page.on('console', (m) => m.type() === 'error' && problems.push('console: ' + m.text()))
await page.addInitScript(() =>
  document.addEventListener('securitypolicyviolation', (e) =>
    console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
  ),
)

const res = await page.goto(URL, { waitUntil: 'networkidle' })
const csp = res.headers()['content-security-policy']
assert.ok(csp?.includes("connect-src 'self'"), 'CSP header served')
console.log('CSP header ok')

// Open, edit an existing line, add text, export.
await page.setInputFiles('input[type=file]', 'tests/fixtures/text-heavy.pdf')
await page.waitForSelector('[data-page-id] canvas')
await page.click('[data-tool=edit-text]')
await page.waitForTimeout(600)
const box = await page.locator('[data-page-id]').first().boundingBox()
const zoom = box.width / 595
await page.mouse.click(box.x + 120 * zoom, box.y + 120 * zoom)
await page.waitForSelector('textarea[aria-label="Edit text"]')
await page.keyboard.type('Production build edit')
await page.keyboard.press('Escape')
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=download]')])
await dl.saveAs('tests/out/prod-export.pdf')
const bytes = await readFile('tests/out/prod-export.pdf')
assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
console.log('export ok', bytes.length, 'bytes')

// Scanned PDF (image decoding in the pdf.js worker under CSP).
await page.click('[aria-label="Close file"]')
await page.setInputFiles('input[type=file]', 'tests/fixtures/scanned.pdf')
await page.waitForSelector('[data-page-id] canvas')
await page.waitForTimeout(800)
await page.screenshot({ path: 'tests/out/prod-scanned.png' })

// Scan-matched edit (raw image pixels, patch export) in the production build.
await page.click('[aria-label="Close file"]')
await page.setInputFiles('input[type=file]', 'tests/fixtures/scanned-ocr.pdf')
await page.waitForSelector('[data-page-id] canvas')
await page.waitForTimeout(1200)
const sbox = await page.locator('[data-page-id]').first().boundingBox()
const sz = sbox.width / 612
await page.mouse.click(sbox.x + 160 * sz, sbox.y + 188 * sz)
await page.waitForSelector('textarea[aria-label="Edit text"]', { timeout: 15000 })
await page.keyboard.press('End')
await page.keyboard.type(' (edited)')
await page.keyboard.press('Escape')
await page.waitForTimeout(800)
const [sdl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=download]')])
await sdl.saveAs('tests/out/prod-scan-export.pdf')
console.log('scan edit export ok')

// Encrypted file + an edit + "Keep protection": the production worker re-encrypts with the
// original passwords (checked with pikepdf when the PDF tools venv exists).
await page.click('[aria-label="Close file"]')
await page.setInputFiles('input[type=file]', 'tests/fixtures/encrypted-aes-256.pdf')
await page.waitForSelector('input[type=password]')
await page.fill('input[type=password]', 'secret')
await page.click('button:has-text("Unlock")')
await page.waitForSelector('[data-page-id] canvas')
await page.click('[data-tool=text]')
const ebox = await page.locator('[data-page-id]').first().boundingBox()
await page.mouse.click(ebox.x + 300, ebox.y + 400)
await page.keyboard.type('Kept protected')
await page.keyboard.press('Escape')
const [edl] = await Promise.all([
  page.waitForEvent('download'),
  (async () => {
    await page.click('[data-testid=download]')
    await page.click('[data-testid=choice-dialog] button:has-text("Keep protection")')
  })(),
])
await edl.saveAs('tests/out/prod-encrypted.pdf')
const { existsSync } = await import('node:fs')
const py = existsSync('tests/.venv/Scripts/python.exe') ? 'tests/.venv/Scripts/python.exe' : 'tests/.venv/bin/python'
if (existsSync(py)) {
  const { execFileSync } = await import('node:child_process')
  const check = `import pikepdf; a=pikepdf.open('tests/out/prod-encrypted.pdf', password='secret'); pikepdf.open('tests/out/prod-encrypted.pdf', password='owner'); print('encrypted', a.is_encrypted, a.encryption.R)`
  console.log(execFileSync(py, ['-I', '-c', check], { encoding: 'utf8' }).trim())
}
console.log('encrypted export ok')

// Offline: the service worker serves the app shell.
await page.evaluate(() => navigator.serviceWorker.ready)
await page.reload({ waitUntil: 'networkidle' })
await ctx.setOffline(true)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('text=Free PDF Editor', { timeout: 10000 })
await page.setInputFiles('input[type=file]', 'tests/fixtures/multi-page.pdf')
await page.waitForSelector('[data-page-id] canvas', { timeout: 15000 })
console.log('offline open ok')
await ctx.setOffline(false)

assert.deepEqual(
  problems.filter((p) => !/Failed to load resource/.test(p)),
  [],
  'no console/CSP errors',
)
console.log('PROD SMOKE PASSED')
await browser.close()
