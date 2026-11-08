import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ANNOT_COLORS, ANNOT_LABEL } from '@/lib/annotations'
import { cn } from '@/lib/utils'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import type { AnnotElement } from '@/types'
import { deleteSelected } from './actions'

/** The selected annotation: colour, line width, comment. */
export function AnnotPanel({ el }: { el: AnnotElement }) {
  const update = (p: Partial<AnnotElement>) => useDoc.getState().updateElement(el.id, p)
  const lines = el.type === 'ink' || el.type === 'rect' || el.type === 'arrow'
  return (
    <div className="grid gap-5 p-4" data-testid="annot-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{ANNOT_LABEL[el.type]}</h2>
        <Button variant="ghost" size="icon" className="size-10 lg:size-8" onClick={deleteSelected} aria-label="Delete annotation" data-testid="delete-element">
          <Trash2 />
        </Button>
      </div>
      {el.text && <p className="line-clamp-3 rounded-lg bg-muted/60 px-3 py-2 text-sm">“{el.text}”</p>}
      <div className="grid gap-2">
        <span className="text-xs font-medium text-muted-foreground">Colour</span>
        <div className="flex flex-wrap gap-2">
          {ANNOT_COLORS.map((c) => (
            <button
              key={c}
              aria-label={`Colour ${c}`}
              aria-pressed={el.color === c}
              className={cn('size-11 rounded-full border-2 lg:size-8', el.color === c ? 'border-brand' : 'border-border')}
              style={{ background: c }}
              onClick={() => {
                update({ color: c })
                useUi.getState().set({ annotColors: { ...useUi.getState().annotColors, [el.type]: c } })
              }}
            />
          ))}
        </div>
      </div>
      {lines && (
        <label className="grid gap-2">
          <span className="text-xs font-medium text-muted-foreground">Line width · {el.strokeWidth ?? 2} pt</span>
          <input type="range" min={0.5} max={8} step={0.5} value={el.strokeWidth ?? 2} onChange={(e) => update({ strokeWidth: +e.target.value })} />
        </label>
      )}
      <label className="grid gap-2">
        <span className="text-xs font-medium text-muted-foreground">{el.type === 'note' ? 'Note' : 'Comment (optional)'}</span>
        <textarea
          value={el.note ?? ''}
          onChange={(e) => update({ note: e.target.value })}
          rows={4}
          autoFocus={el.type === 'note' && !el.note}
          placeholder={el.type === 'note' ? 'Write your note' : 'Shown when someone opens the annotation'}
          className="min-h-24 w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
          data-testid="annot-note"
        />
      </label>
      <p className="text-xs text-muted-foreground">Saved as a standard PDF annotation: other apps can show, reply to or remove it.</p>
    </div>
  )
}
