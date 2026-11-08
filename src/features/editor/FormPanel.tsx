import { ClipboardList, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'

/** Shown in the properties panel when the file has a form. */
export function FormPanel() {
  const form = useSession((s) => s.form)
  const filled = useDoc((s) => Object.keys(s.formValues).length)
  if (!form.fields) return null
  return (
    <section className="grid gap-2 rounded-xl border p-3 text-sm" data-testid="form-panel">
      <div className="flex items-center gap-2 font-medium">
        <ClipboardList className="size-4" /> Form · {form.fields} {form.fields === 1 ? 'field' : 'fields'}
      </div>
      <p className="text-xs text-muted-foreground">Click a field on the page to fill it in. Tab moves to the next one.</p>
      {form.calculated && (
        <p className="text-xs text-muted-foreground" role="note">
          Some fields are calculated by the form (totals and the like). They aren’t recalculated here; Acrobat and most
          viewers recalculate them when the file is opened.
        </p>
      )}
      <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1 lg:min-h-0">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--color-brand)]"
          checked={form.flatten}
          onChange={(e) => useSession.getState().set({ form: { ...form, flatten: e.target.checked } })}
          data-testid="flatten-form"
        />
        <span className="grid gap-0.5">
          <span>Flatten when downloading</span>
          <span className="text-xs text-muted-foreground">Values become part of the page and can’t be changed any more.</span>
        </span>
      </label>
      {filled > 0 && (
        <Button variant="ghost" className="h-10 justify-start gap-2 lg:h-8" onClick={() => useDoc.setState({ formValues: {} })}>
          <RotateCcw /> Reset to the values in the file
        </Button>
      )}
    </section>
  )
}
