// Performance budgets (Phase 8), against the production build served by `npm run cf:dev` (:8787).
// Needs `npm run fixtures:perf`. Run: npm run test:perf   (--update rewrites tests/perf-baseline.json)
//
// Per fixture: time from choosing the file to the first page on screen; while scrolling through the
// document: long tasks over 100 ms and the frame rate; peak memory of all browser processes (canvases
// and ArrayBuffers included, not just the JS heap); and for an edited document, export progress.
// Budgets: first page <= 1.5 s for 50 MB; <= 1 GB peak for the 150 MB scan. Any metric more than 20 %
// worse than the baseline fails. Android numbers are recorded by hand (see tests/perf-baseline.json).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.PERF_URL ?? 'http://localhost:8787/'
const FIX = 'tests/fixtures'
const BASE = 'tests/perf-baseline.json'
const update = process.argv.includes('--update')
for (const f of ['perf-500.pdf', 'perf-2000.pdf', 'perf-scan-50.pdf', 'perf-scan-150.pdf'])
  if (!existsSync(`${FIX}/${f}`)) throw new Error(`missing ${FIX}/${f}: run npm run fixtures:perf`)

const browser = await chromium.launch()
const cdpBrowser = await browser.newBrowserCDPSession()

/** Resident memory (MB) of every process of this browser. */
async function memoryMB() {
  const { processInfo } = await cdpBrowser.send('SystemInfo.getProcessInfo')
  const pids = processInfo.map((p) => p.id).filter(Boolean)
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`], { encoding: 'utf8' })
      return Math.round(+out.trim() / 2 ** 20)
    }
    const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' })
    return Math.round(out.split('\n').reduce((s, l) => s + (+l || 0), 0) / 1024)
  } catch {
    return 0
  }
}

async function run(file, { scroll = true, exportIt = false, memory = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    window.__long = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__long.push(e.duration)
    }).observe({ type: 'longtask', buffered: true })
  })
  await page.goto(URL, { waitUntil: 'networkidle' })
  // A returning visitor: the service worker has the app cached (the first-ever visit also downloads it).
  await page.evaluate(async () => {
    await navigator.serviceWorker?.ready
    for (let i = 0; i < 100; i++) {
      if ((await caches.keys()).some((k) => k.startsWith('workbox-precache'))) break
      await new Promise((r) => setTimeout(r, 100))
    }
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const idle = memory ? await memoryMB() : 0
  let peak = idle
  let sampling = memory
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, await memoryMB())
      await new Promise((r) => setTimeout(r, 400))
    }
  })()
  const t0 = Date.now()
  await page.setInputFiles('input[type=file]', `${FIX}/${file}`)
  await page.waitForSelector('[data-page-id] canvas', { timeout: 120000 })
  const firstPage = Date.now() - t0
  const out = { firstPage }
  if (scroll) {
    await page.waitForTimeout(600)
    await page.evaluate(() => (window.__long = []))
    const s = await page.evaluate(async () => {
      const v = document.querySelector('[data-testid=viewer]')
      let frames = 0
      const start = performance.now()
      let alive = true
      const tick = () => {
        frames++
        if (alive) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      // ~3 s of steady scrolling, then a jump to the end and back (virtualization).
      for (let i = 0; i < 60; i++) {
        v.scrollBy(0, 700)
        await new Promise((r) => setTimeout(r, 50))
      }
      v.scrollTo(0, v.scrollHeight)
      await new Promise((r) => setTimeout(r, 400))
      v.scrollTo(0, 0)
      await new Promise((r) => setTimeout(r, 400))
      alive = false
      const secs = (performance.now() - start) / 1000
      const long = window.__long.filter((d) => d > 100)
      return { fps: Math.round(frames / secs), longTasks: long.length, maxLongTask: Math.round(Math.max(0, ...long)) }
    })
    Object.assign(out, s)
  }
  if (exportIt) {
    // An edit, so the export rebuilds the file (not the unchanged fast path).
    await page.click('[data-tool=text]')
    const box = await page.locator('[data-page-id]').first().boundingBox()
    await page.mouse.click(box.x + 300, box.y + 600)
    await page.keyboard.type('perf')
    await page.keyboard.press('Escape')
    // Every progress update the page shows, recorded in the page itself.
    await page.evaluate(() => {
      window.__progress = []
      const t1 = performance.now()
      new MutationObserver(() => {
        for (const t of document.querySelectorAll('[data-sonner-toast]')) {
          const m = /Preparing your PDF… (\d+)%/.exec(t.textContent ?? '')
          if (m && window.__progress.at(-1)?.[1] !== +m[1]) window.__progress.push([Math.round(performance.now() - t1), +m[1]])
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    const t1 = Date.now()
    await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('[data-testid=download]')])
    out.exportMs = Date.now() - t1
    const seen = await page.evaluate(() => window.__progress)
    out.progressSteps = seen.length
    out.firstProgressMs = seen[0]?.[0] ?? out.exportMs
  }
  sampling = false
  await sampler
  if (memory) {
    out.peakMB = peak
    out.idleMB = idle
  }
  await ctx.close()
  return out
}

const results = {}
for (const [f, o] of [
  ['perf-scan-50.pdf', {}],
  ['perf-scan-150.pdf', {}],
  ['perf-500.pdf', { exportIt: true }],
  ['perf-2000.pdf', {}],
]) {
  // Timing first (nothing else running), then a separate run for memory.
  const t = await run(f, o)
  const m = await run(f, { ...o, memory: true })
  results[f] = { ...t, peakMB: m.peakMB, idleMB: m.idleMB }
}
await browser.close()

console.log('| File | first page ms | fps | long tasks >100 ms (max) | peak MB (browser idle) | export ms (progress steps) |')
console.log('|---|---|---|---|---|---|')
for (const [f, r] of Object.entries(results))
  console.log(`| ${f} | ${r.firstPage} | ${r.fps ?? '–'} | ${r.longTasks ?? '–'} (${r.maxLongTask ?? '–'}) | ${r.peakMB} (${r.idleMB}) | ${r.exportMs ? `${r.exportMs} (${r.progressSteps})` : '–'} |`)

const fails = []
// Absolute budgets.
if (results['perf-scan-50.pdf'].firstPage > 1500) fails.push(`first page of a 50 MB file took ${results['perf-scan-50.pdf'].firstPage} ms (budget 1500)`)
// Memory the document costs: peak over the idle browser (the browser and GPU processes themselves
// take a few hundred MB before any file is opened).
const used150 = results['perf-scan-150.pdf'].peakMB - results['perf-scan-150.pdf'].idleMB
if (used150 > 1024) fails.push(`peak memory on the 150 MB scan +${used150} MB over idle (budget 1024)`)
if ((results['perf-500.pdf'].progressSteps ?? 0) < 3) fails.push('export progress was not streamed (fewer than 3 updates)')

// Regressions against the baseline: worse by more than 20 % (with a little absolute slack for noise).
if (update || (!existsSync(BASE) && !fails.length)) {
  writeFileSync(BASE, JSON.stringify({ note: 'Desktop Chromium (Playwright). Android: record manually — first page / scroll / export by hand on a mid-range phone.', machine: `${process.platform} ${process.arch}`, results }, null, 2) + '\n')
  console.log(`baseline written to ${BASE}`)
} else if (existsSync(BASE)) {
  const base = JSON.parse(readFileSync(BASE, 'utf8')).results
  const slack = { firstPage: 250, peakMB: 120, exportMs: 500, maxLongTask: 80, longTasks: 3 }
  for (const [f, r] of Object.entries(results))
    for (const k of Object.keys(slack)) {
      const b = base[f]?.[k]
      if (b === undefined || r[k] === undefined) continue
      if (r[k] > b * 1.2 + slack[k]) fails.push(`${f} ${k}: ${r[k]} vs baseline ${b}`)
    }
  for (const [f, r] of Object.entries(results)) {
    const b = base[f]?.fps
    if (b && r.fps && r.fps < b / 1.2 - 3) fails.push(`${f} fps: ${r.fps} vs baseline ${b}`)
  }
}
for (const f of fails) console.log('FAIL ' + f)
console.log(fails.length ? `RESULT FAIL (${fails.length})` : 'RESULT PASS')
assert.equal(fails.length, 0)
