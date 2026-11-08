import { CheckSquare, ClipboardList, RotateCcw, ScanSearch, TextCursorInput } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { addField, detectOnCurrentPage } from './field-actions'

/** Shown in the properties panel when nothing is selected: the file's form, and making a flat form fillable. */
export function FormPanel() {
  const form = useSession((s) => s.form)
  const filled = useDoc((s) => Object.keys(s.formValues).length)
  const added = useDoc((s) => Object.values(s.elements).filter((e) => e.kind === 'field').length)
  return (
    <>
      {form.fields > 0 && (
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
      )}
      <section className="grid gap-1 rounded-xl border p-3 text-sm" data-testid="fillable-panel">
        <div className="font-medium">{form.fields > 0 ? 'Add form fields' : 'Make it fillable'}</div>
        <p className="mb-1 text-xs text-muted-foreground">
          Turns lines, boxes and tick boxes of a printed form into real fields others can fill in.
          {added > 0 && ` ${added} new ${added === 1 ? 'field' : 'fields'} so far.`}
        </p>
        <Button variant="outline" className="h-11 justify-start gap-2 lg:h-9" onClick={() => void detectOnCurrentPage()} data-testid="detect-fields">
          <ScanSearch /> Find fields on this page
        </Button>
        <div className="grid grid-cols-2 gap-1">
          <Button variant="ghost" className="h-11 justify-start gap-2 lg:h-9" onClick={() => addField('text')} data-testid="add-text-field">
            <TextCursorInput /> Text field
          </Button>
          <Button variant="ghost" className="h-11 justify-start gap-2 lg:h-9" onClick={() => addField('checkbox')}>
            <CheckSquare /> Check box
          </Button>
        </div>
      </section>
    </>
  )
}
