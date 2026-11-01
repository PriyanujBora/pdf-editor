import { memo, useRef } from 'react'
import { useInView } from '@/hooks/use-in-view'
import { useDoc } from '@/store/document'
import { useSession } from '@/store/session'
import { useUi } from '@/store/ui'
import type { PageItem } from '@/types'
import { InlineTextEditor } from './InlineTextEditor'
import { PageCanvas } from './PageCanvas'
import { PageOverlay } from './PageOverlay'

interface Props {
  page: PageItem
  index: number
  zoom: number
}

/** One page: placeholder until near the viewport, then canvas + editing overlay. */
export const PageView = memo(function PageView({ page, index, zoom }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const info = useSession((s) => s.sourcePages[page.srcIndex])
  const visible = useInView(ref, '[data-testid="viewer"]', '150% 150%')
  const editingId = useUi((s) => s.editingId)
  const editingEl = useDoc((s) => {
    const el = editingId ? s.elements[editingId] : undefined
    return el?.kind === 'text' && el.pageId === page.id ? el : null
  })

  const rotated = page.rotation % 180 !== 0
  const dispW = rotated ? info.height : info.width
  const dispH = rotated ? info.width : info.height

  return (
    <div
      ref={ref}
      data-page-id={page.id}
      data-page-index={index}
      aria-label={`Page ${index + 1}`}
      role="group"
      className="relative shrink-0 bg-white shadow-[var(--page-shadow)]"
      style={{ width: dispW * zoom, height: dispH * zoom }}
    >
      {visible && (
        <>
          <PageCanvas
            pageId={page.id}
            srcIndex={page.srcIndex}
            rotation={info.rotate + page.rotation}
            zoom={zoom}
            width={dispW}
            height={dispH}
          />
          <PageOverlay page={page} width={info.width} height={info.height} zoom={zoom} />
          {editingEl && (
            <InlineTextEditor key={editingEl.id} el={editingEl} page={page} width={info.width} height={info.height} zoom={zoom} />
          )}
        </>
      )}
    </div>
  )
})
