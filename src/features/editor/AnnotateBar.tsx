import { ArrowUpRight, Highlighter, PenTool, Square, StickyNote, Strikethrough, Underline, type LucideIcon } from 'lucide-react'
import { ANNOT_COLORS } from '@/lib/annotations'
import { cn } from '@/lib/utils'
import { useUi, type AnnotTool } from '@/store/ui'

const KINDS: { id: AnnotTool; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'highlight', label: 'Highlight', icon: Highlighter, hint: 'Drag across text, or tap a word' },
  { id: 'underline', label: 'Underline', icon: Underline, hint: 'Drag across text, or tap a word' },
  { id: 'strike', label: 'Strikethrough', icon: Strikethrough, hint: 'Drag across text, or tap a word' },
  { id: 'note', label: 'Note', icon: StickyNote, hint: 'Tap where the note goes' },
  { id: 'ink', label: 'Draw', icon: PenTool, hint: 'Draw freehand' },
  { id: 'rect', label: 'Rectangle', icon: Square, hint: 'Drag to draw a rectangle' },
  { id: 'arrow', label: 'Arrow', icon: ArrowUpRight, hint: 'Drag from the tail to the tip' },
]

/** Floating bar of the Annotate tool: kind of annotation and its colour. */
export function AnnotateBar({ className }: { className?: string }) {
  const tool = useUi((s) => s.tool)
  const kind = useUi((s) => s.annotTool)
  const colors = useUi((s) => s.annotColors)
  if (tool !== 'annotate') return null
  const hint = KINDS.find((k) => k.id === kind)?.hint
  return (
    <div className={cn('pointer-events-none absolute inset-x-0 z-20 flex justify-center px-2', className)}>
      <div className="pointer-events-auto grid max-w-full gap-1 rounded-2xl border bg-background/95 p-1.5 shadow-lg backdrop-blur" role="toolbar" aria-label="Annotation tools" data-testid="annotate-bar">
        <div className="flex items-center gap-0.5 overflow-x-auto">
          {KINDS.map((k) => (
            <button
              key={k.id}
              title={k.label}
              aria-label={k.label}
              aria-pressed={kind === k.id}
              data-annot={k.id}
              onClick={() => useUi.getState().set({ annotTool: k.id, selectedId: null })}
              className={cn('grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-muted lg:size-9', kind === k.id && 'bg-brand/10 text-brand')}
            >
              <k.icon className="size-5 lg:size-4" />
            </button>
          ))}
          <span className="mx-1 h-6 w-px shrink-0 bg-border" />
          {ANNOT_COLORS.slice(0, 5).map((c) => (
            <button
              key={c}
              aria-label={`Colour ${c}`}
              aria-pressed={colors[kind] === c}
              onClick={() => useUi.getState().set({ annotColors: { ...colors, [kind]: c } })}
              className={cn('grid size-11 shrink-0 place-items-center rounded-full lg:size-8')}
            >
              <span className={cn('size-6 rounded-full border-2 lg:size-5', colors[kind] === c ? 'border-brand' : 'border-black/10')} style={{ background: c }} />
            </button>
          ))}
        </div>
        <p className="px-2 pb-0.5 text-center text-[11px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}
