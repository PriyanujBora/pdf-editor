import { Ellipsis, Files, Minimize2, Search, SlidersHorizontal } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { pickImage } from './actions'
import { TOOLS } from './tools'
import { openSignature } from './sign-actions'

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
  const more = TOOLS.filter((t) => !t.primary)
  const run = (id: (typeof TOOLS)[number]['id']) => (id === 'image' ? pickImage() : id === 'sign' ? openSignature() : useUi.getState().setTool(id))
  return (
    <nav
      aria-label="Tools"
      className="flex shrink-0 items-stretch gap-1 border-t bg-background px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),0.375rem)]"
    >
      {TOOLS.filter((t) => t.primary).map((t) => (
        <BarButton key={t.id} testId={t.id} label={t.short} icon={t.icon} active={t.id === tool} onClick={() => run(t.id)} />
      ))}
      {/* Less frequent tools: Edit text, Add image, Redact. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-tool="more"
            aria-label="More tools"
            className={cn(
              'flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium text-muted-foreground active:bg-muted',
              more.some((t) => t.id === tool) && 'bg-brand/10 text-brand',
            )}
          >
            <Ellipsis className="size-5" />
            More
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" className="min-w-48">
          {more.map((t) => (
            <DropdownMenuItem key={t.id} data-tool={t.id} className="min-h-11 gap-3" onSelect={() => run(t.id)}>
              <t.icon className="size-4" /> {t.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem data-tool="compress" className="min-h-11 gap-3" onSelect={() => useUi.getState().set({ compressOpen: true })}>
            <Minimize2 className="size-4" /> Compress
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="my-2 w-px bg-border" />
      <BarButton testId="pages" label="Pages" icon={Files} onClick={() => useUi.getState().set({ thumbsOpen: true })} />
      <BarButton
        testId="props"
        label={tool === 'redact' && !hasSelection ? 'Find' : 'Style'}
        icon={tool === 'redact' && !hasSelection ? Search : SlidersHorizontal}
        disabled={!hasSelection && tool !== 'redact'}
        onClick={() => useUi.getState().set({ propsOpen: true, editingId: null })}
      />
    </nav>
  )
}
