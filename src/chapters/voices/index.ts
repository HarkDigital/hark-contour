import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise } from '../../core/dom'
import { clamp, ease, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECTIONS, SHEET, TESTIMONIALS } from '../../content'
import { C, FONTS, ensureFonts, marker, routeRibbon, type ChartMaterial } from '../../kit/chart'
import { terrainGeometryAsync } from '../../kit/terrain'
import { BAY, LAUNCH, METERS, ROSE, STATIONS, WATER_HALO, bayHeight, bayMaterial } from './bay'
import { makeRose, type Rose } from './rose'
import { knockRoute, letterPlane, makeKnock, pingRings, scatterSoundings, soundings, type Letter, type PingRings, type Soundings } from './sonar'
import './voices.css'

/*
 * SOUNDINGS (voices) — "We listen. They talk." as ECHO SOUNDING.
 *
 * A nautical chart of a bay: pale water stepped by depth, isobaths deepening
 * offshore, water-lining drifting out from every coast, scattered soundings,
 * a printed compass rose in open water. The drone flies a hydrographic
 * survey — three lanes across the bay — and at each station a client's
 * voice is a SONAR PING: a wavefront blooms out in vermilion, rings drift
 * behind it, a survey marker grows out of the water and the company is
 * lettered onto the chart like a water name (the person's name beneath).
 * The quote itself is DOM, in a legend box.
 *
 *   0.000–0.085  intro: top-down on the rose as it's inked in; the eyebrow +
 *                “We listen. They talk.” (settled at 0.06 and at 0.08);
 *                the drone tilts off toward station 1 from 0.062 and
 *                arrives a fifth of the way into the first voice
 *   0.085–0.925  eight voices (0.105 each): glide in (−0.32 … +0.1 of a
 *                beat). Mid-glide the legend box turns to the next voice
 *                and, together, the ping blooms, the marker grows and the
 *                company is lettered in, so the card and the chart name the
 *                same client all the way through the beat → dwell (slow
 *                orbit) → the rings settle into a blue trace as the drone
 *                moves on
 *   0.908–1.000  the drone climbs to a top-down view of the whole survey
 *
 * Everything derives from `local`; frame.time only drives the idle pulse
 * (≤ one new ring per 2 s) and the water-lining drift — both off under
 * reduced motion / Motion off.
 */

const N = TESTIMONIALS.length
const B0 = 0.085
const SPAN = 0.105
const B1 = B0 + N * SPAN
const HYST = 0.004
/** a new idle ring every this many seconds (calm: ≤ 1 per 1.5 s) */
const PULSE = 2.2
/** ring field reach + spacing (world units) */
const REACH = 5.6
const SPACING = 0.95

const startOf = (i: number) => B0 + i * SPAN
/** a glide into station i runs from GA to GB (in beats, around the beat's start): the drone arrives as the quote lands */
const GA = -0.32
const GB = 0.1
/** the first glide: off the rose, arriving a third into the first voice */
const G0A = 0.062
const G0B = B0 + 0.22 * SPAN
/**
 * the legend box turns to voice i at the middle of the glide into station i
 * (the first glide's middle is B0 itself), so the card, the ping and the
 * lettered company arrive together
 */
const FLIP = (GA + GB) / 2
const flipAt = (i: number) => (i <= 0 ? B0 : i >= N ? B1 : startOf(i) + FLIP * SPAN)
/** lettering boxes the survey track is knocked out under: world padding around the letters */
const KNOCK_PAD = 0.15

interface Pose {
  tx: number
  tz: number
  dist: number
  tilt: number
  az: number
  fov: number
}

const mixPose = (a: Pose, b: Pose, t: number, out: Pose) => {
  out.tx = a.tx + (b.tx - a.tx) * t
  out.tz = a.tz + (b.tz - a.tz) * t
  out.dist = a.dist + (b.dist - a.dist) * t
  out.tilt = a.tilt + (b.tilt - a.tilt) * t
  out.az = a.az + (b.az - a.az) * t
  out.fov = a.fov + (b.fov - a.fov) * t
  return out
}

/** per-station azimuth, so each glide swings the drone a little */
const AZ = [-0.1, 0.08, -0.06, 0.12, -0.1, 0.07, -0.08, 0.1]

interface StationRig {
  rings: PingRings
  mark: ReturnType<typeof marker>
  company: Letter
  person: Letter
  /** subject centre (station + lettering), world */
  cx: number
  cz: number
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const height = bayHeight()
  let mat: ChartMaterial & { uniforms: { uIso: { value: number }; uIsoOn: { value: number } } }
  let rose: Rose
  let marks: Soundings
  const rigs: StationRig[] = []
  let survey: ReturnType<typeof routeRibbon>
  let planned: ReturnType<typeof routeRibbon>
  let bench: ReturnType<typeof marker>
  /** the lettered boxes (company, person per station) the track is knocked out under */
  const knock = makeKnock()
  /** route length at each station (survey order), and at the launch */
  const atStation: number[] = []
  let routeLen = 1
  let mobile = false

  // DOM
  let intro: HTMLElement
  let introTitle: HTMLElement
  let panel: HTMLElement
  let stack: HTMLElement
  let countNo: HTMLElement
  const steps: HTMLElement[] = []
  const cards: { root: HTMLElement; parts: HTMLElement[]; h: number }[] = []
  let shown = -2
  let stackH = -1

  // camera scratch (no per-frame allocation)
  const pA: Pose = { tx: 0, tz: 0, dist: 1, tilt: 0, az: 0, fov: 38 }
  const pB: Pose = { tx: 0, tz: 0, dist: 1, tilt: 0, az: 0, fov: 38 }
  const pC: Pose = { tx: 0, tz: 0, dist: 1, tilt: 0, az: 0, fov: 38 }

  /* ------------------------------------------------------------ poses */

  /** place a subject at screen NDC (sx, sy) for a pose's dist/tilt/az/fov */
  function frameSubject(out: Pose, x: number, z: number, sx: number, sy: number, aspect: number) {
    const halfH = out.dist * Math.tan((out.fov * Math.PI) / 360)
    const halfW = halfH * aspect
    const ca = Math.cos(out.az)
    const sa = Math.sin(out.az)
    // camera right (ground) and forward (ground, away from the camera)
    const rx = ca
    const rz = -sa
    const fx = -sa
    const fz = -ca
    const dx = sx * halfW
    const dz = (sy * halfH) / Math.max(0.35, Math.cos(out.tilt))
    out.tx = x - rx * dx - fx * dz
    out.tz = z - rz * dx - fz * dz
    return out
  }

  function stationPose(i: number, u: number, frame: Frame, out: Pose) {
    const portrait = frame.height > frame.width
    const aspect = frame.width / Math.max(1, frame.height)
    const r = rigs[i]
    const dwell = clamp(u)
    out.fov = portrait ? 46 : 38
    out.tilt = portrait ? 0.66 : 0.74
    // portrait: keep ~15 units of chart across the frame (phones far, tablets closer)
    const portraitDist = clamp(7.6 / (Math.tan((46 * Math.PI) / 360) * aspect), 24, 38)
    out.dist = (portrait ? portraitDist : aspect < 1.45 ? 25 : 22) - dwell * 1.2
    out.az = AZ[i] + (dwell - 0.5) * 0.07
    const cx = r ? r.cx : STATIONS[i].x
    const cz = r ? r.cz : STATIONS[i].z
    return portrait ? frameSubject(out, cx, cz, 0, 0.36, aspect) : frameSubject(out, cx, cz, 0.3, 0.06, aspect)
  }

  function overviewPose(frame: Frame, out: Pose, which: 'intro' | 'outro', local: number) {
    const portrait = frame.height > frame.width
    const aspect = frame.width / Math.max(1, frame.height)
    out.fov = portrait ? 46 : 38
    out.az = 0
    if (which === 'intro') {
      // straight down on the rose, settling lower as it's inked in
      const k = ease.outCubic(smoothstep(0, 0.07, local))
      out.tilt = 0.05
      out.az = 0.07 * (1 - k)
      out.dist = (portrait ? 46 : 36) * (1.12 - 0.12 * k)
      return portrait ? frameSubject(out, ROSE.x, ROSE.z, 0, 0.2, aspect) : frameSubject(out, ROSE.x, ROSE.z, 0.34, -0.03, aspect)
    }
    out.tilt = 0.1
    out.dist = portrait ? 92 : 62
    return frameSubject(out, 0, 5, portrait ? 0 : 0.12, 0, aspect)
  }

  /** the drone's pose at `local` (glides eased; a small climb mid-glide) */
  function poseAt(local: number, frame: Frame, out: Pose) {
    // intro → station 1
    if (local < G0B) {
      const g = ease.inOutCubic(smoothstep(G0A, G0B, local))
      overviewPose(frame, pA, 'intro', local)
      stationPose(0, 0, frame, pB)
      mixPose(pA, pB, g, out)
      return out
    }
    // outro: climb to the whole survey
    const outA = B1 + GA * 0.5 * SPAN
    if (local > outA) {
      const g = ease.inOutCubic(smoothstep(outA, 1.0, local))
      stationPose(N - 1, 1, frame, pA)
      overviewPose(frame, pB, 'outro', local)
      mixPose(pA, pB, g, out)
      return out
    }
    // between stations
    for (let i = 1; i < N; i++) {
      const s = startOf(i)
      const a = s + GA * SPAN
      const b = s + GB * SPAN
      if (local >= a && local <= b) {
        const g = ease.inOutCubic((local - a) / (b - a))
        stationPose(i - 1, 1, frame, pA)
        stationPose(i, 0, frame, pB)
        mixPose(pA, pB, g, out)
        const climb = Math.sin(Math.PI * g)
        out.dist *= 1 + 0.16 * climb
        out.tilt -= 0.08 * climb
        return out
      }
    }
    // dwell at a station
    const i = Math.min(N - 1, Math.max(0, Math.floor((local - B0) / SPAN)))
    const s = startOf(i) + (i === 0 ? G0B - B0 : GB * SPAN)
    const e = i === N - 1 ? B1 + GA * 0.5 * SPAN : startOf(i + 1) + GA * SPAN
    return stationPose(i, clamp((local - s) / (e - s)), frame, out)
  }

  /* ------------------------------------------------------------ DOM */

  function buildDom(stage: HTMLElement) {
    intro = el('div', 'vc-intro', undefined, stage)
    el('p', 'hud-eyebrow vc-eyebrow', SECTIONS.voices.eyebrow, intro)
    const m = SECTIONS.voices.title.match(/^(.*?\.)\s+(.*)$/)
    const html = m ? `${m[1]} <em>${m[2]}</em>` : SECTIONS.voices.title
    introTitle = rise(el('h2', 'hud-h2 vc-title', undefined, intro), html)
    // chart marginalia (the sheet, its units): the chrome carries the scale bar, hero + Benchmark the coordinates
    el('p', 'hud-coord vc-note', `${SHEET.name(4, 'Soundings')} · Depths in meters`, intro)

    panel = el('figure', 'vc-panel hud-panel', undefined, stage)
    const meta = el('div', 'vc-meta', undefined, panel)
    const count = el('p', 'hud-label vc-count', undefined, meta)
    count.append('Sounding ')
    countNo = el('b', '', '01', count)
    count.append(` / ${String(N).padStart(2, '0')}`)
    const row = el('ol', 'vc-steps', undefined, meta)
    TESTIMONIALS.forEach((_, i) => steps.push(el('li', '', String(i + 1), row)))
    stack = el('div', 'vc-stack', undefined, panel)
    TESTIMONIALS.forEach(t => {
      const root = el('div', 'vc-card', undefined, stack)
      if (t.quote.length > 170) root.classList.add('vc-card--long')
      const q = rise(el('blockquote', 'hud-quote vc-quote', undefined, root), `“${t.quote}”`)
      const who = el('p', 'vc-who', undefined, root)
      const name = el('span', 'hud-label vc-name', t.name, who)
      const co = el('span', 'vc-co', t.company, who)
      cards.push({ root, parts: [q, name, co], h: 0 })
    })
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(entries => {
        for (const e of entries) {
          const c = cards.find(k => k.root === e.target)
          if (c) c.h = (e.target as HTMLElement).offsetHeight
        }
        applyStackHeight()
      })
      cards.forEach(c => ro.observe(c.root))
    }
  }

  function applyStackHeight(snap = false) {
    if (shown < 0 || shown >= N) return
    const c = cards[shown]
    const hh = c.h || (c.h = c.root.offsetHeight)
    if (hh && hh !== stackH) {
      stackH = hh
      if (snap) stack.style.transition = 'none'
      stack.style.height = `${hh}px`
      if (snap) {
        void stack.offsetHeight
        stack.style.transition = ''
      }
    }
  }

  function setCard(i: number, on: boolean) {
    const c = cards[i]
    if (!c) return
    c.root.classList.toggle('is-on', on)
    setRise(c.parts[0], on)
  }

  function sinkAll() {
    for (let i = 0; i < N; i++) setCard(i, false)
    setRise(introTitle, false)
    intro.classList.remove('is-on')
    panel.classList.remove('is-on')
    shown = -2
    stackH = -1
  }

  function wantAt(local: number) {
    let want = local < B0 ? -1 : local >= B1 ? N : clamp(Math.floor((local - B0 - FLIP * SPAN) / SPAN), 0, N - 1)
    if (shown >= -1 && want !== shown && Math.abs(want - shown) === 1) {
      if (Math.abs(local - flipAt(Math.max(want, shown))) < HYST) want = shown
    }
    return want
  }

  function show(next: number) {
    if (next === shown) return
    const wasCard = shown >= 0 && shown < N
    if (wasCard) setCard(shown, false)
    shown = next
    const isCard = next >= 0 && next < N
    panel.classList.toggle('is-on', isCard)
    if (isCard) {
      setCard(next, true)
      countNo.textContent = String(next + 1).padStart(2, '0')
      steps.forEach((d, i) => {
        d.classList.toggle('is-on', i === next)
        d.classList.toggle('is-past', i < next)
      })
      applyStackHeight(!wasCard)
    }
  }

  /* ------------------------------------------------------------ scene */

  async function buildScene(ctx: ChapterContext) {
    mobile = ctx.mobile
    // ~270k samples: sampled in slices so the loader keeps drawing
    const geo = await terrainGeometryAsync({
      width: BAY.width,
      depth: BAY.depth,
      cx: BAY.cx,
      cz: BAY.cz,
      seg: mobile ? 130 : 200,
      detail: mobile ? 2 : 3,
      height,
    })
    mat = bayMaterial(ctx.world, geo, mobile, knock)
    const land = new THREE.Mesh(geo, mat)
    land.renderOrder = 0
    group.add(land)
    await nextFrame()

    await ensureFonts()

    rose = makeRose(ctx.world, ROSE.r, mobile)
    rose.mesh.position.set(ROSE.x, 0.008, ROSE.z)
    group.add(rose.mesh)
    await nextFrame()

    // stations: rings, a marker, the lettering
    // phones: the company as large as desktop's (relative to the frame), the name larger still
    const k = mobile ? 1.02 : 1
    const kn = mobile ? 1.32 : 1
    // company line → person line, centre to centre
    const gap = 0.28 + 0.62 * kn
    STATIONS.forEach((s, i) => {
      const t = TESTIMONIALS[i]
      const rings = pingRings(ctx.world, REACH, SPACING)
      rings.mesh.position.set(s.x, 0.014, s.z)
      const mk = marker({ color: C.signal, height: 1.15, radius: 0.24 })
      mk.group.position.set(s.x, 0.016, s.z)
      mk.setGrow(0)
      const anchor = s.side > 0 ? 'left' : 'right'
      const company = letterPlane(ctx.world, t.company, {
        font: 'display',
        italic: true,
        weight: 420,
        size: 46,
        color: C.coast,
        halo: WATER_HALO,
        haloWidth: 0.2,
        height: 1.55 * k,
        anchor,
      })
      const person = letterPlane(ctx.world, t.name, {
        font: 'sans',
        weight: 700,
        size: 30,
        uppercase: true,
        tracking: 0.2,
        color: C.inkSoft,
        halo: WATER_HALO,
        haloWidth: 0.2,
        height: 0.88 * kn,
        anchor,
      })
      // the name hangs off the marker into the quadrant the track leaves free
      // (bay.ts STATIONS): its first letter a little past the marker, its top
      // (below) or its foot (above) clear of the marker's ring and both legs
      const clear = s.clear ?? 0.55
      const cz = s.row === 'below' ? s.z + clear + company.ink.hz : s.z - clear - person.ink.hz - gap
      const x0 = s.x + s.side * 0.4
      company.mesh.position.set(x0, 0.02, cz)
      // the canvas pads each side; nudge the smaller line so the letters align
      person.mesh.position.set(x0 + s.side * 0.16 * kn, 0.02, cz + gap)
      group.add(rings.mesh, mk.group, company.mesh, person.mesh)
      // the lettered boxes, and the subject the drone frames: the station and its lettering
      let minX = s.x - 0.4
      let maxX = s.x + 0.4
      let minZ = s.z - 0.4
      let maxZ = s.z + 0.4
      ;[company, person].forEach((L, j) => {
        const p = L.mesh.position
        const r = knock.rects[i * 2 + j].set(p.x + L.ink.x0 - KNOCK_PAD, p.z - L.ink.hz - KNOCK_PAD, p.x + L.ink.x1 + KNOCK_PAD, p.z + L.ink.hz + KNOCK_PAD)
        minX = Math.min(minX, r.x)
        minZ = Math.min(minZ, r.y)
        maxX = Math.max(maxX, r.z)
        maxZ = Math.max(maxZ, r.w)
      })
      rigs.push({ rings, mark: mk, company, person, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 })
    })
    await nextFrame()

    // the survey track: launch → lanes, a faint planned line and the drawn one
    const ctrl = [new THREE.Vector3(LAUNCH.x, 0, LAUNCH.z), ...STATIONS.map(s => new THREE.Vector3(s.x, 0, s.z))]
    const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal', 0.5)
    const pts: THREE.Vector3[] = []
    const per = 40
    for (let seg = 0; seg < ctrl.length - 1; seg++) {
      for (let j = 0; j < per; j++) {
        const t = (seg + j / per) / (ctrl.length - 1)
        pts.push(curve.getPoint(t))
      }
    }
    pts.push(curve.getPoint(1))
    // land under the first leg: ride the relief (full-lift heights; the mesh scales by lift)
    for (const p of pts) p.y = Math.max(0, height(p.x, p.z))
    let acc = 0
    atStation.length = 0
    atStation.push(0)
    for (let i = 1; i < pts.length; i++) {
      acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
      if (i % per === 0) atStation.push(acc)
    }
    routeLen = acc
    planned = routeRibbon(pts, { width: 0.085, color: C.inkSoft, dash: 0.1, gap: 0.24 })
    planned.uniforms.uOpacity.value = 0.7
    planned.mesh.position.y = 0.03
    survey = routeRibbon(pts, { width: 0.1, color: C.signal, dash: 0.36, gap: 0.16 })
    survey.mesh.position.y = 0.035
    survey.mesh.renderOrder = 5
    // both lines are knocked out under each lettered name (as it's lettered in)
    knockRoute(planned.mesh.material as THREE.ShaderMaterial, knock)
    knockRoute(survey.mesh.material as THREE.ShaderMaterial, knock)
    group.add(planned.mesh, survey.mesh)

    bench = marker({ color: C.signal, height: 0.9, radius: 0.22 })
    bench.group.position.set(LAUNCH.x, 0, LAUNCH.z)
    group.add(bench.group)
    await nextFrame()

    // soundings, clear of the rose, the stations and their lettering (a figure's half size around each box)
    const figure = mobile ? 0.82 : 0.62
    const keep: [number, number, number][] = [[ROSE.x, ROSE.z, ROSE.r + 0.9]]
    for (const s of STATIONS) keep.push([s.x, s.z, 2.1])
    // calm water under the intro headline (desktop framing)
    const keepRect: [number, number, number, number][] = [mobile ? [-36, 20.5, -12, 31] : [-54, -3, -31, 6.5]]
    for (let j = 0; j < STATIONS.length * 2; j++) {
      const r = knock.rects[j]
      keepRect.push([r.x - figure * 1.05, r.y - figure * 0.55, r.z + figure * 1.05, r.w + figure * 0.55])
    }
    const list = scatterSoundings(height, {
      x0: -44,
      x1: 40,
      z0: -12,
      z1: 34,
      step: mobile ? 3.6 : 3.1,
      minDepth: 0.075,
      meters: METERS,
      keepOut: keep,
      keepRect,
      seed: 17,
    })
    marks = soundings(ctx.world, list, figure)
    group.add(marks.mesh)

    // canvases drawn before the web fonts arrived: redraw once they have
    const fonts = document.fonts
    if (fonts && !fonts.check(`italic 400 32px ${FONTS.display}`)) {
      void fonts.ready.then(() => {
        rose.redraw()
        marks.redraw()
        for (const r of rigs) {
          r.company.redraw()
          r.person.redraw()
        }
      })
    }
  }

  /* ------------------------------------------------------------ chapter */

  return {
    id: 'voices',
    group,
    anchors: Array.from({ length: N }, (_, i) => B0 + SPAN * (i + 0.55)),
    async init(ctx) {
      buildDom(ctx.stage)
      await buildScene(ctx)
    },
    onEnter() {
      sinkAll()
    },
    onLeave() {
      sinkAll()
    },
    update(local, frame, ctx) {
      const calm = ctx.reducedMotion || !!frame.still
      const idle = calm ? 0 : frame.time / PULSE

      /* ---- the world: distant land fades into the paper margin ---- */
      const pose = poseAt(local, frame, pC)
      ctx.world.params.fogNear = pose.dist * 1.15 + 8
      ctx.world.params.fogFar = pose.dist * 2.6 + 44

      /* ---- DOM ---- */
      // portrait: the headline sits low, where the first legend box will land, and yields to it
      const introOn = local > 0.012 && local < (frame.height > frame.width ? B0 : 0.118)
      intro.classList.toggle('is-on', introOn)
      setRise(introTitle, introOn)
      show(wantAt(local))

      /* ---- the chart ---- */
      const u0 = mat.uniforms
      // flat printed chart top-down → the land lifts as the drone tilts off → settles back for the overview
      const lift = smoothstep(0.03, 0.13, local) * (1 - 0.65 * smoothstep(B1 - 0.02, 0.99, local))
      u0.uLift.value = ease.inOutCubic(lift)
      u0.uRipple.value = calm ? 0 : 0.07
      rose.uniforms.uDraw.value = ease.inOutCubic(smoothstep(0.0, 0.058, local))
      marks.u.uPrint.value = smoothstep(0.0, 0.07, local)

      // the survey track draws itself leg by leg as the drone glides
      let drawn = 0
      if (local < G0B) {
        drawn = atStation[1] * ease.inOutCubic(smoothstep(0.03, G0B, local))
      } else {
        drawn = atStation[1]
        for (let i = 1; i < N; i++) {
          const s = startOf(i)
          const g = ease.inOutCubic(smoothstep(s + GA * SPAN, s + GB * SPAN, local))
          drawn += (atStation[i + 1] - atStation[i]) * g
        }
      }
      survey.uniforms.uProgress.value = drawn / routeLen
      const liftNow = u0.uLift.value
      survey.mesh.scale.y = Math.max(0.0001, liftNow)
      planned.mesh.scale.y = Math.max(0.0001, liftNow)
      bench.group.position.y = Math.max(0, height(LAUNCH.x, LAUNCH.z)) * liftNow + 0.02
      bench.setGrow(smoothstep(0.01, 0.06, local))

      /* ---- the stations ---- */
      for (let i = 0; i < N; i++) {
        const r = rigs[i]
        const u = (local - startOf(i)) / SPAN
        // the ping clock: 0 when the drone arrives over the station
        const p = (local - (i === 0 ? G0B : startOf(i) + GB * SPAN)) / SPAN
        const heard = smoothstep(1.0, 1.3, u)
        const active = smoothstep(-0.14, -0.02, p) * (1 - heard)
        r.rings.u.uActive.value = active
        r.rings.u.uTrace.value = heard
        r.rings.u.uFront.value = REACH * 0.97 * ease.outCubic(clamp((p + 0.06) / 0.55))
        r.rings.u.uPhase.value = Math.max(0, p) * 4 + idle
        r.rings.mesh.visible = active > 0.001 || heard > 0.001
        r.mark.setGrow(ease.outCubic(smoothstep(-0.2, 0.12, p)))
        // lettered in from the card's turn (mid-glide, p ≈ −0.21): name and card agree
        const rc = smoothstep(-0.22, 0.02, p)
        const rp = smoothstep(-0.14, 0.1, p)
        r.company.u.uReveal.value = rc
        r.person.u.uReveal.value = rp
        // the track under each name is knocked out as the name prints
        knock.k[i * 2] = rc
        knock.k[i * 2 + 1] = rp
      }
    },
    camera(local, frame, out: CameraPose) {
      const p = poseAt(local, frame, pC)
      let az = p.az
      let lift = 0
      if (!(frame.reducedMotion || frame.still)) {
        // a drone holding station: the gentlest drift, never a shake
        az += Math.sin(frame.time * 0.11) * 0.006
        lift = Math.sin(frame.time * 0.37) * 0.05
      }
      const st = Math.sin(p.tilt)
      out.target.set(p.tx, 0, p.tz)
      out.position.set(p.tx + Math.sin(az) * st * p.dist, Math.cos(p.tilt) * p.dist + lift, p.tz + Math.cos(az) * st * p.dist)
      out.fov = p.fov
      out.roll = 0
      out.parallax = 0.3
    },
  }
}
