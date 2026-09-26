import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { PROCESS, SHEET, STATS } from '../../content'
import { clamp, ease, lerp, segment, smoothstep, window01 } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { C, chartMaterial, ensureFonts, mapLabel, marker, routeRibbon, type ChartMaterial } from '../../kit/chart'
import { terrainGeometryAsync, drape, type TerrainData } from '../../kit/terrain'
import { mulberry32 } from '../../kit/noise'
import { makeLand, INTERVAL, METERS, POI, BOUNDS, type V2 } from './land'
import { buildField, contourLoops, boardGeometry, drawTimeTexture, loopLength, type DrawTime, type Field, type Loop } from './field'
import { draftMaterial, boardMaterial, ringMaterial, station, type BoardMaterial, type DraftMaterial } from './model'
import './process.css'

/*
 * LAYERS — "We listen first. Then we build."
 *
 * How a relief model is made, on one sheet of chart paper, the drone
 * travelling along:
 *
 *   0.00–0.10  in-beat: blank chart paper, a survey grid, an old dotted
 *              coastline and a total station on its tripod, sounding
 *   0.10–0.27  01 LISTEN     FIELD SURVEY: the sounding rings drift out of
 *                            the station; a vermilion measuring front sweeps the
 *                            island and every point it passes is measured — a
 *                            pin rises to its true height, spot heights are
 *                            lettered in
 *   0.27–0.44  02 PROTOTYPE  THE CONTOUR DRAFT: the pins settle, the drone
 *                            tilts to a map view, and the contours are drawn
 *                            on over blank paper — pencil first, then ink,
 *                            each pen tip vermilion; the index contours get
 *                            their values and the water-lining prints
 *   0.44–0.61  03 BUILD      LAYERS: the model is built as a stack of boards,
 *                            one per contour band, each cut to its contour and
 *                            dropped onto the pencil guide on the board below
 *   0.61–0.78  04 SUPPORT    the finished model: the relief rises through the
 *                            stack and smooths it into the printed chart; a
 *                            route is drawn up to the summit, then revised
 *                            (Rev. 2) along the ridge
 *   0.78–0.95  results: the drone pulls back over the finished sheet; a legend
 *              of three figures (10 years, $1M+, 15)
 *   0.95–1.00  out-beat
 *
 * Everything is derived from `local`; frame.time only drives the sounding
 * rings, the water-lining drift and a slow drone drift (all still under
 * reduced motion / Motion off).
 */

// ---------------------------------------------------------------- timeline

const STEP_AT = [0.1, 0.27, 0.44, 0.61, 0.78]
const ANCHORS = [0.2, 0.372, 0.548, 0.748]
const STATS_AT = 0.875
const HEAD = [0.045, 0.955] as const
const CARD = [0.1, 0.785] as const
const TILES = [0.825, 0.955] as const

const FRONT = [0.104, 0.236] as const
const FRONT_R = 10.8
const RINGS = [0.05, 0.3] as const
const RETRACT = [0.262, 0.302] as const
const PENCIL = [0.282, 0.392] as const
const INK = [0.308, 0.428] as const
const HANDOVER = [0.424, 0.44] as const
const DROP0 = 0.452
const DROP_STEP = 0.0128
const DROP_LEN = 0.036
const LIFT = [0.606, 0.676] as const
const REV1 = [0.672, 0.71] as const
const REV2 = [0.712, 0.752] as const
const STAMP_AT = 0.728
const PEAK = [0.742, 0.772] as const

// 10 years, $1M+, 15 — in that order
const SHOW = [STATS[0], STATS[2], STATS[1]]
const KEYS = ['layers', 'route', 'marker']

/** the chart sheet (terrain) rectangle */
const PAPER = { w: 34, d: 26, cx: 1.2, cz: -0.6 }
/** the field's extent: the island, its water-lining and a margin of flat sea */
const FIELD = { x0: -10, x1: 12, z0: -9, z1: 7.8 }
/** tint ramp range of the chart and the boards */
const H_MAX = 2.9

// ---------------------------------------------------------------- camera keys

const DEG = Math.PI / 180
const UP = new THREE.Vector3(0, 1, 0)
const _c = new THREE.Vector3()
const _f = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()

/** [t, azimuth°, elevation°, distance, screen x, screen y, center y] (az 0 = from the south, + from the east) */
type Key = [number, number, number, number, number, number, number]

const WIDE: Key[] = [
  [0.0, -12, 76, 34, 0.24, 0.02, 0],
  [0.1, -6, 63, 26, 0.25, 0.0, 0],
  [0.19, 1, 54, 24, 0.25, 0.0, 0.2],
  [0.265, 5, 57, 23.5, 0.25, 0.0, 0.2],
  [0.33, 2, 81, 24.5, 0.26, 0.04, 0],
  [0.43, -2, 84, 24, 0.26, 0.04, 0],
  [0.5, -14, 47, 23, 0.29, 0.0, 0.35],
  [0.6, -22, 39, 22, 0.3, 0.0, 0.45],
  [0.69, -30, 34, 21.5, 0.3, 0.02, 0.55],
  [0.78, -35, 33, 22, 0.3, 0.02, 0.5],
  [0.85, -28, 40, 27, 0.18, 0.16, 0.4],
  [0.95, -25, 42, 28, 0.18, 0.16, 0.4],
  [1.0, -23, 46, 30, 0.18, 0.18, 0.4],
]
/** portrait: distance is a multiple of the fit distance; screen y is an offset from the band's center */
const TALL: Key[] = [
  [0.0, -10, 78, 1.15, 0, 0.02, 0],
  [0.1, -6, 66, 1.0, 0, 0, 0],
  [0.19, 0, 56, 0.97, 0, 0, 0.2],
  [0.265, 4, 58, 0.97, 0, 0, 0.2],
  [0.33, 2, 82, 0.99, 0, 0, 0],
  [0.43, -2, 84, 0.99, 0, 0, 0],
  [0.5, -14, 50, 1.0, 0, -0.01, 0.35],
  [0.6, -22, 42, 0.99, 0, -0.01, 0.45],
  [0.69, -30, 36, 0.98, 0, -0.01, 0.55],
  [0.78, -34, 35, 0.99, 0, 0, 0.5],
  [0.85, -28, 42, 1.0, 0, 0, 0.4],
  [0.95, -25, 44, 1.02, 0, 0, 0.4],
  [1.0, -23, 48, 1.08, 0, 0.02, 0.4],
]
/** the island's center (main island + islet) */
const CX = 1.3
const CZ = -0.7
/** half the island's width to keep in frame on narrow screens (world units, with a margin) */
const HALF_W = 9.4

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/** keys from here on frame the finished sheet above the results legend */
const RESULTS = 0.84

/**
 * The free space around the copy, measured from the DOM (fractions of the
 * stage). Portrait: the band between the headline and the copy below it,
 * where the island is centered. While the results legend is up, two
 * rectangles above it ([x0, y0, x1, y1], y down), one beside the headline
 * and one below it: the whole relief is kept inside one of them (landscape:
 * whichever holds it larger; portrait: below).
 */
interface Band {
  top: number
  card: number
  stats: number
  aside: Float64Array
  below: Float64Array
  /** bumped on every measure (invalidates the fitted keys) */
  v: number
}

/**
 * The finished relief's extreme points (world x, y, z: the coast, the high
 * ground and the summit marker's head) and, per camera key, the fitted
 * distance and pan (NaN = not yet fitted for this layout).
 */
interface Fit {
  pts: Float32Array
  n: number
  cam: Float32Array
  cache: Float64Array
  aspect: number
  tanH: number
  v: number
}

const _b = new THREE.Vector3()
/** scratch results of span(): the feasible camera offsets on one axis */
let spanLo = 0
let spanHi = 0

/**
 * Along one screen axis, the camera offsets that keep every point inside
 * [v0, v1] (NDC) at distance D: point j lands at (p_j − off) / (s·(D + z_j)).
 * Feasible when spanLo ≤ spanHi.
 */
function span(q: Float32Array, n: number, axis: number, D: number, s: number, v0: number, v1: number) {
  let lo = -Infinity
  let hi = Infinity
  for (let j = 0; j < n; j++) {
    const p = q[j * 3 + axis]
    const w = s * (D + q[j * 3 + 2])
    const a = p - v1 * w
    const b = p - v0 * w
    if (a > lo) lo = a
    if (b < hi) hi = b
  }
  spanLo = lo
  spanHi = hi
}

function fits(q: Float32Array, n: number, D: number, A: number, tanH: number, x0: number, x1: number, y0: number, y1: number) {
  span(q, n, 0, D, A, x0, x1)
  if (spanLo > spanHi) return false
  span(q, n, 1, D, tanH, y0, y1)
  return spanLo <= spanHi
}

/**
 * The results keys: the smallest distance at which the whole relief fits a
 * free rectangle (landscape: beside or below the headline, whichever holds
 * it larger; portrait: below it), never nearer than the key's own `own`;
 * then the key's own screen offset (sx, sy), nudged just enough to keep the
 * relief inside. Writes fit.cache[i*3 ..] = distance, pan x, pan y.
 */
function fitKey(i: number, own: number, sx: number, sy: number, aspect: number, tanH: number, tall: boolean, band: Band, fit: Fit) {
  const { pts, n, cam: q, cache } = fit
  const A = tanH * aspect
  let near = 0
  for (let j = 0; j < n; j++) {
    const dx = pts[j * 3] - _c.x
    const dy = pts[j * 3 + 1] - _c.y
    const dz = pts[j * 3 + 2] - _c.z
    q[j * 3] = dx * _r.x + dy * _r.y + dz * _r.z
    q[j * 3 + 1] = dx * _u.x + dy * _u.y + dz * _u.z
    q[j * 3 + 2] = dx * _f.x + dy * _f.y + dz * _f.z
    near = Math.max(near, 1 - q[j * 3 + 2])
  }
  let best = Infinity
  let pick: Float64Array | null = null
  for (let ri = tall ? 1 : 0; ri < 2; ri++) {
    const R = ri ? band.below : band.aside
    const x0 = 2 * R[0] - 1
    const x1 = 2 * R[2] - 1
    const y0 = 1 - 2 * R[3]
    const y1 = 1 - 2 * R[1]
    if (x1 - x0 < 0.2 || y1 - y0 < 0.2) continue
    let lo = near
    let hi = 400
    if (!fits(q, n, hi, A, tanH, x0, x1, y0, y1)) continue
    for (let it = 0; it < 28; it++) {
      const mid = (lo + hi) / 2
      if (fits(q, n, mid, A, tanH, x0, x1, y0, y1)) hi = mid
      else lo = mid
    }
    if (hi < best) {
      best = hi
      pick = R
    }
  }
  const o = i * 3
  const D = pick ? Math.max(best, own) : own
  let X = -sx * A * D
  let Y = -sy * tanH * D
  if (pick) {
    span(q, n, 0, D, A, 2 * pick[0] - 1, 2 * pick[2] - 1)
    X = clamp(X, spanLo, spanHi)
    span(q, n, 1, D, tanH, 1 - 2 * pick[3], 1 - 2 * pick[1])
    Y = clamp(Y, spanLo, spanHi)
  }
  cache[o] = D
  cache[o + 1] = X
  cache[o + 2] = Y
}

function place(k: Key, i: number, aspect: number, fov: number, tall: boolean, band: Band, fit: Fit, pos: THREE.Vector3, tgt: THREE.Vector3) {
  const tanH = Math.tan((fov * DEG) / 2)
  const a = k[1] * DEG
  const e = k[2] * DEG
  _c.set(CX, k[6], CZ)
  // the view direction: from the island's center out to the camera
  _b.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e))
  _f.copy(_b).negate()
  _r.crossVectors(_f, UP).normalize()
  _u.crossVectors(_r, _f)
  let d = k[3]
  let sy = k[5]
  if (tall) {
    const bottom = k[0] >= RESULTS ? band.stats : band.card
    const f = Math.max(0.14, bottom - band.top)
    sy += 1 - (band.top + bottom)
    // the island's projected height (its depth foreshortened, plus the relief) fits the band; its width fits the screen
    const vert = 10.5 * Math.sin(e) + 2.2 * Math.cos(e)
    d *= Math.max(HALF_W / (tanH * aspect), vert / (2 * tanH * f))
  } else d *= Math.pow(clamp(1.6 / aspect, 1, 1.7), 0.92)
  // pan so the center lands at screen (sx, sy)
  let px = -k[4] * tanH * d * aspect
  let py = -sy * tanH * d
  if (k[0] >= RESULTS && fit.n > 0) {
    // the results: the whole relief clears the legend and the headline
    if (fit.aspect !== aspect || fit.tanH !== tanH || fit.v !== band.v) {
      fit.cache.fill(NaN)
      fit.aspect = aspect
      fit.tanH = tanH
      fit.v = band.v
    }
    const o = i * 3
    if (Number.isNaN(fit.cache[o])) fitKey(i, d, k[4], sy, aspect, tanH, tall, band, fit)
    d = fit.cache[o]
    px = fit.cache[o + 1]
    py = fit.cache[o + 2]
  }
  tgt.copy(_c).addScaledVector(_r, px).addScaledVector(_u, py)
  pos.copy(tgt).addScaledVector(_b, d)
}

const _pa = new THREE.Vector3()
const _ta = new THREE.Vector3()
const _pb = new THREE.Vector3()
const _tb = new THREE.Vector3()

function sampleKeys(keys: Key[], local: number, aspect: number, fov: number, tall: boolean, band: Band, fit: Fit, pos: THREE.Vector3, tgt: THREE.Vector3) {
  let i = 0
  while (i < keys.length - 2 && local > keys[i + 1][0]) i++
  const a = keys[i]
  const b = keys[i + 1]
  const e = smoother(segment(local, a[0], b[0]))
  place(a, i, aspect, fov, tall, band, fit, _pa, _ta)
  place(b, i + 1, aspect, fov, tall, band, fit, _pb, _tb)
  pos.lerpVectors(_pa, _pb, e)
  tgt.lerpVectors(_ta, _tb, e)
}

// ---------------------------------------------------------------- helpers

/** a smooth path through waypoints (Catmull-Rom), as 2D points ~every 0.12 units */
function smoothPath(pts: V2[]): V2[] {
  const curve = new THREE.CatmullRomCurve3(
    pts.map(p => new THREE.Vector3(p[0], 0, p[1])),
    false,
    'centripetal',
  )
  const n = Math.max(8, Math.round(curve.getLength() / 0.12))
  return curve.getSpacedPoints(n).map(v => [v.x, v.z] as V2)
}

/** the chart's own tint ramp (src/kit/chart.ts), for a board's top */
function tintAt(h: number): THREE.Color {
  const tints = C.tints.map(c => new THREE.Color(c))
  const t = clamp(h / H_MAX, 0, 0.9999)
  const bands = Math.max(1, H_MAX / (INTERVAL * 5))
  const tq = (Math.floor(t * bands) + 0.5) / bands
  const s = clamp(lerp(t, tq, 0.7), 0, 1) * 5
  const i = Math.min(4, Math.floor(s))
  return tints[i].clone().lerp(tints[i + 1], s - i)
}

// ---------------------------------------------------------------- chapter

interface Board {
  mesh: THREE.Mesh
  m: BoardMaterial
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let ready = false

  let field: Field
  let chart: ChartMaterial
  let draft: DraftMaterial
  let draftMesh: THREE.Mesh
  const boards: Board[] = []
  let rings: ReturnType<typeof ringMaterial>
  let ringMesh: THREE.Mesh
  let stn: ReturnType<typeof station>
  const stnAt = new THREE.Vector3()
  let stnScale = 1.8
  const eye = new THREE.Vector3()

  // survey points
  let nPts = 0
  let ptX: Float32Array, ptZ: Float32Array, ptH: Float32Array, ptD: Float32Array
  let stems: THREE.InstancedMesh, heads: THREE.InstancedMesh, marks: THREE.InstancedMesh
  let rays: THREE.LineSegments
  let rayPos: THREE.BufferAttribute, rayCol: THREE.BufferAttribute
  const spot: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; d: number }[] = []
  /** contour values on the index contours, lettered in when the ink reaches them */
  const values: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number }[] = []
  const _m = new THREE.Matrix4()

  // the route and its revision
  let routeA: ReturnType<typeof routeRibbon>, routeB: ReturnType<typeof routeRibbon>
  let peak: ReturnType<typeof marker>
  let peakH = 0
  const peakAt = new THREE.Vector2()
  const inkSoft = new THREE.Color(C.inkSoft)
  const signal = new THREE.Color(C.signal)

  // DOM
  let head: HTMLElement, headline: HTMLElement
  let cardEl: HTMLElement, countEl: HTMLElement, metaEl: HTMLElement, stampEl: HTMLElement
  const stepEls: HTMLElement[] = []
  const stepTitles: HTMLElement[] = []
  const fills: HTMLElement[] = []
  const segs: HTMLElement[] = []
  let statsEl: HTMLElement
  let shown = -2
  let tilesShown = false
  let stampShown = false
  let metaText = -1
  const fillCache = [-1, -1, -1, -1]
  let lastLocal = -1

  const tmpPos = new THREE.Vector3()
  const tmpTgt = new THREE.Vector3()
  /** the free space around the copy, measured on resize (defaults until the first layout) */
  const band: Band = {
    top: 0.2,
    card: 0.58,
    stats: 0.55,
    aside: Float64Array.of(0.4, 0.12, 0.96, 0.64),
    below: Float64Array.of(0.04, 0.34, 0.96, 0.64),
    v: 0,
  }
  const fit: Fit = { pts: new Float32Array(0), n: 0, cam: new Float32Array(0), cache: new Float64Array(WIDE.length * 3), aspect: 0, tanH: 0, v: -1 }

  return {
    id: 'process',
    group,
    anchors: [...ANCHORS, STATS_AT],

    async init(ctx: ChapterContext) {
      const mobile = ctx.mobile
      const height = makeLand()
      field = await buildField(height, FIELD, mobile ? 0.075 : 0.05)
      await nextFrame()

      // ---- the chart sheet
      const geo = await terrainGeometryAsync({
        width: PAPER.w,
        depth: PAPER.d,
        seg: mobile ? 130 : 200,
        detail: mobile ? 2 : 3,
        height: field.sample,
        cx: PAPER.cx,
        cz: PAPER.cz,
      })
      const td = geo.userData as TerrainData
      chart = chartMaterial(ctx.world, {
        terrain: geo,
        interval: INTERVAL,
        hMin: 0,
        hMax: H_MAX,
        waterSpacing: 0.1,
        waterLines: 6,
        lift: 0,
        tint: 0,
        lines: 0,
        shade: 0,
        stepped: 0.7,
      })
      // a coastal vignette: the sea's tint fades into the paper with depth, so
      // the water-lining rings sit on a band of pale blue and the far sea is
      // blank chart paper (the sheet's own edges never show)
      chart.uniforms.uWaterDeep.value.set(C.paper)
      const land = new THREE.Mesh(geo, chart)
      land.renderOrder = 0
      group.add(land)
      await nextFrame()

      // ---- contours: the coast and every level up the hill
      const levels: Loop[][] = []
      const top = Math.floor(td.hMax / INTERVAL - 1e-3)
      for (let k = 0; k <= top; k++) {
        levels.push(contourLoops(field, k * INTERVAL, BOUNDS))
        if (k % 4 === 3) await nextFrame()
      }
      const dt: DrawTime = drawTimeTexture(levels, BOUNDS, mobile ? 0.06 : 0.045)
      draft = draftMaterial(ctx.world, td, dt, INTERVAL)
      const dg = new THREE.PlaneGeometry(PAPER.w, PAPER.d)
      dg.rotateX(-Math.PI / 2)
      draftMesh = new THREE.Mesh(dg, draft.material)
      draftMesh.position.set(PAPER.cx, 0.004, PAPER.cz)
      draftMesh.renderOrder = 1
      group.add(draftMesh)
      await nextFrame()

      // ---- the boards: board k is cut to contour k+1 and stands on the one below
      for (let k = 0; k < top; k++) {
        const lvl = (k + 1) * INTERVAL
        const g = boardGeometry(field, levels[k + 1], lvl, k * INTERVAL, lvl - 0.004)
        if (!g) continue
        const tint = tintAt(lvl + INTERVAL * 0.5)
        const wall = tint.clone().multiplyScalar(0.8).lerp(new THREE.Color(C.contour), 0.2)
        const m = boardMaterial(ctx.world, td, lvl, lvl + INTERVAL, tint, wall)
        const mesh = new THREE.Mesh(g, m.material)
        mesh.renderOrder = 4 + k
        mesh.visible = false
        group.add(mesh)
        boards.push({ mesh, m })
        if (k % 3 === 2) await nextFrame()
      }

      // ---- the survey station: on the beach, where no board stands
      let best = Infinity
      const [sx0, sz0] = POI.station
      for (let dz = -1.2; dz <= 1.2; dz += 0.05) {
        for (let dx = -1.2; dx <= 1.2; dx += 0.05) {
          const h = field.sample(sx0 + dx, sz0 + dz)
          if (h < 0.07 || h > 0.15) continue
          const d = dx * dx + dz * dz
          if (d < best) {
            best = d
            stnAt.set(sx0 + dx, h, sz0 + dz)
          }
        }
      }
      if (!Number.isFinite(best)) stnAt.set(sx0, field.sample(sx0, sz0), sz0)
      stn = station()
      stn.group.position.set(stnAt.x, 0, stnAt.z)
      stn.group.rotation.y = -0.5
      stnScale = mobile ? 2.1 : 1.8
      stn.group.scale.setScalar(stnScale)
      group.add(stn.group)

      rings = ringMaterial(ctx.world)
      rings.uniforms.uCenter.value.set(stnAt.x, stnAt.z)
      const rg = new THREE.PlaneGeometry(FRONT_R * 2 + 1, FRONT_R * 2 + 1)
      rg.rotateX(-Math.PI / 2)
      ringMesh = new THREE.Mesh(rg, rings.material)
      ringMesh.position.set(stnAt.x, 0.007, stnAt.z)
      ringMesh.renderOrder = 2
      group.add(ringMesh)

      // ---- survey points: a jittered grid over the land, plus the named heights
      const rnd = mulberry32(41)
      const pts: number[] = []
      const sp = mobile ? 1.15 : 0.95
      for (let z = BOUNDS.z0 + 0.5; z < BOUNDS.z1; z += sp) {
        for (let x = BOUNDS.x0 + 0.5; x < BOUNDS.x1; x += sp) {
          const px = x + (rnd() - 0.5) * sp * 0.7
          const pz = z + (rnd() - 0.5) * sp * 0.7
          const h = field.sample(px, pz)
          if (h < 0.12) continue
          pts.push(px, pz, h)
        }
      }
      const named: V2[] = [POI.summit, POI.west, POI.north, POI.islet, POI.saddle]
      const namedAt: number[] = []
      const namedPts = named.map(([nx, nz], n) => {
        // the local high point near each named summit (the saddle stays where it is)
        let bx = nx
        let bz = nz
        let bh = field.sample(nx, nz)
        if (n < 4) {
          for (let dz = -0.7; dz <= 0.7; dz += 0.07) {
            for (let dx = -0.7; dx <= 0.7; dx += 0.07) {
              const h = field.sample(nx + dx, nz + dz)
              if (h > bh) {
                bh = h
                bx = nx + dx
                bz = nz + dz
              }
            }
          }
        }
        return [bx, bz, bh]
      })
      // drop grid points crowding a named point, then add the named points last
      for (let i = pts.length - 3; i >= 0; i -= 3) {
        if (namedPts.some(q => Math.hypot(pts[i] - q[0], pts[i + 1] - q[1]) < sp * 0.55)) pts.splice(i, 3)
      }
      for (const q of namedPts) {
        namedAt.push(pts.length / 3)
        pts.push(q[0], q[1], q[2])
      }
      nPts = pts.length / 3
      ptX = new Float32Array(nPts)
      ptZ = new Float32Array(nPts)
      ptH = new Float32Array(nPts)
      ptD = new Float32Array(nPts)
      for (let i = 0; i < nPts; i++) {
        ptX[i] = pts[i * 3]
        ptZ[i] = pts[i * 3 + 1]
        ptH[i] = pts[i * 3 + 2]
        ptD[i] = Math.hypot(ptX[i] - stnAt.x, ptZ[i] - stnAt.z)
      }
      const inkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.ink), toneMapped: false })
      const redMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.signal), toneMapped: false })
      const markMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.signal), toneMapped: false })
      const stemGeo = new THREE.CylinderGeometry(0.014, 0.014, 1, 5)
      stemGeo.translate(0, 0.5, 0)
      stems = new THREE.InstancedMesh(stemGeo, inkMat, nPts)
      heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.065, 12, 8), redMat, nPts)
      const markGeo = new THREE.RingGeometry(0.06, 0.09, 20)
      markGeo.rotateX(-Math.PI / 2)
      marks = new THREE.InstancedMesh(markGeo, markMat, nPts)
      for (const im of [stems, heads, marks]) {
        im.frustumCulled = false
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        group.add(im)
      }
      const rg2 = new THREE.BufferGeometry()
      rayPos = new THREE.BufferAttribute(new Float32Array(nPts * 6), 3)
      rayCol = new THREE.BufferAttribute(new Float32Array(nPts * 8), 4)
      rayPos.setUsage(THREE.DynamicDrawUsage)
      rayCol.setUsage(THREE.DynamicDrawUsage)
      const rc = new THREE.Color(C.signal)
      for (let i = 0; i < nPts * 2; i++) rayCol.setXYZW(i, rc.r, rc.g, rc.b, 0)
      rg2.setAttribute('position', rayPos)
      rg2.setAttribute('color', rayCol)
      rays = new THREE.LineSegments(rg2, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }))
      rays.frustumCulled = false
      rays.renderOrder = 3
      group.add(rays)
      await nextFrame()

      // ---- spot heights, lettered in as they are measured
      await ensureFonts()
      named.forEach((_, n) => {
        const i = namedAt[n]
        const mesh = mapLabel(String(Math.round(ptH[i] * METERS)), {
          font: 'mono',
          size: 30,
          weight: 600,
          color: C.ink,
          height: mobile ? 0.66 : 0.56,
          flat: true,
        })
        const lw = (mesh.geometry as THREE.PlaneGeometry).parameters.width
        mesh.position.set(ptX[i] + 0.16 + lw / 2, 0.012, ptZ[i] + 0.04)
        mesh.renderOrder = 20
        const mat = mesh.material as THREE.MeshBasicMaterial
        mat.opacity = 0
        group.add(mesh)
        spot.push({ mesh, mat, d: ptD[i] })
      })

      // ---- contour values: on the south flank of the index contours, reading uphill
      const dtData = dt.texture.image.data as Float32Array
      const drawTimeAt = (x: number, z: number) => {
        const ii = Math.round((x - dt.origin.x) / dt.step)
        const jj = Math.round((z - dt.origin.y) / dt.step)
        if (ii < 0 || jj < 0 || ii >= dt.size.x || jj >= dt.size.y) return 1
        const v = dtData[jj * dt.size.x + ii]
        return v > 1.5 ? 1 : v
      }
      for (const k of [5, 10]) {
        const ls = [...(levels[k] ?? [])].sort((a, b) => loopLength(b) - loopLength(a)).slice(0, k === 5 ? 2 : 1)
        for (const l of ls) {
          if (loopLength(l) < 2.4) continue
          const n = l.length / 2
          let bi = 0
          for (let i = 1; i < n; i++) if (l[i * 2 + 1] > l[bi * 2 + 1]) bi = i
          const a = ((bi - 4) % n + n) % n
          const b = (bi + 4) % n
          const tx = l[b * 2] - l[a * 2]
          const tz = l[b * 2 + 1] - l[a * 2 + 1]
          let th = Math.atan2(-tz, tx)
          const x = l[bi * 2]
          const z = l[bi * 2 + 1]
          // the letters' top faces uphill
          const gx = field.sample(x + 0.05, z) - field.sample(x - 0.05, z)
          const gz = field.sample(x, z + 0.05) - field.sample(x, z - 0.05)
          if (-Math.sin(th) * gx - Math.cos(th) * gz < 0) th += Math.PI
          const mesh = mapLabel(String(Math.round(k * INTERVAL * METERS)), {
            font: 'mono',
            size: 26,
            weight: 600,
            color: C.index,
            height: mobile ? 0.44 : 0.4,
            flat: true,
          })
          mesh.rotation.set(-Math.PI / 2, 0, th)
          mesh.position.set(x, 0.006, z)
          mesh.renderOrder = 19
          const mat = mesh.material as THREE.MeshBasicMaterial
          mat.opacity = 0
          mesh.visible = false
          group.add(mesh)
          values.push({ mesh, mat, t: drawTimeAt(x, z) })
        }
      }

      await nextFrame()

      // ---- the route to the summit, and its revision along the ridge
      const [smx, smz] = [ptX[namedAt[0]], ptZ[namedAt[0]]]
      peakAt.set(smx, smz)
      peakH = ptH[namedAt[0]]
      const s0: V2 = [stnAt.x + 0.25, stnAt.z - 0.2]
      const pathA = smoothPath([s0, [-1.05, 0.9], [0.25, 0.5], [1.25, 0.05], [1.95, -0.55], [smx, smz]])
      const pathB = smoothPath([s0, [-1.05, 0.9], [-0.85, 0.2], POI.saddle, [0.2, -0.42], [1.0, -0.62], [1.75, -0.95], [smx, smz]])
      routeA = routeRibbon(drape(pathA, field.sample, { offset: 0.035, step: 0.1 }), { width: 0.075, dash: 0.2, gap: 0.12 })
      routeB = routeRibbon(drape(pathB, field.sample, { offset: 0.04, step: 0.1 }), { width: 0.085, dash: 0.2, gap: 0.12 })
      routeA.mesh.renderOrder = 12
      routeB.mesh.renderOrder = 13
      group.add(routeA.mesh, routeB.mesh)
      peak = marker({ color: C.signal, height: 0.85, radius: 0.16 })
      peak.group.position.set(smx, peakH, smz)
      group.add(peak.group)

      // ---- the finished relief's extreme points, for the landscape results fit:
      // the coast every ~0.3 units, the high ground on a coarse grid, the marker's head
      const fp: number[] = []
      for (const l of levels[0] ?? []) {
        const n = l.length / 2
        let run = Infinity
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n
          if (run >= 0.3) {
            fp.push(l[i * 2], 0, l[i * 2 + 1])
            run = 0
          }
          run += Math.hypot(l[j * 2] - l[i * 2], l[j * 2 + 1] - l[i * 2 + 1])
        }
      }
      for (let z = BOUNDS.z0; z <= BOUNDS.z1; z += 0.5) {
        for (let x = BOUNDS.x0; x <= BOUNDS.x1; x += 0.5) {
          const h = field.sample(x, z)
          if (h > 0.5) fp.push(x, h, z)
        }
      }
      fp.push(smx, peakH + 1.05, smz)
      fit.pts = Float32Array.from(fp)
      fit.n = fp.length / 3
      fit.cam = new Float32Array(fp.length)

      // ---- DOM
      const stage = ctx.stage
      head = el('div', 'pr-head', undefined, stage)
      el('p', 'hud-eyebrow', 'How it works', head)
      headline = rise(el('h2', 'hud-h2 pr-headline', undefined, head), 'We listen first. <em>Then we build.</em>')

      cardEl = el('div', 'pr-card hud-panel', undefined, stage)
      const topRow = el('div', 'pr-top', undefined, cardEl)
      countEl = el('span', 'hud-label pr-count', 'Step 01 / 04', topRow)
      metaEl = el('span', 'hud-coord pr-meta', '', topRow)
      const steps = el('div', 'pr-steps', undefined, cardEl)
      PROCESS.forEach((p, i) => {
        const s = el('div', 'pr-step', undefined, steps)
        const n = String(i + 1).padStart(2, '0')
        stepTitles.push(rise(el('h3', 'pr-title', undefined, s), `<em>${n}</em> — ${p.title}`))
        el('p', 'hud-body pr-text', p.text, s)
        stepEls.push(s)
      })
      const track = el('ol', 'pr-track', undefined, cardEl)
      track.setAttribute('aria-hidden', 'true')
      PROCESS.forEach(p => {
        const li = el('li', 'pr-seg', undefined, track)
        const bar = el('span', 'pr-bar', undefined, li)
        fills.push(el('span', 'pr-fill', undefined, bar))
        el('span', 'pr-name', p.title, li)
        segs.push(li)
      })
      stampEl = el('span', 'pr-stamp', 'Rev. 2', cardEl)
      stampEl.setAttribute('aria-hidden', 'true')

      statsEl = el('div', 'pr-stats hud-panel', undefined, stage)
      const cap = el('div', 'pr-cap', undefined, statsEl)
      el('span', 'hud-label', 'Legend', cap)
      el('span', 'hud-coord', SHEET.name(6, 'Layers'), cap)
      const grid = el('div', 'pr-grid', undefined, statsEl)
      SHOW.forEach((s, i) => {
        const t = el('div', 'pr-tile', undefined, grid)
        t.style.setProperty('--i', String(i))
        const key = el('span', `pr-key pr-key--${KEYS[i]}`, undefined, t)
        key.setAttribute('aria-hidden', 'true')
        if (i === 0) for (let q = 0; q < 3; q++) el('i', '', undefined, key)
        el('p', 'pr-value', s.value, t)
        el('p', 'pr-label', s.label, t)
      })
      reveal(head, 0, 0)
      reveal(cardEl, 0, 0)
      reveal(statsEl, 0, 0)
      // measure the free space around the copy (layout only: opacity never changes it)
      const words = headline.querySelectorAll<HTMLElement>('.rise-w')
      const measure = () => {
        const W = stage.clientWidth
        const H = stage.clientHeight
        if (H < 10 || W < 10) return
        band.top = (head.offsetTop + head.offsetHeight) / H
        band.card = cardEl.offsetTop / H
        band.stats = statsEl.offsetTop / H
        // the headline's inked extent (its words, not its box)
        const left = head.getBoundingClientRect().left
        let right = 0
        words.forEach(w => (right = Math.max(right, w.getBoundingClientRect().right - left)))
        const inkR = head.offsetLeft + (right || head.offsetWidth)
        const g = head.offsetLeft
        const m = clamp(0.03 * H, 12, 28)
        const floor = (statsEl.offsetTop - m) / H
        band.aside[0] = (inkR + m * 1.5) / W
        band.aside[1] = head.offsetTop / H
        band.aside[2] = (W - g) / W
        band.aside[3] = floor
        band.below[0] = g / W
        band.below[1] = (head.offsetTop + head.offsetHeight + m) / H
        band.below[2] = (W - g) / W
        band.below[3] = floor
        band.v++
      }
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure)
        ro.observe(stage)
        ro.observe(head)
        ro.observe(cardEl)
        ro.observe(statsEl)
      }
      measure()
      // a late webfont can change the headline's width without resizing its box
      document.fonts?.ready.then(measure).catch(() => {})
      ready = true
    },

    update(local, frame, ctx) {
      if (!ready) return
      const calm = ctx.reducedMotion || frame.reducedMotion || !!frame.still

      // ---- world: the paper, fog well past the sheet
      const w = ctx.world.params
      w.fogNear = 42
      w.fogFar = 120

      // ---- the chart
      const lift = ease.inOutCubic(segment(local, LIFT[0], LIFT[1]))
      const u = chart.uniforms
      u.uLift.value = lift
      u.uTint.value = lerp(lerp(0.1, 0.42, smoothstep(0.41, 0.45, local)), 1, smoothstep(LIFT[0] + 0.01, LIFT[1] + 0.005, local))
      u.uLines.value = smoothstep(HANDOVER[0], HANDOVER[1], local)
      u.uShade.value = 0.85 * smoothstep(LIFT[0], LIFT[1], local)
      u.uRipple.value = calm ? 0 : 0.08
      const peakOn = smoothstep(PEAK[0], PEAK[1], local) * (1 - smoothstep(0.95, 0.99, local))
      u.uHi.value.set(peakAt.x, peakAt.y, 0.95, peakOn * 0.85)

      // ---- the draft sheet
      const d = draft.uniforms
      d.uTicks.value = smoothstep(0.015, 0.075, local) * (1 - smoothstep(0.41, 0.445, local))
      d.uOldCoast.value = smoothstep(0.03, 0.09, local) * (1 - smoothstep(0.41, 0.44, local))
      d.uPencil.value = segment(local, PENCIL[0], PENCIL[1]) * 1.02
      d.uInk.value = segment(local, INK[0], INK[1]) * 1.02
      d.uLines.value = 1 - smoothstep(HANDOVER[1], HANDOVER[1] + 0.015, local)
      const place0 = boards.length ? smoothstep(0.7, 1, segment(local, DROP0, DROP0 + DROP_LEN)) : 0
      d.uShadow.value = place0 * (1 - smoothstep(LIFT[0], LIFT[0] + 0.03, local))
      // after the hand-over only the first board's shadow is left on the sheet
      draftMesh.visible = local < LIFT[0] + 0.035

      // ---- the boards: each drops onto the pencil guide of the one below
      const sink = smoothstep(0.9, 1, lift)
      for (let k = 0; k < boards.length; k++) {
        const b = boards[k]
        const t0 = DROP0 + k * DROP_STEP
        const p = segment(local, t0, t0 + DROP_LEN)
        const above = k + 1 < boards.length ? segment(local, t0 + DROP_STEP, t0 + DROP_STEP + DROP_LEN) : 0
        b.mesh.visible = p > 0 && lift < 0.995
        b.mesh.position.y = 1.5 * (1 - ease.outCubic(p)) - 0.03 * sink
        b.m.uniforms.uOpacity.value = smoothstep(0, 0.22, p)
        b.m.uniforms.uAbove.value = smoothstep(0.7, 1, above)
      }

      // ---- 01 LISTEN: the station, the sounding rings, the measuring front
      const R = ease.inOutQuad(segment(local, FRONT[0], FRONT[1])) * FRONT_R
      const r = rings.uniforms
      r.uTime.value = calm ? 0.35 : frame.time
      r.uFront.value = Math.max(0.001, R)
      r.uFrontOn.value = window01(local, FRONT[0], FRONT[1] + 0.012, 0.012)
      r.uRings.value = window01(local, RINGS[0], RINGS[1], 0.03)
      r.uReach.value = 3.4
      ringMesh.visible = local > RINGS[0] - 0.005 && local < RINGS[1] + 0.005
      const stnY = stnAt.y * lift
      stn.group.position.y = stnY
      stn.group.visible = local < 0.99
      // the instrument steps back to a model's scale once the survey is done
      stn.group.scale.setScalar(stnScale * lerp(1, 0.62, smoothstep(0.44, 0.5, local)))
      eye.copy(stn.eye).multiplyScalar(stn.group.scale.x).applyAxisAngle(UP, stn.group.rotation.y).add(stn.group.position)
      for (const v of values) {
        const o = smoothstep(v.t + 0.01, v.t + 0.05, d.uInk.value) * (1 - smoothstep(HANDOVER[1] + 0.005, HANDOVER[1] + 0.03, local))
        v.mat.opacity = o
        v.mesh.visible = o > 0.003
      }

      if (local !== lastLocal) {
        lastLocal = local
        const retract = ease.inOutCubic(segment(local, RETRACT[0], RETRACT[1]))
        const dots = 1 - smoothstep(0.415, 0.445, local)
        const survey = local < 0.45
        stems.visible = heads.visible = marks.visible = survey
        rays.visible = local < RETRACT[1]
        for (let i = 0; i < nPts; i++) {
          const m = survey ? ease.outCubic(clamp((R - ptD[i]) / 1.1)) : 0
          const hgt = ptH[i] * m * (1 - retract)
          _m.makeScale(1, Math.max(1e-4, hgt), 1).setPosition(ptX[i], 0, ptZ[i])
          if (hgt < 0.01) _m.makeScale(0, 0, 0)
          stems.setMatrixAt(i, _m)
          const hs = smoothstep(0, 0.25, m) * dots
          _m.makeScale(hs, hs * (hgt > 0.02 ? 1 : 0.35), hs).setPosition(ptX[i], hgt + 0.012, ptZ[i])
          heads.setMatrixAt(i, _m)
          const ms = smoothstep(0, 0.4, m) * dots
          _m.makeScale(ms, 1, ms).setPosition(ptX[i], 0.006, ptZ[i])
          marks.setMatrixAt(i, _m)
          // sight lines from the instrument to each point just measured
          const since = R - ptD[i]
          const ra = survey ? smoothstep(0, 0.25, since) * (1 - smoothstep(0.5, 2.4, since)) * 0.6 * (1 - retract) : 0
          rayPos.setXYZ(i * 2, eye.x, eye.y, eye.z)
          rayPos.setXYZ(i * 2 + 1, ptX[i], hgt + 0.012, ptZ[i])
          rayCol.setW(i * 2, ra * 0.25)
          rayCol.setW(i * 2 + 1, ra)
        }
        stems.instanceMatrix.needsUpdate = true
        heads.instanceMatrix.needsUpdate = true
        marks.instanceMatrix.needsUpdate = true
        rayPos.needsUpdate = true
        rayCol.needsUpdate = true
        for (const s of spot) {
          const v = smoothstep(0.4, 1.2, R - s.d) * (1 - smoothstep(0.41, 0.44, local))
          s.mat.opacity = v
          s.mesh.visible = v > 0.003
        }
      }

      // ---- 04 SUPPORT: the route, its revision, the summit marker
      const a1 = segment(local, REV1[0], REV1[1])
      const a2 = segment(local, REV2[0], REV2[1])
      const routeLift = smoothstep(0.85, 1, lift)
      routeA.mesh.visible = a1 > 0 && routeLift > 0.001
      routeB.mesh.visible = a2 > 0 && routeLift > 0.001
      routeA.uniforms.uProgress.value = ease.inOutQuad(a1)
      routeB.uniforms.uProgress.value = ease.inOutQuad(a2)
      const superseded = smoothstep(0.1, 0.6, a2)
      routeA.uniforms.uColor.value.copy(signal).lerp(inkSoft, superseded)
      routeA.uniforms.uOpacity.value = routeLift * lerp(1, 0.55, superseded)
      routeB.uniforms.uOpacity.value = routeLift
      routeA.mesh.scale.y = routeB.mesh.scale.y = Math.max(0.001, lift)
      const pk = ease.outCubic(segment(local, PEAK[0], PEAK[1]))
      peak.setGrow(pk)
      peak.group.visible = pk > 0.001
      peak.group.position.y = peakH * lift

      // ---- post
      const post = ctx.post.params
      post.vignette = 0.16

      // ---- DOM
      reveal(head, window01(local, HEAD[0], HEAD[1], 0.03), 0)
      setRise(headline, local > HEAD[0] + 0.005 && local < HEAD[1] - 0.01)
      const cardV = window01(local, CARD[0], CARD[1], 0.018)
      reveal(cardEl, cardV, 0)
      let idx = 0
      while (idx < 3 && local >= STEP_AT[idx + 1]) idx++
      const cur = local > CARD[0] && local < CARD[1] ? idx : -1
      if (cur !== shown) {
        shown = cur
        stepEls.forEach((s, i) => s.classList.toggle('is-on', i === cur))
        segs.forEach((s, i) => {
          s.classList.toggle('is-on', i === cur)
          s.classList.toggle('is-done', cur >= 0 && i < cur)
        })
        if (cur >= 0) countEl.textContent = `Step ${String(cur + 1).padStart(2, '0')} / 04`
      }
      for (let i = 0; i < stepTitles.length; i++) setRise(stepTitles[i], i === cur && cardV > 0.05)
      for (let i = 0; i < 4; i++) {
        const ph = segment(local, STEP_AT[i], STEP_AT[i + 1] - 0.01)
        const f = local >= STEP_AT[i + 1] ? 1 : ease.outCubic(ph)
        const q = Math.round(f * 1000)
        if (fillCache[i] !== q) {
          fillCache[i] = q
          fills[i].style.transform = `scaleX(${(q / 1000).toFixed(3)})`
        }
      }
      // live marginalia on the card (decorative); the text is rebuilt only when it changes
      let n = 0
      if (idx === 0) {
        for (let i = 0; i < nPts; i++) if (R - ptD[i] > 0.3) n++
      } else if (idx === 2) {
        for (let k = 0; k < boards.length; k++) if (local >= DROP0 + k * DROP_STEP + DROP_LEN * 0.8) n++
      } else if (idx === 3) n = local >= STAMP_AT ? 2 : 1
      const metaKey = idx * 1000 + n
      if (metaKey !== metaText) {
        metaText = metaKey
        metaEl.textContent =
          idx === 0
            ? `Stn. A · ${String(n).padStart(3, '0')} pts`
            : idx === 1
              ? 'C.I. 20 m · draft'
              : idx === 2
                ? `Layer ${String(n).padStart(2, '0')} / ${String(boards.length).padStart(2, '0')}`
                : `Rev. ${n} · route`
      }
      const stampOn = cur === 3 && local >= STAMP_AT
      if (stampOn !== stampShown) {
        stampShown = stampOn
        stampEl.classList.toggle('is-on', stampOn)
      }
      reveal(statsEl, window01(local, TILES[0] - 0.01, TILES[1] + 0.005, 0.02), 0)
      const tilesOn = local > TILES[0] && local < TILES[1]
      if (tilesOn !== tilesShown) {
        tilesShown = tilesOn
        statsEl.classList.toggle('is-on', tilesOn)
      }
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const aspect = frame.width / Math.max(1, frame.height)
      const tall = aspect < 0.9
      const fov = tall ? 42 : 36
      sampleKeys(tall ? TALL : WIDE, local, aspect, fov, tall, band, fit, tmpPos, tmpTgt)
      // a slow drone drift (idle only)
      if (!frame.reducedMotion && !frame.still) {
        const t = frame.time
        tmpPos.x += Math.sin(t * 0.13) * 0.22
        tmpPos.z += Math.cos(t * 0.1) * 0.18
        tmpPos.y += Math.sin(t * 0.17) * 0.1
      }
      out.position.copy(tmpPos)
      out.target.copy(tmpTgt)
      out.fov = fov
      out.roll = 0
      out.parallax = frame.reducedMotion ? 0 : 0.28
    },
  }
}
