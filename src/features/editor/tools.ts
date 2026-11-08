import { EyeOff, ImagePlus, MousePointer2, TextCursorInput, Type, type LucideIcon } from 'lucide-react'
import type { Tool } from '@/store/ui'

export interface ToolDef {
  id: Tool | 'image'
  label: string
  short: string
  icon: LucideIcon
  key: string
  hint: string
}

export const TOOLS: ToolDef[] = [
  {
    id: 'select',
    label: 'Select',
    short: 'Select',
    icon: MousePointer2,
    key: 'V',
    hint: 'Select, move and resize. Tap existing text to edit it',
  },
  { id: 'text', label: 'Add text', short: 'Text', icon: Type, key: 'T', hint: 'Tap the page to add text' },
  {
    id: 'edit-text',
    label: 'Edit text',
    short: 'Edit',
    icon: TextCursorInput,
    key: 'E',
    hint: 'Show all editable text on the page',
  },
  { id: 'image', label: 'Add image', short: 'Image', icon: ImagePlus, key: 'I', hint: 'Insert a PNG or JPG' },
  {
    id: 'redact',
    label: 'Redact',
    short: 'Redact',
    icon: EyeOff,
    key: 'R',
    hint: 'Drag to mark an area or tap a word; it is permanently removed when you download',
  },
]
