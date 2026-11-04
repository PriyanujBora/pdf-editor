import { useEffect, useState } from 'react'
import { ensureFontLoaded } from '@/lib/fonts'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import type { TextElement } from '@/types'
import { applyCurve, colSpan, cssFace, splitWords } from './fit'
import { blur, clipRows, dilate, hashString, lineBand, measure, mulberry32, renderRuns, type Plane } from './raster'
import { analyze, paperModel } from './source'
import { scanPixels } from './pixels'

/**
 * Builds the scan-matched patch for a text element.
 *
 * Only words that changed are repainted: the old ones are erased with
 * synthesized paper and the new ones drawn with the fitted ink/blur/contrast.
 * Unchanged words keep the scan's own pixels; words after an edit that changed
 * the line's length are moved using their *own scanned ink*, so they keep
 * their exact look (bold, quirks and all). The patch is transparent
 * everywhere else, so neighbouring text and other edits are never painted over.
 */

export type ScanText = TextElement & { scan: NonNullable<TextElement['scan']> }

interface OldWord {
  text: string
  /** Baseline offset (px) measured for this word. */
  dy: number
  /** Pen position (px) and advance in the fitted face. */
  x: number
  adv: number
  bold: boolean
  /** Footprint (dilated ink) of this word: pixel indices. */
  foot: Uint32Array
}

interface Source {
  w: number
  h: number
  target: Plane
  ink: [number, number, number]
  paper: Float32Array
  words: OldWord[]
  space: number
}

const sources = new Map<string, Promise<Source>>()
const patches = new Map<string, HTMLCanvasElement>()

const sourceKey = (el: ScanText) => `${el.id}|${JSON.stringify(el.scan)}`

async function buildSource(el: ScanText): Promise<Source> {
  const { pdf, sourcePages } = useSession.getState()
  const page = useDoc.getState().pages.find((p) => p.id === el.pageId)
  if (!pdf || !page) throw new Error('page not available')
  const info = sourcePages[page.srcIndex]
  const s = el.scan
  const img = (await scanPixels(await pdf.getPage(page.srcIndex + 1), page.srcIndex, info, s.region, s.scale)).img
  const { width: w, height: h } = img
  const an = analyze(img, 0, w)
  const T = an.target

  await Promise.all([ensureFontLoaded(s.fitFont, false, false, s.oldText), ensureFontLoaded(s.fitFont, true, false, s.oldText)])
  const face = cssFace(s.fitFont, s.fitBold, s.fitSizePx)
  const texts = splitWords(s.oldText)
  const space = measure(face, ' ').width
  const words: OldWord[] = []
  let prefix = ''
  const all = new Float32Array(w * h)
  for (let i = 0; i < texts.length; i++) {
    const x = s.originX + (prefix ? measure(face, prefix).width : 0) + (s.dxs[i] ?? 0)
    prefix += texts[i] + ' '
    const styled = (bold: boolean) =>
      blur(
        renderRuns(
          [
            bold && s.boldStyle
              ? {
                  text: texts[i],
                  x,
                  dy: s.dys?.[i] ?? 0,
                  font: cssFace(s.fitFont, s.boldStyle.bold, s.fitSizePx),
                  weight: s.boldStyle.weight,
                }
              : { text: texts[i], x, dy: s.dys?.[i] ?? 0, font: cssFace(s.fitFont, bold, s.fitSizePx), weight: s.weight ?? 0 },
          ],
          w,
          h,
          s.baseline,
        ),
        w,
        h,
        s.sigma,
      )
    const isBold = s.bolds?.[i] ?? s.fitBold
    // Footprint = the word's *actual* ink (within its span and the line's band),
    // slightly grown for the anti-aliased halo. Following real ink, not the
    // fitted glyph shapes, leaves no slivers when the fit is a pixel off.
    const shape = styled(isBold)
    let [c0, c1] = colSpan(shape, w, h)
    const [b0, b1] = lineBand(s.baseline, s.fitSizePx)
    // Grow the span to the real ink edge (the fit can drift a pixel or two at
    // the end of justified lines), stopping at the first blank column.
    const inkCol = (x: number) => {
      for (let y = Math.max(0, b0); y < Math.min(h, b1); y++) if (T[y * w + x] > 0.06) return true
      return false
    }
    const limit = Math.round(s.fitSizePx * 0.4)
    for (let n = 0; n < limit && c1 + 1 < w && inkCol(c1 + 1); n++) c1++
    for (let n = 0; n < limit && c0 - 1 > 0 && inkCol(c0 - 1) && (i === 0 || c0 - 1 > words[i - 1].x + words[i - 1].adv); n++)
      c0--
    const ink = new Float32Array(w * h)
    for (let y = Math.max(0, b0); y < Math.min(h, b1); y++)
      for (let xx = Math.max(0, c0 - 1); xx <= Math.min(w - 1, c1 + 1); xx++) {
        const k = y * w + xx
        if (T[k] > 0.06 || shape[k] > 0.06) ink[k] = 1
      }
    const mask = clipRows(dilate(ink, w, h, 1, 0.5), w, h, b0, b1)
    const idx: number[] = []
    for (let k = 0; k < mask.length; k++)
      if (mask[k]) {
        idx.push(k)
        all[k] = 1
      }
    words.push({
      text: texts[i],
      dy: s.dys?.[i] ?? 0,
      x,
      adv: measure(cssFace(s.fitFont, isBold, s.fitSizePx), texts[i]).width,
      bold: isBold,
      foot: Uint32Array.from(idx),
    })
  }

  // Paper: smooth colour fit + the page's own grain, resampled.
  const pm = paperModel(img, (i) => T[i] < 0.04 && all[i] === 0)
  const rand = mulberry32(hashString(el.id))
  const pool = pm.residuals.length / 3
  const noise = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)]
  for (let i = 0; i < w * h; i++) {
    const k = pool ? Math.floor(rand() * pool) * 3 : 0
    for (let c = 0; c < 3; c++) noise[c][i] = pool ? pm.residuals[k + c] : 0
  }
  // Scanner grain is slightly correlated: soften, then restore its strength.
  const soft = noise.map((n) => blur(n, w, h, 0.5))
  const paper = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      for (let c = 0; c < 3; c++) paper[i * 3 + c] = pm.plane(x, y, c) + soft[c][i] * 1.5
    }
  return { w, h, target: T, ink: an.ink, paper, words, space }
}

function getSource(el: ScanText) {
  const key = sourceKey(el)
  let p = sources.get(key)
  if (!p) {
    p = buildSource(el)
    p.catch(() => sources.delete(key))
    sources.set(key, p)
  }
  return p
}

/** Word-level diff (LCS): which old words survive, in order. */
function lcs(a: string[], b: string[]) {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) pairs.push([i++, j++])
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

const hex = (c: string): [number, number, number] => {
  const n = parseInt(c.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** The patch for `text` (default: the element's text). Cached by content. */
export async function composePatch(el: ScanText, text = el.text): Promise<HTMLCanvasElement> {
  const key = [sourceKey(el), text, el.size, el.font, el.bold, el.italic, el.color].join('|')
  const hit = patches.get(key)
  if (hit) return hit
  const src = await getSource(el)
  const s = el.scan
  const { w, h, words: old } = src
  const fresh = splitWords(text)
  const sizePx = el.size * s.scale
  // An explicit B toggle in the panel applies to all replaced words.
  const forceBold = el.bold !== s.fitBold ? el.bold : null
  await Promise.all([ensureFontLoaded(el.font, false, el.italic, text), ensureFontLoaded(el.font, true, el.italic, text)])
  const k = sizePx / s.fitSizePx
  // Bold words use the fitted bold style (Bold face or Regular thickened).
  const styleFor = (bold: boolean) =>
    bold && s.boldStyle
      ? { font: cssFace(el.font, s.boldStyle.bold, sizePx, el.italic), weight: s.boldStyle.weight * k }
      : { font: cssFace(el.font, bold, sizePx, el.italic), weight: (s.weight ?? 0) * k }
  const faceFor = (bold: boolean) => styleFor(bold).font
  const newSpace = measure(faceFor(false), ' ').width

  const erase = new Float32Array(w * h)
  const moved = new Float32Array(w * h) // old ink transplanted to its new place
  const runs: { text: string; x: number; dy: number; font: string; weight: number }[] = []

  const pairs = lcs(
    old.map((o) => o.text),
    fresh,
  )
  pairs.push([old.length, fresh.length]) // sentinel
  const lineEnd = old.length ? old[old.length - 1].x + old[old.length - 1].adv : s.originX
  let shift = 0
  let oi = 0
  let nj = 0
  for (const [ki, kj] of pairs) {
    // Replace old[oi..ki) with fresh[nj..kj).
    if (ki > oi || kj > nj) {
      const appended = oi >= old.length
      const start = appended ? lineEnd + src.space : old[oi].x
      const oldSpan = appended ? 0 : (ki < old.length ? old[ki].x : lineEnd) - start
      let x = start + shift
      const boldRef = old[Math.min(oi, old.length - 1)]?.bold ?? s.fitBold
      for (let j = nj; j < kj; j++) {
        const face = faceFor(forceBold ?? boldRef)
        runs.push({ text: fresh[j], x, dy: old[Math.min(oi, old.length - 1)]?.dy ?? 0, ...styleFor(forceBold ?? boldRef) })
        x += measure(face, fresh[j]).width + newSpace
      }
      let newSpan = 0
      if (kj > nj) {
        newSpan = x - (start + shift) - newSpace // words + inner spaces
        if (ki < old.length) newSpan += newSpace // gap before the next kept word
        if (appended) newSpan += src.space
      }
      for (let i = oi; i < ki; i++) for (const p of old[i].foot) erase[p] = 1
      shift += newSpan - oldSpan
    }
    // Kept word: untouched, or moved with its own ink if the line reflowed.
    if (ki < old.length) {
      const dx = Math.round(shift)
      if (dx !== 0) {
        for (const p of old[ki].foot) {
          erase[p] = 1
          const x = (p % w) + dx
          if (x >= 0 && x < w) moved[p + dx] = Math.max(moved[p + dx], src.target[p])
        }
      }
    }
    oi = ki + 1
    nj = kj + 1
  }

  const drawn = runs.length ? blur(renderRuns(runs, w, h, s.baseline), w, h, s.sigma) : new Float32Array(w * h)
  for (let i = 0; i < drawn.length; i++) drawn[i] = applyCurve(s.curve, drawn[i])
  const E = blur(erase, w, h, 0.8)
  const inkOld = src.ink
  const inkNew = hex(el.color)
  const out = new ImageData(w, h)
  const d = out.data
  for (let i = 0; i < w * h; i++) {
    const e = E[i]
    const a1 = moved[i]
    const a2 = drawn[i]
    const A = 1 - (1 - e) * (1 - a1) * (1 - a2)
    if (A < 0.004) continue
    for (let c = 0; c < 3; c++)
      d[i * 4 + c] = (src.paper[i * 3 + c] * e * (1 - a1) * (1 - a2) + inkOld[c] * a1 * (1 - a2) + inkNew[c] * a2) / A
    d[i * 4 + 3] = A * 255
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.putImageData(out, 0, 0)
  if (patches.size > 64) patches.delete(patches.keys().next().value!)
  patches.set(key, canvas)
  return canvas
}

export async function patchPng(el: ScanText): Promise<Uint8Array> {
  const canvas = await composePatch(el)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!blob) throw new Error('Could not encode patch')
  return new Uint8Array(await blob.arrayBuffer())
}

export function clearScanCaches() {
  sources.clear()
  patches.clear()
}

/** Patch for display; while typing, the erased line (the inline editor draws the text). */
export function useScanPatch(el: ScanText, editing: boolean) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  useEffect(() => {
    let alive = true
    void composePatch(el, editing ? '' : el.text)
      .then((c) => alive && setCanvas(c))
      .catch((e) => console.warn('scan patch failed', e))
    return () => {
      alive = false
    }
  }, [el, editing])
  return canvas
}

export const isScanText = (el: TextElement): el is ScanText => !!el.scan
