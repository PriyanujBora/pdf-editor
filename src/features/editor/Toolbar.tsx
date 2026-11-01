import { ArrowLeft, Download, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import { downloadPdf } from './actions'
import { fitWidth } from './Viewer'

export function Toolbar() {
  const fileName = useSession((s) => s.fileName)
  const zoom = useUi((s) => s.zoom)
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-2">
      <Button variant="ghost" size="icon" className="size-11" aria-label="Close file" onClick={() => useSession.getState().close()}>
        <ArrowLeft />
      </Button>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{fileName}</span>
      <Button variant="ghost" size="icon" className="size-11" onClick={() => useUi.getState().setZoom(zoom / 1.2)} aria-label="Zoom out">
        <Minus />
      </Button>
      <button className="h-11 w-14 text-sm tabular-nums" onClick={() => fitWidth()}>
        {Math.round(zoom * 100)}%
      </button>
      <Button variant="ghost" size="icon" className="size-11" onClick={() => useUi.getState().setZoom(zoom * 1.2)} aria-label="Zoom in">
        <Plus />
      </Button>
      <ThemeToggle />
      <Button className="h-11" onClick={() => void downloadPdf()}>
        <Download /> Download
      </Button>
    </header>
  )
}
