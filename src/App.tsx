import { lazy, Suspense } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Landing } from '@/features/landing/Landing'
import { useThemeClass } from '@/hooks/use-theme'
import { useSession } from '@/store/session'

const Editor = lazy(() => import('@/features/editor/Editor'))

export default function App() {
  useThemeClass()
  const ready = useSession((s) => s.status === 'ready' || (s.status === 'loading' && s.pdf !== null))

  return (
    <TooltipProvider delayDuration={400}>
      {ready ? (
        <Suspense fallback={<div className="h-full bg-workspace" />}>
          <Editor />
        </Suspense>
      ) : (
        <Landing />
      )}
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}
