import { memo } from 'react'
import { Rect } from 'react-konva'
import type { RedactElement } from '@/types'
import type { NodeHandlers } from './handlers'

interface Props extends NodeHandlers {
  el: RedactElement
  draggable: boolean
  selected: boolean
}

/**
 * A redaction mark before it is applied: see-through, so the user can check what it covers. The
 * download removes everything under it and draws an opaque black box instead.
 */
export const RedactNode = memo(function RedactNode({ el, draggable, selected, ...handlers }: Props) {
  return (
    <Rect
      id={el.id}
      name="element redaction"
      x={el.x}
      y={el.y}
      width={el.width}
      height={el.height}
      fill={selected ? 'rgba(15,15,20,0.62)' : 'rgba(15,15,20,0.48)'}
      stroke="#e11d48"
      strokeWidth={1.5}
      strokeScaleEnabled={false}
      dash={[5, 3]}
      draggable={draggable}
      preventDefault={selected}
      {...handlers}
    />
  )
})
