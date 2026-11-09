import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { exportPdf } from '@/lib/export/export-client'
import { cn } from '@/lib/utils'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import { downloadPdf, mb } from './actions'

const PRESETS = [
  { id: 'small', label: 'Smallest', hint: 'For screens and email · 96 dpi', dpi: 96, quality: 0.7 },
  { id: 'balanced', label: 'Balanced', hint: 'Reads well when zoomed · 150 dpi', dpi: 150, quality: 0.8 },
  { id: 'print', label: 'High quality', hint: 'Good for printing · 220 dpi', dpi: 220, quality: 0.86 },
] as const

/** Compress: resample images, preview the size, then download through the usual flow. */
export function CompressDialog() {
  const open = useUi((s) => s.compressOpen)
  const current = useSession((s) => s.compress)
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('balanced')
  // Keyed by preset: switching presets shows no stale estimate.
  const [result, setResult] = useState<{ preset: string; value: { size: number; images: number } | 'none' } | null>(null)
  const [busy, setBusy] = useState(false)
  const original = useSession((s) => s.bytes?.length ?? s.blob?.size ?? 0)
  const p = PRESETS.find((x) => x.id === preset)!
  const estimate = result?.preset === preset ? result.value : null

  const close = () => useUi.getState().set({ compressOpen: false })

  const check = async () => {
    setBusy(true)
    try {
      const r = await exportPdf(undefined, { compress: { dpi: p.dpi, quality: p.quality }, keepEncryption: true })
      setResult({ preset, value: r.compress?.images ? { size: r.bytes.length, images: r.compress.images } : 'none' })
    } catch {
      setResult({ preset, value: 'none' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md" data-testid="compress-dialog">
        <DialogHeader>
          <DialogTitle>Compress</DialogTitle>
          <DialogDescription>Makes images smaller, on this device. Text and drawings stay sharp.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5" role="radiogroup" aria-label="Quality">
          {PRESETS.map((x) => (
            <button
              key={x.id}
              role="radio"
              aria-checked={preset === x.id}
              data-testid={`compress-${x.id}`}
              onClick={() => setPreset(x.id)}
              className={cn('grid min-h-12 rounded-xl border-2 px-3 py-2 text-left', preset === x.id ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/60')}
            >
              <span className="text-sm font-medium">{x.label}</span>
              <span className="text-xs text-muted-foreground">{x.hint}</span>
            </button>
          ))}
        </div>
        <div className="min-h-10 rounded-xl bg-muted/60 px-3 py-2 text-sm" data-testid="compress-estimate" aria-live="polite">
          {busy ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Checking…
            </span>
          ) : estimate === 'none' ? (
            'Nothing to compress at this setting: images are already this small, or in a kind that’s left as it is.'
          ) : estimate ? (
            <>
              Now {mb(original)} → about <b>{mb(estimate.size)}</b> ({Math.round((1 - estimate.size / Math.max(1, original)) * 100)} % smaller), {estimate.images}{' '}
              {estimate.images === 1 ? 'image' : 'images'} resampled.
            </>
          ) : (
            <span className="text-muted-foreground">Now {mb(original)}. Check how small it gets before you download.</span>
          )}
        </div>
        <DialogFooter className="gap-2">
          {current && (
            <Button
              variant="ghost"
              className="h-11 lg:h-9"
              onClick={() => {
                useSession.getState().set({ compress: null })
                close()
              }}
            >
              Don’t compress
            </Button>
          )}
          <Button variant="outline" className="h-11 lg:h-9" disabled={busy} onClick={() => void check()} data-testid="compress-check">
            Check size
          </Button>
          <Button
            className="h-11 lg:h-9"
            disabled={busy}
            data-testid="compress-download"
            onClick={() => {
              useSession.getState().set({ compress: { dpi: p.dpi, quality: p.quality } })
              close()
              void downloadPdf()
            }}
          >
            Download compressed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
