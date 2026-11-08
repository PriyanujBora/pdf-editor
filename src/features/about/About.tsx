import { ArrowLeft, Check, HardDrive, Scale, ShieldCheck, Trash2, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useOfflineStatus } from '@/hooks/use-offline'

const REPO = 'https://github.com/PriyanujBora/pdf-editor'

function Section({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-2xl border bg-background p-5 md:p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <Icon className="size-5 text-brand" /> {title}
      </h2>
      <div className="grid gap-3 text-[15px] leading-relaxed text-muted-foreground [&_b]:font-medium [&_b]:text-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px]">
        {children}
      </div>
    </section>
  )
}

/** Deletes everything this app keeps in this browser: autosave, saved signatures, offline copy. */
async function forgetDevice() {
  const dbs = ['free-pdf-editor', 'free-pdf-editor-signatures']
  await Promise.all(
    dbs.map(
      (name) =>
        new Promise<void>((resolve) => {
          try {
            const r = indexedDB.deleteDatabase(name)
            r.onsuccess = r.onerror = r.onblocked = () => resolve()
          } catch {
            resolve()
          }
        }),
    ),
  )
  try {
    for (const k of await caches.keys()) await caches.delete(k)
    for (const r of (await navigator.serviceWorker?.getRegistrations()) ?? []) await r.unregister()
  } catch {
    /* not available */
  }
  try {
    localStorage.clear()
  } catch {
    /* not available */
  }
}

export default function About() {
  const { ready, online } = useOfflineStatus()
  const [forgotten, setForgotten] = useState(false)
  return (
    <main className="min-h-full bg-workspace">
      <div className="mx-auto grid max-w-2xl gap-5 px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-16 md:px-6">
        <header className="flex items-center gap-2 pt-2">
          <Button variant="ghost" className="h-11 gap-2 px-2" asChild>
            <a href="/">
              <ArrowLeft className="size-4" /> Free PDF Editor
            </a>
          </Button>
        </header>
        <div className="grid gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">About & privacy</h1>
          <p className="text-lg text-muted-foreground">
            A PDF editor that runs entirely in your browser. <b className="text-foreground">Free forever. No ads, no account, no limits, no watermarks.</b>
          </p>
        </div>

        <Section icon={ShieldCheck} title="Your files never leave your device">
          <p>
            Opening, editing, redacting and saving all happen on this device, in this browser tab. There is no server that
            receives files: this site is a set of static files, and the browser is told it may not send data anywhere else.
          </p>
          <p>
            <b>Don’t take our word for it — check:</b>
          </p>
          <ul className="grid list-disc gap-2 pl-5">
            <li>
              The page’s Content-Security-Policy contains <code>connect-src 'self'</code>: the browser blocks any connection to
              another site, so even a bug couldn’t upload a file. (Developer tools → Network → the page’s response headers.)
            </li>
            <li>Open the Network tab while you edit and download: no request carries your file.</li>
            <li>Turn off Wi-Fi or switch to flight mode once the app has loaded — everything keeps working.</li>
            <li>
              Read the code:{' '}
              <a className="font-medium text-brand underline-offset-2 hover:underline" href={REPO} rel="noreferrer">
                github.com/PriyanujBora/pdf-editor
              </a>
              .
            </li>
          </ul>
          <p>No analytics, no telemetry, no crash reporting, no cookies.</p>
        </Section>

        <Section icon={WifiOff} title="Works offline">
          <p className="flex items-center gap-2" data-testid="offline-status">
            {ready ? (
              <>
                <Check className="size-4 text-emerald-600" /> <b>Ready offline on this device.</b>
              </>
            ) : (
              'Saving a copy for offline use… (it’s ready after the first visit).'
            )}
            {!online && <span> You’re offline right now.</span>}
          </p>
          <p>Install it from your browser’s menu to open PDFs from your files app like any other app.</p>
        </Section>

        <Section icon={HardDrive} title="What stays on this device">
          <p>
            So you don’t lose work, the file you’re editing and your changes are saved in this browser’s storage
            (IndexedDB) until you open another file. Passwords are never stored. Signatures you choose to remember are
            kept here too. Nothing of it is ever sent anywhere.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              className="h-11 gap-2"
              data-testid="forget-device"
              onClick={async () => {
                await forgetDevice()
                setForgotten(true)
              }}
            >
              <Trash2 /> Forget everything on this device
            </Button>
            {forgotten && <span className="text-sm text-foreground">Done — autosave, saved signatures and the offline copy are gone.</span>}
          </div>
        </Section>

        <Section icon={Scale} title="Honest limits">
          <ul className="grid list-disc gap-2 pl-5">
            <li>Edited text uses the PDF’s own fonts where they have the letters, otherwise the closest bundled font — the app tells you when.</li>
            <li>
              When old text can’t be removed from the file (rare fonts, text used as a clipping path), it is covered and
              you’re told it’s still in the file. Redaction refuses to download instead.
            </li>
            <li>Edits on scanned pages are recorded in the file’s metadata.</li>
            <li>There is no OCR: scans without a text layer can be annotated and signed, not searched.</li>
            <li>Calculated form fields aren’t recalculated here; Acrobat and most viewers do it when the file opens.</li>
          </ul>
        </Section>

        <Section icon={Scale} title="Open source">
          <p>
            The app’s code is released under the <b>MIT licence</b>. Bundled fonts keep their own licences (SIL Open Font
            License and Apache 2.0) —{' '}
            <a className="font-medium text-brand underline-offset-2 hover:underline" href="/fonts/LICENSE.txt">
              font licences
            </a>
            . PDF rendering by pdf.js (Apache 2.0), writing by pdf-lib (MIT).
          </p>
        </Section>
      </div>
    </main>
  )
}
