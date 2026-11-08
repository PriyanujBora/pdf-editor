import { toast } from 'sonner'
import { uid } from '@/lib/ids'
import { compile, findInLines, searchLines, wordAt, type Match, type Query } from '@/lib/redact/find'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { PageItem, PtRect, RedactElement } from '@/types'

/** Smallest area mark (pt); smaller drags count as taps. */
export const MIN_MARK = 3

function pageLines(page: PageItem) {
  const pdf = useSession.getState().pdf
  if (!pdf) return Promise.resolve([])
  return pdf.getPage(page.srcIndex + 1).then((p) => searchLines(p, String(page.srcIndex)))
}

const sameRect = (a: PtRect, b: PtRect) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5

function existing(pageId: string) {
  return Object.values(useDoc.getState().elements).filter((e): e is RedactElement => e.kind === 'redact' && e.pageId === pageId)
}

function mark(pageId: string, r: PtRect, text?: string): RedactElement {
  return { id: uid('r_'), kind: 'redact', pageId, x: r.x, y: r.y, width: r.width, height: r.height, rotation: 0, ...(text ? { text } : {}) }
}

export function addAreaMark(pageId: string, r: PtRect) {
  const el = mark(pageId, r)
  useDoc.getState().addElement(el)
  useUi.getState().set({ selectedId: el.id })
}

/** Tap in the Redact tool: mark the word under the finger. */
export async function markWordAt(page: PageItem, x: number, y: number) {
  const hit = wordAt(await pageLines(page), x, y)
  if (!hit) {
    toast('No text here', { id: 'redact-hint', description: 'Drag to mark an area — images and drawings under it are removed too.' })
    return
  }
  const dup = existing(page.id).find((e) => sameRect(e, hit.rect))
  if (dup) {
    useUi.getState().set({ selectedId: dup.id })
    return
  }
  const el = mark(page.id, hit.rect, hit.text)
  useDoc.getState().addElement(el)
  useUi.getState().set({ selectedId: el.id })
}

export interface PageHits {
  page: PageItem
  index: number
  matches: Match[]
}

/** Find & redact: every match on every page (current order). */
export async function findMatches(q: Query, onProgress?: (done: number, total: number) => void): Promise<PageHits[] | string> {
  const patterns = compile(q)
  if (typeof patterns === 'string') return patterns
  if (!patterns.length) return []
  const pages = useDoc.getState().pages
  const out: PageHits[] = []
  for (let i = 0; i < pages.length; i++) {
    const matches = findInLines(await pageLines(pages[i]), patterns)
    if (matches.length) out.push({ page: pages[i], index: i, matches })
    onProgress?.(i + 1, pages.length)
  }
  return out
}

/** Marks the given matches (one undo step); matches already marked are skipped. Returns how many were added. */
export function markMatches(hits: { pageId: string; match: Match }[]) {
  const els: RedactElement[] = []
  for (const { pageId, match } of hits) {
    if (existing(pageId).some((e) => sameRect(e, match.rect)) || els.some((e) => e.pageId === pageId && sameRect(e, match.rect))) continue
    els.push(mark(pageId, match.rect, match.text))
  }
  useDoc.getState().addElements(els)
  return els.length
}

export function removeAllMarks() {
  const ids = Object.values(useDoc.getState().elements)
    .filter((e) => e.kind === 'redact')
    .map((e) => e.id)
  useDoc.getState().removeElements(ids)
  useUi.getState().set({ selectedId: null })
}
