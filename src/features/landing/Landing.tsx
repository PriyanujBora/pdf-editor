import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, FileUp, History, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { OpenFailure, openFile, resumeSaved } from '@/lib/open-document'
import { peekSavedName } from '@/lib/persist'
import { useSession } from '@/store/session'
import { cn } from '@/lib/utils'
import { useOfflineStatus } from '@/hooks/use-offline'

// The dialog (and Radix' focus/scroll machinery) is only needed for protected files.
const PasswordDialog = lazy(() => import('./PasswordDialog').then((m) => ({ default: m.PasswordDialog })))

type Pending = { kind: 'file'; file: File } | { kind: 'resume'; name: string }

export function Landing() {
  const inputRef = useRef<HTMLInputElement>(null)
  const status = useSession((s) => s.status)
  const progress = useSession((s) => s.progress)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [pwd, setPwd] = useState<{ pending: Pending; wrong: boolean } | null>(null)

  useEffect(() => {
    void peekSavedName().then(setSavedName)
  }, [])

  const run = useCallback(async (pending: Pending, password?: string) => {
    setError(null)
    setBusyName(pending.kind === 'file' ? pending.file.name : pending.name)
    try {
      if (pending.kind === 'file') await openFile(pending.file, password)
      else await resumeSaved(password)
      setPwd(null)
    } catch (err) {
      const info = err instanceof OpenFailure ? err.info : { kind: 'invalid' as const, message: String(err) }
      if (info.kind === 'password') setPwd({ pending, wrong: info.retry })
      else {
        setPwd(null)
        setError(info.message)
      }
    } finally {
      setBusyName(null)
    }
  }, [])

  const accept = useCallback(
    (files: FileList | null | undefined) => {
      const file = files?.[0]
      if (!file) return
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
      if (!isPdf) {
        setError('That isn’t a PDF. Choose a file ending in .pdf.')
        return
      }
      void run({ kind: 'file', file })
    },
    [run],
  )

  // While the landing page sits idle, warm up what opening a file needs: pdf.js + its worker and the
  // editor's code (all local and lazily loaded; the landing bundle itself doesn't grow).
  useEffect(() => {
    const ric = (window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1200))
    const id = ric(
      () => {
        void import('@/lib/pdf/pdfjs').then((m) => m.loadPdfJs())
        void import('@/features/editor/Editor')
      },
      { timeout: 3000 },
    )
    return () => (window as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id as number)
  }, [])

  // The whole window is a drop target.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      accept(e.dataTransfer?.files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [accept])

  const loading = status === 'loading' || busyName !== null
  const canDrop = !matchMedia('(pointer: coarse)').matches

  return (
    <main className="flex min-h-full flex-col bg-workspace">
      <header className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0.75rem)] md:px-6">
        <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="grid size-6 place-items-center rounded-md bg-foreground text-[10px] font-bold text-background">
            PDF
          </span>
          Free PDF Editor
        </span>
        <ThemeToggle />
      </header>

      <section className="flex flex-1 items-center justify-center px-4 py-8 md:px-6">
        <div className="w-full max-w-2xl">
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose a PDF file"
            aria-busy={loading}
            onClick={() => !loading && inputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !loading) {
                e.preventDefault()
                inputRef.current?.click()
              }
            }}
            className={cn(
              'group relative flex min-h-[min(68vh,520px)] cursor-pointer flex-col items-center justify-center gap-6 rounded-3xl border-2 border-dashed bg-background px-6 py-12 text-center transition-all outline-none',
              'border-border hover:border-foreground/25 focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15',
              dragging && 'scale-[1.01] border-brand bg-brand/5',
              loading && 'cursor-progress',
            )}
          >
            {loading ? (
              <LoadingState name={busyName ?? 'PDF'} progress={progress} />
            ) : (
              <>
                <div
                  className={cn(
                    'grid size-16 place-items-center rounded-2xl bg-brand/10 text-brand transition-transform group-hover:-translate-y-0.5',
                    dragging && '-translate-y-1',
                  )}
                >
                  <FileUp className="size-7" strokeWidth={1.75} />
                </div>
                <div className="space-y-2">
                  <h1 className="text-2xl font-semibold tracking-tight text-balance md:text-3xl">
                    {dragging ? 'Release to open' : canDrop ? 'Drop a PDF to start editing' : 'Open a PDF to start editing'}
                  </h1>
                  <p className="text-muted-foreground">Edit text, fill forms, sign, annotate, redact, merge and compress.</p>
                </div>
                <Button size="lg" className="h-12 rounded-xl px-6 text-base" tabIndex={-1}>
                  Choose PDF
                </Button>
                {error && (
                  <p
                    role="alert"
                    className="flex max-w-md items-start gap-2 rounded-xl bg-destructive/10 px-4 py-3 text-left text-sm text-destructive"
                  >
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    {error}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="mt-4 flex flex-col items-center gap-3 text-sm text-muted-foreground sm:flex-row sm:justify-between">
            <TrustStrip />
            {savedName && !loading && (
              <Button
                variant="ghost"
                className="h-11 max-w-full gap-2 text-foreground"
                onClick={() => void run({ kind: 'resume', name: savedName })}
              >
                <History className="size-4 shrink-0" />
                <span className="truncate">Continue “{savedName}”</span>
              </Button>
            )}
          </div>
        </div>
      </section>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          accept(e.target.files)
          e.target.value = ''
        }}
      />

      {pwd && (
        <Suspense>
          <PasswordDialog
            open={pwd !== null}
            wrong={pwd?.wrong ?? false}
            fileName={pwd ? (pwd.pending.kind === 'file' ? pwd.pending.file.name : pwd.pending.name) : ''}
            onSubmit={(p) => pwd && void run(pwd.pending, p)}
            onCancel={() => setPwd(null)}
          />
        </Suspense>
      )}
    </main>
  )
}

/** What the app promises, each one checkable (details on /about). */
function TrustStrip() {
  const { ready, online } = useOfflineStatus()
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 sm:justify-start" data-testid="trust">
      <li className="flex items-center gap-1.5">
        <ShieldCheck className="size-4" /> Files never leave your device
      </li>
      <li>Free forever · no ads, no account</li>
      <li className="flex items-center gap-1.5" data-testid="offline-badge">
        <span className={cn('size-2 rounded-full', ready ? 'bg-emerald-500' : 'bg-muted-foreground/40')} aria-hidden />
        {!online ? 'Offline — still works' : ready ? 'Works offline' : 'Getting ready for offline…'}
      </li>
      <li>
        <a href="/about" className="font-medium text-foreground underline-offset-2 hover:underline">
          About & privacy
        </a>
      </li>
    </ul>
  )
}

function LoadingState({ name, progress }: { name: string; progress: number }) {
  const pct = Math.round(progress * 100)
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-4" aria-live="polite">
      <p className="w-full truncate font-medium">Opening {name}</p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full bg-brand transition-[width] duration-200', pct === 0 && 'w-1/4 animate-pulse')}
          style={pct > 0 ? { width: `${pct}%` } : undefined}
        />
      </div>
      <p className="text-sm text-muted-foreground tabular-nums">{pct > 0 ? `Reading pages… ${pct}%` : 'Parsing…'}</p>
    </div>
  )
}
