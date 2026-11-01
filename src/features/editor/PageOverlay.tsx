import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Layer, Rect, Stage, Transformer } from 'react-konva'
import type Konva from 'konva'
import { useShallow } from 'zustand/react/shallow'
import { isCoarsePointer } from '@/hooks/use-media-query'
import { primeKeyboard } from '@/lib/keyboard'
import { getTextBlocks, type TextBlock } from '@/lib/pdf/text-blocks'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { EditorElement, PageItem } from '@/types'
import { createTextAt, editTextBlock } from './actions'
import { ImageNode } from './elements/ImageNode'
import { TextNode } from './elements/TextNode'

interface Props {
  page: PageItem
  /** Unrotated page size in points. */
  width: number
  height: number
  zoom: number
}

type KEvt = Konva.KonvaEventObject<Event>

const BRAND = 'oklch(0.56 0.22 268)'

/** Whether the element was already selected when the mouse went down. */
let pressedSelected: boolean | null = null

/** Konva group transform that maps page space onto the user-rotated page. */
function groupTransform(rot: number, w: number, h: number, zoom: number) {
  switch (rot) {
    case 90:
      return { x: h * zoom, y: 0, rotation: 90 }
    case 180:
      return { x: w * zoom, y: h * zoom, rotation: 180 }
    case 270:
      return { x: 0, y: w * zoom, rotation: 270 }
    default:
      return { x: 0, y: 0, rotation: 0 }
  }
}

export function PageOverlay({ page, width, height, zoom }: Props) {
  const groupRef = useRef<Konva.Group>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const elements = useDoc(useShallow((s) => Object.values(s.elements).filter((e) => e.pageId === page.id)))
  const tool = useUi((s) => s.tool)
  const selectedId = useUi((s) => s.selectedId)
  const editingId = useUi((s) => s.editingId)
  const pdf = useSession((s) => s.pdf)
  const coarse = useMemo(isCoarsePointer, [])
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null)

  const rotated = page.rotation % 180 !== 0
  const stageW = (rotated ? height : width) * zoom
  const stageH = (rotated ? width : height) * zoom
  const gt = groupTransform(page.rotation, width, height, zoom)

  // Detect existing text lazily, only when the edit-text tool is in use.
  useEffect(() => {
    if (tool !== 'edit-text' || !pdf || blocks) return
    let alive = true
    void pdf.getPage(page.srcIndex + 1).then((p) =>
      getTextBlocks(p, String(page.srcIndex)).then((b) => alive && setBlocks(b)),
    )
    return () => {
      alive = false
    }
  }, [tool, pdf, page.srcIndex, blocks])

  const covers = elements.flatMap((e) => (e.kind === 'text' && e.cover ? [{ id: e.id, ...e.cover }] : []))
  const visibleBlocks = useMemo(() => {
    if (tool !== 'edit-text' || !blocks) return []
    // Hide lines that already have a replacement.
    return blocks.filter(
      (b) =>
        !covers.some(
          (c) => b.x < c.x + c.width && b.x + b.width > c.x && b.y < c.y + c.height && b.y + b.height > c.y,
        ),
    )
  }, [tool, blocks, covers])

  // Attach the transformer to the selected element.
  useEffect(() => {
    const tr = trRef.current
    if (!tr) return
    const node = selectedId && selectedId !== editingId ? groupRef.current?.findOne<Konva.Node>('#' + selectedId) : null
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selectedId, editingId, elements])

  const selectedEl = elements.find((e) => e.id === selectedId)

  const onStageTap = (e: KEvt) => {
    if (e.target !== e.target.getStage()) return
    const ui = useUi.getState()
    if (ui.tool === 'text') {
      const pos = groupRef.current?.getRelativePointerPosition()
      if (!pos) return
      primeKeyboard()
      createTextAt(page.id, pos.x, pos.y)
    } else if (ui.selectedId || ui.editingId) {
      ui.set({ selectedId: null, editingId: null })
    }
  }

  const handlersFor = useCallback(
    (el: EditorElement) => {
      const select = () => {
        const ui = useUi.getState()
        if (ui.editingId && ui.editingId !== el.id) ui.set({ editingId: null })
        if (ui.selectedId !== el.id) ui.select(el.id)
      }
      const tapEdit = (e: KEvt) => {
        e.cancelBubble = true
        const ui = useUi.getState()
        const wasSelected = pressedSelected ?? ui.selectedId === el.id
        pressedSelected = null
        // Tapping an already-selected text (or any text with the text tools) edits it.
        if (el.kind === 'text' && (wasSelected || ui.tool !== 'select')) {
          primeKeyboard()
          ui.startEditing(el.id)
        } else select()
      }
      return {
        onPointerDown: (e: Konva.KonvaEventObject<PointerEvent>) => {
          // Mouse/pen select on press so a drag can start immediately; touch waits for a tap.
          if (e.evt.pointerType !== 'touch' && useUi.getState().tool === 'select') {
            e.cancelBubble = true
            pressedSelected = useUi.getState().selectedId === el.id
            select()
          }
        },
        onClick: tapEdit,
        onTap: tapEdit,
        onDblClick: (e: KEvt) => {
          e.cancelBubble = true
          if (el.kind === 'text') useUi.getState().startEditing(el.id)
        },
        onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
          useDoc.getState().updateElement(el.id, { x: e.target.x(), y: e.target.y() })
        },
        onTransformEnd: (e: KEvt) => {
          const n = e.target
          const sx = n.scaleX()
          const sy = n.scaleY()
          n.scale({ x: 1, y: 1 })
          const base = { x: n.x(), y: n.y(), rotation: Math.round(n.rotation() * 100) / 100 }
          if (el.kind === 'text') {
            const size = Math.max(2, Math.round(el.size * sy * 10) / 10)
            useDoc.getState().updateElement(el.id, { ...base, size })
          } else {
            useDoc.getState().updateElement(el.id, {
              ...base,
              width: Math.max(4, el.width * sx),
              height: Math.max(4, el.height * sy),
            })
          }
        },
      }
    },
    [],
  )

  const anchor = coarse ? 18 : 10

  return (
    <Stage
      width={stageW}
      height={stageH}
      className="absolute inset-0"
      onClick={onStageTap}
      onTap={onStageTap}
      style={{ cursor: tool === 'text' ? 'text' : 'default' }}
    >
      <Layer>
        <Group ref={groupRef} x={gt.x} y={gt.y} rotation={gt.rotation} scaleX={zoom} scaleY={zoom}>
          {covers.map((c) => (
            <Rect key={'c' + c.id} x={c.x} y={c.y} width={c.width} height={c.height} fill={c.color} listening={false} />
          ))}

          {visibleBlocks.map((b) => (
            <Rect
              key={b.id}
              x={b.x - 1}
              y={b.y - 1}
              width={b.width + 2}
              height={b.height + 2}
              cornerRadius={2}
              fill="rgba(99,102,241,0.07)"
              stroke="rgba(99,102,241,0.55)"
              strokeWidth={1 / zoom}
              strokeScaleEnabled={false}
              preventDefault={false}
              onMouseEnter={(e) => {
                e.target.to({ fill: 'rgba(99,102,241,0.18)', duration: 0.08 })
                const s = e.target.getStage()
                if (s) s.container().style.cursor = 'text'
              }}
              onMouseLeave={(e) => {
                e.target.to({ fill: 'rgba(99,102,241,0.07)', duration: 0.08 })
                const s = e.target.getStage()
                if (s) s.container().style.cursor = 'default'
              }}
              onClick={(e) => {
                e.cancelBubble = true
                editTextBlock(page, b)
              }}
              onTap={(e) => {
                e.cancelBubble = true
                primeKeyboard()
                editTextBlock(page, b)
              }}
            />
          ))}

          {elements.map((el) =>
            el.kind === 'text' ? (
              <TextNode
                key={el.id}
                el={el}
                hidden={el.id === editingId}
                selected={el.id === selectedId}
                draggable={tool === 'select' && (!coarse || el.id === selectedId)}
                {...handlersFor(el)}
              />
            ) : (
              <ImageNode
                key={el.id}
                el={el}
                selected={el.id === selectedId}
                draggable={tool === 'select' && (!coarse || el.id === selectedId)}
                {...handlersFor(el)}
              />
            ),
          )}
        </Group>

        <Transformer
          ref={trRef}
          rotateEnabled
          flipEnabled={false}
          keepRatio
          enabledAnchors={
            selectedEl?.kind === 'text'
              ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
              : ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
          }
          rotationSnaps={[0, 90, 180, 270]}
          rotationSnapTolerance={5}
          rotateAnchorOffset={coarse ? 32 : 22}
          anchorSize={anchor}
          anchorCornerRadius={anchor / 2}
          anchorStroke={BRAND}
          anchorFill="#ffffff"
          borderStroke={BRAND}
          borderStrokeWidth={1.25}
          padding={2}
          ignoreStroke
          anchorStyleFunc={(a) => {
            // Bigger invisible hit area on touch: ≥ 44px targets.
            a.hitStrokeWidth(coarse ? 26 : 8)
          }}
          boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 6 || Math.abs(newBox.height) < 6 ? oldBox : newBox)}
        />
      </Layer>
    </Stage>
  )
}
