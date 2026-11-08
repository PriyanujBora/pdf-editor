import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { useSession } from '@/store/session'
import type { PageItem, SourcePageInfo } from '@/types'

/**
 * Where a page comes from: the opened file, an inserted PDF, or nothing (a blank page). Everything
 * that renders or reads a page goes through here. `key` identifies the source page for caches
 * (text detection, fonts, scan images): the opened file keeps plain indices.
 */
export interface PageSource {
  pdf: PDFDocumentProxy | null
  info: SourcePageInfo
  /** 0-based page index in `pdf`. */
  index: number
  key: string
}

const blankInfo = (w: number, h: number): SourcePageInfo => ({ view: [0, 0, w, h], rotate: 0, width: w, height: h })

export function sourceOf(page: PageItem): PageSource {
  const s = useSession.getState()
  if (page.blank) return { pdf: null, info: blankInfo(page.blank.width, page.blank.height), index: -1, key: `blank:${page.id}` }
  if (page.doc) {
    const d = s.docs[page.doc]
    if (d) return { pdf: d.pdf, info: d.sourcePages[page.srcIndex], index: page.srcIndex, key: `${page.doc}:${page.srcIndex}` }
    // The inserted file is gone (shouldn't happen): render as a blank of A4.
    return { pdf: null, info: blankInfo(595, 842), index: -1, key: `missing:${page.id}` }
  }
  return { pdf: s.pdf, info: s.sourcePages[page.srcIndex], index: page.srcIndex, key: String(page.srcIndex) }
}

/** The pdf.js page, or null for blank pages. */
export function pdfPageOf(page: PageItem): Promise<PDFPageProxy | null> {
  const src = sourceOf(page)
  return src.pdf ? src.pdf.getPage(src.index + 1) : Promise.resolve(null)
}

/** The page is a page of the opened file (bookmarks, form fields, page labels belong to it). */
export const isMainPage = (page: PageItem) => !page.doc && !page.blank
