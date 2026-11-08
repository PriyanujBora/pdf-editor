import { lazy, Suspense } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { Landing } from '@/features/landing/Landing'
import { useThemeClass } from '@/hooks/use-theme'
import { useSession } from '@/store/session'

const Editor = lazy(() => import('@/features/editor/Editor'))
const About = lazy(() => import('@/features/about/About'))

if (import.meta.env.DEV) {
  // Test hook for the Playwright suite (stripped from production builds).
  void Promise.all([import('@/store/document'), import('@/store/ui')]).then(([d, u]) => {
    Object.assign(window, { __doc: d.useDoc, __ui: u.useUi, __session: useSession })
  })
}

export default function App() {
  useThemeClass()
  const ready = useSession((s) => s.status === 'ready' || (s.status === 'loading' && s.pdf !== null))
  // The only other page: /about (a static-assets SPA fallback serves index.html for it).
  if (location.pathname.replace(/\/+$/, '') === '/about')
    return (
      <Suspense fallback={<div className="h-full bg-workspace" />}>
        <About />
      </Suspense>
    )

  return (
    <>
      {ready ? (
        <Suspense fallback={<div className="h-full bg-workspace" />}>
          <Editor />
        </Suspense>
      ) : (
        <Landing />
      )}
      <Toaster position="top-center" />
    </>
  )
}
