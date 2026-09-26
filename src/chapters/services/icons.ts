import * as THREE from 'three'
import { SERVICES } from '../../content'
import { C } from '../../kit/chart'

/*
 * The eleven service MAP SYMBOLS — simple line icons in ink with one
 * survey-vermilion accent, drawn in a 48 × 48 box (y down).
 *
 * One source of truth, two outputs:
 *   iconSvg(slug)  inline SVG for the legend-box card (strokes in CSS)
 *   signAtlas()    a 1024 × 768 canvas atlas of little legend-key signs
 *                  (paper plaque, double neatline, the symbol) for the
 *                  3D sign that rises on the active summit
 *
 * Path data is plain SVG path syntax, so the canvas draws the very same
 * shapes through Path2D (Safari 15 supports SVG path strings there).
 */

interface Part {
  d: string
  /** vermilion accent */
  accent?: boolean
  /** filled instead of stroked */
  fill?: boolean
}

/** a circle as path data */
const circ = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`
/** a four-point sparkle */
const spark = (cx: number, cy: number, r: number) => {
  const k = r * 0.2
  return `M${cx} ${cy - r}Q${cx + k} ${cy - k} ${cx + r} ${cy}Q${cx + k} ${cy + k} ${cx} ${cy + r}Q${cx - k} ${cy + k} ${cx - r} ${cy}Q${cx - k} ${cy - k} ${cx} ${cy - r}Z`
}

export const ICONS: Record<string, Part[]> = {
  // </> — brackets, the slash in vermilion
  'software-development': [{ d: 'M17 13L6.5 24L17 35' }, { d: 'M31 13L41.5 24L31 35' }, { d: 'M27.5 9.5L20.5 38.5', accent: true }],
  // a browser window laid out on a grid
  'web-design': [
    { d: 'M6 9.5H42V38.5H6Z' },
    { d: 'M6 16.5H42' },
    { d: 'M18 16.5V38.5' },
    { d: 'M23.5 21.5H37V28H23.5Z', accent: true },
    { d: 'M23.5 33H32.5' },
    { d: 'M10.5 22H14 M10.5 27H14', accent: false },
  ],
  // a cart on vermilion wheels
  ecommerce: [
    { d: 'M4.5 9H10.5L15 29.5H36.5L41 14.5H12' },
    { d: 'M17 22H38.5' },
    { d: circ(18.5, 37, 2.6), accent: true },
    { d: circ(33.5, 37, 2.6), accent: true },
  ],
  // a magnifier, a spark of GEO inside the lens
  'seo-geo': [{ d: circ(21, 21, 12) }, { d: 'M29.8 29.8L41.5 41.5' }, { d: spark(21, 21, 6.2), accent: true, fill: true }],
  // a bolt with speed lines
  'page-speed': [{ d: 'M28 4.5L12.5 26.5H23.5L20 43.5L36.5 19.5H25.5Z', accent: true }, { d: 'M4 17H9.5 M2.5 24H7.5 M4 31H9.5' }],
  // a chip, a spark at its heart
  'ai-consulting': [
    { d: 'M13 13H35V35H13Z' },
    { d: 'M19 7V13 M24 7V13 M29 7V13 M19 35V41 M24 35V41 M29 35V41' },
    { d: 'M7 19H13 M7 24H13 M7 29H13 M35 19H41 M35 24H41 M35 29H41' },
    { d: spark(24, 24, 6.5), accent: true, fill: true },
  ],
  // a quadcopter from above
  'aerial-media': [
    { d: 'M15.5 15.5L32.5 32.5 M32.5 15.5L15.5 32.5' },
    { d: circ(12.5, 12.5, 6) },
    { d: circ(35.5, 12.5, 6) },
    { d: circ(12.5, 35.5, 6) },
    { d: circ(35.5, 35.5, 6) },
    { d: circ(24, 24, 4.2), accent: true, fill: true },
  ],
  // a bug, patched with a vermilion cross
  'hack-remediation': [
    { d: 'M16 27a8 10 0 1 0 16 0a8 10 0 1 0 -16 0Z' },
    { d: 'M19 18.5a5 4.5 0 0 1 10 0' },
    { d: 'M21 14L18 9 M27 14L30 9' },
    {
      d: 'M16 24H9 M16 31L9.5 34.5 M17 19.5L11 16 M32 24H39 M32 31L38.5 34.5 M31 19.5L37 16',
    },
    { d: 'M24 21.5V33 M18.5 27.25H29.5', accent: true },
  ],
  // a shield with a check
  security: [{ d: 'M24 4.5L39 10.5V23C39 32 32.5 39 24 43.5C15.5 39 9 32 9 23V10.5Z' }, { d: 'M17 24L22 29L31.5 18.5', accent: true }],
  // the accessibility figure
  'ada-accessibility': [
    { d: circ(24, 24, 19.5) },
    { d: 'M12.5 18.5L24 20.5L35.5 18.5' },
    { d: 'M24 20.5V28.5' },
    { d: 'M24 28.5L18 38.5 M24 28.5L30 38.5' },
    { d: circ(24, 12.5, 3), accent: true, fill: true },
  ],
  // a W in a ring
  wordpress: [{ d: circ(24, 24, 18.5) }, { d: 'M12.5 16.5L18.5 33.5L24 20L29.5 33.5L35.5 16.5', accent: true }],
}

const FALLBACK: Part[] = [{ d: 'M24 8L40 24L24 40L8 24Z' }, { d: circ(24, 24, 3), accent: true, fill: true }]

const parts = (slug: string) => ICONS[slug] ?? FALLBACK

/** Inline SVG markup for the card (decorative: aria-hidden). */
export function iconSvg(slug: string, cls = 'su-icon'): string {
  const body = parts(slug)
    .map(p => {
      const c = `${p.accent ? 'ic-accent' : 'ic-ink'}${p.fill ? ' ic-fill' : ''}`
      return `<path class="${c}" d="${p.d}"/>`
    })
    .join('')
  return `<svg class="${cls}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${body}</svg>`
}

export const ATLAS_COLS = 4
export const ATLAS_ROWS = 3
const CELL = 256

/**
 * The sign atlas: each cell is a little legend-key plaque (paper, a heavy
 * outer neatline + hairline inner rule, an offset print shadow) with the
 * symbol at its centre. Cell k = SERVICES[k].
 */
export function signAtlas(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = CELL * ATLAS_COLS
  c.height = CELL * ATLAS_ROWS
  const g = c.getContext('2d')!
  g.clearRect(0, 0, c.width, c.height)
  SERVICES.forEach((s, k) => {
    const ox = (k % ATLAS_COLS) * CELL
    const oy = Math.floor(k / ATLAS_COLS) * CELL
    g.save()
    g.translate(ox, oy)
    // plaque: 200 × 200, centred, with a lifted print shadow
    const p0 = 24
    const pw = 200
    g.fillStyle = 'rgba(70, 45, 20, 0.2)'
    g.fillRect(p0 + 7, p0 + 9, pw, pw)
    g.fillStyle = '#f7f2e6'
    g.fillRect(p0, p0, pw, pw)
    g.strokeStyle = C.ink
    g.lineWidth = 5
    g.strokeRect(p0 + 2.5, p0 + 2.5, pw - 5, pw - 5)
    g.lineWidth = 1.6
    g.strokeRect(p0 + 11, p0 + 11, pw - 22, pw - 22)
    // the symbol, 48 → 124 px
    const sc = 124 / 48
    g.translate(p0 + pw / 2 - 24 * sc, p0 + pw / 2 - 24 * sc)
    g.scale(sc, sc)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const part of parts(s.slug)) {
      const path = new Path2D(part.d)
      const col = part.accent ? C.signal : C.ink
      if (part.fill) {
        g.fillStyle = col
        g.fill(path)
      } else {
        g.strokeStyle = col
        g.lineWidth = part.accent ? 2.9 : 2.5
        g.stroke(path)
      }
    }
    g.restore()
  })
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  return tex
}
