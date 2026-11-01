import { useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface Props {
  open: boolean
  fileName: string
  wrong: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
}

export function PasswordDialog({ open, fileName, wrong, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState('')
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-full bg-muted">
            <LockKeyhole className="size-5" />
          </div>
          <DialogTitle>Password required</DialogTitle>
          <DialogDescription className="break-all">
            “{fileName}” is protected. The password is used only on this device.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(value)
            setValue('')
          }}
          className="grid gap-3"
        >
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Password"
            aria-invalid={wrong || undefined}
            className="h-11"
          />
          {wrong && <p className="text-sm text-destructive">That password didn’t work. Try again.</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" className="h-11" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" className="h-11" disabled={!value}>
              Unlock
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
