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
