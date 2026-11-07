// Export fidelity: document-level features must survive an export.
// For every fidelity fixture: no-edit download (must be the original bytes), a forced in-place
// rebuild, reorder + delete pages, and a text edit; encrypted files also "remove protection".
// Checked by tests/tools/fidelity.py (pikepdf/pypdf/PDFium/Ghostscript).
// Needs the dev server (npm run dev -- --port 5199) and tests/.venv. Run: npm run test:fidelity
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const URL = process.env.E2E_URL ?? 'http://localhost:5199/'
const OUT = 'tests/out/fidelity'
const PY = process.env.PDF_TOOLS_PY ?? (existsSync('tests/.venv/Scripts/python.exe') ? 'tests/.venv/Scripts/python.exe' : 'tests/.venv/bin/python')
const FIXTURES = ['form', 'bookmarks', 'tagged', 'attachments', 'encrypted-rc4-128', 'encrypted-aes-128', 'encrypted-aes-256', 'text-heavy']
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const runs = []

for (const name of FIXTURES) {
  const file = `tests/fixtures/${name}.pdf`
  const password = name.startsWith('encrypted') ? 'secret' : null
  const scenarios = ['noedit', 'rebuild', 'pages', 'edit', ...(password ? ['removed'] : [])]
  for (const sc of scenarios) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const run = { name, file, password, scenario: sc, out: `${OUT}/${name}-${sc}.pdf` }
    try {
      await page.goto(URL, { waitUntil: 'networkidle' })
      await page.setInputFiles('input[type=file]', file)
      if (password) {
        await page.waitForSelector('input[type=password]')
        await page.fill('input[type=password]', password)
        await page.click('button:has-text("Unlock")')
      }
      await page.waitForSelector('[data-page-id] canvas', { timeout: 30000 })
      await page.waitForTimeout(600)
      if (sc !== 'noedit') await page.evaluate(() => (window.__forceRebuild = true))
      if (sc === 'pages') {
        // Last page first, then delete what was the second source page.
        run.order = await page.evaluate(() => {
          const d = window.__doc.getState()
          d.movePage(d.pages.length - 1, 0)
          const second = window.__doc.getState().pages.find((p) => p.srcIndex === 1)
          window.__doc.getState().removePage(second.id)
          return window.__doc.getState().pages.map((p) => p.srcIndex)
        })
      }
      if (sc === 'edit') {
        run.edited = await page.evaluate(async () => {
          const tb = await import('/src/lib/pdf/text-blocks.ts')
          const p = await window.__session.getState().pdf.getPage(1)
          const b = (await tb.getTextBlocks(p, '0')).find((b) => b.source && !b.ocr)
          return b ? b.text : null
        })
        if (run.edited) {
          const box = await page.locator('[data-page-id]').first().boundingBox()
          const b = await page.evaluate(async () => {
            const tb = await import('/src/lib/pdf/text-blocks.ts')
            const p = await window.__session.getState().pdf.getPage(1)
            const b = (await tb.getTextBlocks(p, '0')).find((b) => b.source && !b.ocr)
            return { x: b.x, y: b.y, w: b.width, h: b.height }
          })
          const z = await page.evaluate(() => window.__ui.getState().zoom)
          await page.mouse.click(box.x + (b.x + b.w / 2) * z, box.y + (b.y + b.h / 2) * z)
          await page.waitForSelector('textarea[aria-label="Edit text"]')
          await page.keyboard.press('End')
          await page.keyboard.type(' edited')
          await page.keyboard.press('Escape')
        }
      }
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        (async () => {
          await page.click('[data-testid=download]')
          if (password) {
            await page.waitForSelector('[data-testid=choice-dialog]')
            await page.click(`[data-testid=choice-dialog] button:has-text("${sc === 'removed' ? 'Remove protection' : 'Keep protection'}")`)
          }
        })(),
      ])
      await dl.saveAs(run.out)
    } catch (err) {
      run.error = err.message.split('\n')[0]
    }
    run.errors = errors
    runs.push(run)
    await ctx.close()
  }
  console.log(name, 'done')
}
await browser.close()
await writeFile(`${OUT}/runs.json`, JSON.stringify(runs, null, 1))
const out = execFileSync(PY, ['-I', 'tests/tools/fidelity.py', `${OUT}/runs.json`], { encoding: 'utf8' })
process.stdout.write(out)
if (/^RESULT FAIL/m.test(out)) process.exitCode = 1
