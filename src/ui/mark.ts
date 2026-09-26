import { SITE } from '../content'
import { MARK_SVG } from '../logo/svgSource'
import { ISLAND_RINGS, ISLAND_VIEWBOX } from './island'

/*
 * The Hark mark for the DOM layer (chrome, loader, menu sheet, rotate card,
 * fallback). Pulled from the same Illustrator source the 3D geometry uses,
 * minus the three hairline slivers. The rotated <rect> diamond is baked into
 * a plain path so it can be stroked / dash-drawn like the loops.
 *
 * Contour prints the mark in INK (currentColor). The one vermilion touch is
 * the wordmark's dot: a survey point, a fixed, measured place on the chart.
 *
 * islandSvg(): the mark as a small TOPOGRAPHIC ISLAND (src/ui/island.ts) —
 * layer-tinted land inside its coastline, contours rising inland, and
 * water-lining rings spreading outward like sound. The loader draws it in;
 * the menu sheet, rotate card and fallback carry it as a printed emblem.
 */

export const MARK_VIEWBOX = '0 0 1889.6 1889.9'
export const MARK_W = 1889.6

function parseMark() {
  const loops = [...MARK_SVG.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]).filter(d => d.length > 200)

  // <rect x y w h transform="translate(tx ty) rotate(-45)">
  const r = MARK_SVG.match(
    /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" transform="translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)"/,
  )
  let diamond = ''
  if (r) {
    const [x, y, w, h, tx, ty, deg] = r.slice(1).map(Number)
    const a = (deg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    const pts = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ].map(([px, py]) => [px * c - py * s + tx, px * s + py * c + ty])
    diamond = `M${pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z`
  }
  return { loops, diamond }
}

export const MARK_PATHS = parseMark()

/**
 * The real wordmark, "Hark.Digital" (BRAND.short). The dot is a vermilion
 * survey point; the period stays in the markup (clipped) so copy/paste and
 * find-in-page still read "Hark.Digital". Styled by the .wm rules in ui.css.
 */
export const WORDMARK = `<span class="wm"><span class="wm-a">Hark</span><span class="wm-dot">.</span><span class="wm-b">Digital</span></span>`

/** This site is a concept direction, not a rebrand: a small tag, never part of the name. */
export const CONCEPT_TAG = `<span class="wm-tag"><span class="wm-tag-k">Concept</span><b aria-hidden="true">·</b><em>${SITE.name}</em></span>`

/** Inline SVG markup for the mark, printed in ink (currentColor). */
export function markSvg(className = '', { title }: { title?: string } = {}) {
  const a11y = title ? `role="img" aria-label="${title}"` : 'aria-hidden="true" focusable="false"'
  return `<svg class="${className}" viewBox="${MARK_VIEWBOX}" ${a11y} xmlns="http://www.w3.org/2000/svg">${MARK_PATHS.loops
    .map(d => `<path class="mk-loop" d="${d}"/>`)
    .join('')}<path class="mk-diamond" d="${MARK_PATHS.diamond}"/></svg>`
}

/** Split an island ring into its closed subpaths (each draws on at its own pace). */
export const splitSubpaths = (d: string) =>
  d
    .split('M')
    .filter(Boolean)
    .map(s => `M${s}`)

export interface IslandOptions {
  /** extra class on each ring <path> (the loader dash-draws them) */
  ringAttrs?: string
  /** how many water-lining rings to print (outermost dropped first) */
  water?: number
  /** fill the land with layer tints */
  tint?: boolean
}

/**
 * The mark as a printed island. Strokes are in CSS px (the SVG sets
 * `--u`, viewBox units per CSS px, from its rendered size — see sizeIsland).
 * Classes: .isl-land-N (tints), .isl-coast, .isl-contour, .isl-water.
 */
export function islandSvg(className = '', { ringAttrs = '', water = 6, tint = true }: IslandOptions = {}) {
  const inland = ISLAND_RINGS.filter(r => r.level < 0).sort((a, b) => b.level - a.level)
  const coast = ISLAND_RINGS.find(r => r.level === 0)
  const sea = ISLAND_RINGS.filter(r => r.level > 0)
    .sort((a, b) => a.level - b.level)
    .slice(0, water)
  const land = tint
    ? [coast, ...inland]
        .filter(Boolean)
        .map((r, i) => `<path class="isl-land isl-land-${i}" d="${r!.d}" fill-rule="evenodd"/>`)
        .join('')
    : ''
  const ring = (cls: string, d: string, i: number) =>
    splitSubpaths(d)
      .map(s => `<path class="${cls}" data-ring="${i}" d="${s}" ${ringAttrs}/>`)
      .join('')
  // draw order (and data-ring index): coast, inland contours, then water outward
  let n = 0
  const lines = [
    coast ? ring('isl-coast', coast.d, n++) : '',
    ...inland.map(r => ring('isl-contour', r.d, n++)),
    ...sea.map((r, k) => `<g class="isl-water-g" style="--k:${k}">${ring('isl-water', r.d, n++)}</g>`),
  ].join('')
  return `<svg class="isl ${className}" viewBox="${ISLAND_VIEWBOX}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><g class="isl-landg">${land}</g><g class="isl-lines" fill="none">${lines}</g></svg>`
}

/** Number of stroked rings islandSvg() prints (for the loader's pacing). */
export const islandRingCount = (water = 6) =>
  ISLAND_RINGS.filter(r => r.level <= 0).length + Math.min(water, ISLAND_RINGS.filter(r => r.level > 0).length)

/**
 * Keep an island's hairlines at a true CSS-pixel width whatever size it is
 * drawn: sets --u (viewBox units per CSS px) on the <svg>. Returns a cleanup.
 */
export function sizeIsland(svg: SVGSVGElement): () => void {
  const vb = parseFloat(ISLAND_VIEWBOX.split(' ')[2]) || 1560
  const apply = () => {
    const w = svg.getBoundingClientRect().width
    if (w > 0) svg.style.setProperty('--u', (vb / w).toFixed(3))
  }
  apply()
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(apply)
    ro.observe(svg)
    return () => ro.disconnect()
  }
  window.addEventListener('resize', apply)
  return () => window.removeEventListener('resize', apply)
}
