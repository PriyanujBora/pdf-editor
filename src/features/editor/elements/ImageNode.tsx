import { memo, useEffect, useState } from 'react'
import { Image as KImage, Rect } from 'react-konva'
import { assetImage } from '@/lib/images'
import { useSession } from '@/store/session'
import type { ImageElement } from '@/types'
import type { NodeHandlers } from './handlers'

interface Props extends NodeHandlers {
  el: ImageElement
  draggable: boolean
  selected: boolean
}

export const ImageNode = memo(function ImageNode({ el, draggable, selected, ...handlers }: Props) {
  const asset = useSession((s) => s.assets[el.assetId])
  const [img, setImg] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    let alive = true
    if (asset) void assetImage(asset).then((i) => alive && setImg(i)).catch(() => {})
    return () => {
      alive = false
    }
  }, [asset])

  const common = {
    id: el.id,
    name: 'element',
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    rotation: el.rotation,
    draggable,
    preventDefault: selected,
    ...handlers,
  }
  return img ? <KImage image={img} {...common} /> : <Rect fill="rgba(127,127,127,0.15)" {...common} />
})
