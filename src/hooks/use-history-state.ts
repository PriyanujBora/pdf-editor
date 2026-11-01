import { useStore } from 'zustand'
import { useDoc } from '@/store/document'

export function useHistoryState() {
  const canUndo = useStore(useDoc.temporal, (s) => s.pastStates.length > 0)
  const canRedo = useStore(useDoc.temporal, (s) => s.futureStates.length > 0)
  return { canUndo, canRedo }
}
