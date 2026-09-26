import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { C, chartMaterial, ensureFonts, marker, routeRibbon, type ChartMaterial } from '../../kit/chart'
import { terrainGeometry } from '../../kit/terrain'
import { buildLand, drapeFull, GRID, HALF, INTERVAL, PEAK, SEA_K, toWorld, X0, Z0, type Land } from './land'
import { flatLabel, redrawLabel, sheetFrame, type SheetUniforms } from './sheet'
import './hero.css'

/*
 * HERO — "Relief". The Hark mark as an island massif on a printed chart.
 *
 *   0 – 0.1    INTRO: straight down onto the FLAT printed sheet (uLift 0): the
 *              mark reads upright as an island inside a neatline with a
 *              graduated border; the title block sits in the sheet's margin.
 *              After 'hark:reveal' the chart prints outward from the island
 *              (~1.6 s), the border draws itself round, the rings drift.
 *   0.1 – 0.55 RELIEF: the drone tilts from top-down to a low oblique while the
 *              map lifts into relief (uLift 0 → 1); the sheet's frame lets go
 *              and the sea runs on into the paper; a glide along the NW ridge;
 *              dashed vermilion survey lines trace both crests and a benchmark
 *              grows on the diamond summit (its contours turn vermilion).
 *   0.55–0.93  PAYOFF: a 3/4 aerial, island right of centre (upper half on
 *              portrait), 'Make the internet listen.' + two CTAs.
 *   0.93 – 1   drift out over the open sea under the contour flood.
 *
 * Everything is a pure function of `local` (plus frame.time for the idle orbit
 * and the ring drift, and a one-off wall-clock print-on at reveal).
 */

// ---------------------------------------------------------------- camera keys
// channels: target offset x/z from the summit, log distance, elevation°, azimuth°, screen shift x/y (NDC), fov°
const TX = 0
const TZ = 1
const LD = 2
const EL = 3
const AZ = 4
const SX = 5
const SY = 6
const FOV = 7
const NCH = 8

interface Key {
  t: number
  v: number[]
}

/** Fritsch–Carlson monotone cubic through the keys, per channel (no overshoot on holds) */
class Track {
  private t: number[] = []
  private y: number[][] = []
  private m: number[][] = []
  set(keys: Key[]) {
    this.t = keys.map(k => k.t)
    this.y = []
    this.m = []
    const n = keys.length
    for (let c = 0; c < NCH; c++) {
      const y = keys.map(k => k.v[c])
      const d: number[] = []
      for (let i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / (this.t[i + 1] - this.t[i]))
      const m: number[] = new Array(n).fill(0)
      for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] <= 0) m[i] = 0
        else {
          const w1 = 2 * (this.t[i + 1] - this.t[i]) + (this.t[i] - this.t[i - 1])
          const w2 = (this.t[i + 1] - this.t[i]) + 2 * (this.t[i] - this.t[i - 1])
          m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
        }
      }
      this.y.push(y)
      this.m.push(m)
    }
  }
  sample(t: number, out: number[]) {
    const ts = this.t
    const n = ts.length
    let i = 0
    if (t <= ts[0]) i = 0
    else if (t >= ts[n - 1]) i = n - 2
    else while (i < n - 2 && t > ts[i + 1]) i++
    const h = ts[i + 1] - ts[i]
    const s = clamp((t - ts[i]) / h)
    const s2 = s * s
    const s3 = s2 * s
    const h00 = 2 * s3 - 3 * s2 + 1
    const h10 = s3 - 2 * s2 + s
    const h01 = -2 * s3 + 3 * s2
    const h11 = s3 - s2
    for (let c = 0; c < NCH; c++) {
      const y = this.y[c]
      const m = this.m[c]
      out[c] = h00 * y[i] + h10 * h * m[i] + h01 * y[i + 1] + h11 * h * m[i + 1]
    }
  }
}

const DEG = Math.PI / 180

export default function create(): Chapter {
  const group = new THREE.Group()
  let land: Land
  const mats: ChartMaterial[] = []
  let sheetU: SheetUniforms
  const sheetLabels: THREE.Mesh[] = []
  const seaLabels: THREE.Mesh[] = []
  const routes: ReturnType<typeof routeRibbon>[] = []
  let routeMeshes: THREE.Mesh[] = []
  /** each route's draped points (full relief) and cumulative lengths, for its pen tip */
  const routePts: THREE.Vector3[][] = []
  const routeCum: number[][] = []
  const heads: THREE.Mesh[] = []
  let bench: ReturnType<typeof marker>
  let reduced = false
  let mobile = false

  // DOM
  let intro: HTMLElement
  let legend: HTMLElement
  let payoff: HTMLElement
  let title: HTMLElement

  // reveal clock (wall time, seconds): the print-on is a one-off entrance, not idle motion
  let revealAt = -1
  let initAt = 0
  const now = () => performance.now() / 1000

  // camera
  const track = new Track()
  const val = new Array<number>(NCH).fill(0)
  let keyW = 0
  let keyH = 0
  let layoutDirty = true
  const pos = new THREE.Vector3(X0, 40, Z0 + 0.3)
  const tgt = new THREE.Vector3(X0, 0, Z0)
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const up = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)
  let camDist = 30
  let camFov = 30
  let camEl = 89
  let camAz = 0
  let parallax = 0.1

  const fit = (w: number, h: number, x0: number, x1: number, y0: number, y1: number, rx: number, ry: number, fov: number) => {
    const tanV = Math.tan((fov / 2) * DEG)
    const aspect = w / h
    const hw = Math.max(0.05, (x1 - x0) / w)
    const hh = Math.max(0.05, (y1 - y0) / h)
    const dist = Math.max(ry / (hh * tanV), rx / (hw * tanV * aspect))
    return { ld: Math.log(dist), sx: (x0 + x1) / w - 1, sy: 1 - (y0 + y1) / h }
  }

  const buildKeys = (w: number, h: number) => {
    const portrait = h > w
    const gut = clamp(0.034 * w, 16, 48)
    const top = clamp(0.105 * h, 80, 112)
    const bot = clamp(0.105 * h, 82, 110)
    const iRect = intro ? { right: intro.offsetLeft + intro.offsetWidth, bottom: intro.offsetTop + intro.offsetHeight } : { right: w * 0.36, bottom: h * 0.36 }
    const FI = 28
    const FP = 32
    let I: ReturnType<typeof fit>
    let P: ReturnType<typeof fit>
    if (!portrait) {
      // the sheet sits right of the title block; the massif right of the headline
      I = fit(w, h, Math.max(iRect.right + 56, w * 0.36), w - gut, top - 6, h - bot + 6, HALF + 0.55, HALF + 1.25, FI)
      P = fit(w, h, w * 0.42, w - gut * 0.5, top, h - bot * 0.8, 6.2, 4.8, FP)
    } else {
      I = fit(w, h, gut * 0.7, w - gut * 0.7, iRect.bottom + 22, h - bot + 12, HALF + 0.5, HALF + 1.1, FI)
      P = fit(w, h, gut * 0.5, w - gut * 0.5, top - 10, h * 0.55, 7.3, 4.6, FP)
    }
    const keys: Key[] = portrait
      ? [
          { t: 0.0, v: [0, 0, I.ld, 89.4, 0, I.sx, I.sy, FI] },
          { t: 0.08, v: [0, 0, I.ld - 0.015, 89.4, 0, I.sx, I.sy, FI] },
          { t: 0.24, v: [-0.4, 0.4, I.ld - 0.1, 62, -5, 0, I.sy * 0.2, 30] },
          { t: 0.38, v: [-1.6, -0.2, P.ld - 0.12, 34, -30, 0, 0.06, FP] },
          { t: 0.5, v: [0.2, 0.0, P.ld - 0.18, 28, -6, 0, 0.1, FP] },
          { t: 0.62, v: [0, 0, P.ld - 0.04, 42, 22, P.sx, P.sy, FP] },
          { t: 0.72, v: [0, 0, P.ld, 46, 28, P.sx, P.sy, FP] },
          { t: 0.92, v: [0, 0, P.ld + 0.02, 47, 33, P.sx, P.sy, FP] },
          { t: 1.0, v: [-4.2, 1.4, P.ld + 0.12, 42, 38, P.sx, P.sy, FP] },
        ]
      : [
          { t: 0.0, v: [0, 0, I.ld, 89.4, 0, I.sx, I.sy, FI] },
          { t: 0.08, v: [0, 0, I.ld - 0.015, 89.4, 0, I.sx, I.sy, FI] },
          { t: 0.24, v: [-0.3, 0.5, I.ld - 0.12, 62, -5, I.sx * 0.55, I.sy * 0.4, 30] },
          { t: 0.38, v: [-1.4, -0.4, P.ld - 0.3, 34, -30, 0.1, 0.04, FP] },
          { t: 0.5, v: [0.3, 0.1, P.ld - 0.36, 27, -6, 0.06, 0.04, FP] },
          { t: 0.62, v: [0, 0, P.ld - 0.04, 40, 22, P.sx, P.sy, FP] },
          { t: 0.72, v: [0, 0, P.ld, 44, 28, P.sx, P.sy, FP] },
          { t: 0.92, v: [0, 0, P.ld + 0.02, 45, 33, P.sx, P.sy, FP] },
          { t: 1.0, v: [-4.5, 1.2, P.ld + 0.12, 40, 38, P.sx, P.sy, FP] },
        ]
    track.set(keys)
  }

  const liftAt = (local: number) => ease.inOutCubic(segment(local, 0.1, 0.5))

  /** compute the camera pose for `local` into pos / tgt (update() runs it; camera() writes it) */
  const pose = (local: number, frame: Frame) => {
    if (frame.width !== keyW || frame.height !== keyH || layoutDirty) {
      keyW = frame.width
      keyH = frame.height
      layoutDirty = false
      buildKeys(frame.width, frame.height)
    }
    track.sample(local, val)
    // a slow, small idle orbit in the payoff (a drone holding station). Reduced motion: none. Motion off:
    // frame.time holds, so the orbit holds exactly where it is (no snap back when the switch flips)
    const calm = reduced ? 0 : 1
    const pay = smoothstep(0.62, 0.72, local) * (1 - smoothstep(0.93, 1, local)) * calm
    const t = frame.time
    const az = (val[AZ] + Math.sin(t * 0.11) * 2.4 * pay) * DEG
    const elv = (val[EL] + Math.sin(t * 0.083 + 1.2) * 0.8 * pay) * DEG
    camEl = val[EL]
    camAz = az
    camFov = val[FOV]
    camDist = Math.exp(val[LD])
    const lift = liftAt(local)
    tgt.set(X0 + val[TX], 0.22 * lift, Z0 + val[TZ])
    const ce = Math.cos(elv)
    pos.set(Math.sin(az) * ce, Math.sin(elv), Math.cos(az) * ce).multiplyScalar(camDist).add(tgt)
    fwd.subVectors(tgt, pos).normalize()
    right.crossVectors(fwd, UP).normalize()
    up.crossVectors(right, fwd)
    const tanV = Math.tan((camFov / 2) * DEG)
    const aspect = frame.width / Math.max(1, frame.height)
    const shR = -val[SX] * camDist * tanV * aspect
    const shU = -val[SY] * camDist * tanV
    pos.addScaledVector(right, shR).addScaledVector(up, shU)
    tgt.addScaledVector(right, shR).addScaledVector(up, shU)
    parallax = lerp(0.06, 0.28, smoothstep(80, 45, camEl)) * (1 - smoothstep(0.95, 1, local))
  }

  return {
    id: 'hero',
    group,
    anchors: [0.8],

    async init(ctx: ChapterContext) {
      reduced = ctx.reducedMotion
      mobile = ctx.mobile
      initAt = now()

      // ---------------- DOM first (the camera fit reads the title block's size)
      intro = el('div', 'hr-intro', undefined, ctx.stage)
      el('p', 'hud-eyebrow', MICROCOPY.signalEyebrow, intro)
      el('p', 'hud-body hr-manifesto', BRAND.manifesto, intro)
      const hint = el('p', 'hud-label hr-hint', undefined, intro)
      el('span', 'hr-hint-line', undefined, hint).setAttribute('aria-hidden', 'true')
      el('span', '', MICROCOPY.scrollHint, hint)

      // the sheet's legend: the symbols the survey is about to draw, the tints the relief rises through
      legend = el('div', 'hr-legend hud-panel hud-panel--quiet', undefined, ctx.stage)
      legend.setAttribute('aria-hidden', 'true')
      el('p', 'hud-label hr-legend-title', 'Legend', legend)
      const key = el('ul', 'hr-key', undefined, legend)
      const item = (svg: string, label: string) => {
        const li = el('li', '', undefined, key)
        li.innerHTML = `<svg viewBox="0 0 30 14" width="30" height="14" focusable="false">${svg}</svg>`
        el('span', '', label, li)
      }
      item(`<path d="M15 1.5 21.5 12.5H8.5Z" fill="${C.signal}"/><circle cx="15" cy="9" r="1.6" fill="${C.paper}"/>`, 'Benchmark')
      item(`<path d="M1 7H29" stroke="${C.signal}" stroke-width="2.2" stroke-dasharray="5 3.5"/>`, 'Survey line')
      item(
        `<path d="M1 4.5C9 2 19 7 29 4.5" stroke="${C.contour}" fill="none"/><path d="M1 10.5C9 8 19 13 29 10.5" stroke="${C.index}" stroke-width="1.9" fill="none"/>`,
        'Contour · index',
      )
      item(
        `<path d="M1 3H29" stroke="${C.coast}" stroke-width="1.7"/><path d="M1 7.5H29M1 11.5H29" stroke="${C.waterLine}" stroke-width="0.9" opacity="0.8"/>`,
        'Coast · water-lining',
      )
      const ramp = el('div', 'hr-ramp', undefined, legend)
      for (const c of C.tints) el('i', '', undefined, ramp).style.background = c
      const ticks = el('div', 'hr-ramp-ticks hud-coord', undefined, legend)
      for (const v of ['0', '40', '80', '120 m']) el('span', '', v, ticks)
      el('div', 'hud-rule hr-scale', undefined, legend)
      el('p', 'hud-coord', 'Contour interval 20 m · 1:24 000', legend)

      payoff = el('div', 'hr-payoff', undefined, ctx.stage)
      title = rise(el('h1', 'hud-title hr-title', undefined, payoff), 'Make the internet <em>listen.</em>')
      const ctas = el('div', 'hr-ctas', undefined, payoff)
      const see = el('button', 'hud-btn', 'See the work', ctas)
      see.type = 'button'
      see.addEventListener('click', () => window.__hark?.land('work'))
      const start = el('a', 'hud-btn hud-btn--ghost', 'Start a project', ctas)
      start.href = '#contact'
      start.addEventListener('click', e => {
        if (!window.__hark) return
        e.preventDefault()
        window.__hark.land('contact')
      })
      reveal(legend, 0, 0)
      reveal(payoff, 0)

      const onReveal = () => {
        if (revealAt < 0) revealAt = now()
      }
      if (document.documentElement.dataset.ready === '1') onReveal()
      else window.addEventListener('hark:reveal', onReveal, { once: true })
      document.fonts?.ready.then(() => {
        layoutDirty = true
      })

      // ---------------- land
      land = buildLand()
      await nextFrame()
      const geoIsland = terrainGeometry({
        width: 2 * HALF,
        depth: 2 * HALF,
        seg: mobile ? 160 : 300,
        detail: 2,
        height: land.height,
        cx: X0,
        cz: Z0,
      })
      await nextFrame()
      const geoSea = terrainGeometry({
        width: 76,
        depth: 76,
        seg: mobile ? 76 : 120,
        detail: 2,
        // under the island mesh the sea sheet stays water (the fine mesh covers it)
        height: (x, z) => Math.min(land.height(x, z), -1e-4),
        cx: X0,
        cz: Z0,
      })
      await nextFrame()

      const chartOpts = {
        interval: INTERVAL,
        index: 4,
        hMin: 0,
        hMax: PEAK * 1.02,
        stepped: 0.3,
        shade: 0.72,
        relief: 0.42,
        waterLines: 7,
        waterSpacing: 0.1,
        ripple: reduced ? 0 : 0.07,
        grid: 0.32,
        gridSize: GRID,
        lift: 0,
        line: mobile ? 0.85 : 1.0,
        indexLine: mobile ? 1.4 : 1.9,
        coastLine: mobile ? 1.5 : 1.7,
      }
      const seaMat = chartMaterial(ctx.world, { ...chartOpts, terrain: geoSea })
      const islMat = chartMaterial(ctx.world, { ...chartOpts, terrain: geoIsland, edge: 0 })
      // the fine island sheet wins wherever the two are coplanar
      islMat.polygonOffset = true
      islMat.polygonOffsetFactor = -1
      islMat.polygonOffsetUnits = -2
      for (const m of [seaMat, islMat]) {
        // lifted, the sea stays a calm, nearly flat plane: only land rises
        m.uniforms.uSeaLift.value = SEA_K
        m.uniforms.uWaterDeep.value.set('#d6e3e1')
        m.uniforms.uEdge.value.set(X0, Z0, HALF, HALF)
        m.uniforms.uEdgeFeather.value = 0.05
        mats.push(m)
      }
      const sea = new THREE.Mesh(geoSea, seaMat)
      sea.renderOrder = -1
      // the coarse sea sheet sits a hair below the fine island sheet: where they overlap (all of the
      // island sheet) the fine one always wins the depth test, even far away on phones
      sea.position.y = -0.02
      const island = new THREE.Mesh(geoIsland, islMat)
      group.add(sea, island)

      // ---------------- the sheet: neatline + graduated border (8 bars a side = half a graticule cell each)
      const frame = sheetFrame(X0, Z0, HALF, 8)
      frame.mesh.position.y = 0.004
      sheetU = frame.uniforms
      group.add(frame.mesh)

      // ---------------- survey lines along both crests, the summit benchmark
      const headGeo = new THREE.SphereGeometry(0.075, 16, 10)
      const headMat = new THREE.MeshBasicMaterial({ color: C.signal, toneMapped: false })
      for (const crest of [land.crestA, land.crestB]) {
        const pts = drapeFull(crest, land, 0.05, 0.07)
        const r = routeRibbon(pts, { width: 0.075, dash: 0.2, gap: 0.13, color: C.signal })
        // the kit's ribbon winds its triangles facing down: draw both sides so it shows from above
        ;(r.mesh.material as THREE.ShaderMaterial).side = THREE.DoubleSide
        routes.push(r)
        group.add(r.mesh)
        const cum = [0]
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]))
        routePts.push(pts)
        routeCum.push(cum)
        // the pen tip: where the survey line is being drawn right now
        const head = new THREE.Mesh(headGeo, headMat)
        head.renderOrder = 4
        head.visible = false
        heads.push(head)
        group.add(head)
      }
      routeMeshes = routes.map(r => r.mesh)
      bench = marker({ color: C.signal, height: 1.0, radius: 0.17 })
      bench.group.position.set(land.summit.x, 0, land.summit.z)
      group.add(bench.group)
      await nextFrame()

      // ---------------- lettering (after the faces load, so the canvas metrics are right)
      await Promise.race([ensureFonts(), new Promise(r => setTimeout(r, 2500))])
      const k = mobile ? 1.9 : 1
      const [wx, wz] = toWorld(-0.335, -0.35)
      const water = flatLabel('Hark Sound', {
        font: 'display',
        italic: true,
        size: 64,
        weight: 400,
        color: C.coast,
        tracking: 0.14,
        halo: null,
        height: 0.8,
        anchor: 0.5,
        rot: 0.62,
      })
      water.position.set(wx, 0.006, wz)
      water.userData.topScale = mobile ? 1.9 : 1
      seaLabels.push(water)
      const mono = { font: 'mono' as const, size: 44, weight: 500, color: C.inkSoft, tracking: 0.12, uppercase: true, halo: C.paper }
      const yM = Z0 + HALF + 0.95
      const yT = Z0 - HALF - 0.9
      const addSheet = (text: string, x: number, z: number, anchor: number, show = true) => {
        if (!show) return
        const m = flatLabel(text, { ...mono, height: 0.5 * k, anchor })
        m.position.set(x, 0.005, z)
        sheetLabels.push(m)
      }
      addSheet('Sheet 01 — Relief', X0 - HALF - 0.45, yT, 0, true)
      addSheet('Hark Digital Design · Survey of the studio', X0 + HALF + 0.45, yT, 1, !mobile)
      addSheet(mobile ? MICROCOPY.coordinates : `${MICROCOPY.coordinates} · Scale 1:24 000`, X0 - HALF - 0.45, yM, 0, true)
      addSheet('Contour interval 20 m · Soundings in metres', X0 + HALF + 0.45, yM, 1, !mobile)
      for (const m of [...seaLabels, ...sheetLabels]) group.add(m)
      // fonts that arrive later: redraw once with the real faces
      document.fonts?.ready.then(() => {
        for (const m of [...seaLabels, ...sheetLabels]) redrawLabel(m)
      })
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      if (!land) return
      const t = now()
      if (revealAt < 0 && (document.documentElement.dataset.ready === '1' || t - initAt > 12)) revealAt = t
      const since = reduced ? 99 : revealAt < 0 ? 0 : t - revealAt
      pose(local, frame)

      // ---------------- the chart
      const lift = liftAt(local)
      // the sheet lets go as the relief rises: the sea runs on past the neatline into the paper
      const unframe = smoothstep(0.1, 0.36, local)
      const printR = local > 0.12 ? 60 : lerp(0.5, 13.5, ease.outQuad(clamp(since / 1.9)))
      const printF = lerp(0.8, 2.2, clamp(since / 1.9))
      const hiAmt = smoothstep(0.4, 0.54, local)
      const feather = lerp(0.05, 18, unframe)
      const edge = HALF + feather + 12 * unframe
      for (let i = 0; i < mats.length; i++) {
        const u = mats[i].uniforms
        u.uLift.value = lift
        // ring drift: frame.time already holds still when Motion is off; none at all under reduced motion
        u.uRipple.value = reduced ? 0 : 0.07
        u.uReveal.value.set(X0, Z0, printR, printF)
        u.uEdge.value.set(X0, Z0, edge, edge)
        u.uEdgeFeather.value = feather
        u.uGrid.value = lerp(0.32, 0.16, unframe)
        u.uHi.value.set(land.summit.x, land.summit.z, 0.86, hiAmt)
      }

      // ---------------- the sheet frame + marginalia
      const sheetOn = 1 - smoothstep(0.1, 0.24, local)
      sheetU.uDraw.value = local > 0.12 ? 1 : ease.inOutCubic(clamp((since - 0.45) / 1.45))
      sheetU.uOpacity.value = sheetOn
      const letters = smoothstep(1.0, 1.8, since)
      for (const m of sheetLabels) {
        const mat = m.material as THREE.MeshBasicMaterial
        mat.opacity = letters * sheetOn
        m.visible = mat.opacity > 0.01
      }
      // lettering sized for the flat sheet on small screens eases back to its chart size once oblique
      const oblique = smoothstep(75, 40, camEl)
      for (const m of seaLabels) {
        const mat = m.material as THREE.MeshBasicMaterial
        mat.opacity = smoothstep(0.9, 1.7, since) * (1 - smoothstep(0.93, 0.97, local)) * 0.9
        m.visible = mat.opacity > 0.01
        m.position.y = 0.006
        m.scale.setScalar(lerp((m.userData.topScale as number) ?? 1, 1, oblique))
      }

      // ---------------- survey lines + benchmark
      const draw = ease.inOutQuad(segment(local, 0.2, 0.52))
      const ly = Math.max(lift, 1e-3)
      for (let i = 0; i < routes.length; i++) {
        routes[i].uniforms.uProgress.value = draw
        routes[i].uniforms.uOpacity.value = smoothstep(0.2, 0.23, local)
        routeMeshes[i].scale.y = ly
        routeMeshes[i].position.y = 0.004
        routeMeshes[i].visible = local > 0.2
        // pen tip at the drawing head
        const head = heads[i]
        const pts = routePts[i]
        const cum = routeCum[i]
        const sLen = draw * cum[cum.length - 1]
        let lo = 0
        let hi = cum.length - 1
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1
          if (cum[mid] < sLen) lo = mid
          else hi = mid
        }
        const seg = Math.max(1e-6, cum[hi] - cum[lo])
        head.position.lerpVectors(pts[lo], pts[hi], clamp((sLen - cum[lo]) / seg))
        head.position.y = head.position.y * ly + 0.03
        head.visible = local > 0.2 && draw > 0.003 && draw < 0.997
      }
      const grow = ease.outCubic(segment(local, 0.42, 0.56))
      bench.setGrow(grow)
      bench.group.visible = grow > 0.001
      bench.group.position.y = land.summit.y * lift

      // ---------------- world: the hillshade stays lit from the image's upper left as the drone turns
      // (at azimuth 0 that is the chart's north-west convention)
      const ca = Math.cos(camAz)
      const sa = Math.sin(camAz)
      ctx.world.params.sun.set(-ca * 0.8 - sa * 0.6, 1.25, sa * 0.8 - ca * 0.6)
      // no fog over the flat sheet; distance fades the sea into the paper once oblique
      ctx.world.params.fogNear = lerp(camDist * 1.8, camDist * 1.05, oblique)
      ctx.world.params.fogFar = lerp(camDist * 3.5, camDist * 2.7, oblique)

      // ---------------- DOM
      if (since > 0 || reduced) intro.classList.add('is-in')
      reveal(intro, 1 - smoothstep(0.075, 0.11, local))
      reveal(legend, smoothstep(1.1, 1.9, since) * (1 - smoothstep(0.47, 0.53, local)), 0)
      reveal(payoff, smoothstep(0.6, 0.66, local) * (1 - smoothstep(0.9, 0.935, local)))
      setRise(title, local > 0.6 && local < 0.935)
    },

    camera(_local: number, _frame: Frame, out: CameraPose) {
      out.position.copy(pos)
      out.target.copy(tgt)
      out.fov = camFov
      out.roll = 0
      out.parallax = parallax
    },
  }
}
