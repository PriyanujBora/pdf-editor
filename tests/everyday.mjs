// Phase 6 everyday jobs: signatures (and, as they land, annotations, pages, fields, compress).
// Needs the dev server (npm run dev -- --port 5199) and tests/.venv. Run: npm run test:everyday
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const URL = process.env.E2E_URL ?? 'http://localhost:5199/'
const FIX = 'tests/fixtures'
const OUT = 'tests/out/everyday'
const PY = process.platform === 'win32' ? 'tests/.venv/Scripts/python.exe' : 'tests/.venv/bin/python'
await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
let failures = 0
const only = process.argv[2]

export async function test(name, fn, opts = {}) {
  if (only && !name.includes(only)) return
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 }, acceptDownloads: true, hasTouch: !!opts.touch, isMobile: !!opts.touch })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !/favicon|DevTools/.test(m.text()) && errors.push(m.text()))
  try {
    await page.goto(URL, { waitUntil: 'networkidle' })
    await fn(page)
    assert.deepEqual(errors, [], 'console errors')
    console.log(`PASS ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${err.message.split('\n').slice(0, 8).join(' ')}`)
    await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }).catch(() => {})
  }
  await ctx.close()
}
const open = async (page, file) => {
  await page.setInputFiles('input[type=file]', `${FIX}/${file}`)
  await page.waitForSelector('[data-page-id] canvas', { timeout: 30000 })
  await page.waitForTimeout(400)
}
const pagePoint = async (page, i, x, y) => {
  const box = await page.locator('[data-page-id]').nth(i).boundingBox()
  const zoom = await page.evaluate(() => window.__ui.getState().zoom)
  return { x: box.x + x * zoom, y: box.y + y * zoom }
}
const download = async (page, name) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid=download]')])
  const path = `${OUT}/${name}`
  await dl.saveAs(path)
  return path
}
const py = (code, ...args) => {
  const r = spawnSync(PY, ['-W', 'ignore', '-c', code, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr.slice(-600))
  return r.stdout.trim()
}
const elements = (page) => page.evaluate(() => Object.values(window.__doc.getState().elements))

await test('signatures: draw + date, reuse saved, typed, uploaded', async (page) => {
  await open(page, 'text-heavy.pdf')
  await page.click('[data-tool=sign]')
  await page.waitForSelector('[data-testid=sign-dialog]')
  // Draw a scribble.
  const pad = await page.locator('[data-testid=sign-pad]').boundingBox()
  await page.mouse.move(pad.x + 40, pad.y + 120)
  await page.mouse.down()
  for (let i = 0; i <= 30; i++) await page.mouse.move(pad.x + 40 + i * 14, pad.y + 100 + Math.sin(i / 3) * 50)
  await page.mouse.up()
  await page.check('[data-testid=sign-date]')
  await page.click('[data-testid=sign-place]')
  await page.waitForSelector('[data-testid=sign-dialog]', { state: 'detached', timeout: 10000 })
  let p = await pagePoint(page, 0, 420, 330)
  await page.mouse.click(p.x, p.y)
  let els = await elements(page)
  assert.equal(els.filter((e) => e.kind === 'image').length, 1, 'signature placed')
  assert.equal(els.filter((e) => e.kind === 'text').length, 1, 'date placed')
  await page.screenshot({ path: `${OUT}/signature-placed.png` })
  // Saved signatures come back first.
  await page.click('[data-tool=sign]')
  await page.waitForSelector('[data-testid=sign-tab-saved][aria-selected=true]')
  // Typed.
  await page.click('[data-testid=sign-tab-type]')
  await page.fill('[data-testid=sign-name]', 'Ada Lovelace')
  await page.waitForFunction(() => !document.querySelector('[data-testid=sign-place]').disabled)
  await page.click('[data-testid=sign-place]')
  await page.waitForSelector('[data-testid=sign-dialog]', { state: 'detached', timeout: 10000 })
  p = await pagePoint(page, 0, 200, 330)
  await page.mouse.click(p.x, p.y)
  // Uploaded photo, paper removed.
  await page.click('[data-tool=sign]')
  await page.click('[data-testid=sign-tab-upload]')
  await page.setInputFiles('[data-testid=sign-upload]', `${FIX}/signature-photo.png`)
  await page.waitForTimeout(300)
  await page.click('[data-testid=sign-place]')
  await page.waitForSelector('[data-testid=sign-dialog]', { state: 'detached', timeout: 10000 })
  p = await pagePoint(page, 0, 300, 420)
  await page.mouse.click(p.x, p.y)
  els = await elements(page)
  assert.equal(els.filter((e) => e.kind === 'image').length, 3)
  // The uploaded one is transparent where the paper was.
  const corner = await page.evaluate(async () => {
    const s = window.__session.getState()
    const imgs = Object.values(window.__doc.getState().elements).filter((e) => e.kind === 'image')
    const a = s.assets[imgs[2].assetId]
    const bmp = await createImageBitmap(new Blob([a.bytes], { type: 'image/png' }))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')
    ctx.drawImage(bmp, 0, 0)
    return [ctx.getImageData(1, 1, 1, 1).data[3], bmp.width, bmp.height]
  })
  assert.equal(corner[0], 0, 'paper should be transparent')
  await page.screenshot({ path: `${OUT}/signatures.png` })
  const path = await download(page, 'signed.pdf')
  const out = py(
    `import sys, pikepdf, subprocess
pdf = pikepdf.open(sys.argv[1])
imgs = [o for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.get('/Subtype') == '/Image' and '/SMask' in o]
txt = subprocess.run(['pdftotext', '-f', '1', '-l', '1', sys.argv[1], '-'], capture_output=True).stdout.decode('utf-8', 'replace')
print(len(imgs), 'date' if any(m in txt for m in ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']) else 'nodate')`,
    path,
  )
  assert.match(out, /^3 date$/, out)
})

await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
