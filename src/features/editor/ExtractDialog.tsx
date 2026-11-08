import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { extractPages, parseRanges, splitEvery } from './page-actions'

/** Extract chosen pages into a new PDF, or split the document into files of N pages. */
export function ExtractDialog() {
  const open = useUi((s) => s.extractOpen)
  const n = useDoc((s) => s.pages.length)
  const [mode, setMode] = useState<'extract' | 'split'>('extract')
  const [range, setRange] = useState('')
  const [every, setEvery] = useState(1)
  const parsed = parseRanges(range, n)
  const close = () => useUi.getState().set({ extractOpen: false })
  const go = async () => {
    close()
    if (mode === 'extract' && parsed) await extractPages(parsed, 'pages-' + range.replace(/\s+/g, '').replace(/,/g, '_'))
    else if (mode === 'split') await splitEvery(Math.max(1, every))
  }
  const files = Math.ceil(n / Math.max(1, every))
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md" data-testid="extract-dialog">
        <DialogHeader>
          <DialogTitle>Extract or split pages</DialogTitle>
          <DialogDescription>New PDFs with your edits included. The open document doesn’t change.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-xl bg-muted/70 p-1" role="tablist">
          {(['extract', 'split'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn('min-h-11 flex-1 rounded-lg text-sm font-medium text-muted-foreground lg:min-h-9', mode === m && 'bg-background text-foreground shadow-sm')}
            >
              {m === 'extract' ? 'Extract pages' : 'Split into files'}
            </button>
          ))}
        </div>
        {mode === 'extract' ? (
          <label className="grid gap-2 text-sm">
            <span className="text-xs text-muted-foreground">Pages (of {n}), e.g. 1-3, 5, 8-</span>
            <Input value={range} onChange={(e) => setRange(e.target.value)} placeholder="1-3, 5" className="h-11 text-base" data-testid="extract-range" />
            {range && !parsed && <span className="text-xs text-destructive">Use page numbers from 1 to {n}, like “1-3, 5”.</span>}
          </label>
        ) : (
          <label className="grid gap-2 text-sm">
            <span className="text-xs text-muted-foreground">Pages per file</span>
            <Input type="number" min={1} max={n} value={every} onChange={(e) => setEvery(+e.target.value || 1)} className="h-11 w-28 text-base" data-testid="split-every" />
            <span className="text-xs text-muted-foreground">
              {files} {files === 1 ? 'file' : 'files'} — your browser may ask before saving several downloads.
            </span>
          </label>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 lg:h-9" onClick={close}>
            Cancel
          </Button>
          <Button className="h-11 lg:h-9" disabled={mode === 'extract' && !parsed} onClick={() => void go()} data-testid="extract-go">
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
