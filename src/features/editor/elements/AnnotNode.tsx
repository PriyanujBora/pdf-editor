import { memo } from 'react'
import { Arrow, Group, Line, Rect } from 'react-konva'
import type { AnnotElement } from '@/types'
import type { NodeHandlers } from './handlers'

interface Props extends NodeHandlers {
  el: AnnotElement
  draggable: boolean
  selected: boolean
}

/** Draws an annotation the way its exported appearance stream does (lib/export/annotations.ts). */
export function AnnotShape({ el }: { el: Pick<AnnotElement, 'type' | 'color' | 'width' | 'height' | 'quads' | 'points' | 'strokeWidth'> }) {
  const sw = el.strokeWidth ?? 2
  switch (el.type) {
    case 'highlight':
      return (
        <>
          {(el.quads ?? []).map((q, i) => (
            <Rect key={i} x={q.x} y={q.y} width={q.width} height={q.height} fill={el.color} opacity={0.45} />
          ))}
        </>
      )
    case 'underline':
    case 'strike':
      return (
        <>
          {(el.quads ?? []).map((q, i) => {
            const y = el.type === 'underline' ? q.y + q.height * 0.9 : q.y + q.height * 0.55
            return <Line key={i} points={[q.x, y, q.x + q.width, y]} stroke={el.color} strokeWidth={Math.max(0.8, q.height * 0.07)} />
          })}
        </>
      )
    case 'note':
      return (
        <>
          <Rect width={el.width} height={el.height} fill={el.color} cornerRadius={3} stroke="rgba(0,0,0,0.35)" strokeWidth={0.6} />
          {[0.3, 0.5, 0.7].map((f) => (
            <Line key={f} points={[el.width * 0.22, el.height * f, el.width * 0.78, el.height * f]} stroke="rgba(0,0,0,0.55)" strokeWidth={1} />
          ))}
        </>
      )
    case 'ink':
      return (
        <>
          {(el.points ?? []).map((p, i) => (
            <Line key={i} points={p} stroke={el.color} strokeWidth={sw} lineCap="round" lineJoin="round" tension={0.3} />
          ))}
        </>
      )
    case 'rect':
      return <Rect x={sw / 2} y={sw / 2} width={Math.max(1, el.width - sw)} height={Math.max(1, el.height - sw)} stroke={el.color} strokeWidth={sw} />
    case 'arrow': {
      const p = el.points?.[0] ?? [0, 0, 0, 0]
      return <Arrow points={p} stroke={el.color} fill={el.color} strokeWidth={sw} pointerLength={sw * 4 + 4} pointerWidth={sw * 4 + 4} lineCap="round" />
    }
  }
}

export const AnnotNode = memo(function AnnotNode({ el, draggable, selected, ...handlers }: Props) {
  return (
    <Group id={el.id} name="element annotation" x={el.x} y={el.y} draggable={draggable} preventDefault={selected} {...handlers}>
      {/* Hit area: the whole box (thin lines and highlights are otherwise hard to grab). */}
      <Rect width={Math.max(6, el.width)} height={Math.max(6, el.height)} fill="rgba(0,0,0,0.001)" />
      <AnnotShape el={el} />
      {selected && <Rect width={el.width} height={el.height} stroke="oklch(0.56 0.22 268)" strokeWidth={1} dash={[3, 2]} strokeScaleEnabled={false} listening={false} />}
    </Group>
  )
})
