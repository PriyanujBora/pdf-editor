import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Layer, Rect, Stage, Transformer } from 'react-konva'
import type Konva from 'konva'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { isCoarsePointer } from '@/hooks/use-media-query'
import { primeKeyboard } from '@/lib/keyboard'
import { getTextBlocks, type TextBlock } from '@/lib/pdf/text-blocks'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { EditorElement, PageItem, PtRect } from '@/types'
import { createTextAt, editTextBlock } from './actions'
import { ImageNode } from './elements/ImageNode'
import { TextNode } from './elements/TextNode'
import { ScanTextNode } from './elements/ScanTextNode'
import { SourceTextNode } from './elements/SourceTextNode'
import { RedactNode } from './elements/RedactNode'
import { addAreaMark, markWordAt, MIN_MARK } from './redact-actions'
import { activeInput } from './active-input'
import { isScanText } from '@/lib/scan/compose'
import { caretAt, type LineLayout } from '@/lib/text/line-layout'

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
  const coarse = useMemo(() => isCoarsePointer(), [])
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null)
  /** Area mark being dragged out with the Redact tool. */
  const [draft, setDraft] = useState<PtRect | null>(null)
  const drawing = useRef<{ x0: number; y0: number; cancel: () => void } | null>(null)
  /** Latest layout of each edited source line (caret placement from pointer x). */
  const layouts = useRef(new Map<string, LineLayout>())
  const onLayout = useMemo(() => new Map<string, (l: LineLayout) => void>(), [])
  const layoutSink = (id: string) => {
    let f = onLayout.get(id)
    if (!f) onLayout.set(id, (f = (l: LineLayout) => void layouts.current.set(id, l)))
    return f
  }

  const rotated = page.rotation % 180 !== 0
  const stageW = (rotated ? height : width) * zoom
  const stageH = (rotated ? width : height) * zoom
  const gt = groupTransform(page.rotation, width, height, zoom)

  // Existing text is editable straight from the Select tool too (tap a line),
  // so detect it whenever a page is mounted with either tool active.
  const textTools = tool === 'select' || tool === 'edit-text'
  useEffect(() => {
    if (!textTools || !pdf || blocks) return
    let alive = true
    void pdf.getPage(page.srcIndex + 1).then((p) =>
      getTextBlocks(p, String(page.srcIndex)).then((b) => {
        if (!alive) return
        setBlocks(b)
        if (!b.length && useUi.getState().tool === 'edit-text' && useUi.getState().currentPageId === page.id) {
          toast('No editable text on this page', {
            id: 'no-text',
            description: 'It may be a scanned image. You can still add new text on top.',
          })
        }
      }),
    )
    return () => {
      alive = false
    }
  }, [textTools, pdf, page.srcIndex, page.id, blocks])

  // A no-text hint for scanned pages when switching to Edit text later.
  useEffect(() => {
    if (tool === 'edit-text' && blocks && !blocks.length && useUi.getState().currentPageId === page.id) {
      toast('No editable text on this page', {
        id: 'no-text',
        description: 'It may be a scanned image. You can still add new text on top.',
      })
    }
  }, [tool, blocks, page.id])

  const covers = elements.flatMap((e) => (e.kind === 'text' && e.cover ? [{ id: e.id, ...e.cover }] : []))
  // Lines already replaced (vector cover or scan-matched) are not offered again.
  const replaced = [
    ...covers,
    ...elements.flatMap((e) => (e.kind === 'text' && e.scan ? [e.scan.lineBox] : [])),
    ...elements.flatMap((e) => (e.kind === 'text' && e.source ? [e.source.box] : [])),
  ]
  const visibleBlocks = useMemo(() => {
    if (!textTools || !blocks) return []
    // Hide lines that already have a replacement — the same line, not neighbours whose boxes merely
    // touch it (tightly set paragraphs have overlapping ascent/descent boxes).
    return blocks.filter(
      (b) =>
        !replaced.some((c) => {
          const overlapY = Math.min(b.y + b.height, c.y + c.height) - Math.max(b.y, c.y)
          return b.x < c.x + c.width && b.x + b.width > c.x && overlapY > 0.5 * Math.min(b.height, c.height)
        }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textTools, blocks, elements])
  // Edit-text mode outlines every line; Select mode only reveals one on hover.
  const outlined = tool === 'edit-text'
  const restFill = outlined ? 'rgba(99,102,241,0.07)' : 'rgba(99,102,241,0)'
  const restStroke = outlined ? 'rgba(99,102,241,0.55)' : 'rgba(99,102,241,0)'

  // Attach the transformer to the selected element.
  useEffect(() => {
    const tr = trRef.current
    if (!tr) return
    const sel = elements.find((e) => e.id === selectedId)
    // Scan-matched text is locked to its line: no move/resize handles.
    const locked = sel?.kind === 'text' && !!sel.scan
    const node =
      selectedId && selectedId !== editingId && !locked ? groupRef.current?.findOne<Konva.Node>('#' + selectedId) : null
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selectedId, editingId, elements])

  const selectedEl = elements.find((e) => e.id === selectedId)

  const onBlockTap = (b: TextBlock, touch: boolean) => {
    const ui = useUi.getState()
    // In Select mode the first tap away from a selection just deselects.
    if (ui.tool === 'select' && (ui.selectedId || ui.editingId)) {
      ui.set({ selectedId: null, editingId: null })
      return
    }
    if (touch) primeKeyboard()
    editTextBlock(page, b, groupRef.current?.getRelativePointerPosition() ?? undefined, blocks ?? [])
  }

  const onStageTap = (e: KEvt) => {
    if (e.target !== e.target.getStage()) return
    const ui = useUi.getState()
    if (ui.tool === 'redact') return // marks are made on press/release (onRedactPress)
    if (ui.tool === 'text') {
      const pos = groupRef.current?.getRelativePointerPosition()
      if (!pos) return
      primeKeyboard()
      createTextAt(page.id, pos.x, pos.y)
    } else if (ui.selectedId || ui.editingId) {
      ui.set({ selectedId: null, editingId: null })
    }
  }

  /** Redact tool: drag on the page to mark an area; a tap marks the word under it. */
  const onRedactPress = (e: Konva.KonvaEventObject<PointerEvent>) => {
    const ui = useUi.getState()
    if (ui.tool !== 'redact' || e.target !== e.target.getStage() || !e.evt.isPrimary) return
    const stage = e.target.getStage()
    const start = groupRef.current?.getRelativePointerPosition()
    if (!stage || !start) return
    ui.set({ selectedId: null })
    const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v))
    const rectTo = (p: { x: number; y: number }): PtRect => {
      const x1 = clamp(p.x, width)
      const y1 = clamp(p.y, height)
      return { x: Math.min(start.x, x1), y: Math.min(start.y, y1), width: Math.abs(x1 - start.x), height: Math.abs(y1 - start.y) }
    }
    const pos = (ev: PointerEvent) => {
      stage.setPointersPositions(ev)
      return groupRef.current?.getRelativePointerPosition() ?? start
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.evt.pointerId) return
      const r = rectTo(pos(ev))
      if (r.width >= MIN_MARK || r.height >= MIN_MARK) setDraft(r)
    }
    // A second finger means pinch-zoom, not a mark.
    const touch = (ev: TouchEvent) => ev.touches.length > 1 && cleanup()
    const cleanup = () => {
      window.removeEventListener('touchstart', touch)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      drawing.current = null
      setDraft(null)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.evt.pointerId) return
      const r = rectTo(pos(ev))
      cleanup()
      if (r.width >= MIN_MARK && r.height >= MIN_MARK) addAreaMark(page.id, r)
      else if (r.width < MIN_MARK && r.height < MIN_MARK) void markWordAt(page, start.x, start.y)
    }
    const cancel = () => cleanup()
    drawing.current = { x0: start.x, y0: start.y, cancel }
    window.addEventListener('touchstart', touch)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  useEffect(() => () => drawing.current?.cancel(), [])

  const handlersFor = useCallback((el: EditorElement) => {
    const select = () => {
      const ui = useUi.getState()
      if (ui.editingId && ui.editingId !== el.id) ui.set({ editingId: null })
      if (ui.selectedId !== el.id) ui.select(el.id)
    }
    const tapEdit = (e: KEvt) => {
      e.cancelBubble = true
      const ui = useUi.getState()
      // Clicks inside the line being edited only move the caret (handled on press).
      if (ui.editingId === el.id) return
      const wasSelected = pressedSelected ?? ui.selectedId === el.id
      pressedSelected = null
      // Tapping an already-selected text (or any text with the text tools) edits it.
      if (el.kind === 'text' && (wasSelected || ui.tool !== 'select') && ui.tool !== 'redact') {
        primeKeyboard()
        const L = layouts.current.get(el.id)
        const pos = groupRef.current?.getRelativePointerPosition()
        if (el.kind === 'text' && el.source && L && pos) ui.set({ caret: caretAt(L, pos.x) })
        ui.startEditing(el.id)
      } else select()
    }
    /** While editing a source line, pressing on it places the caret (and drags a selection) without blurring. */
    const pressCaret = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      const ui = useUi.getState()
      const input = activeInput.current
      const L = layouts.current.get(el.id)
      if (el.kind !== 'text' || !el.source || ui.editingId !== el.id || !input || !L) return false
      e.evt.preventDefault()
      e.cancelBubble = true
      const stage = e.target.getStage()
      const at = () => {
        const pos = groupRef.current?.getRelativePointerPosition()
        return pos ? caretAt(L, pos.x) : input.selectionStart
      }
      const anchor = 'shiftKey' in e.evt && e.evt.shiftKey ? input.selectionStart : at()
      const set = (i: number) => {
        input.setSelectionRange(Math.min(anchor, i), Math.max(anchor, i), i < anchor ? 'backward' : 'forward')
        useUi.getState().set({ textSel: [input.selectionStart, input.selectionEnd] })
      }
      set(at())
      if (e.evt.type === 'mousedown') {
        const move = (ev: MouseEvent) => {
          stage?.setPointersPositions(ev)
          set(at())
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      return true
    }
    return {
      onMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => void pressCaret(e),
      onTouchStart: (e: Konva.KonvaEventObject<TouchEvent>) => void pressCaret(e),
      onPointerDown: (e: Konva.KonvaEventObject<PointerEvent>) => {
        // Mouse/pen select on press so a drag can start immediately; touch waits for a tap.
        const t = useUi.getState().tool
        if (e.evt.pointerType !== 'touch' && (t === 'select' || (t === 'redact' && el.kind === 'redact'))) {
          e.cancelBubble = true
          pressedSelected = useUi.getState().selectedId === el.id
          select()
        }
      },
      onClick: tapEdit,
      onTap: tapEdit,
      onDblClick: (e: KEvt) => {
        e.cancelBubble = true
        const ui = useUi.getState()
        const input = activeInput.current
        if (el.kind === 'text' && el.source && ui.editingId === el.id && input) {
          // Double-click selects the word under the caret.
          const v = input.value
          let a = input.selectionStart
          let b = a
          while (a > 0 && /S/.test(v[a - 1])) a--
          while (b < v.length && /S/.test(v[b])) b++
          input.setSelectionRange(a, b)
          ui.set({ textSel: [a, b] })
          return
        }
        if (el.kind === 'text') ui.startEditing(el.id)
      },
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
        useDoc.getState().updateElement(el.id, { x: e.target.x(), y: e.target.y() }, { merge: false })
      },
      onTransformEnd: (e: KEvt) => {
        const n = e.target
        const sx = n.scaleX()
        const sy = n.scaleY()
        n.scale({ x: 1, y: 1 })
        const base = { x: n.x(), y: n.y(), rotation: Math.round(n.rotation() * 100) / 100 }
        if (el.kind === 'text') {
          const size = Math.max(2, Math.round(el.size * sy * 10) / 10)
          useDoc.getState().updateElement(el.id, { ...base, size }, { merge: false })
        } else {
          useDoc.getState().updateElement(
            el.id,
            {
              ...base,
              width: Math.max(4, el.width * sx),
              height: Math.max(4, el.height * sy),
            },
            { merge: false },
          )
        }
      },
    }
  }, [])

  const anchor = coarse ? 18 : 10

  return (
    <Stage
      width={stageW}
      height={stageH}
      className="absolute inset-0"
      onClick={onStageTap}
      onTap={onStageTap}
      onPointerDown={onRedactPress}
      style={{
        cursor: tool === 'text' ? 'text' : tool === 'redact' ? 'crosshair' : 'default',
        // One finger draws marks with the Redact tool (two fingers still zoom).
        touchAction: tool === 'redact' ? 'none' : undefined,
      }}
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
              name="text-block"
              fill={restFill}
              stroke={restStroke}
              strokeWidth={1}
              strokeScaleEnabled={false}
              preventDefault={false}
              onMouseEnter={(e) => {
                ;(e.target as Konva.Rect).fill('rgba(99,102,241,0.14)').stroke('rgba(99,102,241,0.7)')
                const s = e.target.getStage()
                if (s) s.container().style.cursor = 'text'
              }}
              onMouseLeave={(e) => {
                ;(e.target as Konva.Rect).fill(restFill).stroke(restStroke)
                const s = e.target.getStage()
                if (s) s.container().style.cursor = 'default'
              }}
              onClick={(e) => {
                e.cancelBubble = true
                onBlockTap(b, false)
              }}
              onTap={(e) => {
                e.cancelBubble = true
                onBlockTap(b, true)
              }}
            />
          ))}

          <Group listening={tool !== 'redact'}>
          {elements.map((el) =>
            el.kind === 'text' && isScanText(el) ? (
              <ScanTextNode
                key={el.id}
                el={el}
                editing={el.id === editingId}
                selected={el.id === selectedId}
                {...handlersFor(el)}
                onDragEnd={undefined}
                onTransformEnd={undefined}
              />
            ) : null,
          )}

          {elements.map((el) =>
            el.kind === 'text' && el.source ? (
              <SourceTextNode
                key={el.id}
                el={el}
                pageId={page.id}
                pageRotation={page.rotation}
                editing={el.id === editingId}
                selected={el.id === selectedId}
                draggable={tool === 'select' && (!coarse || el.id === selectedId)}
                onLayout={layoutSink(el.id)}
                {...handlersFor(el)}
              />
            ) : el.kind === 'text' && el.scan ? null : el.kind === 'text' ? (
              <TextNode
                key={el.id}
                el={el}
                hidden={el.id === editingId}
                selected={el.id === selectedId}
                draggable={tool === 'select' && (!coarse || el.id === selectedId)}
                {...handlersFor(el)}
              />
            ) : el.kind === 'image' ? (
              <ImageNode
                key={el.id}
                el={el}
                selected={el.id === selectedId}
                draggable={tool === 'select' && (!coarse || el.id === selectedId)}
                {...handlersFor(el)}
              />
            ) : null,
          )}
          </Group>

          {/* Redaction marks sit above everything they will remove. */}
          {elements.map((el) =>
            el.kind === 'redact' ? (
              <RedactNode
                key={el.id}
                el={el}
                selected={el.id === selectedId}
                draggable={(tool === 'select' || tool === 'redact') && (!coarse || el.id === selectedId)}
                {...handlersFor(el)}
              />
            ) : null,
          )}
          {draft && (
            <Rect
              x={draft.x}
              y={draft.y}
              width={draft.width}
              height={draft.height}
              fill="rgba(15,15,20,0.35)"
              stroke="#e11d48"
              strokeWidth={1.5}
              strokeScaleEnabled={false}
              dash={[5, 3]}
              listening={false}
            />
          )}
        </Group>

        <Transformer
          ref={trRef}
          rotateEnabled={!(selectedEl?.kind === 'text' && selectedEl.source) && selectedEl?.kind !== 'redact'}
          flipEnabled={false}
          keepRatio={selectedEl?.kind !== 'redact'}
          enabledAnchors={
            // Edited original text moves but never changes size by accident: size is in the panel.
            selectedEl?.kind === 'text' && selectedEl.source
              ? []
              : selectedEl?.kind === 'text' || (selectedEl?.kind === 'redact' && coarse)
              ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
              : [
                  'top-left',
                  'top-center',
                  'top-right',
                  'middle-left',
                  'middle-right',
                  'bottom-left',
                  'bottom-center',
                  'bottom-right',
                ]
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
