import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toggleTheme } from '@/hooks/use-theme'
import { useUi } from '@/store/ui'
import { cn } from '@/lib/utils'

export function ThemeToggle({ className }: { className?: string }) {
  const dark = useUi((s) => s.theme === 'dark')
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('size-11 md:size-9', className)}
      onClick={toggleTheme}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}
