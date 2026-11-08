import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDoc } from '@/store/document'
import type { FieldElement } from '@/types'
import { deleteSelected } from './actions'

/** The selected new form field: name, kind, multi-line. */
export function FieldPanel({ el }: { el: FieldElement }) {
  const update = (p: Partial<FieldElement>) => useDoc.getState().updateElement(el.id, p)
  return (
    <div className="grid gap-5 p-4" data-testid="field-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">New form field</h2>
        <Button variant="ghost" size="icon" className="size-10 lg:size-8" onClick={deleteSelected} aria-label="Delete field" data-testid="delete-element">
          <Trash2 />
        </Button>
      </div>
      <label className="grid gap-2">
        <span className="text-xs font-medium text-muted-foreground">Name</span>
        <Input value={el.name} onChange={(e) => update({ name: e.target.value })} className="h-11 text-base md:text-sm lg:h-9" data-testid="field-name" />
      </label>
      <div className="grid gap-2">
        <span className="text-xs font-medium text-muted-foreground">Kind</span>
        <div className="flex gap-1 rounded-xl bg-muted/70 p-1">
          {(['text', 'checkbox'] as const).map((t) => (
            <button
              key={t}
              aria-pressed={el.fieldType === t}
              onClick={() => update({ fieldType: t })}
              className={'min-h-11 flex-1 rounded-lg text-sm lg:min-h-8 ' + (el.fieldType === t ? 'bg-background shadow-sm' : 'text-muted-foreground')}
            >
              {t === 'text' ? 'Text' : 'Check box'}
            </button>
          ))}
        </div>
      </div>
      {el.fieldType === 'text' && (
        <label className="flex min-h-11 items-center gap-3 text-sm lg:min-h-8">
          <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={!!el.multiline} onChange={(e) => update({ multiline: e.target.checked })} />
          Several lines
        </label>
      )}
      <p className="text-xs text-muted-foreground">Becomes a real fillable field in the downloaded PDF. Open that file again to fill it in.</p>
    </div>
  )
}
