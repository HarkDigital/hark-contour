import * as THREE from 'three'
import type { Chapter, ChapterContext } from '../../core/types'
import { Callout, reveal, setRise } from '../../core/dom'
import { clamp, damp, ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { ensureFonts, FONTS } from '../../kit/chart'
import { buildHud, measureHud, type Hud, type HudLayout } from './hud'
import { buildBenchmark, DISC_R, type Benchmark } from './disc'
import { buildChart, TOP, type ChartSet } from './scene'
import './contact.css'

/*
 * CONTACT · "Benchmark" — the final chapter: where you find us.
 *
 * A brass survey benchmark disc is set into the top of a quiet knoll on the
 * printed chart, the Hark mark embossed at its centre and the studio's name
 * engraved round its rim. The drone finds it from above, descends onto it
 * while the flat printed map lifts into relief, and settles into a close
 * three-quarter view; listening rings (packets of three vermilion
 * hairlines, a printed "(((") leave the disc and drift out across the
 * chart (hark = listen). Map lettering belongs to the flat sheet and lifts
 * away as the drone tilts.
 *
 *   0.00–0.06  the contour flood drains: a top-down printed sheet, flat
 *   0.03–0.13  a vermilion "you are here" ring draws itself round the disc
 *   0.04–0.27  the descent: top-down tilts to oblique, the map lifts (0.07–0.25)
 *   0.10–0.22  the legend box comes in (settled from 0.24: landing = intro = 0.3)
 *   0.18–0.50  the listening rings reach further out across the chart
 *   0.27–0.85  a slow drone drift round the disc; the light walks the rim
 *   0.85–1.00  the final still: nothing scroll-driven moves
 *
 * Everything is derived from `local`; frame.time only drives the rings'
 * drift, the water-lining and a tiny hover, all off under reduced motion /
 * Motion off, and the hover dies for the final still.
 */

const FOV = 30
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2))
const DEG = Math.PI / 180

/** top-down start: distance and the chart framing */
const D0 = 38
/** azimuths (camera round the disc; + = toward the west) */
const AZ0 = -4 * DEG
const AZ1 = 12 * DEG
const AZ2 = 30 * DEG
const EL0 = 88.4 * DEG
const EL1 = 38 * DEG
const EL2 = 31 * DEG
/** the disc turns to face the final view, so its lettering reads square */
const DISC_YAW = -24 * DEG

export default function create(): Chapter {
  const group = new THREE.Group()
  let hud: Hud
  let chart: ChartSet
  let disc: Benchmark
  let callout: Callout
  let lay: HudLayout | null = null
  let lastW = 0
  let lastH = 0
  // the disc's place on screen (NDC) and the distance that frames it
  let sx = 0.3
  let sy = 0
  let dFit = 11
  let hoverAmt = 0
  let idleAmt = 0
  const tmpF = new THREE.Vector3()
  const tmpR = new THREE.Vector3()
  const tmpU = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)
  const calloutPoint = new THREE.Vector3()
  const shortLandscape = () => matchMedia('(orientation: landscape) and (max-height: 500px)').matches

  const liftAt = (local: number) => ease.inOutCubic(segment(local, 0.07, 0.25))
  const descentAt = (local: number) => ease.inOutCubic(segment(local, 0.035, 0.27))
  const driftAt = (local: number) => smoothstep(0.27, 0.85, local)

  const relayout = (W: number, H: number) => {
    lay = measureHud(hud, W, H, !shortLandscape())
    hud.dirty = false
    lastW = W
    lastH = H
    const a = lay.art
    const aw = Math.max(60, a.x1 - a.x0)
    const ah = Math.max(60, a.y1 - a.y0)
    const cx = (a.x0 + a.x1) / 2
    // landscape: a touch below the art's centre (the rings travel up and away)
    const cy = lay.portrait ? (a.y0 + a.y1) / 2 + ah * 0.04 : (a.y0 + a.y1) / 2 + ah * 0.05
    sx = (cx / W) * 2 - 1
    sy = 1 - (cy / H) * 2
    // the distance at which the disc (plus a breath of air) fits the art area
    const rs = DISC_R * 1.14
    const fw = lay.portrait ? 0.66 : 0.54
    const fh = lay.portrait ? 0.74 : 0.56
    const byW = (2 * rs * H) / (2 * TAN * fw * aw)
    const byH = (2 * rs * Math.sin(EL1) * H + 0.3 * H) / (2 * TAN * fh * ah)
    dFit = clamp(Math.max(byW, byH), 6, 30)
  }

  /** camera spherical coordinates round the disc for this local */
  const poseAt = (local: number) => {
    const a = descentAt(local)
    const b = driftAt(local)
    const el = lerp(lerp(EL0, EL1, a), EL2, b)
    const az = lerp(lerp(AZ0, AZ1, a), AZ2, b)
    // log-space descent: a steady drone drop, not a lurch at the end
    const d = D0 * Math.pow(dFit / D0, a) * lerp(1, 0.93, b)
    return { el, az, d }
  }

  return {
    id: 'contact',
    group,
    anchors: [0.3],

    async init(ctx: ChapterContext) {
      hud = buildHud(ctx.stage)
      callout = new Callout(ctx.stage, { side: 'right', offset: { x: 70, y: -54 } })
      callout.root.setAttribute('aria-hidden', 'true')
      callout.label.textContent = 'You are here'
      await ensureFonts()
      const fontsIn = !document.fonts || document.fonts.check(`700 40px ${FONTS.sans}`)
      await nextFrame()
      chart = await buildChart(ctx.world, ctx.mobile)
      group.add(chart.land, chart.rings.mesh, chart.here.mesh, ...chart.labels)
      await nextFrame()
      disc = buildBenchmark(ctx.renderer, ctx.mobile)
      disc.spin.rotation.y = DISC_YAW
      group.add(disc.group)
      if (!fontsIn) {
        document.fonts?.ready
          .then(() => {
            disc.redraw()
            chart.redrawLabels()
          })
          .catch(() => {})
      }
      await nextFrame()
    },

    update(local, frame, ctx) {
      const W = frame.width
      const H = frame.height
      if (hud.dirty || W !== lastW || H !== lastH || !lay) relayout(W, H)

      const calm = ctx.reducedMotion || frame.reducedMotion || !!frame.still
      idleAmt = damp(idleAmt, calm ? 0 : 1 - smoothstep(0.7, 0.85, local), 4, frame.dt)
      const t = frame.time

      // ---- the chart: flat printed sheet → relief
      const lift = liftAt(local)
      const u = chart.chart.uniforms
      u.uLift.value = lift
      u.uBase.value = 0
      u.uRipple.value = calm ? 0 : 0.06
      u.uGrid.value = 0.42 * (1 - smoothstep(0.08, 0.24, local))
      u.uGridSize.value = 5
      u.uHi.value.set(0, 0, 1, 0)

      // ---- the benchmark follows the lifting land
      const yDisc = TOP * lift
      disc.group.position.set(0, yDisc, 0)

      // ---- "you are here": drawn round the disc first, fine once we arrive
      const hu = chart.here.u
      hu.uDraw.value = ease.inOutCubic(segment(local, 0.03, 0.13))
      const a = descentAt(local)
      hu.uWidth.value = lerp(0.13, 0.03, a)
      hu.uOpacity.value = 1
      chart.here.mesh.position.set(0, yDisc + 0.012, 0)

      // ---- the listening rings
      const hoverTo = hud.hover ? 1 : 0
      hoverAmt = damp(hoverAmt, hoverTo, 5, frame.dt)
      const since = (performance.now() - hud.copiedAt) / 1000
      const copied = since >= 0 && since < 1.8 ? Math.sin((since / 1.8) * Math.PI) : 0
      if (copied > 0 || Math.abs(hoverAmt - hoverTo) > 0.004) window.__hark?.engine?.wake()
      const ru = chart.rings.u
      ru.uPhase.value = ctx.reducedMotion ? 0.3 : t * 0.1
      ru.uReach.value = lerp(3.2, 15, smoothstep(0.16, 0.5, local))
      ru.uAmt.value = smoothstep(0.14, 0.3, local) * (0.85 + 0.25 * hoverAmt + 0.3 * copied)

      // ---- map lettering belongs to the sheet: it lifts away as the drone tilts
      // (grazing lettering on the relief only reads as clutter)
      chart.labelU.uOpacity.value = 1 - smoothstep(0.15, 0.25, local)

      // ---- the world: paper, the NW hillshade, fog that grows with the drone's height
      const pose = poseAt(local)
      const wp = ctx.world.params
      wp.fogNear = pose.d + 3.5
      wp.fogFar = pose.d + 22
      // the key walks slowly round the rim as you drift (a glint in the lettering)
      const drift = driftAt(local)
      const ka = lerp(-2.2, -1.2, drift)
      wp.keyDir.set(Math.cos(ka) * 0.75, 0.95, Math.sin(ka) * 0.75 + 0.35)
      wp.key = 0.5
      wp.fill = 0.9

      // ---- copy
      reveal(hud.panel, smoothstep(0.1, 0.2, local))
      setRise(hud.title, local > 0.12)

      // ---- the descent's annotation
      const cv = smoothstep(0.06, 0.1, local) * (1 - smoothstep(0.19, 0.24, local))
      calloutPoint.set(DISC_R * 1.1, yDisc + 0.05, -DISC_R * 1.1)
      callout.update(calloutPoint, ctx.camera, W, H, cv)
    },

    camera(local, frame, out) {
      const p = poseAt(local)
      const t = frame.time
      const idle = idleAmt < 1e-3 ? 0 : idleAmt
      const az = p.az + 0.01 * Math.sin(t * 0.13) * idle
      const el = p.el + 0.006 * Math.sin(t * 0.17 + 1.1) * idle
      const lift = liftAt(local)
      const tgt = out.target.set(0, TOP * lift + 0.06, 0)
      tmpF.set(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
      out.position.copy(tgt).addScaledVector(tmpF, p.d)
      // pan so the disc sits in the art area (NDC sx, sy), easing in as the box arrives
      const pan = smoothstep(0.04, 0.22, local)
      tmpF.negate()
      tmpR.crossVectors(tmpF, UP).normalize()
      tmpU.crossVectors(tmpR, tmpF).normalize()
      const aspect = frame.width / Math.max(1, frame.height)
      const px = sx * p.d * TAN * aspect * pan
      const py = sy * p.d * TAN * pan
      out.position.addScaledVector(tmpR, -px).addScaledVector(tmpU, -py)
      out.target.addScaledVector(tmpR, -px).addScaledVector(tmpU, -py)
      out.fov = FOV
      out.roll = 0
      out.parallax = 0.12 * (1 - smoothstep(0.7, 0.85, local))
    },
  }
}
