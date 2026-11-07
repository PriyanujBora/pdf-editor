import type { ReactNode } from 'react'
import { create } from 'zustand'

export interface ChoiceOption<T extends string> {
  value: T
  label: string
  variant?: 'default' | 'outline' | 'destructive'
}

interface Pending {
  title: string
  description: ReactNode
  icon?: ReactNode
  options: ChoiceOption<string>[]
  resolve: (v: string | null) => void
}

export const useChoice = create<{ pending: Pending | null }>()(() => ({ pending: null }))

/** Asks the user to pick one option; resolves with its value, or null when dismissed. */
export function choose<T extends string>(opts: Omit<Pending, 'resolve' | 'options'> & { options: ChoiceOption<T>[] }): Promise<T | null> {
  return new Promise((resolve) => {
    useChoice.getState().pending?.resolve(null)
    useChoice.setState({ pending: { ...opts, resolve: resolve as (v: string | null) => void } })
  })
}

export const settle = (v: string | null) => {
  const p = useChoice.getState().pending
  useChoice.setState({ pending: null })
  p?.resolve(v)
}

