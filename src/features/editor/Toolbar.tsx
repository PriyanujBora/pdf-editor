import { ArrowLeft, Download, Minus, Plus, Redo2, Undo2 } from 'lucide-react'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ThemeToggle } from '@/components/theme-toggle'
import { closeDocument } from '@/lib/open-document'
import { cn } from '@/lib/utils'
import { redo, undo, useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import { downloadPdf, pickImage } from './actions'
import { TOOLS } from './tools'
import { fitWidth } from './Viewer'

function IconTip({ label, shortcut, children }: { label: string; shortcut?: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut && <kbd className="ml-2 font-sans text-[11px] opacity-60">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

export function useHistoryState() {
  const canUndo = useStore(useDoc.temporal, (s) => s.pastStates.length > 0)
  const canRedo = useStore(useDoc.temporal, (s) => s.futureStates.length > 0)
  return { canUndo, canRedo }
}

export function FileTitle() {
  const fileName = useSession((s) => s.fileName)
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Button variant="ghost" size="icon" className="size-11 shrink-0 lg:size-9" aria-label="Close file" onClick={() => void closeDocument()}>
        <ArrowLeft />
      </Button>
      <span className="truncate text-sm font-medium" title={fileName}>
        {fileName}
      </span>
    </div>
  )
}

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** Desktop top toolbar. */
export function Toolbar() {
  const zoom = useUi((s) => s.zoom)
  const tool = useUi((s) => s.tool)
  const { canUndo, canRedo } = useHistoryState()

  return (
    <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b bg-background px-2">
      <FileTitle />

      <nav aria-label="Tools" className="flex items-center gap-1 rounded-xl bg-muted/70 p-1">
        {TOOLS.map((t) => {
          const active = t.id === tool
          return (
            <IconTip key={t.id} label={t.hint} shortcut={t.id === 'image' ? undefined : t.key}>
              <Button
                variant="ghost"
                aria-pressed={t.id === 'image' ? undefined : active}
                data-tool={t.id}
                className={cn(
                  'h-9 gap-2 rounded-lg px-3 text-muted-foreground hover:bg-background hover:text-foreground',
                  active && 'bg-background text-foreground shadow-sm ring-1 ring-border [&_svg]:text-brand',
                )}
                onClick={() => (t.id === 'image' ? pickImage() : useUi.getState().setTool(t.id))}
              >
                <t.icon />
                <span className="hidden xl:inline">{t.label}</span>
              </Button>
            </IconTip>
          )
        })}
      </nav>

      <div className="flex items-center justify-end gap-1">
        <IconTip label="Undo" shortcut={`${mod}Z`}>
          <Button variant="ghost" size="icon" className="size-9" disabled={!canUndo} onClick={undo} aria-label="Undo">
            <Undo2 />
          </Button>
        </IconTip>
        <IconTip label="Redo" shortcut={`${mod}Y`}>
          <Button variant="ghost" size="icon" className="size-9" disabled={!canRedo} onClick={redo} aria-label="Redo">
            <Redo2 />
          </Button>
        </IconTip>
        <Separator orientation="vertical" className="mx-1 !h-5" />
        <IconTip label="Zoom out" shortcut={`${mod}−`}>
          <Button variant="ghost" size="icon" className="size-9" onClick={() => useUi.getState().setZoom(zoom / 1.2)} aria-label="Zoom out">
            <Minus />
          </Button>
        </IconTip>
        <IconTip label="Fit width">
          <Button variant="ghost" className="h-9 w-14 px-0 tabular-nums" onClick={() => fitWidth()} aria-label="Fit width">
            {Math.round(zoom * 100)}%
          </Button>
        </IconTip>
        <IconTip label="Zoom in" shortcut={`${mod}+`}>
          <Button variant="ghost" size="icon" className="size-9" onClick={() => useUi.getState().setZoom(zoom * 1.2)} aria-label="Zoom in">
            <Plus />
          </Button>
        </IconTip>
        <Separator orientation="vertical" className="mx-1 !h-5" />
        <ThemeToggle />
        <Button className="ml-1 h-9 gap-2 rounded-lg px-4" onClick={() => void downloadPdf()} data-testid="download">
          <Download /> Download
        </Button>
      </div>
    </header>
  )
}

/** Phone/tablet top bar. */
export function MobileTopBar() {
  const { canUndo, canRedo } = useHistoryState()
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b bg-background px-1 pt-[env(safe-area-inset-top)]">
      <div className="min-w-0 flex-1">
        <FileTitle />
      </div>
      <Button variant="ghost" size="icon" className="size-11" disabled={!canUndo} onClick={undo} aria-label="Undo">
        <Undo2 />
      </Button>
      <Button variant="ghost" size="icon" className="size-11" disabled={!canRedo} onClick={redo} aria-label="Redo">
        <Redo2 />
      </Button>
      <ThemeToggle />
      <Button size="icon" className="mr-1 size-11 rounded-xl" onClick={() => void downloadPdf()} aria-label="Download PDF" data-testid="download">
        <Download />
      </Button>
    </header>
  )
}

