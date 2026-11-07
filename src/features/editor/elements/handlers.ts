import type Konva from 'konva'

type Evt<E extends Event = Event> = Konva.KonvaEventObject<E>

export interface NodeHandlers {
  onPointerDown?: (e: Evt<PointerEvent>) => void
  onMouseDown?: (e: Evt<MouseEvent>) => void
  onTouchStart?: (e: Evt<TouchEvent>) => void
  onClick?: (e: Evt<MouseEvent>) => void
  onTap?: (e: Evt<TouchEvent>) => void
  onDblClick?: (e: Evt<MouseEvent>) => void
  onDblTap?: (e: Evt<TouchEvent>) => void
  onDragEnd?: (e: Evt<DragEvent>) => void
  onTransformEnd?: (e: Evt<Event>) => void
}
