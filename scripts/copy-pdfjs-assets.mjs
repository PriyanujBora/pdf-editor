// Copies pdf.js runtime assets (CMaps, standard fonts, wasm decoders, ICC
// profiles) into public/pdfjs so they are served same-origin and work offline.
import { cp, mkdir } from 'node:fs/promises'

const src = 'node_modules/pdfjs-dist'
await mkdir('public/pdfjs', { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(`${src}/${dir}`, `public/pdfjs/${dir}`, { recursive: true })
}
