import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAutosave, useShortcuts } from '@/hooks/use-editor-effects'
import { useIsDesktop } from '@/hooks/use-media-query'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import { ChoiceDialog } from './ChoiceDialog'
import { SignatureDialog } from './SignatureDialog'
import { AnnotateBar } from './AnnotateBar'
import { ExtractDialog } from './ExtractDialog'
import { MobileToolbar } from './MobileToolbar'
import { PropertiesPanel } from './PropertiesPanel'
import { Thumbnails } from './Thumbnails'
import { MobileTopBar, Toolbar } from './Toolbar'
import { Viewer } from './Viewer'

function PageCount() {
  const n = useDoc((s) => s.pages.length)
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {n} {n === 1 ? 'page' : 'pages'}
    </span>
  )
}

export default function Editor() {
  useAutosave()
  useShortcuts()
  const desktop = useIsDesktop()
  const thumbsOpen = useUi((s) => s.thumbsOpen)
  const propsOpen = useUi((s) => s.propsOpen)

  if (desktop) {
    return (
      <TooltipProvider delayDuration={400}>
        <div className="flex h-full flex-col bg-workspace">
          <Toolbar />
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-[184px] shrink-0 flex-col border-r bg-background" aria-label="Pages">
              <div className="flex h-10 items-center justify-between border-b px-3">
                <span className="text-xs font-medium">Pages</span>
                <PageCount />
              </div>
              <Thumbnails className="min-h-0 flex-1" />
            </aside>
            <main className="relative min-w-0 flex-1">
              <Viewer />
              <AnnotateBar className="top-3" />
            </main>
            <aside className="w-72 shrink-0 overflow-y-auto border-l bg-background" aria-label="Properties">
              <PropertiesPanel />
            </aside>
          </div>
          <ChoiceDialog />
          <SignatureDialog />
          <ExtractDialog />
        </div>
      </TooltipProvider>
    )
  }

  return (
    <div className="flex h-full flex-col bg-workspace">
      <MobileTopBar />
      <main className="relative min-h-0 flex-1">
        <Viewer />
        <AnnotateBar className="bottom-3" />
      </main>
      <MobileToolbar />
      <ChoiceDialog />
      <SignatureDialog />
      <ExtractDialog />

      <Sheet open={thumbsOpen} onOpenChange={(o) => useUi.getState().set({ thumbsOpen: o })}>
        <SheetContent side="left" className="flex w-[min(85vw,280px)] flex-col gap-0 p-0">
          <SheetHeader className="border-b">
            <SheetTitle>Pages</SheetTitle>
            <SheetDescription>Tap to jump. Long-press and drag to reorder.</SheetDescription>
          </SheetHeader>
          <Thumbnails className="min-h-0 flex-1" />
        </SheetContent>
      </Sheet>

      <Drawer open={propsOpen} onOpenChange={(o) => useUi.getState().set({ propsOpen: o })}>
        <DrawerContent className="max-h-[85dvh]">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Properties</DrawerTitle>
            <DrawerDescription>Change the selected element</DrawerDescription>
          </DrawerHeader>
          <div className="overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <PropertiesPanel />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}
