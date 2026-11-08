import { toast } from 'sonner'
import { uid } from '@/lib/ids'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { ImageElement, PageItem, TextElement } from '@/types'

export const openSignature = () => useUi.getState().set({ signOpen: true, editingId: null })

/** The dialog made a signature: wait for a tap on the page (Sign tool). */
export function armSignature(png: Uint8Array, width: number, height: number, date: boolean) {
  const id = uid('a_')
  useSession.getState().addAsset({ id, mime: 'image/png', bytes: png, width, height })
  useUi.getState().set({ signOpen: false, tool: 'sign', selectedId: null, pendingSign: { assetId: id, width, height, date } })
  toast('Tap where the signature goes', { id: 'sign-hint', description: 'You can move and resize it afterwards. Esc cancels.' })
}

/** Places the pending signature centred on a page-space point (upright on rotated pages), plus the date. */
export function placeSignature(page: PageItem, x: number, y: number) {
  const ui = useUi.getState()
  const p = ui.pendingSign
  if (!p) return
  // About 45 mm wide, at most about 18 mm tall.
  let w = 130
  let h = (w * p.height) / p.width
  if (h > 52) {
    h = 52
    w = (h * p.width) / p.height
  }
  // Elements rotate around their top-left corner; on a page the user turned they get the opposite
  // rotation so they read upright on screen. Top-left = centre + R·(offset from the centre).
  const rotation = (360 - page.rotation) % 360
  const t = (rotation * Math.PI) / 180
  const at = (ox: number, oy: number) => ({ x: x + ox * Math.cos(t) - oy * Math.sin(t), y: y + ox * Math.sin(t) + oy * Math.cos(t) })
  const tl = at(-w / 2, -h / 2)
  const img: ImageElement = { id: uid('i_'), kind: 'image', pageId: page.id, assetId: p.assetId, x: tl.x, y: tl.y, width: w, height: h, rotation }
  const els: (ImageElement | TextElement)[] = [img]
  if (p.date) {
    const d = at(-w / 2, h / 2 + 4)
    els.push({
      id: uid('t_'),
      kind: 'text',
      pageId: page.id,
      x: d.x,
      y: d.y,
      rotation,
      text: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      font: 'inter',
      size: 10,
      color: '#111111',
      bold: false,
      italic: false,
      align: 'left',
      lineHeight: 1.2,
    })
  }
  useDoc.getState().addElements(els)
  ui.set({ tool: 'select', pendingSign: null, selectedId: img.id })
  toast.dismiss('sign-hint')
}
