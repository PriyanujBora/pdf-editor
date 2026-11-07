import { memo, useEffect, useRef, useState } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, RotateCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useInView } from '@/hooks/use-in-view'
import { cn } from '@/lib/utils'
import { undo, useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { PageItem } from '@/types'
import { choose } from './choice'
import { viewerBridge } from './viewer-bridge'

const THUMB_W = 132
const thumbCache = new Map<string, string>()

/** Small lazily-rendered page preview, cached per (source page, rotation). */
const ThumbImage = memo(function ThumbImage({ page }: { page: PageItem }) {
  const ref = useRef<HTMLDivElement>(null)
  const pdf = useSession((s) => s.pdf)
  const info = useSession((s) => s.sourcePages[page.srcIndex])
  const visible = useInView(ref, '[data-thumbs-scroll]', '200px 0px')
  const key = `${page.srcIndex}:${page.rotation}`
  const [rendered, setRendered] = useState<{ key: string; url: string } | null>(null)
  const url = thumbCache.get(key) ?? (rendered?.key === key ? rendered.url : null)
  const rot = (info.rotate + page.rotation) % 360
  const w = rot % 180 === info.rotate % 180 ? info.width : info.height
  const h = rot % 180 === info.rotate % 180 ? info.height : info.width

  useEffect(() => {
    if (thumbCache.has(key) || !visible || !pdf) return
    let alive = true
    void (async () => {
      const p = await pdf.getPage(page.srcIndex + 1)
      const scale = (THUMB_W * Math.min(2, devicePixelRatio || 1)) / w
      const vp = p.getViewport({ scale, rotation: rot })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      await p.render({ canvas, viewport: vp }).promise
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.8))
      if (!blob) return
      const u = URL.createObjectURL(blob)
      thumbCache.set(key, u)
      if (alive) setRendered({ key, url: u })
    })().catch(() => {})
    return () => {
      alive = false
    }
  }, [visible, pdf, key, page.srcIndex, rot, w])

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-md bg-white shadow-[var(--page-shadow)]"
      style={{ width: THUMB_W, aspectRatio: `${w} / ${h}` }}
    >
      {url && <img src={url} alt="" draggable={false} className="size-full object-contain" />}
    </div>
  )
})

function SortableThumb({
  page,
  index,
  active,
  canDelete,
}: {
  page: PageItem
  index: number
  active: boolean
  canDelete: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group relative flex flex-col items-center gap-1.5 rounded-xl p-2 select-none',
        isDragging && 'z-10 opacity-80',
      )}
      data-thumb-index={index}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={() => {
          viewerBridge.scrollToPage(page.id)
          useUi.getState().set({ currentPageId: page.id, thumbsOpen: false })
        }}
        aria-label={`Page ${index + 1}. Drag to reorder.`}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'cursor-grab touch-manipulation rounded-lg p-1 ring-2 ring-transparent transition-shadow outline-none focus-visible:ring-ring active:cursor-grabbing',
          active && 'ring-brand',
        )}
      >
        <ThumbImage page={page} />
      </button>
      <div className="flex w-full items-center justify-between px-1">
        <GripVertical className="size-4 text-muted-foreground/50" aria-hidden />
        <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
        <div className="flex">
          <button
            type="button"
            className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground lg:size-8"
            onClick={() => useDoc.getState().rotatePage(page.id, 90)}
            aria-label={`Rotate page ${index + 1}`}
          >
            <RotateCw className="size-4" />
          </button>
          <button
            type="button"
            disabled={!canDelete}
            className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30 lg:size-8"
            onClick={async () => {
              // Bookmarks that lead to this page disappear with it: say so first.
              const marks = useSession.getState().bookmarks[page.srcIndex] ?? []
              if (marks.length) {
                const shown = marks.slice(0, 3).map((t) => `“${t}”`).join(', ') + (marks.length > 3 ? ` and ${marks.length - 3} more` : '')
                const ok = await choose({
                  title: `Delete page ${index + 1}?`,
                  description: (
                    <>
                      This page has {marks.length === 1 ? 'a bookmark' : `${marks.length} bookmarks`} ({shown}). Deleting the
                      page removes {marks.length === 1 ? 'it' : 'them'} from the downloaded PDF.
                    </>
                  ),
                  options: [
                    { value: 'delete', label: 'Delete page', variant: 'destructive' },
                    { value: 'cancel', label: 'Cancel', variant: 'outline' },
                  ],
                })
                if (ok !== 'delete') return
              }
              useDoc.getState().removePage(page.id)
              toast(`Page ${index + 1} deleted`, { action: { label: 'Undo', onClick: () => undo() } })
            }}
            aria-label={`Delete page ${index + 1}`}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </li>
  )
}

export function Thumbnails({ className }: { className?: string }) {
  const pages = useDoc((s) => s.pages)
  const current = useUi((s) => s.currentPageId)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const from = pages.findIndex((p) => p.id === active.id)
    const to = pages.findIndex((p) => p.id === over.id)
    useDoc.getState().movePage(from, to)
  }

  return (
    <div data-thumbs-scroll className={cn('overflow-y-auto overscroll-contain', className)}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={pages.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col items-center gap-1 p-2" aria-label="Pages">
            {pages.map((p, i) => (
              <SortableThumb key={p.id} page={p} index={i} active={p.id === current} canDelete={pages.length > 1} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  )
}
