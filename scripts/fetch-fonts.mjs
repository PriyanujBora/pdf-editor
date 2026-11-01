// Downloads the bundled static TTF fonts (SIL OFL) into public/fonts.
// Re-run only if you want to refresh them: `node scripts/fetch-fonts.mjs`.
import { writeFile, mkdir } from 'node:fs/promises'

const FAMILIES = {
  Inter: { file: 'Inter', italic: true },
  Roboto: { file: 'Roboto', italic: true },
  'Noto Serif': { file: 'NotoSerif', italic: true },
  'Noto Sans Bengali': { file: 'NotoSansBengali', italic: false },
  'Noto Sans Devanagari': { file: 'NotoSansDevanagari', italic: false },
}

const query = Object.entries(FAMILIES)
  .map(([name, f]) =>
    'family=' + name.replaceAll(' ', '+') +
    (f.italic ? ':ital,wght@0,400;0,700;1,400;1,700' : ':wght@400;700'))
  .join('&')

// An old user agent makes Google Fonts serve complete static .ttf files.
const css = await (await fetch(`https://fonts.googleapis.com/css2?${query}`, {
  headers: { 'User-Agent': 'Mozilla/4.0' },
})).text()

await mkdir('public/fonts', { recursive: true })
const re = /font-family: '([^']+)';\s*font-style: (\w+);\s*font-weight: (\d+);[^}]*?src: url\(([^)]+)\)/g
for (const [, family, style, weight, url] of css.matchAll(re)) {
  const variant = (weight === '700' ? 'Bold' : '') + (style === 'italic' ? 'Italic' : '') || 'Regular'
  const name = `${FAMILIES[family].file}-${variant}.ttf`
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
  await writeFile(`public/fonts/${name}`, buf)
  console.log(name, (buf.length / 1024).toFixed(0) + ' KB')
}
