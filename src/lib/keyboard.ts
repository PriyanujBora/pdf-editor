/**
 * iOS only opens the on-screen keyboard for focus() calls made synchronously
 * inside a user gesture. Our text editor mounts a frame later, so we focus a
 * hidden textarea during the tap, then hand focus over once the real editor
 * exists — the keyboard stays up across the hand-off.
 */
let proxy: HTMLTextAreaElement | null = null

export function primeKeyboard() {
  if (!matchMedia('(pointer: coarse)').matches) return
  if (!proxy) {
    proxy = document.createElement('textarea')
    proxy.setAttribute('aria-hidden', 'true')
    proxy.tabIndex = -1
    Object.assign(proxy.style, {
      position: 'fixed',
      top: '40%',
      left: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      fontSize: '16px',
      pointerEvents: 'none',
    })
    document.body.appendChild(proxy)
  }
  proxy.focus({ preventScroll: true })
}
