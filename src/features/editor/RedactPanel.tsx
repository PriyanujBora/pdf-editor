import { Loader2, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PRESETS, type Match, type PresetId } from '@/lib/redact/find'
import { cn } from '@/lib/utils'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { RedactElement, SanitizeOptions } from '@/types'
import { deleteSelected } from './actions'
import { findMatches, markMatches, removeAllMarks, type PageHits } from './redact-actions'
import { viewerBridge } from './viewer-bridge'

const SANITIZE: { id: keyof SanitizeOptions; label: string; hint: string }[] = [
  { id: 'metadata', label: 'Document properties', hint: 'Title, author, keywords, XMP metadata, app data' },
  { id: 'javascript', label: 'JavaScript and actions', hint: 'Scripts, and links that launch programs' },
  { id: 'attachments', label: 'Attachments', hint: 'Embedded files' },
  { id: 'hiddenLayers', label: 'Hidden layers', hint: 'Content in layers that are switched off' },
  { id: 'comments', label: 'Comments and markups', hint: 'Notes, highlights, stamps, drawings' },
  { id: 'formValues', label: 'Form field values', hint: 'Typed answers, ticks, signatures' },
]

function Check({ checked, onChange, label, hint, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; testId?: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5 hover:bg-muted/60 lg:min-h-0">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      <span className="grid gap-0.5">
        <span className="text-sm leading-tight">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function FindSection() {
  const [text, setText] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [presets, setPresets] = useState<PresetId[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [hits, setHits] = useState<PageHits[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [off, setOff] = useState<Set<string>>(new Set())

  const total = hits?.reduce((n, h) => n + h.matches.length, 0) ?? 0
  const key = (h: PageHits, i: number) => `${h.page.id}:${i}`
  const chosen = total - off.size

  const run = async () => {
    setError(null)
    setHits(null)
    setOff(new Set())
    setBusy('Searching…')
    const res = await findMatches({ text, regex, caseSensitive, presets }, (d, n) => setBusy(`Searching… page ${d} of ${n}`))
    setBusy(null)
    if (typeof res === 'string') setError(res)
    else setHits(res)
  }

  const markAll = () => {
    if (!hits) return
    const picks: { pageId: string; match: Match }[] = []
    for (const h of hits) h.matches.forEach((m, i) => !off.has(key(h, i)) && picks.push({ pageId: h.page.id, match: m }))
    markMatches(picks)
    setHits(null)
  }

  const togglePreset = (id: PresetId) => setPresets((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const canSearch = !!text.trim() || presets.length > 0

  return (
    <Section title="Find and redact">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSearch) void run()
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={regex ? 'Regular expression' : 'Word or phrase'}
          className="h-11 text-base md:text-sm lg:h-9"
          aria-label="Text to find"
          data-testid="redact-query"
        />
        <Button type="submit" className="h-11 shrink-0 gap-1.5 lg:h-9" disabled={!canSearch || !!busy} data-testid="redact-find">
          {busy ? <Loader2 className="animate-spin" /> : <Search />} Find
        </Button>
      </form>
      <div className="flex flex-wrap gap-x-4">
        <Check checked={regex} onChange={setRegex} label="Regular expression" />
        <Check checked={caseSensitive} onChange={setCaseSensitive} label="Match case" />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common patterns">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.hint}
            aria-pressed={presets.includes(p.id)}
            data-testid={`preset-${p.id}`}
            onClick={() => togglePreset(p.id)}
            className={cn(
              'min-h-11 rounded-full border px-3 text-xs font-medium transition-colors lg:min-h-8',
              presets.includes(p.id) ? 'border-brand bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {busy && <p className="text-xs text-muted-foreground">{busy}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {hits && (
        <div className="grid gap-2" data-testid="redact-results">
          <p className="text-sm">
            {total === 0
              ? 'No matches.'
              : `${total} ${total === 1 ? 'match' : 'matches'} on ${hits.length} ${hits.length === 1 ? 'page' : 'pages'}`}
          </p>
          {total > 0 && (
            <>
              <ul className="grid max-h-56 gap-0.5 overflow-y-auto rounded-lg border p-1">
                {hits.flatMap((h) =>
                  h.matches.map((m, i) => (
                    <li key={key(h, i)}>
                      <Check
                        checked={!off.has(key(h, i))}
                        onChange={(v) =>
                          setOff((s) => {
                            const n = new Set(s)
                            if (v) n.delete(key(h, i))
                            else n.add(key(h, i))
                            return n
                          })
                        }
                        label={m.text}
                        hint={`Page ${h.index + 1}`}
                      />
                    </li>
                  )),
                )}
              </ul>
              <Button className="h-11 lg:h-9" disabled={!chosen} onClick={markAll} data-testid="redact-mark-all">
                Mark {chosen} {chosen === 1 ? 'match' : 'matches'} for redaction
              </Button>
            </>
          )}
        </div>
      )}
    </Section>
  )
}

function MarksSection() {
  const marks = useDoc(useShallow((s) => Object.values(s.elements).filter((e): e is RedactElement => e.kind === 'redact')))
  const pages = useDoc((s) => s.pages)
  const selectedId = useUi((s) => s.selectedId)
  const pageIndex = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages])
  const live = marks.filter((m) => pageIndex.has(m.pageId)).sort((a, b) => pageIndex.get(a.pageId)! - pageIndex.get(b.pageId)! || a.y - b.y || a.x - b.x)
  const pageCount = new Set(live.map((m) => m.pageId)).size

  return (
    <Section title="Marked for redaction">
      {live.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing marked yet. Drag on the page to mark an area, or tap a word.</p>
      ) : (
        <>
          <p className="text-sm" data-testid="redact-count">
            {live.length} {live.length === 1 ? 'mark' : 'marks'} on {pageCount} {pageCount === 1 ? 'page' : 'pages'}
          </p>
          <ul className="grid max-h-48 gap-0.5 overflow-y-auto rounded-lg border p-1">
            {live.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted lg:min-h-8',
                    m.id === selectedId && 'bg-muted',
                  )}
                  onClick={() => {
                    viewerBridge.scrollToPage(m.pageId)
                    useUi.getState().set({ selectedId: m.id })
                  }}
                >
                  <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">p. {pageIndex.get(m.pageId)! + 1}</span>
                  <span className="truncate">{m.text ?? 'Area'}</span>
                </button>
              </li>
            ))}
          </ul>
          <Button variant="outline" className="h-11 gap-2 lg:h-9" onClick={removeAllMarks}>
            <X /> Remove all marks
          </Button>
        </>
      )}
    </Section>
  )
}

function SanitizeSection() {
  const opts = useSession((s) => s.sanitize)
  const set = (id: keyof SanitizeOptions, v: boolean) => useSession.getState().set({ sanitize: { ...opts, [id]: v } })
  return (
    <Section title="Also remove from the file">
      <div className="grid">
        {SANITIZE.map((o) => (
          <Check key={o.id} checked={opts[o.id]} onChange={(v) => set(o.id, v)} label={o.label} hint={o.hint} testId={`sanitize-${o.id}`} />
        ))}
      </div>
    </Section>
  )
}

/** Redact tool panel: the selected mark, Find & redact, the list of marks, document clean-up. */
export function RedactPanel({ mark }: { mark?: RedactElement }) {
  return (
    <div className="grid gap-5 p-4" data-testid="redact-panel">
      {mark ? (
        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Redaction mark</h2>
            <Button variant="ghost" size="icon" className="size-10 lg:size-8" onClick={deleteSelected} aria-label="Remove mark" data-testid="delete-element">
              <Trash2 />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {mark.text ? <>Covers “{mark.text}”. </> : null}
            Drag the mark or its handles to adjust it.
          </p>
        </div>
      ) : (
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold">Redact</h2>
          <p className="text-sm text-muted-foreground">
            Drag on the page to mark an area, or tap a word. When you download, everything under a mark — text, image
            pixels, drawings, comments, form fields — is permanently removed and covered with a black box.
          </p>
        </div>
      )}
      <FindSection />
      <MarksSection />
      <SanitizeSection />
      <div className="flex items-start gap-3 rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <p>
          Applied when you download. The new file is then checked; if anything you marked can still be found in it,
          nothing is downloaded and you’ll see why.
        </p>
      </div>
    </div>
  )
}
