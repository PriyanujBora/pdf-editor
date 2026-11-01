import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import './index.css'
import App from './App.tsx'
import { OpenFailure, openFile } from './lib/open-document'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PDFs opened with the installed app ("Open with…") arrive via the launch queue.
interface LaunchParams {
  files: FileSystemFileHandle[]
}
const launchQueue = (window as unknown as { launchQueue?: { setConsumer: (cb: (p: LaunchParams) => void) => void } }).launchQueue
launchQueue?.setConsumer(async ({ files }) => {
  const handle = files[0]
  if (!handle) return
  try {
    await openFile(await handle.getFile())
  } catch (err) {
    const info = err instanceof OpenFailure ? err.info : null
    toast.error(info?.kind === 'invalid' ? info.message : 'Open this protected PDF from the start screen to enter its password.')
  }
})
