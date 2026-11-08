import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { loadPdfJs, PDFJS_ASSET_OPTIONS } from '@/lib/pdf/pdfjs'
import { captureGlyphs } from '@/lib/text/capture'
import type { PageItem, RedactElement, SourcePageInfo } from '@/types'
import { glyphRedactBox, glyphUnder, type Box } from './geometry'

/**
 * After a redacted export, the output is opened again with pdf.js (an independent reader) and
 * checked: no glyph — visible or invisible — under any mark, no annotation touching a mark, and every
 * marked string found no more often than it appears unmarked in the original.
 */

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '')

function count(hay: string, needle: string) {
  if (!needle) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

async function pageTexts(pdf: PDFDocumentProxy, indices: number[]): Promise<string> {
  const parts: string[] = []
  for (const i of indices) {
    const tc = await (await pdf.getPage(i + 1)).getTextContent()
    parts.push(tc.items.map((it) => ('str' in it ? (it as TextItem).str : '')).join(''))
  }
  return normalize(parts.join(''))
}

export interface VerifyResult {
  problems: string[]
  /** What was checked, for the success message. */
  checked: { marks: number; strings: number }
}

export async function verifyRedaction(
  bytes: Uint8Array,
  password: string,
  pages: PageItem[],
  sourcePages: SourcePageInfo[],
  marks: RedactElement[],
  source: PDFDocumentProxy,
): Promise<VerifyResult> {
  const pdfjs = await loadPdfJs()
  const task = pdfjs.getDocument({ data: bytes.slice(), password, ...PDFJS_ASSET_OPTIONS, fontExtraProperties: true, enableXfa: false })
  const problems: string[] = []
  const needles = [...new Set(marks.flatMap((m) => (m.text ? [normalize(m.text)] : [])).filter((n) => n.length >= 3))]
  try {
    const out = await task.promise
    if (out.numPages !== pages.length) problems.push('The downloaded file has a different number of pages than expected.')
    for (let i = 0; i < pages.length && i < out.numPages; i++) {
      const mine = marks.filter((m) => m.pageId === pages[i].id)
      if (!mine.length) continue
      const page = await out.getPage(i + 1)
      const info = sourcePages[pages[i].srcIndex]
      // Page space of the original page: the viewport with its original rotation.
      const { glyphs, fonts } = await captureGlyphs(page, info.rotate)
      // The same test the export used to decide what to remove (shrunk a little against float noise).
      const rects: Box[] = mine.map((m) => [m.x + 0.05, m.y + 0.05, m.x + m.width - 0.05, m.y + m.height - 0.05])
      const under = glyphs.some((g) => {
        if (!g.upright) return rects.some((r) => g.x > r[0] + 1 && g.x < r[2] - 1 && g.y > r[1] + 1 && g.y < r[3] - 1)
        const w = g.w * (fonts.get(g.font)?.fontMatrix ?? 0.001) * g.size * g.hScale
        return glyphUnder(glyphRedactBox(g.x, g.y, w, g.size), rects)
      })
      if (under) problems.push(`Page ${i + 1}: text can still be found under a mark.`)
      const vp = page.getViewport({ scale: 1, rotation: info.rotate })
      for (const a of (await page.getAnnotations()) as { rect?: number[]; subtype?: string }[]) {
        if (!a.rect) continue
        const [x0, y0] = vp.convertToViewportPoint(a.rect[0], a.rect[1])
        const [x1, y1] = vp.convertToViewportPoint(a.rect[2], a.rect[3])
        const b = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
        if (mine.some((m) => b[0] < m.x + m.width && b[2] > m.x && b[1] < m.y + m.height && b[3] > m.y)) {
          problems.push(`Page ${i + 1}: an annotation (${a.subtype ?? 'unknown'}) still overlaps a mark.`)
          break
        }
      }
    }
    if (needles.length) {
      const order = pages.map((p) => p.srcIndex)
      const before = await pageTexts(source, order)
      const after = await pageTexts(out, pages.map((_, i) => i).filter((i) => i < out.numPages))
      for (const n of needles) {
        const marked = marks.filter((m) => m.text && normalize(m.text) === n).length
        const allowed = Math.max(0, count(before, n) - marked)
        const left = count(after, n)
        if (left > allowed) {
          const label = marks.find((m) => m.text && normalize(m.text) === n)?.text ?? n
          problems.push(`“${label}” can still be found ${left - allowed === 1 ? 'once' : `${left - allowed} times`} in the page text.`)
        }
      }
    }
  } catch (err) {
    problems.push('The redacted file couldn’t be opened again to check it: ' + (err instanceof Error ? err.message : String(err)))
  } finally {
    void task.destroy()
  }
  return { problems, checked: { marks: marks.length, strings: needles.length } }
}
