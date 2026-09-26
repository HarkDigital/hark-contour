import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, damp, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SERVICES } from '../../content'
import { C, chartMaterial, labelTexture, ensureFonts, type ChartMaterial } from '../../kit/chart'
import { terrainGeometryAsync, drape } from '../../kit/terrain'
import { buildRange, INTERVAL, type Range } from './range'
import { Annotations, type Box, type PinLayout } from './annot'
import { Hud, type HudMetrics } from './hud'
import { traverse, type Traverse } from './traverse'
import './services.css'

/*
 * SERVICES — "Summits".
 *
 * The studio's eleven services are eleven summits on one ridgeline, printed
 * as a topographic chart (layer tints sand → umber → rock → snow, 100 m
 * contours, index every 500 m) standing in relief over a sound whose
 * water-lining rings drift out from the shore. Every summit carries a
 * vermilion survey benchmark, a hairline leader and its name, lettered
 * like a panorama board.
 *
 *   0.00–0.08  in: the flat printed sheet, seen from straight above, lifts
 *              into relief as the drone tilts down into a wide oblique of
 *              the whole range; the names are lettered in, west to east.
 *              "Eleven ways to be heard." (settled at 0.06 and 0.08)
 *   0.08–0.92  eleven summits (~0.076 each): the drone glides along the
 *              range to the summit in view — its contours turn vermilion,
 *              its benchmark swells, its leader grows and a legend-key sign
 *              with the service's map symbol rises on it; a dashed survey
 *              traverse draws itself along the crest behind the drone
 *   0.92–1.00  out: the drone climbs back to the vertical and the relief
 *              settles flat onto the sheet again
 *
 * Everything that moves the view derives from `local`; frame.time only
 * drives a very slow idle drift. The benchmark/sign growth, the contour
 * highlight, decluttering and the lettering ease toward scroll-decided
 * targets (time-damped, never faster than ~2/s), so a fast scrub can't
 * strobe.
 */

const N = SERVICES.length
const A = 0.08
const B = 0.92
const SPAN = (B - A) / N
/** half-width (in beats) of each glide, centred on the boundary between two summits */
const TURN = 0.32
const ANCHORS = Array.from({ length: N }, (_, i) => A + SPAN * (i + 0.55))
const INTRO_IN = 0.032
const INTRO_OUT = 0.087
const CARD_IN = 0.095
const CARD_OUT = 0.918

/** a long, front-loaded glide with a soft start and a settled finish */
const glide = (t: number) => {
  const x = Math.pow(clamp(t), 0.8)
  return x * x * (3 - 2 * x)
}

/** Continuous summit index (0..N-1): holds mid-beat, glides across the boundaries. */
function summitAt(local: number) {
  const u = (local - A) / SPAN
  let f = 0
  for (let j = 1; j < N; j++) f += glide((u - (j - TURN)) / (2 * TURN))
  return f
}

/** Catmull-Rom between b and c */
const cr = (a: number, b: number, c: number, d: number, t: number) =>
  0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t)

interface Pose {
  pos: THREE.Vector3
  target: THREE.Vector3
}
const newPose = (): Pose => ({
  pos: new THREE.Vector3(),
  target: new THREE.Vector3(),
})

export default function create(): Chapter {
  const group = new THREE.Group()
  let range: Range
  let mat: ChartMaterial
  let annot: Annotations
  let hud: Hud
  let route: Traverse
  const rivers: Traverse[] = []
  let sound: THREE.Mesh
  const soundings: THREE.Mesh[] = []
  let renderer: THREE.WebGLRenderer
  let mobile = false
  let active = false
  let canvas: HTMLCanvasElement | null = null
  let lastLocal = 0

  // eased, time-damped state (converges to what `local` decides)
  const grow = new Float32Array(N)
  const routeAt = new Float32Array(N)
  const textA = new Float32Array(N)
  const textT = new Float32Array(N)
  let letter = 0
  let hiIdx = -1
  let hiAmt = 0
  let calm = 1
  let first = true

  // camera
  const pose = newPose()
  const pA = newPose()
  const pB = newPose()
  let fov = 32
  const probe = new THREE.PerspectiveCamera()
  const pv = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const fwd = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const right = new THREE.Vector3()
  const camUp = new THREE.Vector3()
  const center = new THREE.Vector3()
  const pts: THREE.Vector3[] = Array.from({ length: 48 }, () => new THREE.Vector3())
  let npts = 0
  const q = new THREE.Vector3()

  // lettering layout scratch (no per-frame allocation)
  const scr = Array.from({ length: N }, () => ({ x: 0, y: 0, ok: false }))
  const lays: PinLayout[] = Array.from({ length: N }, () => ({
    ok: false,
    g: 0,
    lead: 0,
    tri: 0,
    sign: 0,
    reveal: 0,
    alpha: 0,
    textAlpha: 0,
    full: true,
    side: 1,
    nudge: 0,
    align: 0.5,
    elev: 1,
  }))
  /** each idle name's chosen alignment (placement candidate) and its eased value */
  const alignT = new Float32Array(N).fill(0.5)
  const alignA = new Float32Array(N).fill(0.5)
  const boxes: Box[] = Array.from({ length: N }, () => ({
    x0: 0,
    x1: 0,
    y0: 0,
    y1: 0,
  }))
  const placed: Box[] = Array.from({ length: N }, () => ({
    x0: 0,
    x1: 0,
    y0: 0,
    y1: 0,
  }))
  const order = new Int32Array(N)
  const cands = new Float32Array(4)

  // the wide view's panorama board: its row pitch (and whether the
  // elevations, or even the names, fit) comes from the SETTLED wide view,
  // once per viewport, so it is the same at any jumped-to local and never
  // changes mid-intro
  const pW = newPose()
  const board = {
    W: 0,
    H: 0,
    top: 0,
    introTop: 0,
    introRight: 0,
    gutter: 0,
    valid: false,
    lettering: -1,
    pitch: 38,
    elev: true,
    names: true,
  }
  /** the settled wide view's summit points (CSS px) and a rehearsal layout */
  const boardX = new Float32Array(N)
  const boardY = new Float32Array(N)
  const boardIn = new Uint8Array(N)
  const rehearse: PinLayout = {
    ok: true,
    g: 0,
    lead: 0,
    tri: 10,
    sign: 0,
    reveal: 1,
    alpha: 1,
    textAlpha: 1,
    full: true,
    side: 1,
    nudge: 0,
    align: 0.5,
    elev: 1,
  }
  const rehearseBox: Box = { x0: 0, x1: 0, y0: 0, y1: 0 }
  const MARGIN = 14

  /** Catmull-Rom through the summit tops, at continuous index f */
  function summitPoint(f: number, out: THREE.Vector3) {
    const s = range.summits
    const i = Math.max(0, Math.min(N - 2, Math.floor(f)))
    const t = clamp(f - i)
    const p0 = s[Math.max(0, i - 1)]
    const p1 = s[i]
    const p2 = s[i + 1]
    const p3 = s[Math.min(N - 1, i + 2)]
    out.set(cr(p0.x, p1.x, p2.x, p3.x, t), cr(p0.h, p1.h, p2.h, p3.h, t), cr(p0.z, p1.z, p2.z, p3.z, t))
    return out
  }

  /** place the camera around `c` (heading, pitch, distance), aimed so `c` lands at NDC (ax, ay) */
  function aim(out: Pose, c: THREE.Vector3, heading: number, pitch: number, d: number, ax: number, ay: number, tv: number, th: number) {
    fwd.set(Math.sin(heading), 0, -Math.cos(heading))
    out.pos.copy(c).addScaledVector(fwd, -d * Math.cos(pitch))
    out.pos.y += d * Math.sin(pitch)
    dir.copy(c).sub(out.pos).normalize()
    right.crossVectors(dir, up).normalize()
    camUp.crossVectors(right, dir)
    out.target
      .copy(c)
      .addScaledVector(right, -ax * th * d)
      .addScaledVector(camUp, -ay * tv * d)
  }

  /**
   * Fit pts[0..npts) into the NDC rect (cx, cy, hw, hh) from the given
   * heading/pitch: iterate distance + aim offset against a probe camera.
   */
  function fit(out: Pose, heading: number, pitch: number, aspect: number, cx: number, cy: number, hw: number, hh: number) {
    const tv = Math.tan(THREE.MathUtils.degToRad(fov / 2))
    const th = tv * aspect
    center.set(0, 0, 0)
    for (let k = 0; k < npts; k++) center.add(pts[k])
    center.multiplyScalar(1 / Math.max(1, npts))
    let ext = 0
    for (let k = 0; k < npts; k++) ext = Math.max(ext, pts[k].distanceTo(center))
    let d = Math.max(4, ext / Math.max(0.05, Math.min(th * hw, tv * hh)))
    let ax = cx
    let ay = cy
    probe.fov = fov
    probe.aspect = aspect
    probe.updateProjectionMatrix()
    for (let it = 0; it < 4; it++) {
      aim(out, center, heading, pitch, d, ax, ay, tv, th)
      probe.position.copy(out.pos)
      probe.lookAt(out.target)
      probe.updateMatrixWorld()
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (let k = 0; k < npts; k++) {
        pv.copy(pts[k]).project(probe)
        if (pv.x < minX) minX = pv.x
        if (pv.x > maxX) maxX = pv.x
        if (pv.y < minY) minY = pv.y
        if (pv.y > maxY) maxY = pv.y
      }
      if (!Number.isFinite(minX + maxX + minY + maxY)) break
      const k = Math.max((maxX - minX) / (2 * hw), (maxY - minY) / (2 * hh))
      ax -= (minX + maxX) / 2 - cx
      ay -= (minY + maxY) / 2 - cy
      d *= clamp(k, 0.6, 1.6)
    }
    aim(out, center, heading, pitch, d, ax, ay, tv, th)
  }

  /** px rect (x0, y0 top, x1, y1 bottom) → NDC centre + half extents (into `rc`, no allocation) */
  const rc = { cx: 0, cy: 0, hw: 0, hh: 0 }
  function rect(W: number, H: number, x0: number, y0: number, x1: number, y1: number) {
    rc.cx = (x0 + x1) / W - 1
    rc.cy = 1 - (y0 + y1) / H
    rc.hw = Math.max(0.12, (x1 - x0) / W)
    rc.hh = Math.max(0.1, (y1 - y0) / H)
    return rc
  }

  const isPortrait = (frame: Frame) => frame.height > frame.width * 1.05

  function widePose(out: Pose, frame: Frame, m: HudMetrics, drift: number) {
    const W = Math.max(1, frame.width)
    const H = Math.max(1, frame.height)
    const s = range.summits
    npts = 0
    const portrait = isPortrait(frame)
    for (let i = 0; i < N; i++) {
      const p = s[i]
      pts[npts++].set(p.x, p.h, p.z)
      // the shore below it: the headline sits on open water, clear of the coast
      if (portrait) pts[npts++].set(p.x, 0.5, p.z + 3.5)
      else pts[npts++].set(range.coast[i][0], 0, range.coast[i][1])
    }
    const g = m.valid ? m.gutter : 24
    const top = m.valid ? m.safeTop : H * 0.11
    const introTop = m.valid && m.introTop > 0 ? m.introTop : H * 0.62
    if (portrait) {
      // the range upper, receding on a diagonal; the headline below over the sound
      const r = rect(W, H, g, top + 50, W - g, Math.min(introTop - 20, H * 0.6))
      fit(out, 0.82 + drift, 0.86, W / H, r.cx, r.cy, r.hw, r.hh)
    } else if (H < 560) {
      // a short landscape sheet: the range beside the headline, not above it
      const x0 = m.valid && m.introRight > 0 ? m.introRight + 24 : W * 0.5
      const r = rect(W, H, x0, top + 52, W - g, H - (m.valid ? m.safeBottom : 80) - 8)
      fit(out, 0.02 + drift, 0.62, W / H, r.cx, r.cy, r.hw, r.hh)
    } else {
      // the whole range across the sheet, names in the paper above, the sound below
      const band = Math.min(150, H * 0.17)
      const r = rect(W, H, g + 10, top + band, W - g - 10, introTop - 22)
      fit(out, 0.02 + drift, 0.56, W / H, r.cx, r.cy, r.hw, r.hh)
    }
  }

  function summitPose(out: Pose, f: number, frame: Frame, m: HudMetrics, drift: number) {
    const W = Math.max(1, frame.width)
    const H = Math.max(1, frame.height)
    summitPoint(f, q)
    // a box around the summit in view (fixed size, so the zoom stays even along the range)
    npts = 0
    pts[npts++].set(q.x, q.y + 0.2, q.z)
    pts[npts++].set(q.x - 7.2, q.y - 3.8, q.z + 0.6)
    pts[npts++].set(q.x + 7.2, q.y - 3.8, q.z + 0.6)
    pts[npts++].set(q.x, q.y - 4.4, q.z + 7.5)
    pts[npts++].set(q.x, q.y - 3.2, q.z - 3.6)
    const heading = lerp(0.3, -0.3, f / (N - 1)) + drift
    const g = m.valid ? m.gutter : 24
    const top = m.valid ? m.safeTop : H * 0.11
    const bot = m.valid ? m.safeBottom : H * 0.11
    if (isPortrait(frame)) {
      const cardTop = m.valid ? m.cardTop : H * 0.55
      const r = rect(W, H, g + 16, top + 104, W - g - 16, cardTop - 14)
      fit(out, heading, 0.62, W / H, r.cx, r.cy, r.hw, r.hh)
    } else {
      const x0 = (m.valid ? m.colRight : W * 0.36) + 40
      // leave room on the right for the summit's name beside its sign
      const x1 = W - g - Math.min(290, (W - x0) * 0.36)
      const r = rect(W, H, x0, top + Math.min(160, H * 0.21), x1, H - bot - 6)
      fit(out, heading, 0.6, W / H, r.cx, r.cy, r.hw, r.hh)
    }
  }

  function topPose(out: Pose, frame: Frame, m: HudMetrics) {
    const W = Math.max(1, frame.width)
    const H = Math.max(1, frame.height)
    npts = 0
    for (const p of range.summits) {
      pts[npts++].set(p.x, 0, p.z - 4)
      pts[npts++].set(p.x, 0, p.z + 9)
    }
    const g = m.valid ? m.gutter : 24
    const top = m.valid ? m.safeTop : H * 0.11
    const bot = m.valid ? m.safeBottom : H * 0.11
    const r = rect(W, H, g, top, W - g, H - bot)
    fit(out, 0, 1.36, W / H, r.cx, r.cy, r.hw, r.hh)
  }

  function lerpPose(out: Pose, a: Pose, b: Pose, t: number) {
    out.pos.lerpVectors(a.pos, b.pos, t)
    out.target.lerpVectors(a.target, b.target, t)
  }

  function computePose(local: number, frame: Frame, m: HudMetrics, drift: number) {
    fov = isPortrait(frame) ? 38 : 32
    const f = summitAt(local)
    // in: straight down on the flat sheet → the wide oblique (settled by 0.056)
    const tilt = glide((local - 0.004) / 0.052)
    // the dive from the wide view onto summit 01 (after the landing at 0.08)
    const near = glide((local - 0.081) / 0.03)
    // out: the climb back to the vertical
    const climb = glide((local - 0.926) / 0.064)
    if (near <= 0) {
      widePose(pA, frame, m, drift)
      if (tilt < 1) {
        topPose(pB, frame, m)
        lerpPose(pose, pB, pA, tilt)
      } else {
        pose.pos.copy(pA.pos)
        pose.target.copy(pA.target)
      }
    } else if (climb <= 0) {
      summitPose(pB, f, frame, m, drift)
      if (near < 1) {
        widePose(pA, frame, m, drift)
        lerpPose(pose, pA, pB, near)
      } else {
        pose.pos.copy(pB.pos)
        pose.target.copy(pB.target)
      }
    } else {
      summitPose(pA, f, frame, m, drift)
      topPose(pB, frame, m)
      lerpPose(pose, pA, pB, climb)
    }
    cp.f = f
    cp.tilt = tilt
    cp.near = near
    cp.climb = climb
    return cp
  }
  const cp = { f: 0, tilt: 0, near: 0, climb: 0 }

  function project(frame: Frame, lift: number) {
    probe.position.copy(pose.pos)
    probe.fov = fov
    probe.aspect = Math.max(1, frame.width) / Math.max(1, frame.height)
    probe.updateProjectionMatrix()
    probe.lookAt(pose.target)
    probe.updateMatrixWorld()
    for (let i = 0; i < N; i++) {
      const s = range.summits[i]
      pv.set(s.x, s.h * lift, s.z).project(probe)
      const ok = pv.z < 1 && Number.isFinite(pv.x + pv.y)
      scr[i].ok = ok
      scr[i].x = (pv.x * 0.5 + 0.5) * frame.width
      scr[i].y = (-pv.y * 0.5 + 0.5) * frame.height
    }
  }

  /**
   * Fit the wide view's three label rows into the paper between the top band
   * and the skyline (recomputed only when the viewport, the copy or the
   * lettering moves). A name + elevation block reaches ~30 px over its row
   * line and is ~25 px tall, a name alone ~16 / ~9 px; neighbouring rows keep
   * an 11 px gap (the declutter pad). The placement is rehearsed on the
   * settled view: where names + elevations don't all fit, the elevations go;
   * where the names alone don't, the wide view letters numbers only (never a
   * board with names missing).
   */
  function fitBoard(frame: Frame, m: HudMetrics, topBand: number) {
    const W = Math.max(1, frame.width)
    const H = Math.max(1, frame.height)
    const b = board
    if (
      b.W === W &&
      b.H === H &&
      b.top === topBand &&
      b.introTop === m.introTop &&
      b.introRight === m.introRight &&
      b.gutter === m.gutter &&
      b.valid === m.valid &&
      b.lettering === annot.version
    )
      return b
    b.W = W
    b.H = H
    b.top = topBand
    b.introTop = m.introTop
    b.introRight = m.introRight
    b.gutter = m.gutter
    b.valid = m.valid
    b.lettering = annot.version
    widePose(pW, frame, m, 0)
    probe.position.copy(pW.pos)
    probe.fov = fov
    probe.aspect = W / H
    probe.updateProjectionMatrix()
    probe.lookAt(pW.target)
    probe.updateMatrixWorld()
    let sky = Infinity
    for (let i = 0; i < N; i++) {
      const s = range.summits[i]
      pv.set(s.x, s.h, s.z).project(probe)
      boardX[i] = (pv.x * 0.5 + 0.5) * W
      boardY[i] = (-pv.y * 0.5 + 0.5) * H
      boardIn[i] = pv.z < 1 && boardX[i] > -4 && boardX[i] < W + 4 && boardY[i] > 0 && boardY[i] < H ? 1 : 0
      if (boardIn[i] && boardY[i] < sky) sky = boardY[i]
    }
    // from row 0's line (24 px over the skyline) up to the top band, less 4 px for the idle drift
    const room = sky - 24 - topBand - 4
    const pE = Math.min(38, (room - 31) / 2)
    const pN = Math.min(38, (room - 17) / 2)
    const wide = !isPortrait(frame) && W >= 980
    b.elev = wide && pE >= 36 && boardFits(W, sky, topBand, pE, true)
    b.names = b.elev || (wide && pN >= 22 && boardFits(W, sky, topBand, pN, false))
    b.pitch = b.elev ? pE : Math.max(22, pN)
    return b
  }

  /**
   * The live wide-view placement (west → east; centred, else flagged east,
   * else west), rehearsed on the settled view with a little extra margin:
   * does every summit on the sheet get its name?
   */
  function boardFits(W: number, sky: number, topBand: number, pitch: number, elev: boolean) {
    const L = rehearse
    L.elev = elev ? 1 : 0
    let np = 0
    for (let i = 0; i < N; i++) {
      if (!boardIn[i]) continue
      const p = annot.pins[i]
      const x = boardX[i]
      const y = boardY[i]
      L.lead = y - (sky - 24 - range.summits[i].row * pitch)
      const half = annot.nameWidth(p, true, 0) * 0.5
      L.nudge = x - half < MARGIN ? MARGIN - (x - half) : x + half > W - MARGIN ? W - MARGIN - (x + half) : 0
      let ok = false
      for (let c = 0; c < 3 && !ok; c++) {
        L.align = c === 0 ? 0.5 : c === 1 ? 0 : 1
        const bx = annot.box(p, L, rehearseBox)
        const pb = placed[np]
        pb.x0 = x + bx.x0
        pb.x1 = x + bx.x1
        pb.y0 = y - bx.y1
        pb.y1 = y - bx.y0
        ok = pb.y0 > topBand + 2 && pb.x0 > MARGIN - 4 && pb.x1 < W - MARGIN + 4
        for (let j = 0; ok && j < np; j++) if (overlaps(pb, placed[j], 12)) ok = false
      }
      if (!ok) return false
      np++
    }
    return true
  }

  const overlaps = (a: Box, b: Box, pad: number) => a.x0 < b.x1 + pad && a.x1 + pad > b.x0 && a.y0 < b.y1 + pad && a.y1 + pad > b.y0

  return {
    id: 'services',
    group,
    anchors: ANCHORS,

    async init(ctx: ChapterContext) {
      mobile = ctx.mobile
      renderer = ctx.renderer
      range = buildRange()
      await nextFrame()
      // ~390k height samples on desktop: sliced, a frame yielded between slices
      const geo = await terrainGeometryAsync({
        width: 98,
        depth: 68,
        cz: 1,
        seg: mobile ? 150 : 250,
        detail: mobile ? 2 : 3,
        height: range.height,
      })
      await nextFrame()
      mat = chartMaterial(ctx.world, {
        terrain: geo,
        interval: INTERVAL,
        index: 5,
        hMin: 0,
        hMax: range.hMax * 0.9,
        stepped: 0.75,
        shade: 0.9,
        relief: 1.1,
        waterLines: 6,
        waterSpacing: 0.12,
        edge: 9,
      })
      const land = new THREE.Mesh(geo, mat)
      group.add(land)

      // the survey traverse along the crest (draws itself summit to summit)
      const trail = drape(range.crest, range.height, {
        offset: 0.04,
        step: 0.14,
      })
      route = traverse(trail, ctx.world, {
        width: mobile ? 2.2 : 2.5,
        dash: 0.34,
        gap: 0.2,
      })
      // the route's own distance at each benchmark, so it draws exactly summit to summit
      {
        let k = 0
        for (let j = 0; j < trail.length && k < N; j++) {
          while (k < N && Math.hypot(trail[j].x - range.summits[k].x, trail[j].z - range.summits[k].z) < 0.07) routeAt[k++] = route.dist[j]
        }
        for (; k < N; k++) routeAt[k] = route.length
      }
      group.add(route.mesh)
      // the rivers: thin solid water-ink lines on the valley floors
      for (const r of range.rivers) {
        const t = traverse(drape(r, range.height, { offset: 0.03, step: 0.2 }), ctx.world, {
          width: 1.4,
          gap: 0,
          color: C.waterLine,
          pull: 0.006,
        })
        t.uniforms.uProgress.value = 1
        t.mesh.renderOrder = 1
        rivers.push(t)
        group.add(t.mesh)
      }
      await nextFrame()

      annot = new Annotations(range.summits, ctx.world)
      group.add(annot.group)
      await annot.letter(renderer.getPixelRatio())

      // the sound's name, in the water: Newsreader italic, lettered flat on the chart
      await ensureFonts()
      const { texture, aspect } = labelTexture('Hark Sound', {
        font: 'display',
        italic: true,
        size: 44,
        color: C.coast,
        tracking: 0.16,
        halo: null,
      })
      const sh = 2.3
      sound = new THREE.Mesh(
        new THREE.PlaneGeometry(sh * aspect, sh),
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        }),
      )
      sound.rotation.x = -Math.PI / 2
      sound.position.set(range.sound.x, 0.02, range.sound.y)
      sound.renderOrder = 2
      group.add(sound)
      // soundings: small italic depth figures (fathoms, read off the same
      // height field) scattered over the open water east of the headline
      const spots: [number, number][] = [
        [5.5, 14.2],
        [9.5, 21.5],
        [16.5, 13.8],
        [22.5, 16.6],
        [24.5, 22.4],
        [12.5, 25.5],
        [18, 26.8],
        [29, 19.5],
      ]
      for (const [x, z] of spots) {
        const hh = range.height(x, z)
        if (hh > -0.35) continue
        const { texture: t2, aspect: a2 } = labelTexture(String(Math.round(-hh * 22)), {
          font: 'display',
          italic: true,
          size: 30,
          color: C.coast,
          halo: null,
        })
        const sd = new THREE.Mesh(
          new THREE.PlaneGeometry(1.35 * a2, 1.35),
          new THREE.MeshBasicMaterial({
            map: t2,
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
            toneMapped: false,
          }),
        )
        sd.rotation.x = -Math.PI / 2
        sd.position.set(x, 0.02, z)
        sd.renderOrder = 2
        soundings.push(sd)
        group.add(sd)
      }
      // redraw the lettering once late web fonts arrive
      if (document.fonts && document.fonts.status !== 'loaded') {
        document.fonts.ready.then(() => annot.letter(renderer.getPixelRatio())).catch(() => undefined)
      }

      hud = new Hud(ctx.stage, range.summits, k => window.__hark?.land('services', true, ANCHORS[k]))

      // click a summit's benchmark / name to fly there (click, not pointerdown: touch scrolls must not jump)
      canvas = ctx.renderer.domElement
      canvas.addEventListener('click', e => {
        if (!active || !canvas || lastLocal < A || lastLocal > CARD_OUT) return
        const r = canvas.getBoundingClientRect()
        const k = nearest(e.clientX - r.left, e.clientY - r.top)
        if (k >= 0) window.__hark?.land('services', true, ANCHORS[k])
      })
    },

    onEnter() {
      active = true
      first = true
    },
    onLeave() {
      active = false
      if (canvas) canvas.style.cursor = ''
    },

    update(local, frame, ctx) {
      const still = ctx.reducedMotion || frame.reducedMotion || !!frame.still
      const dt = frame.dt
      const t = frame.time
      lastLocal = local
      const m = hud.metrics()
      const W = Math.max(1, frame.width)
      const H = Math.max(1, frame.height)
      annot.setViewport(W, H)
      // the lettering prints 1:1: redraw it if the render resolution moved a lot
      const dpr = renderer.getPixelRatio()
      if (annot.stale(dpr)) void annot.letter(dpr)

      // ---------- the drone
      const drift = still ? 0 : 0.018 * Math.sin(t * 0.11) + 0.008 * Math.sin(t * 0.047 + 1.3)
      const { f, tilt, climb } = computePose(local, frame, m, drift)

      // ---------- the chart: lift into relief (in), settle flat (out)
      const lift = smoothstep(0, 1, tilt) * (1 - smoothstep(0.1, 0.95, climb))
      const u = mat.uniforms
      u.uLift.value = lift
      u.uRipple.value = still ? 0 : 0.07
      u.uGrid.value = 0.35 * (1 - lift)
      u.uGridSize.value = 6
      route.uniforms.uLift.value = lift
      route.uniforms.uRes.value.set(W, H)
      for (const r of rivers) {
        r.uniforms.uLift.value = lift
        r.uniforms.uRes.value.set(W, H)
      }
      project(frame, lift)

      // ---------- which summit is in view (card + lettering follow it)
      const inItems = local >= CARD_IN && local < CARD_OUT
      const shown = inItems ? Math.max(0, Math.min(N - 1, Math.round(f))) : -1
      const calmV = 1 - smoothstep(0.7, 1.6, Math.abs(frame.velocity))
      calm = first ? calmV : damp(calm, calmV, calmV < calm ? 10 : 2.5, dt)
      // `first`: jumped here — show the settled state at once. `still`
      // (reduced motion / Motion off): no movement (growth, slides, lettering
      // are instant), but colour and opacity changes still fade, so a fast
      // scrub can never flash.
      const settle = first
      const instant = still || first

      // benchmarks grow on the summit in view (damped: a scrub can't strobe them)
      for (let i = 0; i < N; i++) {
        const target = i === shown ? (calm > 0.5 ? 1 : still ? 0 : 0.35) : 0
        grow[i] = instant ? target : damp(grow[i], target, target > grow[i] ? 5.5 : 8, dt)
      }

      // the vermilion contours ride the summit in view: fade out, move, fade back in
      if (shown !== hiIdx) {
        hiAmt = settle ? 0 : damp(hiAmt, 0, 9, dt)
        if (hiAmt < 0.03 || hiIdx < 0) {
          hiIdx = shown
          if (settle) hiAmt = hiIdx >= 0 ? 1 : 0
        }
      } else {
        const want = hiIdx >= 0 ? (calm > 0.5 ? 1 : 0.3) : 0
        hiAmt = settle ? want : damp(hiAmt, want, 4, dt)
      }
      if (hiIdx >= 0) {
        const s = range.summits[hiIdx]
        u.uHi.value.set(s.x, s.z, 4.3, hiAmt)
      } else u.uHi.value.w = 0

      // the survey traverse, drawn to the drone's position along the crest
      const fi = Math.max(0, Math.min(N - 2, Math.floor(f)))
      const along = lerp(routeAt[fi], routeAt[fi + 1], clamp(f - fi))
      route.uniforms.uProgress.value = local < A ? 0 : along / Math.max(1e-3, route.length)
      route.uniforms.uOpacity.value = smoothstep(0.08, 0.1, local) * (1 - smoothstep(0.93, 0.97, local))

      // ---------- lettering on the range
      const letterOn = local > 0.012 && local < 0.94 ? 1 : 0
      letter = instant ? letterOn : letterOn > letter ? Math.min(letterOn, letter + dt / 1.1) : Math.max(0, letter - dt / 0.45)
      const portrait = isPortrait(frame)
      const wideness = 1 - smoothstep(0.081, 0.1, local)
      const topBand = (m.valid ? m.safeTop : 80) - 18
      const bd = fitBoard(frame, m, topBand)
      // full names where there's room: the wide view needs a wide landscape sheet
      // with room for the board over the range, a close view only a tablet's
      // width (phones letter numbers; the card names it)
      const full = wideness > 0.5 ? !portrait && W >= 980 && bd.names : W >= 700
      const marks = 1 - smoothstep(0.93, 0.965, local)
      const margin = MARGIN
      // panorama-board rows: in the wide view every name sits on one of three
      // lines above the skyline (pitched to the room), the leader dropping to its summit
      let skyline = Infinity
      for (let i = 0; i < N; i++) if (scr[i].ok && scr[i].y < skyline) skyline = scr[i].y
      for (let i = 0; i < N; i++) {
        const L = lays[i]
        const s = range.summits[i]
        const g = grow[i]
        const rowWide = full ? scr[i].y - (skyline - 24 - s.row * bd.pitch) : 16 + (i % 2) * 24
        const rowClose = 26 + (i % 2) * 22
        L.ok = scr[i].ok
        L.g = g
        L.full = full
        L.lead = lerp(lerp(rowClose, rowWide, wideness), portrait ? 40 : 50, g)
        L.tri = lerp(portrait ? 9 : 10, portrait ? 13 : 15, g)
        L.sign = lerp(0, portrait ? 46 : 56, Math.min(1, g * 1.4))
        // lettered in, west → east
        L.reveal = clamp(letter * 1.5 - (i / (N - 1)) * 0.5)
        // a narrow or short sheet has no room for elevations on the wide view
        L.elev = full && bd.elev ? 1 : 1 - wideness
        L.alpha = marks * (shown >= 0 ? lerp(0.85, 1, g) : 1)
        // beside the sign the name flips to the roomier side
        const nameW = annot.nameWidth(annot.pins[i], full, 1)
        const signHalf = (portrait ? 46 : 56) * 0.5 + 10
        const roomR = W - margin - (scr[i].x + signHalf)
        const roomL = scr[i].x - signHalf - margin
        L.side = roomR < nameW && roomL > roomR ? -1 : 1
        // idle names are centred on their leader: nudge them in from the edges
        const half = annot.nameWidth(annot.pins[i], full, 0) * 0.5
        L.nudge = 0
        if (wideness > 0.5) {
          if (scr[i].x - half < margin) L.nudge = margin - (scr[i].x - half)
          else if (scr[i].x + half > W - margin) L.nudge = W - margin - (scr[i].x + half)
        }
      }

      // declutter (greedy, classic map-label placement): the summit in view
      // first, then outward along the range. An idle name tries its flag
      // positions (away from the summit in view, then the other way, then
      // centred) and keeps its current one while it still fits; a name that
      // can't fit, leaves the sheet or slips under the card fades out.
      let n = 0
      if (shown < 0) for (let i = 0; i < N; i++) order[n++] = i
      else {
        order[n++] = shown
        for (let d = 1; d < N; d++) {
          if (shown - d >= 0) order[n++] = shown - d
          if (shown + d < N) order[n++] = shown + d
        }
      }
      const cardOn = shown >= 0 && !portrait && m.valid
      let np = 0
      for (let k = 0; k < n; k++) {
        const i = order[k]
        const L = lays[i]
        const sx = scr[i].x
        const sy = scr[i].y
        let ok = scr[i].ok && sx > -4 && sx < W + 4 && sy > 0 && sy < H
        // a summit hidden behind the card keeps nothing on the chart
        if (ok && cardOn && sx < m.colRight + 12 && sy > m.cardTop - 30 && sy < m.cardBottom + 30) ok = false
        if (!ok) {
          textT[i] = 0
          L.alpha = 0
          continue
        }
        const close = wideness < 0.5 && shown >= 0 && i !== shown
        const pref = i > shown ? 0 : 1
        if (close) {
          cands[0] = alignT[i]
          cands[1] = pref
          cands[2] = 1 - pref
          cands[3] = 0.5
        } else if (wideness >= 0.5) {
          // the wide board: centred over its leader, else flagged east, else west
          // (a crowded, height-bound range on a short sheet); a jump lands on the fresh layout
          cands[0] = settle ? 0.5 : alignT[i]
          cands[1] = 0.5
          cands[2] = 0
          cands[3] = 1
        } else cands[0] = cands[1] = cands[2] = cands[3] = 0.5
        let placedOk = false
        for (let c = 0; c < 4 && !placedOk; c++) {
          if (c > 0 && cands[c] === cands[c - 1]) continue
          L.align = cands[c]
          const b = annot.box(annot.pins[i], L, boxes[i])
          const pb = placed[np]
          pb.x0 = sx + b.x0
          pb.x1 = sx + b.x1
          pb.y0 = sy - b.y1
          pb.y1 = sy - b.y0
          let fits = pb.y0 > topBand && pb.x0 > margin - 6 && pb.x1 < W - margin + 6
          if (fits && cardOn && pb.x0 < m.colRight + 8 && pb.x1 > m.cardLeft - 8 && pb.y1 > m.cardTop - 8 && pb.y0 < m.cardBottom + 8)
            fits = false
          // hysteresis: a name already showing keeps its place on a tighter margin
          const pad = textT[i] > 0.5 ? 4 : 10
          for (let j = 0; fits && j < np; j++) if (overlaps(pb, placed[j], pad)) fits = false
          if (fits) {
            placedOk = true
            alignT[i] = cands[c]
            np++
          }
        }
        textT[i] = placedOk ? 1 : 0
      }
      for (let i = 0; i < N; i++) {
        textA[i] = settle ? textT[i] : damp(textA[i], textT[i], 9, dt)
        alignA[i] = instant ? alignT[i] : damp(alignA[i], alignT[i], 7, dt)
        const L = lays[i]
        L.align = alignA[i]
        L.textAlpha = textA[i] * L.alpha
        // a name that couldn't be placed takes its leader with it (the ▲ stays,
        // an unnamed spot height): no leader stands pointing at empty paper.
        // Its length follows the name's fade; under reduced motion it snaps.
        const keep = Math.max(instant ? textT[i] : textA[i], L.g)
        if (keep < 1) L.lead = lerp(L.tri * 0.72, L.lead, keep)
        annot.layout(annot.pins[i], L, lift)
      }

      // ---------- the sound's name floats at sea level whatever the lift
      const seaInk = smoothstep(0.02, 0.06, local) * (1 - smoothstep(0.93, 0.97, local))
      ;(sound.material as THREE.MeshBasicMaterial).opacity = 0.9 * seaInk
      for (const sd of soundings) (sd.material as THREE.MeshBasicMaterial).opacity = 0.75 * seaInk

      // ---------- world: hillshade from the west (the faces toward the drone read), paper fog
      const w = ctx.world.params
      w.sun.set(-1, 1.2, 0.05)
      const dist = pose.pos.distanceTo(pose.target)
      w.fogNear = dist * 1.02 + 6
      w.fogFar = dist * 1.9 + 40
      ctx.post.params.vignette = 0.14

      // ---------- copy
      const introOn = local >= INTRO_IN && local < INTRO_OUT
      hud.update(introOn, shown)
      first = false

      // hover: a pointer over a summit (desktop)
      if (active && !mobile && canvas) {
        const px = (frame.pointerRaw.x * 0.5 + 0.5) * W
        const py = (-frame.pointerRaw.y * 0.5 + 0.5) * H
        const k = local > A && local < CARD_OUT ? nearest(px, py) : -1
        const cur = k >= 0 ? 'pointer' : ''
        if (canvas.style.cursor !== cur) canvas.style.cursor = cur
      }
    },

    camera(_local, frame, out: CameraPose) {
      out.position.copy(pose.pos)
      out.target.copy(pose.target)
      out.fov = fov
      out.roll = 0
      out.parallax = frame.mobile || frame.reducedMotion || frame.still ? 0 : 0.22
    },
  }

  /** the summit whose benchmark (or its leader above it) is within reach of (x, y) CSS px, or -1 */
  function nearest(x: number, y: number) {
    let best = -1
    let bd = 30 * 30
    for (let i = 0; i < N; i++) {
      if (!scr[i].ok) continue
      const dx = scr[i].x - x
      const dy = Math.max(0, scr[i].y - y - 60, y - scr[i].y - 10)
      const d = dx * dx + dy * dy
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return best
  }
}
