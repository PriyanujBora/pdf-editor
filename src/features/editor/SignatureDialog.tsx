import { Eraser, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { deleteSignature, listSignatures, loadScriptFont, removeBackground, renderTyped, saveSignature, SCRIPT_FONTS, trimToPng, type SavedSignature } from '@/lib/signatures'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { armSignature } from './sign-actions'

type Tab = 'draw' | 'type' | 'upload' | 'saved'
const INKS = [
  { id: 'black', label: 'Black', color: '#111111' },
  { id: 'blue', label: 'Blue', color: '#1d3fbf' },
]

/** Freehand pad: pointer strokes smoothed with midpoint quadratic curves, at 2× resolution. */
function DrawPad({ color, canvasRef, onInk }: { color: string; canvasRef: React.RefObject<HTMLCanvasElement | null>; onInk: (v: boolean) => void }) {
  const last = useRef<{ x: number; y: number; mx: number; my: number } | null>(null)
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height }
  }
  return (
    <canvas
      ref={canvasRef}
      width={1040}
      height={400}
      aria-label="Draw your signature"
      data-testid="sign-pad"
      className="h-[200px] w-full touch-none rounded-xl border bg-white"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        const p = pos(e)
        last.current = { ...p, mx: p.x, my: p.y }
        const ctx = e.currentTarget.getContext('2d')!
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2)
        ctx.fill()
        onInk(true)
      }}
      onPointerMove={(e) => {
        const l = last.current
        if (!l) return
        const p = pos(e)
        const ctx = e.currentTarget.getContext('2d')!
        const mx = (l.x + p.x) / 2
        const my = (l.y + p.y) / 2
        ctx.strokeStyle = color
        ctx.lineWidth = 5.2
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(l.mx, l.my)
        ctx.quadraticCurveTo(l.x, l.y, mx, my)
        ctx.stroke()
        last.current = { ...p, mx, my }
      }}
      onPointerUp={() => (last.current = null)}
      onPointerCancel={() => (last.current = null)}
    />
  )
}

export function SignatureDialog() {
  const open = useUi((s) => s.signOpen)
  const [tab, setTab] = useState<Tab>('draw')
  const [ink, setInk] = useState(INKS[0].color)
  const [drawn, setDrawn] = useState(false)
  const [name, setName] = useState('')
  const [face, setFace] = useState<string>(SCRIPT_FONTS[0].id)
  const [fontsReady, setFontsReady] = useState(false)
  const [upload, setUpload] = useState<ImageBitmap | null>(null)
  const [threshold, setThreshold] = useState(0.62)
  const [date, setDate] = useState(false)
  const [remember, setRemember] = useState(true)
  const [saved, setSaved] = useState<SavedSignature[]>([])
  const [busy, setBusy] = useState(false)
  const pad = useRef<HTMLCanvasElement | null>(null)
  const preview = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!open) return
    void listSignatures().then((s) => {
      setSaved(s)
      if (s.length) setTab('saved')
    })
  }, [open])
  useEffect(() => {
    if (open && tab === 'type' && !fontsReady) void Promise.all(SCRIPT_FONTS.map(loadScriptFont)).then(() => setFontsReady(true))
  }, [open, tab, fontsReady])
  // Upload preview with the paper removed.
  useEffect(() => {
    const c = preview.current
    if (!upload || !c) return
    const out = removeBackground(upload, threshold, 800)
    c.width = out.width
    c.height = out.height
    c.getContext('2d')!.drawImage(out, 0, 0)
  }, [upload, threshold, tab])
  const thumbs = useMemo(() => saved.map((s) => ({ s, url: URL.createObjectURL(new Blob([s.png as BlobPart], { type: 'image/png' })) })), [saved])
  useEffect(() => () => thumbs.forEach((t) => URL.revokeObjectURL(t.url)), [thumbs])

  const close = () => useUi.getState().set({ signOpen: false })
  const ready = tab === 'draw' ? drawn : tab === 'type' ? !!name.trim() && fontsReady : tab === 'upload' ? !!upload : false

  const place = async () => {
    setBusy(true)
    try {
      let canvas: HTMLCanvasElement | null = null
      if (tab === 'draw') canvas = pad.current
      else if (tab === 'type') canvas = renderTyped(name.trim(), SCRIPT_FONTS.find((f) => f.id === face)!.family, ink)
      else if (tab === 'upload' && upload) canvas = removeBackground(upload, threshold)
      if (!canvas) return
      const t = await trimToPng(canvas)
      if (!t) return
      if (remember) await saveSignature(t)
      armSignature(t.png, t.width, t.height, date)
    } finally {
      setBusy(false)
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    ...(saved.length ? [{ id: 'saved' as Tab, label: 'Saved' }] : []),
    { id: 'draw', label: 'Draw' },
    { id: 'type', label: 'Type' },
    { id: 'upload', label: 'Upload' },
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-xl" data-testid="sign-dialog">
        <DialogHeader>
          <DialogTitle>Your signature</DialogTitle>
          <DialogDescription>Stays on this device. It’s added to the page as an image you can move and resize.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-xl bg-muted/70 p-1" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              data-testid={`sign-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn('min-h-11 flex-1 rounded-lg text-sm font-medium text-muted-foreground lg:min-h-9', tab === t.id && 'bg-background text-foreground shadow-sm')}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab !== 'saved' && tab !== 'upload' && (
          <div className="flex items-center gap-2 text-sm" role="radiogroup" aria-label="Ink colour">
            {INKS.map((i) => (
              <button
                key={i.id}
                role="radio"
                aria-checked={ink === i.color}
                aria-label={i.label}
                onClick={() => setInk(i.color)}
                className={cn('grid size-11 place-items-center rounded-full border-2 lg:size-8', ink === i.color ? 'border-brand' : 'border-transparent')}
              >
                <span className="size-6 rounded-full lg:size-5" style={{ background: i.color }} />
              </button>
            ))}
          </div>
        )}

        {tab === 'draw' && (
          <div className="grid gap-2">
            <DrawPad color={ink} canvasRef={pad} onInk={setDrawn} />
            <Button
              variant="ghost"
              className="h-10 justify-self-start gap-2 lg:h-8"
              onClick={() => {
                const c = pad.current
                c?.getContext('2d')!.clearRect(0, 0, c.width, c.height)
                setDrawn(false)
              }}
            >
              <Eraser /> Clear
            </Button>
          </div>
        )}

        {tab === 'type' && (
          <div className="grid gap-3">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="h-11 text-base" aria-label="Your name" data-testid="sign-name" />
            <div className="grid gap-2 sm:grid-cols-2">
              {SCRIPT_FONTS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFace(f.id)}
                  aria-pressed={face === f.id}
                  className={cn('min-h-20 truncate rounded-xl border-2 bg-white px-3 text-left text-3xl', face === f.id ? 'border-brand' : 'border-border')}
                  style={{ fontFamily: `"${f.family}"`, color: ink }}
                >
                  {fontsReady ? name.trim() || 'Your name' : '…'}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'upload' && (
          <div className="grid gap-3">
            <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-sm hover:bg-muted/60">
              <Upload className="size-4" /> {upload ? 'Choose another photo' : 'Choose a photo or scan of your signature'}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                data-testid="sign-upload"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) setUpload(await createImageBitmap(f, { imageOrientation: 'from-image' }))
                }}
              />
            </label>
            {upload && (
              <>
                <canvas
                  ref={preview}
                  className="max-h-48 w-full rounded-xl border object-contain"
                  style={{ background: 'repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px' }}
                />
                <label className="grid gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">Remove background — move until only the ink is left</span>
                  <input type="range" min={0.3} max={0.95} step={0.01} value={threshold} onChange={(e) => setThreshold(+e.target.value)} />
                </label>
              </>
            )}
          </div>
        )}

        {tab === 'saved' && (
          <ul className="grid grid-cols-2 gap-2">
            {thumbs.map(({ s, url }) => (
              <li key={s.id} className="relative">
                <button
                  className="grid h-24 w-full place-items-center rounded-xl border bg-white p-2 hover:border-brand"
                  onClick={() => armSignature(s.png, s.width, s.height, date)}
                  aria-label="Use this signature"
                >
                  <img src={url} alt="" className="max-h-full max-w-full" />
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1 right-1 size-9"
                  aria-label="Delete saved signature"
                  onClick={async () => {
                    await deleteSignature(s.id)
                    setSaved(await listSignatures())
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-1 text-sm">
          <label className="flex min-h-11 items-center gap-3 lg:min-h-8">
            <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={date} onChange={(e) => setDate(e.target.checked)} data-testid="sign-date" />
            Add today’s date below it
          </label>
          {tab !== 'saved' && (
            <label className="flex min-h-11 items-center gap-3 lg:min-h-8">
              <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember it on this device
            </label>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 lg:h-9" onClick={close}>
            Cancel
          </Button>
          {tab !== 'saved' && (
            <Button className="h-11 lg:h-9" disabled={!ready || busy} onClick={() => void place()} data-testid="sign-place">
              Place signature
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
