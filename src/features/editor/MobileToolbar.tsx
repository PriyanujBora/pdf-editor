import { Files, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { pickImage } from './actions'
import { TOOLS } from './tools'

function BarButton({
  active,
  disabled,
  label,
  icon: Icon,
  onClick,
  testId,
}: {
  active?: boolean
  disabled?: boolean
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      data-tool={testId}
      onClick={onClick}
      className={cn(
        'flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium text-muted-foreground transition-colors',
        'active:bg-muted disabled:opacity-40',
        active && 'bg-brand/10 text-brand',
      )}
    >
      <Icon className="size-5" />
      {label}
    </button>
  )
}

/** Phone/tablet bottom toolbar. */
export function MobileToolbar() {
  const tool = useUi((s) => s.tool)
  const hasSelection = useUi((s) => s.selectedId !== null)
  return (
    <nav
      aria-label="Tools"
      className="flex shrink-0 items-stretch gap-1 border-t bg-background px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),0.375rem)]"
    >
      {TOOLS.map((t) => (
        <BarButton
          key={t.id}
          testId={t.id}
          label={t.short}
          icon={t.icon}
          active={t.id === tool}
          onClick={() => (t.id === 'image' ? pickImage() : useUi.getState().setTool(t.id))}
        />
      ))}
      <div className="my-2 w-px bg-border" />
      <BarButton testId="pages" label="Pages" icon={Files} onClick={() => useUi.getState().set({ thumbsOpen: true })} />
      <BarButton
        testId="props"
        label="Style"
        icon={SlidersHorizontal}
        disabled={!hasSelection}
        active={hasSelection}
        onClick={() => useUi.getState().set({ propsOpen: true, editingId: null })}
      />
    </nav>
  )
}
