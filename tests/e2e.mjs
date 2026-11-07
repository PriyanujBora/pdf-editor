// End-to-end checks with Playwright (Chromium) at phone, tablet and desktop
// widths. Needs the dev server: `npm run dev -- --port 5199` (or E2E_URL).
// Run: npm run fixtures && npm run test:e2e
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const URL = process.env.E2E_URL ?? 'http://localhost:5199/'
const FIX = 'tests/fixtures'
const OUT = 'tests/out'
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
let failures = 0
const results = []

async function test(name, viewport, fn, opts = {}) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    hasTouch: !!opts.touch,
    isMobile: !!opts.touch,
    acceptDownloads: true,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !/favicon|DevTools/.test(m.text()) && errors.push(m.text()))
  const t0 = Date.now()
  try {
    await page.goto(URL, { waitUntil: 'networkidle' })
    await fn(page)
    assert.deepEqual(errors, [], 'console errors')
    results.push(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    failures++
    results.push(`FAIL ${name}: ${err.message.split('\n').slice(0, 8).join(' ')}`)
    await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, '_')}.png` }).catch(() => {})
  }
  console.log(results.at(-1))
  await ctx.close()
}

const open = async (page, file) => {
  await page.setInputFiles('input[type=file]', `${FIX}/${file}`)
  await page.waitForSelector('[data-page-id] canvas', { timeout: 30000 })
  await page.waitForTimeout(400)
}
const state = (page, fn) => page.evaluate(fn)
const elements = (page) => state(page, () => Object.values(window.__doc.getState().elements))
const download = async (page, name) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid=download]')])
  const path = `${OUT}/${name}`
  await dl.saveAs(path)
  return path
}
/** Client point of page-space (x, y) on page index i (no user rotation). */
const pagePoint = async (page, i, x, y) => {
  const box = await page.locator('[data-page-id]').nth(i).boundingBox()
  const zoom = await state(page, () => window.__ui.getState().zoom)
  return { x: box.x + x * zoom, y: box.y + y * zoom }
}

const DESKTOP = { width: 1440, height: 900 }
const TABLET = { width: 820, height: 1180 }
const PHONE = { width: 390, height: 844 }

// --- Desktop ---------------------------------------------------------------

await test('desktop: open text-heavy, add/edit text, image, pages, export', DESKTOP, async (page) => {
  await page.screenshot({ path: `${OUT}/desktop-landing.png` })
  await open(page, 'text-heavy.pdf')
  assert.equal(await page.locator('[data-page-id]').count(), 3)
  await page.screenshot({ path: `${OUT}/desktop-editor.png` })

  // 3. Add text
  await page.click('[data-tool=text]')
  let p = await pagePoint(page, 0, 380, 40)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.type('Added by test ✓')
  await page.keyboard.press('Escape')
  let els = await elements(page)
  assert.equal(els.length, 1, 'text added')
  assert.equal(els[0].text, 'Added by test ✓')
  // Style it via the properties panel
  await page.click('[aria-label="Bold"]')
  await page.click('[aria-label="Colour #2563eb"]')
  await page.click('[aria-label="Align center"]')
  await page.fill('[aria-label="Font size"]', '20')
  els = await elements(page)
  assert.equal(els[0].bold, true)
  assert.equal(els[0].color, '#2563eb')
  assert.equal(els[0].size, 20)

  // 4. Edit existing text
  await page.click('[data-tool=edit-text]')
  await page.waitForTimeout(500)
  p = await pagePoint(page, 0, 120, 120) // "Invoice total…" line (y≈842-716-14)
  await page.mouse.click(p.x, p.y)
  await page.waitForSelector('textarea[aria-label="Edit text"]')
  const original = await page.inputValue('textarea[aria-label="Edit text"]')
  assert.match(original, /Invoice total/)
  // Clicking only places the caret; nothing is replaced until you type.
  assert.equal((await elements(page)).filter((e) => e.kind === 'text' && e.source).length, 1)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Invoice total: $99.00 PAID')
  await page.keyboard.press('Escape')
  els = await elements(page)
  const edited = els.find((e) => e.source)
  assert.ok(edited, 'replacement created')
  assert.equal(edited.text, 'Invoice total: $99.00 PAID')
  assert.ok(Math.abs(edited.size - 14) < 0.5, `size matched (${edited.size})`)
  assert.equal(edited.font, 'roboto')
  assert.ok(/^#(1|2)/.test(edited.color), `colour sampled (${edited.color})`)
  assert.ok(edited.source.background.toLowerCase() !== '#ffffff', `patch samples box bg (${edited.source.background})`)
  await page.screenshot({ path: `${OUT}/desktop-edited.png` })

  // 5. Add an image
  await page.click('[data-tool=select]')
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-tool=image]')])
  await chooser.setFiles(`${OUT}/desktop-landing.png`)
  await page.waitForFunction(() => Object.values(window.__doc.getState().elements).some((e) => e.kind === 'image'))
  // Move it by dragging
  const img = (await elements(page)).find((e) => e.kind === 'image')
  p = await pagePoint(page, 0, img.x + img.width / 2, img.y + img.height / 2)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 60, p.y + 40, { steps: 6 })
  await page.mouse.up()
  const moved = (await elements(page)).find((e) => e.kind === 'image')
  assert.ok(moved.x > img.x + 20 && moved.y > img.y + 10, 'image dragged')
  // Rotate via panel
  await page.click('[aria-label="Rotate right"]')
  assert.equal((await elements(page)).find((e) => e.kind === 'image').rotation, 90)

  // 6. Delete + undo/redo
  await page.keyboard.press('Delete')
  assert.equal((await elements(page)).filter((e) => e.kind === 'image').length, 0, 'deleted')
  await page.keyboard.press('Control+z')
  assert.equal((await elements(page)).filter((e) => e.kind === 'image').length, 1, 'undo delete')
  await page.keyboard.press('Control+y')
  assert.equal((await elements(page)).filter((e) => e.kind === 'image').length, 0, 'redo delete')
  await page.keyboard.press('Control+z')

  // 7. Pages: rotate page 2, reorder 3 → 1, then delete & undo
  await page.click('[aria-label="Rotate page 2"]')
  const thumbs = page.locator('[data-thumb-index] button[aria-label^="Page"]')
  const a = await thumbs.nth(2).boundingBox()
  const b = await thumbs.nth(0).boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2, a.y + 10, { steps: 5 })
  await page.mouse.move(b.x + b.width / 2, b.y + 10, { steps: 12 })
  await page.mouse.up()
  const order = await state(page, () => window.__doc.getState().pages.map((p) => p.srcIndex))
  assert.deepEqual(order, [2, 0, 1])
  await page.click('[aria-label="Delete page 1"]')
  assert.equal(await page.locator('[data-page-id]').count(), 2)
  await page.keyboard.press('Control+z')
  assert.equal(await page.locator('[data-page-id]').count(), 3)
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/desktop-pages.png` })

  // 8. Download
  const path = await download(page, 'desktop-export.pdf')
  console.log('   exported →', path)
})

await test('desktop: tapping existing text in Select mode edits it', DESKTOP, async (page) => {
  await open(page, 'text-heavy.pdf')
  await page.waitForTimeout(800) // text detection
  const p = await pagePoint(page, 0, 120, 120) // "Invoice total…" line
  await page.mouse.click(p.x, p.y)
  await page.waitForSelector('textarea[aria-label="Edit text"]', { timeout: 4000 })
  assert.match(await page.inputValue('textarea[aria-label="Edit text"]'), /Invoice total/)
})

await test('desktop: clicking a line and leaving changes nothing (no element, no undo step, same pixels)', DESKTOP, async (page) => {
  await open(page, 'text-heavy.pdf')
  await page.waitForTimeout(800)
  const p = await pagePoint(page, 0, 120, 120)
  const clip = { x: p.x - 80, y: p.y - 16, width: 420, height: 32 }
  const before = await page.screenshot({ clip })
  await page.mouse.click(p.x, p.y)
  await page.waitForSelector('textarea[aria-label="Edit text"]')
  const sel = await page.evaluate(() => {
    const t = document.querySelector('textarea[aria-label="Edit text"]')
    return [t.selectionStart, t.selectionEnd]
  })
  assert.equal(sel[0], sel[1], 'caret, not a selection')
  assert.ok(sel[0] > 0 && sel[0] < 20, `caret near the click (${sel[0]})`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  assert.equal((await elements(page)).length, 0, 'no element left behind')
  assert.equal(await state(page, () => window.__doc.temporal.getState().pastStates.length), 0, 'no undo step')
  await page.mouse.move(5, 5) // hover highlight off
  await page.waitForTimeout(200)
  const after = await page.screenshot({ clip })
  assert.ok(before.equals(after), 'line pixels unchanged')
})

await test('desktop: edits default to the PDF’s own font, fall back when a glyph is missing', DESKTOP, async (page) => {
  await open(page, 'text-heavy.pdf')
  await page.waitForTimeout(800)
  const p = await pagePoint(page, 0, 120, 120) // "Invoice total…" — embedded Roboto subset (Type0)
  await page.mouse.click(p.x, p.y)
  await page.waitForSelector('textarea[aria-label="Edit text"]')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Invoice total: $12,000.00 due 30 Nov 2026')
  await page.keyboard.press('Escape')
  let el = (await elements(page))[0]
  assert.ok(!el.override, 'still drawn as printed')
  assert.match(el.source.runs[0].baseFont, /Roboto/)
  assert.match(await page.textContent('[aria-label=Font]'), /As printed/)
  // "Q" was never drawn with this subset → bundled fallback + explanation.
  await page.fill('textarea[placeholder="Type here"]', 'Quote total')
  await page.waitForSelector('text=available in the original font')
  el = (await elements(page))[0]
  assert.ok(!el.override, 'only the missing glyph falls back; the line keeps its own font')
  await download(page, 'original-font-export.pdf')
})

await test('desktop: editing OCR text on a scan blends into the scan', DESKTOP, async (page) => {
  await open(page, 'scanned-ocr.pdf')
  await page.waitForTimeout(1200)
  const p = await pagePoint(page, 0, 160, 188) // "Principal Investigator: Dr. Ananya Barua, …"
  await page.mouse.click(p.x, p.y)
  await page.waitForSelector('textarea[aria-label="Edit text"]', { timeout: 15000 })
  let el = (await elements(page))[0]
  assert.ok(el.scan, 'scan-matched (invisible OCR layer detected)')
  assert.equal(el.font, 'tinos', `Times-like scan matched to Tinos (${el.font})`)
  assert.ok(Math.abs(el.size - 13) < 1.2, `size fitted (${el.size})`)
  const v = await page.inputValue('textarea[aria-label="Edit text"]')
  await page.fill('textarea[aria-label="Edit text"]', v.replace('Barua', 'Baruah'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  el = (await elements(page))[0]
  assert.match(el.text, /Baruah/)
  // Locked to its line: no transformer handles, panel explains.
  await page.evaluate((id) => window.__ui.getState().select(id), el.id)
  await page.waitForSelector('[data-testid=scan-match]')
  await page.screenshot({ path: `${OUT}/desktop-scan-edit.png` })
  const path = await download(page, 'scan-edit-export.pdf')
  console.log('   exported →', path)
})

await test('desktop: complex scripts + rotated pages export', DESKTOP, async (page) => {
  await open(page, 'text-heavy.pdf')
  const addText = async (pageIdx, x, y, text) => {
    await page.locator('[data-page-id]').nth(pageIdx).scrollIntoViewIfNeeded()
    await page.click('[data-tool=text]')
    const p = await pagePoint(page, pageIdx, x, y)
    await page.mouse.click(p.x, p.y)
    await page.keyboard.insertText(text)
    await page.keyboard.press('Escape')
  }
  await addText(0, 60, 40, 'আমার সোনার বাংলা · नमस्ते दुनिया · Hello')
  // Page 3 has /Rotate 90 in the source; also rotate page 2 by the user.
  await addText(2, 40, 40, 'On a rotated page')
  await page.click('[aria-label="Rotate page 2"]')
  await addText(1, 40, 40, 'User-rotated page')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/desktop-scripts.png` })
  await download(page, 'scripts-export.pdf')
})

await test('desktop: ctrl+wheel zoom', DESKTOP, async (page) => {
  await open(page, 'multi-page.pdf')
  const z0 = await state(page, () => window.__ui.getState().zoom)
  const v = await page.locator('[data-testid=viewer]').boundingBox()
  await page.mouse.move(v.x + v.width / 2, v.y + 300)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -400)
  await page.keyboard.up('Control')
  const z1 = await state(page, () => window.__ui.getState().zoom)
  assert.ok(z1 > z0 * 1.5, `zoomed in ${z0} → ${z1}`)
})

await test('desktop: 40-page doc is virtualized and exports all pages', DESKTOP, async (page) => {
  await open(page, 'multi-page.pdf')
  assert.equal(await page.locator('[data-page-id]').count(), 40)
  const canvases = await page.locator('[data-page-id] canvas').count()
  assert.ok(canvases < 12, `only nearby pages rendered (${canvases})`)
  await page.locator('[data-testid=viewer]').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await page.waitForSelector('[data-page-index="39"] canvas', { timeout: 10000 })
  await page.screenshot({ path: `${OUT}/desktop-multipage-end.png` })
  await download(page, 'multi-export.pdf')
})

await test('desktop: scanned PDF shows no-text hint, still editable', DESKTOP, async (page) => {
  await open(page, 'scanned.pdf')
  await page.click('[data-tool=edit-text]')
  await page.waitForSelector('text=No editable text on this page', { timeout: 8000 })
  await page.click('[data-tool=text]')
  const p = await pagePoint(page, 0, 300, 60)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.type('APPROVED')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${OUT}/desktop-scanned.png` })
  await download(page, 'scanned-export.pdf')
})

await test('desktop: encrypted PDF asks for password', DESKTOP, async (page) => {
  await page.setInputFiles('input[type=file]', `${FIX}/encrypted.pdf`)
  await page.waitForSelector('text=Password required')
  await page.fill('input[type=password]', 'wrong')
  await page.click('button:has-text("Unlock")')
  await page.waitForSelector('text=That password didn’t work')
  await page.fill('input[type=password]', 'secret')
  await page.click('button:has-text("Unlock")')
  await page.waitForSelector('[data-page-id] canvas')
  await download(page, 'encrypted-export.pdf')
})

await test('desktop: corrupt PDF shows a friendly error', DESKTOP, async (page) => {
  await page.setInputFiles('input[type=file]', `${FIX}/corrupt.pdf`)
  await page.waitForSelector('[role=alert]')
  const msg = await page.textContent('[role=alert]')
  assert.match(msg, /valid PDF|couldn’t be opened/)
  await page.screenshot({ path: `${OUT}/desktop-corrupt.png` })
})

await test('desktop: autosave survives reload', DESKTOP, async (page) => {
  await open(page, 'text-heavy.pdf')
  await page.click('[data-tool=text]')
  const p = await pagePoint(page, 0, 300, 400)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.type('persisted')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  await page.reload({ waitUntil: 'networkidle' })
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('[data-page-id] canvas')
  const els = await elements(page)
  assert.ok(els.some((e) => e.text === 'persisted'))
})

await test('desktop: dark mode', DESKTOP, async (page) => {
  await page.click('[aria-label="Switch to dark mode"]')
  await page.screenshot({ path: `${OUT}/desktop-landing-dark.png` })
  await open(page, 'text-heavy.pdf')
  await page.screenshot({ path: `${OUT}/desktop-editor-dark.png` })
})

// --- Tablet & phone ---------------------------------------------------------

for (const [label, vp] of [
  ['tablet', TABLET],
  ['phone', PHONE],
]) {
  await test(
    `${label}: touch add text, style drawer, pages sheet, export`,
    vp,
    async (page) => {
      await page.screenshot({ path: `${OUT}/${label}-landing.png` })
      await open(page, 'text-heavy.pdf')
      await page.screenshot({ path: `${OUT}/${label}-editor.png` })
      // no horizontal overflow at fit-width
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      assert.equal(overflow, false, 'no page-level horizontal scroll')

      await page.tap('[data-tool=text]')
      const p = await pagePoint(page, 0, 80, 690)
      await page.touchscreen.tap(p.x, p.y)
      await page.waitForSelector('textarea[aria-label="Edit text"]')
      await page.keyboard.type('Signed on phone')
      await page.screenshot({ path: `${OUT}/${label}-typing.png` })
      await page.tap('[data-tool=props]')
      await page.waitForSelector('[role=dialog] >> text=Font')
      await page.tap('[role=dialog] [aria-label="Italic"]')
      await page.screenshot({ path: `${OUT}/${label}-drawer.png` })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      const el = (await elements(page))[0]
      assert.equal(el.text, 'Signed on phone')
      assert.equal(el.italic, true)

      // Touch targets in the bottom bar are ≥ 44px
      const sizes = await page.$$eval('nav[aria-label=Tools] button', (bs) => bs.map((b) => [b.offsetWidth, b.offsetHeight]))
      assert.ok(
        sizes.every(([w, h]) => w >= 44 && h >= 44),
        `touch targets ${JSON.stringify(sizes)}`,
      )

      await page.tap('[data-tool=pages]')
      await page.waitForSelector('[role=dialog] >> text=Pages')
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${OUT}/${label}-pages.png` })
      await page.tap('[aria-label="Rotate page 1"]')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      await download(page, `${label}-export.pdf`)
    },
    { touch: true },
  )
}

await test(
  'phone: pinch zoom',
  PHONE,
  async (page) => {
    await open(page, 'text-heavy.pdf')
    const z0 = await state(page, () => window.__ui.getState().zoom)
    const v = await page.locator('[data-testid=viewer]').boundingBox()
    const cdp = await page.context().newCDPSession(page)
    const cx = v.x + v.width / 2
    const cy = v.y + 300
    const pts = (d) => [
      { x: cx - d, y: cy, id: 0 },
      { x: cx + d, y: cy, id: 1 },
    ]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) })
    for (let d = 50; d <= 120; d += 10) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const z1 = await state(page, () => window.__ui.getState().zoom)
    assert.ok(z1 > z0 * 2, `pinched ${z0} → ${z1}`)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/phone-pinched.png` })
  },
  { touch: true },
)

await browser.close()
await writeFile(`${OUT}/results.txt`, results.join('\n') + '\n')
console.log(`\n${results.length - failures}/${results.length} passed`)
process.exit(failures ? 1 : 0)
