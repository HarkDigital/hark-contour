import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { clamp, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECURITY, SHEET, STATS } from '../../content'
import { C, chartMaterial, ensureFonts, mapLabel, marker, type ChartMaterial } from '../../kit/chart'
import { terrainGeometryAsync, heightRange, type HeightFn } from '../../kit/terrain'
import { FN, pressureAt, weatherMaterial, type Field, type WeatherUniforms } from './weather'
import { BOUNDS, SEA, SITE, makeLand } from './land'
import { radarDisc, type RadarUniforms } from './radar'
import './shield.css'

/*
 * PRESSURE — "Hacked? Breathe." A weather chart printed over a small stretch
 * of coast, with your site marked on the headland.
 *
 *   0.00–0.29  THREAT   a low deepens out at sea and spirals in toward the
 *                       site: isobars tighten, plum pressure tints step
 *                       darker, a cold front (triangles) and a warm front
 *                       (semicircles) draw themselves out of it and sweep
 *                       in; the paper greys toward a storm tint and the
 *                       land is pressed flat. Eyebrow + "Hacked?" from 0.06.
 *   0.30–0.58  BREATHE  "Breathe." + the body (the 0.45 landing): the
 *                       pressure equalizes — isobars relax into wide calm
 *                       curves, the fronts break up and fade, the L becomes
 *                       an H (fair weather), the plum drains back to paper
 *                       and ink, and the land breathes back up into relief
 *                       as the drone tilts from the chart view to oblique.
 *   0.58–0.95  STEADY   fair weather: range rings, bearing ticks and a slow
 *                       radar sweep around the site (24/7 watch; contours
 *                       it passes print vermilion); 24/7 + label + CTA
 *                       draw on as the body leaves (anchor 0.8). On tall
 *                       screens the chart fades back into the paper behind
 *                       "24/7" (the weather overprint's veil).
 *
 * Everything derives from `local`; frame.time only turns the sweep, drifts
 * the rings and slowly turns the storm (all off under reduced motion /
 * Motion off).
 */

const T = {
  build1: 0.29,
  fronts0: 0.05,
  fronts1: 0.24,
  breathe: 0.3,
  eq0: 0.31,
  eq1: 0.5,
  diss0: 0.31,
  diss1: 0.44,
  morph0: 0.33,
  morph1: 0.47,
  lift0: 0.34,
  lift1: 0.62,
  handoff: 0.58,
  watch0: 0.58,
  watch1: 0.7,
  out: 0.94,
}

const TRENDS = ['falling', 'rising', 'steady']
const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]
const TAU = Math.PI * 2

// storm track (site-relative): in from the open sea to the south, arcing west, hooking in at the site
const P0 = new THREE.Vector2(7, 15)
const P1 = new THREE.Vector2(-10, 10)
const P2 = new THREE.Vector2(-2.3, 2.5)
/** where the fair-weather high settles (north-west of the site, over the sound; clear of the copy on wide screens) */
const HIGH = new THREE.Vector2(-4.0, -2.5)
/** "The Sound" (site-relative): west of the headland on wide screens, south of it on tall ones */
const SOUND_WIDE = new THREE.Vector2(-7.4, -0.5)
const SOUND_TALL = new THREE.Vector2(-2.8, 6.9)

/** the fair-weather field the chapter settles into (the readout reports its high) */
const FAIR: Field = {
  low: new THREE.Vector4(0, 0, 0, 3),
  lowS: new THREE.Vector4(0, 3.4, 1, 0),
  high: new THREE.Vector4(SITE.x + HIGH.x, SITE.z + HIGH.y, 15, 6.2),
  field: new THREE.Vector4(0.16, 0.34, 1014, 1.1),
}
const P_HIGH = pressureAt(FAIR, SITE.x + HIGH.x, SITE.z + HIGH.y)

// ------------------------------------------------------------------ camera

interface Key {
  l: number
  yaw: number
  pitch: number
  dist: number
  fx: number
  fz: number
}
const KEYS: Key[] = [
  { l: 0.0, yaw: 0.44, pitch: 1.0, dist: 27, fx: 0.6, fz: 3.4 },
  { l: 0.14, yaw: 0.3, pitch: 1.12, dist: 25, fx: -0.2, fz: 2.4 },
  { l: 0.29, yaw: 0.16, pitch: 1.22, dist: 23, fx: -0.9, fz: 1.4 },
  { l: 0.45, yaw: 0.02, pitch: 1.14, dist: 23, fx: -1.3, fz: 0.0 },
  { l: 0.62, yaw: -0.28, pitch: 0.82, dist: 18, fx: -0.5, fz: -0.2 },
  { l: 0.8, yaw: -0.46, pitch: 0.7, dist: 16.2, fx: 0.0, fz: 0.0 },
  { l: 1.0, yaw: -0.66, pitch: 0.62, dist: 15.2, fx: 0.3, fz: -0.4 },
]
const CR = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}
function keyAt(l: number, out: Omit<Key, 'l'>) {
  let k = 0
  while (k < KEYS.length - 2 && l > KEYS[k + 1].l) k++
  const a = KEYS[Math.max(0, k - 1)]
  const b = KEYS[k]
  const c = KEYS[k + 1]
  const d = KEYS[Math.min(KEYS.length - 1, k + 2)]
  const t = clamp((l - b.l) / (c.l - b.l))
  out.yaw = CR(a.yaw, b.yaw, c.yaw, d.yaw, t)
  out.pitch = CR(a.pitch, b.pitch, c.pitch, d.pitch, t)
  out.dist = CR(a.dist, b.dist, c.dist, d.dist, t)
  out.fx = CR(a.fx, b.fx, c.fx, d.fx, t)
  out.fz = CR(a.fz, b.fz, c.fz, d.fz, t)
}

const _key = { yaw: 0, pitch: 0, dist: 0, fx: 0, fz: 0 }
const _dir = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _Y = new THREE.Vector3(0, 1, 0)

/** yaw of the current pose (labels and the letter turn with it to stay upright) */
let poseYaw = 0
/** the solved pose's half-extents (tan of the half fov, vertical and horizontal) */
let poseTanV = 1
let poseTanX = 1

function solvePose(l: number, frame: Frame, out: CameraPose) {
  keyAt(l, _key)
  const w = Math.max(1, frame.width)
  const h = Math.max(1, frame.height)
  const aspect = w / h
  const tall = h > w * 1.05
  const fov = tall ? 42 : 38
  // keep a similar stretch of chart across aspect ratios
  const scale = tall ? Math.pow(1.6 / aspect, 0.62) : Math.pow(Math.max(1, 1.6 / aspect), 0.8)
  const dist = _key.dist * scale
  const yaw = _key.yaw
  const pitch = _key.pitch
  poseYaw = yaw
  // where the focus sits on screen: right of the copy on landscape, above it on portrait
  // (portrait: in fair weather the site eases right so the high stays in frame)
  const ox = tall ? lerp(0.02, 0.22, smoothstep(0.4, 0.64, l)) : 0.27
  const oy = tall ? 0.36 : -0.02
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const tanX = tanV * aspect
  poseTanV = tanV
  poseTanX = tanX
  _dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  _fwd.copy(_dir).negate()
  _right.crossVectors(_fwd, _Y).normalize()
  _up.crossVectors(_right, _fwd)
  out.target
    .set(SITE.x + _key.fx, 0.3, SITE.z + _key.fz)
    .addScaledVector(_right, -ox * dist * tanX)
    .addScaledVector(_up, -oy * dist * tanV)
  out.position.copy(out.target).addScaledVector(_dir, dist)
  out.fov = fov
  out.roll = 0
  out.parallax = frame.reducedMotion || frame.still ? 0 : 0.22
  return dist
}

// ------------------------------------------------------------------ helpers

/** map lettering scale: ~1 on desktop, larger where a world unit covers fewer pixels */
function letterScale(frame: Frame) {
  const w = Math.max(1, frame.width)
  const h = Math.max(1, frame.height)
  const aspect = w / h
  const tall = h > w * 1.05
  const fov = tall ? 42 : 38
  const scale = tall ? Math.pow(1.6 / aspect, 0.62) : Math.pow(Math.max(1, 1.6 / aspect), 0.8)
  const visible = 2 * 23 * scale * Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect
  return clamp(46 / (w / visible), 1, 2.2)
}

const inOut = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t))

const _p = new THREE.Vector3()
/** NDC of the last projected point */
const _s = { x: 0, y: 0 }
/** project a world point under the pose solved last (camera at `cam`) into _s */
function project(cam: THREE.Vector3, x: number, y: number, z: number) {
  _p.set(x - cam.x, y - cam.y, z - cam.z)
  const d = Math.max(0.1, _p.dot(_fwd))
  _s.x = _p.dot(_right) / (d * poseTanX)
  _s.y = _p.dot(_up) / (d * poseTanV)
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** quadratic Bézier on the storm track */
function track(s: number, out: THREE.Vector2) {
  const u = 1 - s
  out.set(u * u * P0.x + 2 * u * s * P1.x + s * s * P2.x, u * u * P0.y + 2 * u * s * P1.y + s * s * P2.y)
  return out.set(out.x + SITE.x, out.y + SITE.z)
}

/** a front: FN points from the low, heading `a0`, bending by `bend` over `len` */
function frontLine(pts: THREE.Vector2[], cx: number, cz: number, a0: number, bend: number, len: number) {
  const step = len / (FN - 1)
  let x = cx
  let z = cz
  for (let i = 0; i < FN; i++) {
    pts[i].set(x, z)
    const a = a0 + bend * (i / (FN - 1))
    x += Math.cos(a) * step
    z += Math.sin(a) * step
  }
}

interface IsoLabel {
  level: number
  low: boolean
  /** ray angle from screen-down, radians (toward screen-right positive) */
  ray: number
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  w: number
}

// ------------------------------------------------------------------ chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  let height: HeightFn = () => 0
  let chart: ChartMaterial | null = null
  let wx: WeatherUniforms | null = null
  let site: ReturnType<typeof marker> | null = null
  let dial: RadarUniforms | null = null
  let dialMesh: THREE.Mesh | null = null
  const DIAL_R = 3.2
  let siteLabel: THREE.Mesh | null = null
  let siteLabelW = 1
  let soundLabel: THREE.Mesh | null = null
  let soundW = 1
  const isoLabels: IsoLabel[] = []
  const field: Field = {
    low: new THREE.Vector4(),
    lowS: new THREE.Vector4(),
    high: new THREE.Vector4(),
    field: new THREE.Vector4(),
  }
  const siteH = { v: 0 }

  /** the chart's surface at full lift: land as it stands, the sea floor sunk by SEA of its depth */
  const surf = (x: number, z: number) => {
    const h = height(x, z)
    return h > 0 ? h : h * SEA
  }

  /** the highest surface under a flat label (so relief never swallows its letters) */
  function groundTop(x: number, z: number, w: number, d: number, yaw: number) {
    const cy = Math.cos(yaw)
    const sy = Math.sin(yaw)
    const ax = (cy * w) / 2
    const az = (-sy * w) / 2
    const bx = (-sy * d) / 2
    const bz = (-cy * d) / 2
    let m = surf(x, z)
    m = Math.max(m, surf(x + ax + bx, z + az + bz), surf(x + ax - bx, z + az - bz))
    m = Math.max(m, surf(x - ax + bx, z - az + bz), surf(x - ax - bx, z - az - bz))
    m = Math.max(m, surf(x + ax, z + az), surf(x - ax, z - az))
    return m
  }

  // colours (storm variants lerped per frame, no allocation)
  const tintsBase = C.tints.map(c => new THREE.Color(c))
  const grey = new THREE.Color('#cdc4c6')
  const tintsStorm = tintsBase.map(c => c.clone().lerp(grey, 0.42))
  // nautical convention: shallow water blue, deep water left as paper
  const waterBase = new THREE.Color('#bcd6de')
  const waterStorm = new THREE.Color('#bdc0cf')
  const deepBase = new THREE.Color('#eeebe0')
  const deepStorm = new THREE.Color('#d7cdce')
  const paperStorm = new THREE.Color('#d9cfcf')
  const skyStorm = new THREE.Color('#cdc2c6')
  const paperBase = new THREE.Color(C.paper)
  const skyBase = new THREE.Color('#ebe3d1')
  const plum = new THREE.Color(C.storm)
  const inkSoft = new THREE.Color('#6f6259')
  const alarm = new THREE.Color(C.alarm)
  const fair = new THREE.Color(C.coast)
  const tmpC = new THREE.Color()
  const tmpD = new THREE.Color()
  const v2 = new THREE.Vector2()
  const lowC = new THREE.Vector2()

  // DOM
  let copyA: HTMLElement
  let eyebrow: HTMLElement
  let titleA: HTMLElement
  let line1: HTMLElement
  let line2: HTMLElement
  let panelA: HTMLElement
  let copyB: HTMLElement
  let stat: HTMLElement
  let panelB: HTMLElement
  let legend: HTMLElement
  let readP: HTMLElement
  let readT: HTMLElement
  let readK: HTMLElement
  let lastRead = -1

  // the copy's layout boxes in CSS px (re-measured after a resize or a font load): the veil
  // sits behind "24/7" on tall screens, and "The Sound" keeps clear of the copy on screen
  const veilPx: Box = { x0: 0, y0: 0, x1: 0, y1: 0 }
  /** eyebrow + heading, the body panel, the steady copy */
  const rects: Box[] = [0, 1, 2].map(() => ({ x0: 0, y0: 0, x1: 0, y1: 0 }))
  const rectW = [0, 0, 0]
  let layDirty = true
  const boxOf = (b: Box, x: number, y: number, w: number, h: number) => {
    b.x0 = x
    b.y0 = y
    b.x1 = x + w
    b.y1 = y + h
  }
  function measureLayout() {
    layDirty = false
    const ax = copyA.offsetLeft
    const ay = copyA.offsetTop
    const headW = Math.max(eyebrow.offsetLeft + eyebrow.offsetWidth, titleA.offsetLeft + titleA.offsetWidth)
    boxOf(rects[0], ax, ay, headW, titleA.offsetTop + titleA.offsetHeight)
    boxOf(rects[1], ax + panelA.offsetLeft, ay + panelA.offsetTop, panelA.offsetWidth, panelA.offsetHeight)
    boxOf(rects[2], copyB.offsetLeft, copyB.offsetTop, copyB.offsetWidth, copyB.offsetHeight)
    boxOf(veilPx, copyB.offsetLeft + stat.offsetLeft, copyB.offsetTop + stat.offsetTop, stat.offsetWidth, stat.offsetHeight)
  }

  // "The Sound": its screen box (CSS px) for a baseline centre (x, y, z)
  const lb: Box = { x0: 0, y0: 0, x1: 0, y1: 0 }
  const lbl = { ex: 1, ez: 0, ux: 0, uz: -1, half: 1, hh: 0.5 }
  function labelBox(cam: THREE.Vector3, x: number, y: number, z: number, W: number, H: number) {
    lb.x0 = lb.y0 = Infinity
    lb.x1 = lb.y1 = -Infinity
    for (let i = 0; i < 4; i++) {
      const sa = i & 1 ? 1 : -1
      const sb = i & 2 ? 1 : -1
      project(cam, x + lbl.ex * lbl.half * sa + lbl.ux * lbl.hh * sb, y, z + lbl.ez * lbl.half * sa + lbl.uz * lbl.hh * sb)
      const px = ((_s.x + 1) / 2) * W
      const py = ((1 - _s.y) / 2) * H
      lb.x0 = Math.min(lb.x0, px)
      lb.x1 = Math.max(lb.x1, px)
      lb.y0 = Math.min(lb.y0, py)
      lb.y1 = Math.max(lb.y1, py)
    }
  }

  const scratch: CameraPose = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 40, roll: 0, parallax: 0 }

  function legendRow(parent: HTMLElement, svg: string, text: string) {
    const li = el('li', 'sh-key', undefined, parent)
    const k = el('span', 'sh-key-sym', undefined, li)
    k.innerHTML = svg
    el('span', 'sh-key-txt', text, li)
  }

  return {
    id: 'shield',
    group,
    anchors: [0.8],

    async init(ctx: ChapterContext) {
      const stage = ctx.stage
      const mobile = ctx.mobile

      // ---------------- DOM (visual layer; the accessible copy lives in srContent)
      copyA = el('div', 'sh-a', undefined, stage)
      eyebrow = el('p', 'hud-eyebrow sh-eyebrow', SECURITY.eyebrow, copyA)
      const h = el('h2', 'hud-title sh-title', undefined, copyA)
      titleA = h
      line1 = rise(el('span', 'sh-line', undefined, h), 'Hacked?')
      line2 = rise(el('span', 'sh-line', undefined, h), '<em>Breathe.</em>')
      panelA = el('div', 'hud-panel sh-panel', undefined, copyA)
      el('p', 'hud-body', SECURITY.body, panelA)

      copyB = el('div', 'sh-b', undefined, stage)
      stat = rise(el('p', 'hud-title sh-stat', undefined, copyB), STAT.value)
      panelB = el('div', 'hud-panel sh-panel sh-panel-b', undefined, copyB)
      el('p', 'hud-body', STAT.label, panelB)
      const cta = el('a', 'hud-btn sh-cta', SECURITY.cta, panelB)
      cta.href = SECURITY.href

      // the chart's legend (decorative marginalia)
      legend = el('div', 'hud-panel hud-panel--quiet sh-legend', undefined, stage)
      legend.setAttribute('aria-hidden', 'true')
      el('p', 'hud-label sh-legend-title', SHEET.name(5, 'Pressure'), legend)
      el('p', 'sh-legend-sub', 'Surface analysis', legend)
      const ul = el('ul', 'sh-keys', undefined, legend)
      legendRow(
        ul,
        '<svg viewBox="0 0 44 14"><path d="M1 11H43" stroke="#4a3566" stroke-width="2"/><path d="M6 11l5-8 5 8zM22 11l5-8 5 8z" fill="#4a3566"/></svg>',
        'Cold front',
      )
      legendRow(
        ul,
        '<svg viewBox="0 0 44 14"><path d="M1 11H43" stroke="#b3241c" stroke-width="2"/><path d="M6 11a5 5 0 0 1 10 0zM22 11a5 5 0 0 1 10 0z" fill="#b3241c"/></svg>',
        'Warm front',
      )
      legendRow(
        ul,
        '<svg viewBox="0 0 44 14"><path d="M1 9C12 3 30 13 43 6" fill="none" stroke="#4a3566" stroke-width="1.3"/></svg>',
        'Isobar · 4 hPa',
      )
      legendRow(
        ul,
        '<svg viewBox="0 0 44 14"><circle cx="22" cy="7" r="5" fill="none" stroke="#d2462a" stroke-width="2"/><circle cx="22" cy="7" r="1.6" fill="#d2462a"/></svg>',
        'Your site',
      )
      legendRow(
        ul,
        '<svg viewBox="0 0 44 14"><path d="M22 7L36 1.5A15 15 0 0 1 36 12.5Z" fill="#d2462a" fill-opacity=".22"/><path d="M22 7L36 1.5" stroke="#d2462a" stroke-width="1.4"/><circle cx="22" cy="7" r="1.6" fill="#d2462a"/></svg>',
        'Watch · 24/7',
      )
      const rd = el('p', 'hud-coord sh-readout', undefined, legend)
      readK = el('span', 'sh-read-k', 'Low', rd)
      rd.append(' · ')
      readP = el('b', 'sh-read-p', '1004', rd)
      rd.append(' hPa · ')
      readT = el('span', 'sh-read-t', 'falling', rd)

      reveal(copyA, 0)
      reveal(copyB, 0)
      reveal(legend, 0, 0)

      const dirty = () => (layDirty = true)
      window.addEventListener('resize', dirty)
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(dirty)
        ro.observe(copyA)
        ro.observe(copyB)
        ro.observe(stat)
      }
      document.fonts?.ready.then(dirty)

      // ---------------- the land
      height = makeLand(23)
      const geo = await terrainGeometryAsync({
        width: BOUNDS.width,
        depth: BOUNDS.depth,
        cx: BOUNDS.cx,
        cz: BOUNDS.cz,
        seg: mobile ? 130 : 200,
        detail: mobile ? 2 : 3,
        height,
      })
      const { hMax } = heightRange(geo)
      await nextFrame()
      chart = chartMaterial(ctx.world, {
        terrain: geo,
        hMin: 0,
        hMax,
        interval: 0.2,
        waterSpacing: 0.12,
        waterLines: 6,
        stepped: 0.75,
        grid: 0.3,
        gridSize: 4,
        lift: 0.3,
        // the sea stays nearly level as the land rises (water lettering and the H sit on it)
        seaLift: SEA,
        edge: 7,
      })
      chart.uniforms.uWaterDeep.value.copy(deepBase)
      const land = new THREE.Mesh(geo, chart)
      group.add(land)

      // the weather overprint: the same mesh, drawn again
      const w = weatherMaterial(ctx.world, chart)
      wx = w.u
      const over = new THREE.Mesh(geo, w.mat)
      over.renderOrder = 1
      group.add(over)
      siteH.v = height(SITE.x, SITE.z)

      // ---------------- your site
      site = marker({ color: C.signal, height: 1.1, radius: 0.24 })
      group.add(site.group)
      // the marker prints over the dial
      site.group.traverse(o => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.renderOrder = 4
        const mm = m.material as THREE.MeshBasicMaterial
        mm.transparent = true
        mm.depthWrite = false
      })
      const disc = radarDisc(DIAL_R, ctx.world.chart.uDpr)
      dial = disc.u
      dialMesh = disc.mesh
      group.add(disc.mesh)

      await ensureFonts()
      await nextFrame()
      siteLabel = mapLabel('Your site', { font: 'sans', size: 44, weight: 700, color: C.ink, tracking: 0.22, uppercase: true, height: 0.5, flat: true, haloWidth: 0.3 })
      siteLabelW = (siteLabel.geometry as THREE.PlaneGeometry).parameters.width
      siteLabel.renderOrder = 3
      group.add(siteLabel)
      soundLabel = mapLabel('The Sound', { font: 'display', size: 56, italic: true, color: C.coast, tracking: 0.16, height: 0.95, flat: true, halo: null })
      soundW = (soundLabel.geometry as THREE.PlaneGeometry).parameters.width
      group.add(soundLabel)
      // isobar numbers along two rays (low: toward the sound; high: below the H)
      const specs: [number, boolean, number][] = [
        [1004, true, -0.7],
        [996, true, -0.7],
        [988, true, -0.7],
        [980, true, -0.7],
        [1024, false, 0.35],
        [1020, false, 0.35],
      ]
      for (const [level, low, ray] of specs) {
        const mesh = mapLabel(String(level), {
          font: 'mono',
          size: 40,
          weight: 500,
          color: low ? C.storm : '#5b5047',
          halo: C.paper,
          haloWidth: 0.34,
          height: 0.5,
          flat: true,
        })
        const mat = mesh.material as THREE.MeshBasicMaterial
        mat.opacity = 0
        group.add(mesh)
        isoLabels.push({ level, low, ray, mesh, mat, w: (mesh.geometry as THREE.PlaneGeometry).parameters.width })
      }
    },

    update(l: number, frame: Frame, ctx: ChapterContext) {
      const calm = ctx.reducedMotion || !!frame.still
      const time = calm ? 0 : frame.time
      const wp = ctx.world.params
      const pp = ctx.post.params

      // ---------------- phases
      const sb = segment(l, 0.0, T.build1)
      const s = 1 - (1 - sb) * (1 - sb) * (1 - 0.35 * sb)
      const eq = inOut(segment(l, T.eq0, T.eq1))
      const storm = smoothstep(0.02, 0.26, l) * (1 - smoothstep(T.eq0, 0.52, l))
      const wash = smoothstep(0.03, 0.22, l) * (1 - smoothstep(T.eq0, 0.5, l))
      const morph = inOut(segment(l, T.morph0, T.morph1))
      const diss = segment(l, T.diss0, T.diss1)
      const rise01 = inOut(segment(l, T.lift0, T.lift1))
      const watch = smoothstep(T.watch0, T.watch1, l)
      const lift = lerp(lerp(0.3, 0.06, s), 1, rise01)
      const W = Math.max(1, frame.width)
      const H = Math.max(1, frame.height)
      const tall = H > W * 1.05
      // the copy handoff: the steady copy draws on as the body leaves (no copy-less stretch)
      const inA = smoothstep(0.055, 0.075, l) * (1 - smoothstep(T.handoff - 0.022, T.handoff - 0.002, l))
      const inB = smoothstep(T.handoff - 0.012, T.handoff + 0.008, l) * (1 - smoothstep(T.out, T.out + 0.02, l))

      // camera (solved here too so labels and the letter can turn with it)
      const camDist = solvePose(l, frame, scratch)
      const yaw = poseYaw
      const cy = Math.cos(yaw)
      const sy = Math.sin(yaw)
      // lettering keeps a legible size where the camera stands further off (phones, tablets)
      const ls = letterScale(frame)
      // screen axes on the ground
      const rx = cy
      const rz = -sy
      const dx = sy
      const dz = cy

      // ---------------- world: the paper greys toward the storm and back
      wp.paper = tmpC.copy(paperBase).lerp(paperStorm, storm)
      wp.sky = tmpD.copy(skyBase).lerp(skyStorm, storm)
      wp.fogNear = camDist * 1.05
      wp.fogFar = camDist * 2.6
      pp.vignette = 0.16 + 0.22 * storm
      pp.bloomStrength = 0
      pp.glitch = 0

      // ---------------- the chart
      if (chart) {
        const u = chart.uniforms
        u.uLift.value = lift
        u.uRipple.value = calm ? 0 : 0.08
        for (let i = 0; i < tintsBase.length; i++) u.uTints.value[i].copy(tintsBase[i]).lerp(tintsStorm[i], storm)
        u.uWaterC.value.copy(waterBase).lerp(waterStorm, storm)
        u.uWaterDeep.value.copy(deepBase).lerp(deepStorm, storm)
        u.uGrid.value = lerp(0.22, 0.38, storm) * (1 - 0.5 * rise01)
      }

      // ---------------- the pressure field
      track(s, lowC)
      // equalizing, the system drifts off over the sound and turns into the high
      const travel = inOut(segment(l, T.eq0, T.eq1 + 0.05))
      lowC.x = lerp(lowC.x, SITE.x + HIGH.x, travel)
      lowC.y = lerp(lowC.y, SITE.z + HIGH.y, travel)
      const ampL = lerp(12, 56, s) * (1 - eq * eq * 0.3 - eq * 0.7)
      const sigL = lerp(4.6, 2.6, s) + eq * 3
      field.low.set(lowC.x, lowC.y, ampL, sigL)
      field.lowS.set(lerp(0.8, 3.8, s) * (1 - eq), 3.4, lerp(1.25, 1.7, s) * (1 - eq) + eq, -0.4 + time * 0.035)
      const ampH = 15 * inOut(segment(l, 0.34, 0.6))
      field.high.set(lowC.x, lowC.y, ampH, 6.2)
      // gradient + wave: organic in the storm, gentle and even in fair weather
      field.field.set(lerp(0.34, 0.16, eq), lerp(-0.22, 0.34, eq), 1014, lerp(2.6, 1.1, eq))

      if (wx) {
        const u = wx
        u.uLow.value.copy(field.low)
        u.uLowS.value.copy(field.lowS)
        u.uHigh.value.copy(field.high)
        u.uField.value.copy(field.field)
        u.uWash.value = wash
        u.uIso.value = lerp(1, 0.62, eq)
        const pCentre = pressureAt(field, lowC.x, lowC.y)
        u.uRedBelow.value = storm > 0.02 ? pCentre + 0.62 * ampL : 0
        u.uIsoC.value.copy(plum).lerp(inkSoft, eq)

        // fronts: out of the low, sweeping round with it
        const phi = lerp(-0.75, -0.15, s) + eq * 0.4
        frontLine(u.uWarm.value, lowC.x, lowC.y, phi, 0.35, 8.5)
        frontLine(u.uCold.value, lowC.x, lowC.y, phi + 1.75, 0.75, 10.5)
        const fr = segment(l, T.fronts0, T.fronts1)
        // the gate closes once the fronts have dissolved: the shader then skips both polyline searches
        const frontsOn = diss >= 0.999 ? 0 : smoothstep(T.fronts0 - 0.01, T.fronts0 + 0.02, l)
        u.uFront.value.set(inOut(fr), inOut(segment(l, T.fronts0 + 0.03, T.fronts1 + 0.02)), diss, frontsOn)

        // the letter: L at the low → H at the high, turning with the view to stay upright
        const lx = lowC.x
        const lz = lowC.y
        const scale = lerp(0.8, 1.25, s) * (1 - 0.1 * morph)
        u.uLetter.value.set(lx, lz, scale, yaw)
        u.uLetterK.value.set(morph, smoothstep(0.03, 0.12, l), 0, 0)
        u.uLetterC.value.copy(alarm).lerp(fair, morph)
        u.uKnock.value.set(lx, lz, scale * 1.45, smoothstep(0.03, 0.12, l))

        // the watch
        const sweep = (time * TAU) / 7
        u.uRadar.value.set(SITE.x, SITE.z, sweep, watch * (1 - smoothstep(0.97, 1, l)))
        u.uRadarK.value.set(0.85, DIAL_R, calm ? 0 : 1, 0)
        if (dial && dialMesh) {
          dial.uCentre.value.set(SITE.x, SITE.z)
          dial.uSweep.value.set(sweep, watch * (1 - smoothstep(0.97, 1, l)))
          dial.uK.value.set(0.8, DIAL_R, calm ? 0 : 1, calm ? 0 : time * 0.1)
          dialMesh.visible = watch > 0.001
          dialMesh.position.set(SITE.x, siteH.v * lift + 0.03, SITE.z)
        }

        // isobar numbers: find where each labelled isobar crosses its ray
        for (let i = 0; i < isoLabels.length; i++) {
          const L = isoLabels[i]
          const g = u.uGap.value[i]
          const cx = L.low ? lowC.x : field.high.x
          const cz = L.low ? lowC.y : field.high.y
          const ca = Math.cos(L.ray)
          const sa = Math.sin(L.ray)
          const ux = dx * ca + rx * sa
          const uz = dz * ca + rz * sa
          let found = -1
          let prev = pressureAt(field, cx + ux * 0.4, cz + uz * 0.4) - L.level
          for (let r = 0.6; r <= 13; r += 0.2) {
            const cur = pressureAt(field, cx + ux * r, cz + uz * r) - L.level
            if ((L.low && prev < 0 && cur >= 0) || (!L.low && prev > 0 && cur <= 0)) {
              let a = r - 0.2
              let b = r
              for (let k = 0; k < 6; k++) {
                const m = (a + b) / 2
                const pm = pressureAt(field, cx + ux * m, cz + uz * m) - L.level
                if ((L.low && pm < 0) || (!L.low && pm > 0)) a = m
                else b = m
              }
              found = (a + b) / 2
              break
            }
            prev = cur
          }
          // (tall screens letter the high's inner isobar only: the outer one would crowd the water name)
          const sys = L.low ? wash * (1 - diss) : tall && L.level === 1020 ? 0 : smoothstep(0.46, 0.6, l) * (1 - smoothstep(0.97, 1, l))
          const knockR = scale * 1.6
          let vis = found > 0 ? sys * smoothstep(knockR * (L.low ? 1 : 0.9), knockR * (L.low ? 1 : 0.9) + 0.4, found) * (1 - smoothstep(9, 11, found)) : 0
          if (!L.low && found > 0) vis *= 1
          const x = cx + ux * Math.max(found, 0)
          const z = cz + uz * Math.max(found, 0)
          L.mesh.visible = vis > 0.01
          L.mat.opacity = vis
          L.mesh.position.set(x, groundTop(x, z, L.w * ls, 0.5 * ls, yaw) * lift + 0.04, z)
          L.mesh.rotation.set(-Math.PI / 2, 0, yaw)
          L.mesh.scale.setScalar(ls)
          g.set(x, z, (L.w * 0.5 + 0.08) * ls, vis > 0.01 ? Math.min(1, vis * 1.5) : 0)
        }

        // the central-pressure readout follows the letter: the low's centre as
        // it deepens and fills, crossing 1013 hPa just as the L turns into an
        // H, then the high it settles into; the key comes from the value
        // (only touch the DOM when it changes)
        const pc = morph < 0.5 ? lerp(pCentre, 1012, morph * 2) : lerp(1014, P_HIGH, (morph - 0.5) * 2)
        const pr = Math.round(pc)
        const high = pr >= 1013
        const tr = l < T.breathe ? 0 : l < T.morph1 ? 1 : 2
        const key = (high ? 2 : 1) * 100000 + tr * 10000 + pr
        if (key !== lastRead) {
          lastRead = key
          readK.textContent = high ? 'High' : 'Low'
          readP.textContent = String(pr)
          readT.textContent = TRENDS[tr]
        }

        // the veil: on tall screens the chart fades back into the paper behind "24/7"
        const vk = tall ? 0.88 * inB : 0
        if (vk > 0.001) {
          if (layDirty) measureLayout()
          const pad = 6
          const fea = clamp(0.06 * Math.min(W, H), 22, 56)
          u.uVeil.value.set(
            ((veilPx.x0 - pad) / W) * 2 - 1,
            1 - ((veilPx.y1 + pad) / H) * 2,
            ((veilPx.x1 + pad) / W) * 2 - 1,
            1 - ((veilPx.y0 - pad) / H) * 2,
          )
          u.uVeilK.value.set(vk, (2 * fea) / W, (2 * fea) / H, 0)
        } else u.uVeilK.value.x = 0
      }

      // ---------------- your site
      if (site) {
        site.setGrow(smoothstep(0.02, 0.12, l))
        site.group.position.set(SITE.x, siteH.v * lift + 0.03, SITE.z)
        site.group.scale.setScalar(ls)
      }
      if (siteLabel) {
        const off = (0.42 + siteLabelW / 2) * ls
        const x = SITE.x + rx * off - dx * 0.05
        const z = SITE.z + rz * off - dz * 0.05
        siteLabel.position.set(x, groundTop(x, z, siteLabelW * ls, 0.5 * ls, yaw) * lift + 0.05, z)
        siteLabel.rotation.set(-Math.PI / 2, 0, yaw)
        siteLabel.scale.setScalar(ls)
        ;(siteLabel.material as THREE.MeshBasicMaterial).opacity = smoothstep(0.05, 0.13, l)
      }
      if (soundLabel) {
        // water lettering: laid on the (nearly level) sea, clear of the floor across its whole
        // footprint; nudged off the copy (below it on wide screens, above it on tall ones), then
        // slid along its baseline to stay inside the frame
        const sc = Math.min(ls, 1.3)
        const a = yaw + 0.25
        lbl.ex = Math.cos(a)
        lbl.ez = -Math.sin(a)
        lbl.ux = -Math.sin(a)
        lbl.uz = -Math.cos(a)
        lbl.half = soundW * sc * 0.5
        lbl.hh = 0.95 * sc * 0.5
        const gut = clamp(0.034 * W, 16, 48) + 10
        const lim = 1 - (2 * gut) / W
        const cam = scratch.position
        const anchor = tall ? SOUND_TALL : SOUND_WIDE
        let x = SITE.x + anchor.x
        let z = SITE.z + anchor.y
        let y = groundTop(x, z, soundW * sc, 0.95 * sc, a) * lift + 0.04
        if (layDirty) measureLayout()
        rectW[0] = inA
        rectW[1] = inA * smoothstep(T.breathe, T.breathe + 0.03, l)
        rectW[2] = inB
        const M = 14
        for (let k = 0; k < 3; k++) {
          const R = rects[k]
          if (rectW[k] < 0.001) continue
          labelBox(cam, x, y, z, W, H)
          // how far the label reaches into the box across the push (eased, so the nudge never jumps)
          const ox = Math.min(lb.x1 - (R.x0 - M), R.x1 + M - lb.x0)
          const oy = tall ? R.y1 + M - lb.y0 : lb.y1 - (R.y0 - M)
          const push = tall ? R.y0 - M - lb.y1 : R.y1 + M - lb.y0
          if (ox <= 0 || oy <= 0 || (tall ? push >= 0 : push <= 0)) continue
          // px down the screen per world unit along the ground's screen-down axis
          project(cam, x, y, z)
          const y0 = _s.y
          project(cam, x + dx, y, z + dz)
          const jy = ((y0 - _s.y) * H) / 2
          if (jy < 1e-3) continue
          const d = (push * rectW[k] * smoothstep(0, 48, ox) * smoothstep(0, 32, oy)) / jy
          x += dx * d
          z += dz * d
          y = groundTop(x, z, soundW * sc, 0.95 * sc, a) * lift + 0.04
        }
        for (let it = 0; it < 3; it++) {
          project(cam, x - lbl.ex * lbl.half, y, z - lbl.ez * lbl.half)
          const xl = _s.x
          project(cam, x + lbl.ex * lbl.half, y, z + lbl.ez * lbl.half)
          const xr = _s.x
          const shift = xl < -lim ? -lim - xl : xr > lim ? lim - xr : 0
          if (shift === 0) break
          project(cam, x, y, z)
          const c0 = _s.x
          project(cam, x + lbl.ex, y, z + lbl.ez)
          const j = _s.x - c0
          if (Math.abs(j) < 1e-4) break
          x += (lbl.ex * shift) / j
          z += (lbl.ez * shift) / j
          y = groundTop(x, z, soundW * sc, 0.95 * sc, a) * lift + 0.04
        }
        soundLabel.position.set(x, y, z)
        soundLabel.rotation.set(-Math.PI / 2, 0, a)
        soundLabel.scale.setScalar(sc)
        // south of the headland the storm passes right over the name: it prints back in as the weather clears
        const so = tall ? smoothstep(0.34, 0.44, l) : 1
        ;(soundLabel.material as THREE.MeshBasicMaterial).opacity = so
        soundLabel.visible = so > 0.01
        // the isobars break around the name, like any lettering on the chart
        if (wx) {
          const nr = 0.4 * sc
          const nh = Math.max(0, lbl.half - nr * 0.6)
          wx.uName.value.set(x - lbl.ex * nh, z - lbl.ez * nh, x + lbl.ex * nh, z + lbl.ez * nh)
          wx.uNameK.value.set(nr, so)
        }
      }

      // ---------------- DOM
      reveal(copyA, inA)
      reveal(eyebrow, 1, 0)
      setRise(line1, l > 0.058 && l < T.handoff - 0.014)
      setRise(line2, l > T.breathe && l < T.handoff - 0.014)
      reveal(panelA, smoothstep(T.breathe, T.breathe + 0.03, l), 0)
      reveal(copyB, inB)
      setRise(stat, l > T.handoff - 0.01 && l < T.out + 0.01)
      reveal(panelB, smoothstep(T.handoff - 0.004, T.handoff + 0.02, l), 0)
      reveal(legend, smoothstep(0.06, 0.1, l) * (1 - smoothstep(T.out, T.out + 0.02, l)), 0)
    },

    camera(l: number, frame: Frame, out: CameraPose) {
      solvePose(l, frame, out)
    },
  }
}
