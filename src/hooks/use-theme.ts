import { useEffect } from 'react'
import { useUi } from '@/store/ui'

export function useThemeClass() {
  const theme = useUi((s) => s.theme)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d0e10' : '#ffffff')
    try {
      localStorage.setItem('theme', theme)
    } catch {
      /* ignore */
    }
  }, [theme])
}

export const toggleTheme = () => useUi.setState((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' }))
