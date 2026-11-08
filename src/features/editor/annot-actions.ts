import { bbox } from '@/lib/annotations'
import { uid } from '@/lib/ids'
import { useDoc } from '@/store/document'
import { useUi } from '@/store/ui'
import type { AnnotElement, AnnotType, PtRect } from '@/types'

const NOTE = 20

/** Creates an annotation from absolute page-space geometry; stores it relative to its box. */
export function createAnnot(pageId: string, type: AnnotType, g: { quads?: PtRect[]; points?: number[][]; rect?: PtRect; at?: { x: number; y: number }; text?: string }) {
  const ui = useUi.getState()
  const color = ui.annotColors[type]
  const strokeWidth = type === 'ink' ? 2 : type === 'rect' || type === 'arrow' ? 2 : undefined
  let box: PtRect
  if (type === 'note') box = { x: (g.at?.x ?? 0) - NOTE / 2, y: (g.at?.y ?? 0) - NOTE / 2, width: NOTE, height: NOTE }
  else if (type === 'rect') box = g.rect!
  else box = bbox(g.quads ?? [], g.points ?? [], type === 'ink' || type === 'arrow' ? (strokeWidth ?? 2) * 3 : 0)
  const rel = (r: PtRect) => ({ ...r, x: r.x - box.x, y: r.y - box.y })
  const el: AnnotElement = {
    id: uid('n_'),
    kind: 'annot',
    pageId,
    type,
    color,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: 0,
    ...(g.quads ? { quads: g.quads.map(rel) } : {}),
    ...(g.points ? { points: g.points.map((p) => p.map((v, i) => v - (i % 2 ? box.y : box.x))) } : {}),
    ...(strokeWidth ? { strokeWidth } : {}),
    ...(g.text ? { text: g.text } : {}),
  }
  useDoc.getState().addElement(el)
  // A new note asks for its text right away (the panel's comment box).
  ui.set({ selectedId: el.id, ...(type === 'note' ? { propsOpen: true } : {}) })
  return el
}
