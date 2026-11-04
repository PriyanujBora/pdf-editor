import { memo } from 'react'
import { Group, Image as KImage, Rect } from 'react-konva'
import { useScanPatch, type ScanText } from '@/lib/scan/compose'
import type { NodeHandlers } from './handlers'

interface Props extends NodeHandlers {
  el: ScanText
  editing: boolean
  selected: boolean
}

/**
 * A text edit on a scanned page, drawn *into* the scan: the old letters are
 * repainted with paper and the new ones carry the scan's ink, blur and grain.
 * Locked to its line (no drag/resize); the selection shows as an outline.
 */
export const ScanTextNode = memo(function ScanTextNode({ el, editing, selected, ...handlers }: Props) {
  const patch = useScanPatch(el, editing)
  const r = el.scan.region
  const box = el.scan.lineBox
  return (
    <Group id={el.id} name="element" {...handlers} preventDefault={selected}>
      {patch && <KImage image={patch} x={r.x} y={r.y} width={r.width} height={r.height} listening={false} />}
      {/* Hit area + selection outline around the line itself. */}
      <Rect
        x={box.x - 2}
        y={box.y - 2}
        width={Math.max(box.width, 8) + 4}
        height={box.height + 4}
        fill="rgba(0,0,0,0.001)"
        stroke={selected && !editing ? 'oklch(0.56 0.22 268)' : undefined}
        strokeWidth={1.25}
        strokeScaleEnabled={false}
        dash={[4, 3]}
        cornerRadius={2}
      />
    </Group>
  )
})
