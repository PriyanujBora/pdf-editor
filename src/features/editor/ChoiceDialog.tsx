import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { settle, useChoice } from './choice'

/** Mounted once by the editor. */
export function ChoiceDialog() {
  const pending = useChoice((s) => s.pending)
  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && settle(null)}>
      <DialogContent className="sm:max-w-md" data-testid="choice-dialog">
        {pending && (
          <>
            <DialogHeader>
              {pending.icon && <div className="mb-2 grid size-10 place-items-center rounded-full bg-muted">{pending.icon}</div>}
              <DialogTitle>{pending.title}</DialogTitle>
              <DialogDescription asChild>
                <div className="text-sm text-muted-foreground">{pending.description}</div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-2">
              {pending.options.map((o, i) => (
                <Button
                  key={o.value}
                  variant={o.variant ?? (i === 0 ? 'default' : 'outline')}
                  className="h-11 lg:h-9"
                  autoFocus={i === 0}
                  onClick={() => settle(o.value)}
                >
                  {o.label}
                </Button>
              ))}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
