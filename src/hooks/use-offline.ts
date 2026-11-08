import { useEffect, useState } from 'react'

/**
 * Whether the app works offline yet (the service worker is active and its precache is filled) and
 * whether the device is offline right now. Nothing leaves the device either way.
 */
export function useOfflineStatus() {
  const [ready, setReady] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    let alive = true
    let t: ReturnType<typeof setInterval> | undefined
    const check = async () => {
      try {
        if (!('serviceWorker' in navigator) || !('caches' in window)) return
        const reg = await navigator.serviceWorker.getRegistration()
        if (!reg?.active) return
        const keys = await caches.keys()
        if (alive && keys.some((k) => k.startsWith('workbox-precache'))) {
          setReady(true)
          clearInterval(t)
        }
      } catch {
        /* storage unavailable (private mode) */
      }
    }
    void check()
    t = setInterval(() => void check(), 4000)
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return { ready, online }
}
