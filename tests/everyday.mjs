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

await test('annotations: markup from text, note, ink, rectangle, arrow → real PDF annotations', async (page) => {
  await open(page, 'text-heavy.pdf')
  await page.click('[data-tool=annotate]')
  await page.waitForSelector('[data-testid=annotate-bar]')
  const drag = async (x0, y0, x1, y1, steps = 8) => {
    const a = await pagePoint(page, 0, x0, y0)
    const b = await pagePoint(page, 0, x1, y1)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps + (i % 2) * 3)
    await page.mouse.up()
    await page.waitForTimeout(150)
  }
  // Highlight across the start of the first Lorem line (baseline ≈ 168).
  await drag(52, 165, 200, 165)
  // Underline: tap a word.
  await page.click('[data-annot=underline]')
  let p = await pagePoint(page, 0, 120, 182)
  await page.mouse.click(p.x, p.y)
  // Note.
  await page.click('[data-annot=note]')
  p = await pagePoint(page, 0, 500, 100)
  await page.mouse.click(p.x, p.y)
  await page.fill('[data-testid=annot-note]', 'Check this figure')
  await page.click('[data-annot=ink]')
  await drag(380, 380, 470, 420, 14)
  await page.click('[data-annot=rect]')
  await drag(60, 380, 160, 440)
  await page.click('[data-annot=arrow]')
  await drag(200, 440, 300, 390)
  const kinds = (await elements(page)).filter((e) => e.kind === 'annot').map((e) => e.type).sort()
  assert.deepEqual(kinds, ['arrow', 'highlight', 'ink', 'note', 'rect', 'underline'])
  const hl = (await elements(page)).find((e) => e.type === 'highlight')
  assert.ok(hl.text && hl.text.startsWith('Lorem'), 'highlight knows its text: ' + hl.text)
  await page.screenshot({ path: `${OUT}/annotations.png` })
  const path = await download(page, 'annotated.pdf')
  const out = py(
    `import sys, pikepdf, pypdfium2 as pdfium
pdf = pikepdf.open(sys.argv[1])
ann = [a for a in pdf.pages[0].get('/Annots', []) if str(a.get('/Subtype')) in ('/Highlight','/Underline','/Text','/Ink','/Square','/Line')]
kinds = sorted(str(a.Subtype)[1:] for a in ann)
ok_ap = all('/AP' in a and '/N' in a.AP for a in ann)
hl = [a for a in ann if a.Subtype == '/Highlight'][0]
note = [a for a in ann if a.Subtype == '/Text'][0]
img = pdfium.PdfDocument(sys.argv[1])[0].render(scale=1).to_pil().convert('RGB')
# A pixel inside the highlight, in page space (x 70, y 169): yellowish (blue channel low).
r, g, b = img.getpixel((70, 169))
print(','.join(kinds), ok_ap, len(list(hl.QuadPoints)) % 8 == 0, str(note.Contents), r - b > 60)`,
    path,
  )
  assert.equal(out, 'Highlight,Ink,Line,Square,Text,Underline True True Check this figure True', out)
})

await test('pages: insert PDFs, blank, duplicate, extract; resume', async (page) => {
  await open(page, 'form.pdf')
  const insert = async (file) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-testid=insert-pdf]')])
    await chooser.setFiles(`${FIX}/${file}`)
    await page.waitForFunction((n) => window.__doc.getState().pages.length >= n, null, { timeout: 20000 }).catch(() => {})
  }
  const count = () => page.evaluate(() => window.__doc.getState().pages.length)
  await insert('bookmarks.pdf')
  await page.waitForFunction(() => window.__doc.getState().pages.length === 6)
  await page.click('[data-testid=blank-page]')
  assert.equal(await count(), 7)
  // Duplicate the last page (form page 2).
  await page.locator('[data-testid=duplicate-page]').nth(6).click()
  assert.equal(await count(), 8)
  // Text on an inserted page and on the duplicate.
  const pages = await page.evaluate(() => window.__doc.getState().pages)
  await page.evaluate(([a, b]) => {
    const mk = (pageId, text) => ({ id: 't_' + text, kind: 'text', pageId, x: 72, y: 300, rotation: 0, text, font: 'inter', size: 14, color: '#c00000', bold: false, italic: false, align: 'left', lineHeight: 1.2 })
    window.__doc.getState().addElements([mk(a, 'OnInsertedPage'), mk(b, 'OnDuplicatePage')])
  }, [pages[2].id, pages[7].id])
  // The same form again: its field names clash.
  await insert('form.pdf')
  await page.waitForFunction(() => window.__doc.getState().pages.length === 10)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/pages.png` })
  const path = await download(page, 'assembled.pdf')
  const out = py(
    `import sys, re, subprocess, pikepdf, pypdf
p = sys.argv[1]
r = pypdf.PdfReader(p)
n = len(r.pages)
marks = []
for i in range(n):
    t = subprocess.run(['pdftotext', '-f', str(i+1), '-l', str(i+1), p, '-'], capture_output=True).stdout.decode('utf-8','replace')
    m = re.search(r'page-(\\d)-zq', t)
    marks.append((m.group(1) if m else '-') + ('I' if 'OnInsertedPage' in t else '') + ('D' if 'OnDuplicatePage' in t else ''))
def flat(o, d=0):
    out = []
    for it in o:
        if isinstance(it, list): out += flat(it, d+1)
        else: out.append((d, it.title, r.get_destination_page_number(it)))
    return out
outline = flat(r.outline)
links = []
ins = [i for i, m in enumerate(marks) if 'I' in m][0]
for a in r.pages[ins].get('/Annots') or []:
    a = a.get_object()
    if a.get('/Subtype') == '/Link':
        d = a.get('/Dest')
        links.append(r.get_page_number(d[0].get_object()) if d else None)
names = sorted((r.get_fields() or {}).keys())
pdf = pikepdf.open(p)
pageobjs = sum(1 for o in pdf.objects if isinstance(o, pikepdf.Dictionary) and o.get('/Type') == '/Page')
print(n, ''.join(m[0] for m in marks), [m for m in marks if len(m) > 1], outline, sorted(links), 'name (2)' in names and 'name' in names, pageobjs)`,
    path,
  )
  // New pages go after the page in view (page 1): form 1, form 1-2 again, blank, bookmarks 1-4, form 2, its duplicate.
  assert.ok(out.startsWith("10 112-123422 ['1I', '2D']"), out)
  assert.ok(out.includes("(0, 'bookmarks', 4), (1, 'Chapter 1', 4), (2, 'Section 1.1', 5), (1, 'Chapter 2', 5), (1, 'Chapter 3', 6), (2, 'Section 3.1', 7)"), out)
  assert.ok(out.includes('[5, 7] True 10'), out)
  // Extract pages 2-3.
  await page.click('[data-testid=extract-pages]')
  await page.fill('[data-testid=extract-range]', '2-3')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=extract-go]')])
  await dl.saveAs(`${OUT}/extract.pdf`)
  assert.equal(py(`import sys, pypdf; print(len(pypdf.PdfReader(sys.argv[1]).pages))`, `${OUT}/extract.pdf`), '2')
  // Resume: the inserted documents come back.
  await page.waitForTimeout(1200)
  await page.reload({ waitUntil: 'networkidle' })
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('[data-page-id] canvas')
  assert.equal(await count(), 10)
  assert.equal(await page.evaluate(() => Object.keys(window.__session.getState().docs).length), 2)
})

await test('flat form → fillable: detect, adjust, real fields', async (page) => {
  await open(page, 'flat-form.pdf')
  await page.click('[data-testid=detect-fields]')
  await page.waitForFunction(() => Object.values(window.__doc.getState().elements).filter((e) => e.kind === 'field').length > 0, null, { timeout: 15000 })
  const fields = (await elements(page)).filter((e) => e.kind === 'field')
  const names = fields.map((f) => `${f.fieldType}:${f.name}${f.multiline ? '+' : ''}`).sort()
  assert.deepEqual(names, ['checkbox:I agree to the terms', 'text:Address+', 'text:Email', 'text:Full name', 'text:Signature'], names.join(' | '))
  await page.screenshot({ path: `${OUT}/fields-detected.png` })
  // Rename one in the panel.
  const email = fields.find((f) => f.name === 'Email')
  await page.evaluate((id) => window.__ui.getState().set({ selectedId: id }), email.id)
  await page.fill('[data-testid=field-name]', 'E-mail address')
  const path = await download(page, 'fillable.pdf')
  const out = py(
    `import sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
f = r.get_fields() or {}
print(sorted((k, str(v.get('/FT'))) for k, v in f.items()))`,
    path,
  )
  assert.equal(out, "[('Address', '/Tx'), ('E-mail address', '/Tx'), ('Full name', '/Tx'), ('I agree to the terms', '/Btn'), ('Signature', '/Tx')]", out)
  // The new file opens as a form: fill it in.
  await page.click('[aria-label="Close file"]')
  await page.setInputFiles('input[type=file]', path)
  await page.waitForSelector('[data-field="Full name"]', { timeout: 20000 })
})

await test('compress: preview the size, download smaller images, text kept', async (page) => {
  await open(page, 'scanned-ocr.pdf')
  await page.click('[data-testid=compress]')
  await page.click('[data-testid=compress-small]')
  await page.click('[data-testid=compress-check]')
  await page.waitForFunction(() => /smaller/.test(document.querySelector('[data-testid=compress-estimate]')?.textContent ?? ''), null, { timeout: 60000 })
  await page.screenshot({ path: `${OUT}/compress.png` })
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid=compress-download]')])
  const path = `${OUT}/compressed.pdf`
  await dl.saveAs(path)
  const out = py(
    `import sys, os, subprocess, pikepdf
src, out = sys.argv[1], sys.argv[2]
pdf = pikepdf.open(out)
imgs = [o for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.get('/Subtype') == '/Image']
w = max(int(o.Width) for o in imgs)
txt = subprocess.run(['pdftotext', out, '-'], capture_output=True).stdout.decode('utf-8', 'replace')
print(os.path.getsize(out) < 0.7 * os.path.getsize(src), w <= 1060, 'MEMORANDUM' in txt)`,
    `${FIX}/scanned-ocr.pdf`,
    path,
  )
  assert.equal(out, 'True True True', out)
})

await browser.close()
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
