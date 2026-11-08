import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Minus,
  MousePointerClick,
  Plus,
  RotateCcw,
  RotateCw,
  Trash2,
  Undo,
  Square,
} from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FONT_FAMILIES, FONT_LIST } from '@/lib/fonts'
import { displayFontName, missingGlyphs } from '@/lib/original-font'
import { refreshOriginal } from '@/lib/pdf/font-scan'
import { layoutLine } from '@/lib/text/line-layout'
import { measureCanvas } from '@/lib/text/measure-canvas'
import { cn } from '@/lib/utils'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { EditorElement, FontFamilyId, ImageElement, TextAlign, TextElement } from '@/types'
import { deleteSelected } from './actions'
import { TOOLS } from './tools'
import { RedactPanel } from './RedactPanel'

const SWATCHES = ['#111111', '#ffffff', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#7c3aed']

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-2', className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

const update = (id: string, patch: Partial<EditorElement>) => useDoc.getState().updateElement(id, patch)

function rotateBy(el: EditorElement, delta: number) {
  update(el.id, { rotation: (((Math.round(el.rotation / 90) * 90 + delta) % 360) + 360) % 360 })
}

const ORIGINAL = '__original'
const PRINTED = '__printed'

/** Switch a scan-matched edit to the plain approach: paper-coloured cover + text on top. */
function plainPatch(el: TextElement) {
  if (!el.scan) return
  const b = el.scan.lineBox
  const pad = Math.max(1, el.size * 0.08)
  update(el.id, {
    scan: undefined,
    cover: {
      x: b.x - pad,
      y: b.y - pad,
      width: b.width + 2 * pad,
      height: b.height + 2 * pad,
      color: el.scan.paper,
      original: el.scan.oldText,
    },
  })
}

function TextProps({ el }: { el: TextElement }) {
  const f = FONT_FAMILIES[el.font]
  const src = el.source
  const notRemoved = useSession((s) => s.notRemoved[el.id])
  const missing = src
    ? el.override
      ? []
      : layoutLine(el, measureCanvas).fallbackChars
    : el.original && el.useOriginal
      ? missingGlyphs(el.text, el.original)
      : []
  // Restyling an edited line draws every word in the chosen style.
  const style = (patch: Partial<TextElement>) => update(el.id, src ? { ...patch, override: true } : patch)
  // Other pages may have shown more of this font since the edit started.
  useEffect(() => {
    if (!missing.length || !el.original) return
    const fresh = refreshOriginal(el.original)
    if (Object.keys(fresh.glyphs).length > Object.keys(el.original.glyphs).length) update(el.id, { original: fresh })
  }, [missing.length, el.id, el.original])
  const setSize = (s: number) => style({ size: Math.min(400, Math.max(2, Math.round(s * 10) / 10)) })
  return (
    <div className="grid gap-5">
      <Field label="Text">
        <textarea
          value={el.text}
          onChange={(e) => update(el.id, { text: e.target.value })}
          rows={3}
          className="min-h-20 w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
          placeholder="Type here"
        />
      </Field>

      <Field label="Font">
        <Select
          value={src ? (el.override ? el.font : PRINTED) : el.original && el.useOriginal ? ORIGINAL : el.font}
          onValueChange={(v) =>
            v === PRINTED
              ? update(el.id, { override: false })
              : v === ORIGINAL
                ? update(el.id, { useOriginal: true })
                : src
                  ? style({ font: v as FontFamilyId })
                  : update(el.id, {
                      font: v as FontFamilyId,
                      useOriginal: false,
                      italic: el.italic && FONT_FAMILIES[v as FontFamilyId].hasItalic,
                    })
          }
        >
          <SelectTrigger className="h-11 w-full lg:h-9" aria-label="Font">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {src && (
              <SelectItem value={PRINTED} className="h-10 lg:h-8">
                <span className="truncate">As printed (PDF’s own fonts)</span>
              </SelectItem>
            )}
            {!src && el.original && (
              <SelectItem value={ORIGINAL} className="h-10 lg:h-8">
                <span className="truncate">Original · {displayFontName(el.original.baseFont)}</span>
              </SelectItem>
            )}
            {FONT_LIST.map((font) => (
              <SelectItem key={font.id} value={font.id} className="h-10 lg:h-8">
                <span style={{ fontFamily: `"${font.css}"` }}>{font.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {missing.length > 0 && (
          <p className="text-xs text-muted-foreground" role="status">
            {missing.map((c) => `“${c}”`).join(' ')} {missing.length === 1 ? 'isn’t' : 'aren’t'} available in the original font
            (PDFs usually embed only the characters they use), so {missing.length === 1 ? 'it uses' : 'they use'}{' '}
            {src ? 'the closest bundled font' : f.label}.
          </p>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Size">
          <div className="flex h-11 items-center rounded-lg border lg:h-9">
            <button
              className="grid h-full w-10 place-items-center text-muted-foreground hover:text-foreground"
              onClick={() => setSize(el.size - 1)}
              aria-label="Smaller"
            >
              <Minus className="size-4" />
            </button>
            <input
              type="number"
              inputMode="decimal"
              min={2}
              max={400}
              step={0.5}
              value={el.size}
              onChange={(e) => e.target.value && setSize(+e.target.value)}
              className="w-full min-w-0 bg-transparent text-center text-base tabular-nums outline-none md:text-sm [&::-webkit-inner-spin-button]:appearance-none"
              aria-label="Font size"
            />
            <button
              className="grid h-full w-10 place-items-center text-muted-foreground hover:text-foreground"
              onClick={() => setSize(el.size + 1)}
              aria-label="Larger"
            >
              <Plus className="size-4" />
            </button>
          </div>
        </Field>
        <Field label="Style">
          <div className="flex gap-1">
            <Toggle
              variant="outline"
              className="h-11 flex-1 lg:h-9"
              pressed={el.bold}
              onPressedChange={(bold) => (src ? style({ bold }) : update(el.id, { bold, useOriginal: false }))}
              aria-label="Bold"
            >
              <Bold />
            </Toggle>
            <Toggle
              variant="outline"
              className="h-11 flex-1 lg:h-9"
              pressed={el.italic}
              onPressedChange={(italic) => (src ? style({ italic }) : update(el.id, { italic, useOriginal: false }))}
              aria-label="Italic"
              title={f.hasItalic ? 'Italic' : 'Slanted (this font has no italic)'}
            >
              <Italic />
            </Toggle>
          </div>
        </Field>
      </div>

      <Field label="Colour">
        <div className="flex flex-wrap items-center gap-2">
          {[...new Set([...(el.cover ? [el.color] : []), ...SWATCHES])].slice(0, 8).map((c) => (
            <button
              key={c}
              aria-label={`Colour ${c}`}
              onClick={() => style({ color: c })}
              className={cn(
                'size-9 rounded-full border shadow-xs ring-offset-2 ring-offset-background transition-transform active:scale-95 lg:size-7',
                el.color.toLowerCase() === c && 'ring-2 ring-brand',
              )}
              style={{ background: c }}
            />
          ))}
          <label
            className="relative size-9 cursor-pointer overflow-hidden rounded-full border bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] lg:size-7"
            title="Custom colour"
          >
            <input
              type="color"
              value={el.color}
              onChange={(e) => style({ color: e.target.value })}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Custom colour"
            />
          </label>
        </div>
      </Field>

      {!el.scan && !src && (
        <Field label="Align">
          <ToggleGroup
            type="single"
            variant="outline"
            value={el.align}
            onValueChange={(v) => v && update(el.id, { align: v as TextAlign })}
            className="w-full"
          >
            <ToggleGroupItem value="left" aria-label="Align left" className="h-11 flex-1 lg:h-9">
              <AlignLeft />
            </ToggleGroupItem>
            <ToggleGroupItem value="center" aria-label="Align center" className="h-11 flex-1 lg:h-9">
              <AlignCenter />
            </ToggleGroupItem>
            <ToggleGroupItem value="right" aria-label="Align right" className="h-11 flex-1 lg:h-9">
              <AlignRight />
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}

      {el.scan && (
        <div className="rounded-xl border border-dashed p-3 text-sm" data-testid="scan-match">
          <p className="text-xs font-medium text-muted-foreground">Blended into the scan</p>
          <p className="mt-1 line-clamp-2 break-words">{el.scan.oldText}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Old letters are repainted with the page’s paper; the new ones get the scan’s ink, blur and grain. The downloaded PDF
            keeps a searchable text layer and notes that it was edited.
          </p>
          <div className="mt-2 grid">
            <Button variant="ghost" className="h-10 justify-start gap-2 lg:h-8" onClick={() => plainPatch(el)}>
              <Square /> Use a plain patch instead
            </Button>
            <Button variant="ghost" className="h-10 justify-start gap-2 lg:h-8" onClick={deleteSelected}>
              <Undo /> Restore original
            </Button>
          </div>
        </div>
      )}

      {src && (
        <div className="rounded-xl border border-dashed p-3 text-sm" data-testid="source-edit">
          <p className="text-xs font-medium text-muted-foreground">Edits printed text</p>
          <p className="mt-1 line-clamp-2 break-words">{src.text}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Words you didn’t change keep the PDF’s own letters and positions. When you download, the old words are removed
            from the file, so searching or copying won’t find them.
          </p>
          {notRemoved && (
            <p className="mt-2 text-xs font-medium text-destructive" role="alert">
              The last download couldn’t remove the old text here ({notRemoved}): it was covered, but it’s still in the file.
            </p>
          )}
          <Button variant="ghost" className="mt-2 h-10 w-full justify-start gap-2 lg:h-8" onClick={deleteSelected}>
            <Undo /> Restore original
          </Button>
        </div>
      )}

      {el.cover && (
        <div className="rounded-xl border border-dashed p-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">Replaces original text</p>
          <p className="mt-1 line-clamp-2 break-words">{el.cover.original}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            The original is covered, not erased: it can still be found by copying or searching the downloaded file.
          </p>
          <Button variant="ghost" className="mt-2 h-10 w-full justify-start gap-2 lg:h-8" onClick={deleteSelected}>
            <Undo /> Restore original
          </Button>
        </div>
      )}
    </div>
  )
}

function ImageProps({ el }: { el: ImageElement }) {
  return (
    <div className="grid gap-5">
      <Field label="Size">
        <p className="text-sm tabular-nums">
          {Math.round(el.width)} × {Math.round(el.height)} pt
        </p>
      </Field>
    </div>
  )
}

export function PropertiesPanel({ className }: { className?: string }) {
  const selectedId = useUi((s) => s.selectedId)
  const el = useDoc((s) => (selectedId ? s.elements[selectedId] : undefined))
  const tool = useUi((s) => s.tool)

  const marks = useDoc((s) => Object.values(s.elements).filter((e) => e.kind === 'redact').length)
  // Scan-matched text is locked to its line; edited printed text moves but doesn't rotate.
  const locked = el?.kind === 'text' && (!!el.scan || !!el.source)

  if (el?.kind === 'redact') return <RedactPanel mark={el} />
  if (!el && tool === 'redact') return <RedactPanel />
  if (!el) {
    const t = TOOLS.find((x) => x.id === tool)
    return (
      <div className={cn('grid gap-4 p-4 text-sm text-muted-foreground', className)}>
        <div className="flex items-start gap-3 rounded-xl bg-muted/60 p-3">
          <MousePointerClick className="mt-0.5 size-4 shrink-0" />
          <p>{t && tool !== 'select' ? t.hint + '.' : 'Tap any text on the page to edit it, or select something you added.'}</p>
        </div>
        {marks > 0 && (
          <p className="rounded-xl border border-destructive/30 px-3 py-2 text-xs">
            {marks} {marks === 1 ? 'area is' : 'areas are'} marked for redaction — removed when you download.
          </p>
        )}
        <ul className="grid gap-2 px-1 text-xs">
          {TOOLS.filter((x) => x.id !== 'select').map((x) => (
            <li key={x.id} className="flex items-center gap-2">
              <x.icon className="size-3.5" /> {x.hint}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <div className={cn('grid gap-5 p-4', className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{el.kind === 'text' ? (el.cover || el.scan || el.source ? 'Edited text' : 'Text') : 'Image'}</h2>
        <div className={cn('flex gap-1', locked && 'hidden')}>
          <Button
            variant="ghost"
            size="icon"
            className="size-10 lg:size-8"
            onClick={() => rotateBy(el, -90)}
            aria-label="Rotate left"
          >
            <RotateCcw />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-10 lg:size-8"
            onClick={() => rotateBy(el, 90)}
            aria-label="Rotate right"
          >
            <RotateCw />
          </Button>
        </div>
      </div>
      {el.kind === 'text' ? <TextProps el={el} /> : <ImageProps el={el} />}
      {!locked && (
        <Field label="Rotation">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              value={Math.round(el.rotation)}
              onChange={(e) => update(el.id, { rotation: ((+e.target.value % 360) + 360) % 360 })}
              className="h-11 w-24 text-base tabular-nums md:text-sm lg:h-9"
              aria-label="Rotation in degrees"
            />
            <span className="text-sm text-muted-foreground">degrees</span>
          </div>
        </Field>
      )}
      <Button variant="destructive" className="h-11 gap-2 lg:h-9" onClick={deleteSelected} data-testid="delete-element">
        <Trash2 /> Delete
      </Button>
    </div>
  )
}
