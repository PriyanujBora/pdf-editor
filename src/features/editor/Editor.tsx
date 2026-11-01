import { useAutosave, useShortcuts } from '@/hooks/use-editor-effects'
import { Toolbar } from './Toolbar'
import { Viewer } from './Viewer'

export default function Editor() {
  useAutosave()
  useShortcuts()
  return (
    <div className="flex h-full flex-col bg-workspace">
      <Toolbar />
      <main className="relative min-h-0 flex-1">
        <Viewer />
      </main>
    </div>
  )
}
