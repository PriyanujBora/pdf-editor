// Renders the PWA PNG icons from public/favicon.svg. Run: node scripts/make-icons.mjs
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const svg = await readFile('public/favicon.svg', 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage()
const render = async (file, size, pad = 0, bg = 'transparent') => {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px">
      <div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`,
  )
  await page.screenshot({ path: `public/${file}`, omitBackground: bg === 'transparent' })
}
await render('icon-192.png', 192)
await render('icon-512.png', 512)
await render('apple-touch-icon.png', 180, 0, '#16171a')
// Maskable: full-bleed background with the glyph inside the safe zone.
await render('icon-maskable-512.png', 512, 64, '#16171a')
await browser.close()
console.log('icons written')
