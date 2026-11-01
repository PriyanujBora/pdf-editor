import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => matchMedia(query).matches,
    () => false,
  )
}

/** Desktop layout: side panels + top toolbar. */
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')
export const isCoarsePointer = () => matchMedia('(pointer: coarse)').matches
