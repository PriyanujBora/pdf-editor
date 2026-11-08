import { memo } from 'react'
import { Group, Line, Rect, Text } from 'react-konva'
import type { FieldElement } from '@/types'
import type { NodeHandlers } from './handlers'

interface Props extends NodeHandlers {
  el: FieldElement
  draggable: boolean
  selected: boolean
}

const BRAND = 'oklch(0.56 0.22 268)'

/** A new form field before download: a tinted box with its name. */
export const FieldNode = memo(function FieldNode({ el, draggable, selected, ...handlers }: Props) {
  const label = Math.min(8, Math.max(5, el.height * 0.45))
  return (
    <Group id={el.id} name="element field" x={el.x} y={el.y} width={el.width} height={el.height} draggable={draggable} preventDefault={selected} {...handlers}>
      <Rect width={el.width} height={el.height} fill="rgba(59,91,255,0.1)" stroke={BRAND} strokeWidth={1} strokeScaleEnabled={false} dash={selected ? undefined : [4, 3]} />
      {el.fieldType === 'checkbox' ? (
        <Line points={[el.width * 0.22, el.height * 0.55, el.width * 0.42, el.height * 0.75, el.width * 0.8, el.height * 0.28]} stroke={BRAND} strokeWidth={1} strokeScaleEnabled={false} listening={false} opacity={0.6} />
      ) : (
        <Text text={el.name} x={2} y={1} fontSize={label} fill={BRAND} width={el.width - 4} wrap="none" ellipsis listening={false} />
      )}
    </Group>
  )
})
