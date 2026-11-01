import type { Rotation } from '@/types'

/** Affine matrix, PDF convention: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Mat {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const identity = (): Mat => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

/** m1 ∘ m2 — apply m2 first, then m1. */
export function mul(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

export function invert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

export const translate = (x: number, y: number): Mat => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y })
export const scale = (sx: number, sy: number): Mat => ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 })
/** Rotation by `deg` — clockwise on screen in a y-down space (Konva's sense). */
export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
}

export const apply = (m: Mat, x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f })

/**
 * PDF user space → page space (pdf.js viewport at scale 1 with the page's
 * own /Rotate). Mirrors pdf.js' PageViewport transform.
 */
export function pdfToPage(view: [number, number, number, number], rot: Rotation): Mat {
  const [x0, y0, x1, y1] = view
  switch (rot) {
    case 90:
      return { a: 0, b: 1, c: 1, d: 0, e: -y0, f: -x0 }
    case 180:
      return { a: -1, b: 0, c: 0, d: 1, e: x1, f: -y0 }
    case 270:
      return { a: 0, b: -1, c: -1, d: 0, e: y1, f: x1 }
    default:
      return { a: 1, b: 0, c: 0, d: -1, e: -x0, f: y1 }
  }
}

/**
 * Element-local frame → page space. Local frame: origin at the element's
 * top-left, x right, **y up** (PDF style), so the box spans y ∈ [-h, 0].
 */
export const elementFrame = (x: number, y: number, deg: number) => mul(mul(translate(x, y), rotate(deg)), scale(1, -1))

/** Page space → displayed (user-rotated) page space, for a W×H page. */
export function userRotation(rot: Rotation, w: number, h: number): Mat {
  switch (rot) {
    case 90:
      return mul(translate(h, 0), rotate(90))
    case 180:
      return mul(translate(w, h), rotate(180))
    case 270:
      return mul(translate(0, w), rotate(270))
    default:
      return identity()
  }
}
