import { EyeOff, ShieldAlert } from 'lucide-react'
import type { RedactionReport } from '@/lib/export/protocol'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import type { RedactElement } from '@/types'
import { choose } from './choice'

/** Redaction marks on pages that are still in the document. */
export function liveMarks(): RedactElement[] {
  const d = useDoc.getState()
  const ids = new Set(d.pages.map((p) => p.id))
  return Object.values(d.elements).filter((e): e is RedactElement => e.kind === 'redact' && ids.has(e.pageId))
}

const pageNo = (pageId: string) => useDoc.getState().pages.findIndex((p) => p.id === pageId) + 1
const hits = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** Things the download can't redact: images you added, or scan-matched edits, under a mark. */
export function redactionConflicts(marks: RedactElement[]): string[] {
  const out: string[] = []
  for (const el of Object.values(useDoc.getState().elements)) {
    const mine = marks.filter((m) => m.pageId === el.pageId)
    if (!mine.length) continue
    if (el.kind === 'image') {
      // Bounding box of the (possibly rotated) image.
      const t = (el.rotation * Math.PI) / 180
      const xs = [0, el.width * Math.cos(t), -el.height * Math.sin(t), el.width * Math.cos(t) - el.height * Math.sin(t)].map((v) => el.x + v)
      const ys = [0, el.width * Math.sin(t), el.height * Math.cos(t), el.width * Math.sin(t) + el.height * Math.cos(t)].map((v) => el.y + v)
      const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
      if (mine.some((m) => hits(m, box))) out.push(`Page ${pageNo(el.pageId)}: an image you added overlaps a mark. Move or delete it first.`)
    } else if (el.kind === 'text' && el.scan && mine.some((m) => hits(m, el.scan!.region)))
      out.push(`Page ${pageNo(el.pageId)}: an edit on the scanned text overlaps a mark. Undo the edit or move the mark.`)
  }
  return out
}

export async function explain(title: string, intro: string, items: string[]) {
  await choose({
    title,
    icon: <ShieldAlert className="size-5" />,
    description: (
      <>
        <p>{intro}</p>
        <ul className="mt-2 grid max-h-60 list-disc gap-1 overflow-y-auto pl-5 text-left" data-testid="blocked-reasons">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </>
    ),
    options: [{ value: 'ok', label: 'OK' }],
  })
}

const SANITIZE_LABEL: Record<string, string> = {
  metadata: 'document properties and metadata',
  javascript: 'JavaScript and actions',
  attachments: 'attachments',
  hiddenLayers: 'hidden layers',
  comments: 'comments and markups',
  formValues: 'form field values',
}

/** Last word before a redacted download. */
export async function confirmRedaction(marks: RedactElement[]): Promise<boolean> {
  const opts = useSession.getState().sanitize
  const clean = Object.entries(opts)
    .filter(([, v]) => v)
    .map(([k]) => SANITIZE_LABEL[k])
  const pages = new Set(marks.map((m) => m.pageId)).size
  const pick = await choose({
    title: marks.length ? 'Redact and download?' : 'Clean up and download?',
    icon: <EyeOff className="size-5" />,
    description: (
      <>
        {marks.length > 0 && (
          <p>
            Everything under {marks.length === 1 ? 'the mark' : `the ${marks.length} marks`} on {pages === 1 ? '1 page' : `${pages} pages`} — text,
            image pixels, drawings, comments and form fields — is permanently removed from the downloaded file and covered
            with black boxes. Marked words are also removed from bookmarks and tags.
          </p>
        )}
        {clean.length > 0 && <p className="mt-2">Also removed from the file: {clean.join(', ')}.</p>}
        <p className="mt-2">Your marks stay here, so you can still change them. The downloaded file is checked before it’s saved.</p>
      </>
    ),
    options: [
      { value: 'go', label: marks.length ? 'Redact and download' : 'Clean up and download', variant: 'destructive' },
      { value: 'cancel', label: 'Cancel', variant: 'outline' },
    ],
  })
  return pick === 'go'
}

const ADVICE: Record<string, string> = {
  'the document properties': 'Tick “Document properties” under “Also remove from the file”.',
  'the XMP metadata': 'Tick “Document properties” under “Also remove from the file”.',
  'an attachment': 'Tick “Attachments” under “Also remove from the file”.',
  JavaScript: 'Tick “JavaScript and actions” under “Also remove from the file”.',
  'a comment or annotation': 'Tick “Comments and markups” under “Also remove from the file”.',
  'a form field': 'Tick “Form field values” under “Also remove from the file”.',
  'an annotation or form field appearance': 'Tick “Form field values” and “Comments and markups”.',
}

const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** Why the worker refused to produce a file: problems, then where each marked text was found, then what to do. */
export function blockedReasons(r: RedactionReport): string[] {
  const byText = new Map<string, string[]>()
  for (const l of r.leaks) byText.set(l.text, [...(byText.get(l.text) ?? []), l.where])
  const advice = [...new Set(r.leaks.map((l) => ADVICE[l.where] ?? 'Mark it on the page too, or remove it with another app first.'))]
  return [...r.problems, ...[...byText].map(([t, where]) => `“${t}” is still in ${joinAnd(where)}.`), ...advice]
}
