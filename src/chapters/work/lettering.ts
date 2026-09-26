import * as THREE from 'three'
import { C, FONTS } from '../../kit/chart'

/*
 * Stacked map lettering: a place name set in two or three lines (a number,
 * then the name broken at a word), drawn once into a canvas with a paper
 * halo — how a chart letters a long name where one line won't fit.
 */

export interface Line {
  text: string
  font: keyof typeof FONTS
  /** glyph size, CSS px (drawn at 2x) */
  size: number
  weight: number
  color: string
  /** letter spacing, em */
  tracking?: number
  italic?: boolean
  uppercase?: boolean
  /** measured and laid out but not drawn (a twin texture carries it) */
  ghost?: boolean
}

export interface Stack {
  texture: THREE.CanvasTexture
  aspect: number
  /** canvas height in CSS px (world height = hpx × units per px) */
  hpx: number
  /** CSS px from the canvas's left edge to the glyphs */
  padPx: number
}

const SCALE = 2

/**
 * Free a static canvas's pixels once the GPU has its copy. Every stack is
 * drawn into a fresh canvas (a redraw builds a new texture), so nothing ever
 * draws into this one again.
 */
export function releaseAfterUpload(t: THREE.Texture) {
  t.onUpdate = () => {
    const c = t.image as HTMLCanvasElement | undefined
    if (c && 'width' in c) c.width = c.height = 1
    t.onUpdate = null
  }
}

export function stackTexture(
  lines: Line[],
  { halo = C.paper as string | null, haloWidth = 0.17, lineGap = 0.14, align = 'left' as 'left' | 'right' | 'center' } = {},
): Stack {
  const c = document.createElement('canvas')
  const x = c.getContext('2d')!
  const fontOf = (l: Line) => `${l.italic ? 'italic ' : ''}${l.weight} ${l.size * SCALE}px ${FONTS[l.font]}`
  const maxSize = Math.max(...lines.map(l => l.size))
  const hw = haloWidth * maxSize * SCALE
  const pad = Math.ceil(hw + maxSize * SCALE * 0.14)
  const metrics = lines.map(l => {
    x.font = fontOf(l)
    const t = l.uppercase ? l.text.toUpperCase() : l.text
    const chars = Array.from(t)
    const adv = chars.map(ch => x.measureText(ch).width)
    const track = (l.tracking ?? 0) * l.size * SCALE
    const w = adv.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1)
    return { chars, adv, track, w, h: l.size * SCALE * 1.08 }
  })
  const gap = lineGap * maxSize * SCALE
  const textW = Math.max(...metrics.map(m => m.w))
  const textH = metrics.reduce((a, m) => a + m.h, 0) + gap * (lines.length - 1)
  c.width = Math.ceil(textW + pad * 2)
  c.height = Math.ceil(textH + pad * 2)
  x.textBaseline = 'middle'
  x.lineJoin = 'round'
  // halo first (all lines), then the letters, each line in its own colour
  for (const stroke of halo ? [true, false] : [false]) {
    if (stroke) {
      x.strokeStyle = halo!
      x.lineWidth = hw
    }
    let y = pad
    lines.forEach((l, i) => {
      const m = metrics[i]
      if (l.ghost) {
        y += m.h + gap
        return
      }
      x.font = fontOf(l)
      x.fillStyle = l.color
      const cy = y + m.h / 2
      let px = align === 'left' ? pad : align === 'right' ? pad + textW - m.w : pad + (textW - m.w) / 2
      m.chars.forEach((ch, k) => {
        if (stroke) x.strokeText(ch, px, cy)
        else x.fillText(ch, px, cy)
        px += m.adv[k] + m.track
      })
      y += m.h + gap
    })
  }
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  releaseAfterUpload(texture)
  return { texture, aspect: c.width / c.height, hpx: c.height / SCALE, padPx: pad / SCALE }
}

/**
 * Break a name into stacked lines (never inside a word): one line when it's
 * short, else the most balanced two lines, else three when two would still
 * run longer than `maxTwo` characters.
 */
export function breakName(name: string, maxOne = 13, maxTwo = 15): string[] {
  const words = name.split(' ')
  if (name.length <= maxOne || words.length < 2) return [name]
  let best: string[] = [name]
  let bestD = Infinity
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    const d = Math.max(a.length, b.length)
    if (d < bestD) {
      bestD = d
      best = [a, b]
    }
  }
  if (bestD <= maxTwo || words.length < 3) return best
  for (let i = 1; i < words.length - 1; i++)
    for (let j = i + 1; j < words.length; j++) {
      const parts = [words.slice(0, i).join(' '), words.slice(i, j).join(' '), words.slice(j).join(' ')]
      const d = Math.max(...parts.map(p => p.length))
      if (d < bestD) {
        bestD = d
        best = parts
      }
    }
  return best
}
