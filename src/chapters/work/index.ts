import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECTIONS, WORK, workImage, type WorkItem } from '../../content'
import { C, chartMaterial, ensureFonts, marker, type ChartMaterial } from '../../kit/chart'
import { printLine, type PrintLine } from './line'
import { terrainGeometry, drape, heightRange } from '../../kit/terrain'
import { loadScreenshot, placeholderTexture, whenRevealed } from '../../kit/images'
import { CONTOUR_SEEDS, GRID, OTHERS, ROUTE, SITES, SPOT_BOXES, TERRAIN, grad, gridRef, height, maxOver, onContour, riverLine, spline, summit } from './land'
import { MOUNT_ASPECT, PLATE_BOTTOM, buildPlate, hostOf, isPreview, type Plate } from './plates'
import { breakName, stackTexture, type Line, type Stack } from './lettering'
import './work.css'

/*
 * SURVEY (Selected work) — a drone survey of one coastal region.
 *
 * The chart: a valley meeting the sea (Echo Bay, headlands, a river), six
 * survey sites strung along a dashed route, nine more dotted across the
 * sheet. Each featured site keeps an AERIAL PLATE (the project's screenshot
 * mounted like a map inset) lying flat beside it — together they read as the
 * sheet index. The drone flies the route: the route draws itself in survey
 * vermilion, the site's contours turn vermilion, and its plate lifts off the
 * chart, turns to face the drone and the screenshot prints in, left → right,
 * held on two leader lines above its marker. Past the sixth site the drone
 * climbs to a top-down overview: the relief settles back, a graticule prints
 * over the sheet and nine small markers grow, lettered, with a gazetteer.
 *
 *   0.000–0.095  intro: top-down sheet index (flat print), route + markers
 *                draw in; "Built to be heard." settled 0.035–0.135
 *   0.095–0.168  the dive to site 01: the map lifts into relief
 *   0.080–0.220  item 01 (card 0.150–0.216)
 *   0.220–0.820  items 02–06, 0.12 each: glide ~0.046, then dwell + card
 *   0.820–0.872  climb to the overview (relief settles to a low lift)
 *   0.846–0.944  gazetteer: "Nine more, all live."; rows step 0.868–0.936
 *   0.950–1.000  out: the drone climbs away, the chart flattens
 *
 * Everything derives from `local`; frame.time only drives the drone's idle
 * hover and the water-lining drift.
 */

const FEATURED = WORK.filter(w => w.featured)
const REST = WORK.filter(w => !w.featured)
const NF = FEATURED.length
const NR = REST.length

/* ---- timeline ---- */
const DIVE_A = 0.095
const DIVE_B = 0.168
const S0 = 0.08
const S0_END = 0.22
const F1 = 0.82
const SPAN = (F1 - S0_END) / Math.max(1, NF - 1)
const TRAV = 0.046
const GZ_B = 0.872
const GZ_IN = 0.846
const ROW0 = 0.868
const ROW1 = 0.936
const GZ_OUT = 0.944
const OUT_A = 0.95

const slotStart = (k: number) => (k === 0 ? S0 : S0_END + (k - 1) * SPAN)
/** when the drone has arrived over site k */
const arriveAt = (k: number) => (k === 0 ? DIVE_B : slotStart(k) - 0.004 + TRAV)
/** when the drone leaves site k */
const departAt = (k: number) => (k === NF - 1 ? F1 : slotStart(k + 1) - 0.004)
/** the flight into site k: [start, end] */
const flightIn = (k: number): [number, number] => (k === 0 ? [DIVE_A, DIVE_B] : [slotStart(k) - 0.004, arriveAt(k)])
/** the flight out of site k */
const flightOut = (k: number): [number, number] => (k === NF - 1 ? [F1, GZ_B] : [departAt(k), arriveAt(k + 1)])
const rowAt = (j: number) => ROW0 + ((j + 0.5) * (ROW1 - ROW0)) / NR

/** card k visibility */
function cardV(k: number, l: number) {
  const a = arriveAt(k)
  const d = departAt(k)
  const inn = k === 0 ? smoothstep(0.146, 0.162, l) : smoothstep(a - 0.012, a + 0.002, l)
  const out = 1 - smoothstep(d - 0.008, d + 0.002, l)
  return inn * out
}

/** how far plate k has lifted off the chart (0 rest … 1 facing the drone) */
function riseOf(k: number, l: number) {
  const [ia, ib] = flightIn(k)
  const [oa, ob] = flightOut(k)
  const up = smoothstep(ia + (ib - ia) * 0.35, ib, l)
  const down = smoothstep(oa, oa + (ob - oa) * 0.55, l)
  return up * (1 - down)
}

/** the screenshot printed into plate k's window */
function developOf(k: number, l: number) {
  const a = arriveAt(k)
  const d = departAt(k)
  return smoothstep(a - 0.004, a + 0.022, l) * (1 - smoothstep(d - 0.004, d + 0.004, l))
}

/* ---- sizes ---- */
const MARKER_H = 1.15
const OTHER_H = 0.8
const REST_W = 4.2
const PLATE_DEPTH = 0.7
const FOV = 38
const DEG = Math.PI / 180
const UP = new THREE.Vector3(0, 1, 0)

const pad2 = (n: number) => String(n).padStart(2, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']

interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}
interface Shot {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
}
const shot = (): Shot => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: FOV })

interface Layout {
  key: string
  W: number
  H: number
  portrait: boolean
  safe: Region
  dockR: number
  cardTop: number[]
  gazR: number
  gazTop: number
  introR: number
  introTop: number
}

type Align = 'left' | 'right' | 'center'
interface Lab {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  draw: () => Stack
  /** world units per CSS px of lettering */
  k: number
  align: Align
  /** world width (for placement) */
  w: number
  h: number
}

const _d = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
const _p = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)

/** camera basis for yaw (0 = from the south, looking north) and pitch (down) */
function basis(yaw: number, pitch: number) {
  _d.set(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  _r.crossVectors(_d, UP).normalize()
  _u.crossVectors(_r, _d).normalize()
}

/** put world point P at NDC (nx, ny), `dist` along the view direction */
function place(out: Shot, P: THREE.Vector3, nx: number, ny: number, dist: number, yaw: number, pitch: number, aspect: number) {
  basis(yaw, pitch)
  const hh = dist * Math.tan((FOV * DEG) / 2)
  const hw = hh * aspect
  out.pos.copy(P).addScaledVector(_d, -dist).addScaledVector(_r, -nx * hw).addScaledVector(_u, -ny * hh)
  out.tgt.copy(out.pos).addScaledVector(_d, dist)
  out.fov = FOV
  return out
}

class Work implements Chapter {
  id = 'work'
  group = new THREE.Group()
  anchors = [...FEATURED.map((_, k) => (k === 0 ? 0.188 : slotStart(k) + 0.082)), ...REST.map((_, j) => rowAt(j))]

  private ctx!: ChapterContext
  private mobile = false
  private reduced = false
  private ready = false

  // 3D
  private chart!: ChartMaterial
  private plates: Plate[] = []
  /** plate k's pose when its site is active (per layout) */
  private act = FEATURED.map(() => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 }))
  private restY: number[] = []
  private siteH: number[] = []
  private markers: ReturnType<typeof marker>[] = []
  private others: ReturnType<typeof marker>[] = []
  private otherH: number[] = []
  private siteLabs: Lab[] = []
  private otherLabs: Lab[] = []
  private waterLabs: Lab[] = []
  private gridLabs: Lab[] = []
  /** contour elevations + spot heights */
  private elevLabs: Lab[] = []
  private labY = new Map<Lab, number>()
  private allLabs: Lab[] = []
  private base!: PrintLine
  private flown!: PrintLine
  private river!: PrintLine
  private res = new THREE.Vector2()
  private lines: PrintLine[] = []
  private cSignal = new THREE.Color(C.signal)
  private cInk = new THREE.Color(C.ink)
  /** route arc fraction at each featured site */
  private frac: number[] = []
  private fontsDrawn = false

  // DOM
  private safe!: HTMLElement
  private intro!: HTMLElement
  private introTitle!: HTMLElement
  private key!: HTMLElement
  private dock!: HTMLElement
  private cards: { root: HTMLElement; name: HTMLElement }[] = []
  private gazDock!: HTMLElement
  private gaz!: HTMLElement
  private gazTitle!: HTMLElement
  private rowsEl!: HTMLElement
  private rows: HTMLAnchorElement[] = []
  private hoverRow = -1
  private curRow = -2

  // layout / camera
  private lay: Layout | null = null
  private layDirty = true
  private cur = shot()
  private sa = shot()
  private sb = shot()
  private tmp = new THREE.Vector3()

  async init(ctx: ChapterContext) {
    this.ctx = ctx
    this.mobile = ctx.mobile
    this.reduced = ctx.reducedMotion
    this.buildDom(ctx.stage)
    await nextFrame()

    // ---- the land
    const geo = terrainGeometry({
      width: TERRAIN.width,
      depth: TERRAIN.depth,
      cx: TERRAIN.cx,
      cz: TERRAIN.cz,
      seg: this.mobile ? 130 : 200,
      detail: this.mobile ? 2 : 3,
      height,
    })
    this.chart = chartMaterial(ctx.world, {
      terrain: geo,
      interval: 0.25,
      hMin: 0,
      // the ramp tops out in rock: no snowfields on a coastal sheet
      hMax: heightRange(geo).hMax * 1.16,
      waterSpacing: 0.13,
      waterLines: 6,
      stepped: 0.75,
      gridSize: GRID.size,
      grid: 0,
      lift: 0.06,
      edge: 7,
    })
    const land = new THREE.Mesh(geo, this.chart)
    this.group.add(land)
    await nextFrame()

    // ---- fonts for the lettering (never block init for long on them)
    let fontsIn = false
    await Promise.race([ensureFonts().then(() => (fontsIn = true)), new Promise(r => setTimeout(r, 1200))])
    this.fontsDrawn = fontsIn

    // ---- route, river
    const path = spline(ROUTE, 0.2)
    const routePts = drape(path, height, { lift: 1, offset: 0, step: 0.2 })
    this.base = printLine(routePts, { width: 1.6, color: C.inkSoft, dashPx: 6, gapPx: 5 })
    this.flown = printLine(routePts, { width: 3, color: C.signal, dashPx: 11, gapPx: 6 })
    this.base.uniforms.uOpacity.value = 0.75
    this.flown.mesh.renderOrder = 4
    this.river = printLine(drape(riverLine(), height, { lift: 1, offset: 0, step: 0.2 }), { width: 1.6, color: C.waterLine, gapPx: 0 })
    this.lines = [this.base, this.flown, this.river]
    this.group.add(this.base.mesh, this.flown.mesh, this.river.mesh)
    // the arc fraction at each site (nearest route sample)
    const cum: number[] = [0]
    for (let i = 1; i < routePts.length; i++) cum.push(cum[i - 1] + routePts[i].distanceTo(routePts[i - 1]))
    const total = cum[cum.length - 1]
    this.frac = SITES.map(s => {
      let best = 0
      let bd = Infinity
      routePts.forEach((p, i) => {
        const d = (p.x - s.x) ** 2 + (p.z - s.z) ** 2
        if (d < bd) {
          bd = d
          best = i
        }
      })
      return cum[best] / total
    })

    // ---- markers
    SITES.forEach(s => {
      const m = marker({ color: C.signal, height: MARKER_H, radius: 0.36 })
      // the ground ring a hair above the bench so relief never bites into it
      m.ring.position.y = 0.05
      this.siteH.push(height(s.x, s.z))
      m.group.position.set(s.x, 0, s.z)
      this.group.add(m.group)
      this.markers.push(m)
    })
    OTHERS.forEach(o => {
      const m = marker({ color: C.ink, height: OTHER_H, radius: 0.3 })
      m.ring.position.y = 0.05
      this.otherH.push(height(o.x, o.z))
      m.group.position.set(o.x, 0, o.z)
      this.group.add(m.group)
      this.others.push(m)
    })
    await nextFrame()

    // ---- lettering
    const put = (lab: Lab, x: number, z: number) => {
      lab.mesh.position.set(x, 0, z)
      const cx = lab.align === 'left' ? x + lab.w / 2 : lab.align === 'right' ? x - lab.w / 2 : x
      this.labY.set(lab, Math.max(0, maxOver(cx, z, lab.w / 2, lab.h / 2)))
      this.group.add(lab.mesh)
    }
    const name = (t: string, size: number): Line[] =>
      breakName(t).map(text => ({ text, font: 'sans', size, weight: 700, color: C.ink, tracking: 0.1, uppercase: true }))
    SITES.forEach((s, k) => {
      const lines: Line[] = [{ text: `SITE ${pad2(k + 1)}`, font: 'mono', size: 38, weight: 600, color: C.signalText, tracking: 0.14 }, ...name(FEATURED[k].name, 48)]
      const align: Align = s.side > 0 ? 'left' : 'right'
      const lab = this.makeLab(() => stackTexture(lines, { align }), 0.6 / 48, align)
      put(lab, s.x + s.side * 0.6, s.z + 0.1)
      this.siteLabs.push(lab)
    })
    OTHERS.forEach((o, j) => {
      const lines: Line[] = [{ text: pad2(NF + j + 1), font: 'mono', size: 44, weight: 600, color: C.signalText, tracking: 0.06 }, ...name(REST[j].name, 48)]
      const align: Align = o.side > 0 ? 'left' : 'right'
      const lab = this.makeLab(() => stackTexture(lines, { align }), 0.84 / 48, align)
      put(lab, o.x + o.side * 0.45, o.z + 0.3)
      this.otherLabs.push(lab)
    })
    const water = (t: string, size: number): Line[] => [{ text: t, font: 'display', size, weight: 400, italic: true, color: C.coast, tracking: 0.05 }]
    const sound = this.makeLab(() => stackTexture(water('Echo Bay', 56)), 1.25 / 56, 'center')
    put(sound, -3.4, 4.2)
    const reach = this.makeLab(() => stackTexture(water('The Outer Reach', 56)), 1.05 / 56, 'center')
    put(reach, -9, 15.2)
    this.waterLabs.push(sound, reach)
    const gridLine = (t: string): Line[] => [{ text: t, font: 'mono', size: 40, weight: 600, color: C.ink }]
    for (let c = 0; c < GRID.cols; c++) {
      const lab = this.makeLab(() => stackTexture(gridLine(String.fromCharCode(65 + c))), 1.05 / 40, 'center')
      put(lab, GRID.x0 + (c + 0.5) * GRID.size, GRID.z0 - 0.95)
      this.gridLabs.push(lab)
    }
    for (let r = 0; r < GRID.rows; r++) {
      const lab = this.makeLab(() => stackTexture(gridLine(String(r + 1))), 1.05 / 40, 'center')
      put(lab, GRID.x0 - 0.95, GRID.z0 + (r + 0.5) * GRID.size)
      this.gridLabs.push(lab)
    }
    // contour elevations along index contours (the label knocks the line out,
    // as a printed chart does) and spot heights on the summits — decorative
    const INDEX_H = 0.25 * 5
    const qY = new THREE.Quaternion()
    for (const [sx, sz] of CONTOUR_SEEDS) {
      const level = Math.round(height(sx, sz) / INDEX_H) * INDEX_H
      if (level < INDEX_H - 1e-3) continue
      const at = onContour(sx, sz, level)
      if (!at) continue
      const [gx, gz] = grad(at[0], at[1])
      let tx = -gz
      let tz = gx
      if (tx < 0) {
        tx = -tx
        tz = -tz
      }
      const text = String(Math.round(level / 0.25) * 20)
      const lab = this.makeLab(() => stackTexture([{ text, font: 'mono', size: 34, weight: 500, color: C.index, tracking: 0.04 }], { haloWidth: 0.34 }), 0.42 / 34, 'center')
      lab.mesh.position.set(at[0], 0, at[1])
      lab.mesh.quaternion.copy(qY.setFromAxisAngle(UP, Math.atan2(-tz, tx)).multiply(_flat))
      this.labY.set(lab, Math.max(0, level))
      this.group.add(lab.mesh)
      this.elevLabs.push(lab)
    }
    for (const b of SPOT_BOXES) {
      const [x, z, h] = summit(b)
      const lab = this.makeLab(() => stackTexture([{ text: `× ${Math.round(h * 80)}`, font: 'mono', size: 34, weight: 500, color: C.ink, tracking: 0.02 }]), 0.4 / 34, 'left')
      lab.mesh.position.set(x - 0.14, 0, z)
      this.labY.set(lab, Math.max(0, maxOver(x + lab.w / 2, z, lab.w / 2, lab.h / 2)))
      this.group.add(lab.mesh)
      this.elevLabs.push(lab)
    }
    await nextFrame()

    // ---- plates
    const ph = placeholderTexture(C.paper2)
    FEATURED.forEach((w, k) => {
      const s = SITES[k]
      const p = buildPlate(w, k, gridRef(s.x, s.z), ph)
      p.root.renderOrder = 10
      p.mount.renderOrder = 10
      p.image.renderOrder = 11
      p.shadow.renderOrder = 9
      this.group.add(p.root, p.leaders)
      this.plates.push(p)
      this.restY.push(Math.max(0, maxOver(s.rx, s.rz, REST_W / 2, REST_W / MOUNT_ASPECT / 2)))
    })

    // redraw the lettering once the faces are in, if we drew before them
    if (!this.fontsDrawn)
      ensureFonts().then(() => {
        this.fontsDrawn = true
        for (const lab of this.allLabs) this.redrawLab(lab)
        for (const p of this.plates) p.redraw()
      })

    window.addEventListener('resize', () => (this.layDirty = true))
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => (this.layDirty = true))
      for (const c of this.cards) ro.observe(c.root)
      ro.observe(this.gaz)
      ro.observe(this.intro)
      ro.observe(this.safe)
    }
    document.fonts?.ready.then(() => (this.layDirty = true))

    // ---- screenshots: the first now, the rest once the site is revealed
    const load = (k: number) =>
      loadScreenshot(workImage(FEATURED[k].id), { width: 960 })
        .then(tex => {
          tex.anisotropy = 8
          try {
            ctx.renderer.initTexture(tex)
          } catch {
            /* uploads on first use */
          }
          const u = this.plates[k].imageMat.uniforms
          u.map.value = tex
          u.uHasMap.value = 1
        })
        .catch(err => console.warn(`[work] missing screenshot for ${FEATURED[k].id}`, err))
    load(0)
    whenRevealed().then(async () => {
      for (let k = 1; k < NF; k++) {
        await load(k)
        await nextFrame()
      }
    })
    this.ready = true
  }

  // ------------------------------------------------------------------ lettering

  private labGeo(st: Stack, k: number, align: Align) {
    const h = st.hpx * k
    const w = h * st.aspect
    const g = new THREE.PlaneGeometry(w, h)
    // aligned labels: the glyphs (not the halo padding) start / end at the anchor
    if (align === 'left') g.translate(w / 2 - st.padPx * k, 0, 0)
    else if (align === 'right') g.translate(-(w / 2 - st.padPx * k), 0, 0)
    return { g, w, h }
  }

  private makeLab(draw: () => Stack, k: number, align: Align): Lab {
    const st = draw()
    const mat = new THREE.MeshBasicMaterial({ map: st.texture, transparent: true, depthWrite: false, toneMapped: false })
    const { g, w, h } = this.labGeo(st, k, align)
    const mesh = new THREE.Mesh(g, mat)
    mesh.quaternion.copy(_flat)
    mesh.renderOrder = 2
    const lab: Lab = { mesh, mat, draw, k, align, w, h }
    this.allLabs.push(lab)
    return lab
  }

  private redrawLab(lab: Lab) {
    const st = lab.draw()
    lab.mat.map?.dispose()
    lab.mat.map = st.texture
    lab.mat.needsUpdate = true
    lab.mesh.geometry.dispose()
    lab.mesh.geometry = this.labGeo(st, lab.k, lab.align).g
  }

  // ------------------------------------------------------------------ DOM

  private buildDom(stage: HTMLElement) {
    this.safe = el('div', 'wk-safe', undefined, stage)

    // intro: the sheet's title block
    this.intro = el('div', 'wk-intro', undefined, stage)
    el('p', 'hud-eyebrow', SECTIONS.work.eyebrow, this.intro)
    const title = SECTIONS.work.title
    const cut = title.lastIndexOf(' ')
    this.introTitle = rise(
      el('h2', 'hud-h2 wk-title', undefined, this.intro),
      cut > 0 ? `${esc(title.slice(0, cut))} <em>${esc(title.slice(cut + 1))}</em>` : `<em>${esc(title)}</em>`,
    )
    const count = el('p', 'wk-count', undefined, this.intro)
    count.innerHTML = [`${WORK.length} sites`, `${NF} featured`, `${NR} more`].map(s => `<span>${esc(s)}</span>`).join('<i aria-hidden="true">·</i>')
    // the sheet's index to its aerial plates (marginalia; the sr layer carries the copy)
    this.key = el('div', 'wk-key', undefined, stage)
    this.key.setAttribute('aria-hidden', 'true')
    el('p', 'hud-label wk-key-h', 'Index to aerial plates', this.key)
    const idx = el('ol', 'wk-key-list', undefined, this.key)
    FEATURED.forEach((w, k) => {
      const li = el('li', '', undefined, idx)
      li.innerHTML = `<span class="wk-key-no">${pad2(k + 1)}</span><span class="wk-key-name">${esc(w.name)}</span><span class="wk-lead"></span><span class="wk-key-ref">${gridRef(SITES[k].x, SITES[k].z)}</span>`
    })
    el('p', 'hud-coord wk-key-foot', 'Sheet 02 · Survey · Scale 1:24,000', this.key)

    // one legend box per site, docked left (bottom on portrait)
    this.dock = el('div', 'wk-dock', undefined, stage)
    FEATURED.forEach((w, k) => this.cards.push(this.buildCard(this.dock, w, k)))

    // the gazetteer of the other nine
    this.gazDock = el('div', 'wk-dock wk-dock--gaz', undefined, stage)
    this.gaz = el('section', 'wk-gaz hud-panel', undefined, this.gazDock)
    const meta = el('div', 'wk-meta', undefined, this.gaz)
    el('span', 'hud-label wk-site', `Gazetteer · Sites ${pad2(NF + 1)}–${pad2(NF + NR)}`, meta)
    const allLive = REST.every(w => !isPreview(w.url))
    const nine = WORDS[NR] ?? String(NR)
    this.gazTitle = rise(
      el('h3', 'hud-h2 wk-gaz-title', undefined, this.gaz),
      allLive ? `${esc(nine)} more, <em>all live.</em>` : `${esc(nine)} <em>more.</em>`,
    )
    const ol = el('ol', 'wk-rows', undefined, this.gaz)
    this.rowsEl = ol
    ol.addEventListener('scroll', () => this.rowsEdges(), { passive: true })
    REST.forEach((w, j) => {
      const li = el('li', '', undefined, ol)
      const a = el('a', 'wk-row', undefined, li)
      a.href = w.url
      a.target = '_blank'
      a.rel = 'noopener'
      const o = OTHERS[j]
      a.innerHTML =
        `<span class="wk-no">${pad2(NF + j + 1)}</span>` +
        `<span class="wk-rname">${esc(w.name)}${isPreview(w.url) ? ' <small class="wk-pre">Preview</small>' : ''}</span>` +
        `<span class="wk-lead" aria-hidden="true"></span>` +
        `<span class="wk-ref" aria-hidden="true">${gridRef(o.x, o.z)}</span>` +
        `<span class="wk-rind">${esc(w.industry)}</span>`
      a.setAttribute('aria-label', `${w.name}, ${w.industry} (opens in a new tab)`)
      const on = () => (this.hoverRow = j)
      const off = () => {
        if (this.hoverRow === j) this.hoverRow = -1
      }
      a.addEventListener('pointerenter', on)
      a.addEventListener('pointerleave', off)
      a.addEventListener('focus', on)
      a.addEventListener('blur', off)
      this.rows.push(a)
    })
    const cta = el('div', 'wk-cta', undefined, this.gaz)
    const hello = el('button', 'hud-btn', 'Say hello', cta)
    hello.type = 'button'
    hello.addEventListener('click', () => window.__hark?.land('contact'))
  }

  private buildCard(parent: HTMLElement, w: WorkItem, k: number) {
    const root = el('article', 'wk-card hud-panel', undefined, parent)
    const pre = isPreview(w.url)
    const meta = el('div', 'wk-meta', undefined, root)
    const site = el('span', 'hud-label wk-site', undefined, meta)
    site.innerHTML = `<i class="wk-pin" aria-hidden="true"></i>Site ${pad2(k + 1)} / ${pad2(NF)}`
    el('span', 'hud-label wk-ind', w.industry, meta)
    const name = rise(el('h3', 'hud-h2 wk-name', undefined, root), esc(w.name))
    el('p', 'hud-body wk-blurb', w.blurb, root)
    const tags = el('ul', 'hud-tags wk-tags', undefined, root)
    for (const t of w.tags) el('li', 'hud-tag', t, tags)
    if (pre) el('li', 'hud-tag wk-tag-pre', 'Preview', tags)
    const cta = el('div', 'wk-cta', undefined, root)
    const a = el('a', 'hud-btn', pre ? 'Preview site ↗' : 'Visit site ↗', cta)
    a.href = w.url
    a.target = '_blank'
    a.rel = 'noopener'
    const s = SITES[k]
    el('span', 'hud-coord wk-host', `${pre ? 'Pre-launch build' : hostOf(w.url)} · Grid ${gridRef(s.x, s.z)}`, cta)
    return { root, name }
  }

  // ------------------------------------------------------------------ layout

  private ensureLayout(f: Frame): Layout {
    const key = `${f.width}x${f.height}`
    if (this.lay && this.lay.key === key && !this.layDirty) return this.lay
    this.layDirty = false
    const W = f.width
    const H = f.height
    const portrait = typeof matchMedia === 'function' ? matchMedia('(max-aspect-ratio: 10/9)').matches : W / H < 1.1
    const s = this.safe.getBoundingClientRect()
    const safe = s.width > 0 ? { x0: s.left, y0: s.top, x1: s.right, y1: s.bottom } : { x0: 24, y0: 90, x1: W - 24, y1: H - 90 }
    const dock = this.dock
    const measured = dock.offsetWidth > 0
    const gd = this.gazDock
    this.lay = {
      key,
      W,
      H,
      portrait,
      safe,
      dockR: measured ? dock.offsetLeft + dock.offsetWidth : W * 0.38,
      cardTop: this.cards.map(c => (measured && c.root.offsetHeight > 0 ? dock.offsetTop + c.root.offsetTop : H * 0.55)),
      gazR: this.gaz.offsetWidth > 0 ? gd.offsetLeft + this.gaz.offsetLeft + this.gaz.offsetWidth : W * 0.4,
      gazTop: this.gaz.offsetHeight > 0 ? gd.offsetTop + this.gaz.offsetTop : H * 0.45,
      introR: this.intro.offsetWidth > 0 ? this.intro.offsetLeft + this.intro.offsetWidth : W * 0.42,
      introTop: this.intro.offsetHeight > 0 ? this.intro.offsetTop : H * 0.6,
    }
    this.rowsEdges()
    this.computePlates()
    return this.lay
  }

  /** where the plate + its marker go on screen for site k (CSS px) */
  private siteFrame(k: number) {
    const L = this.lay!
    const s = L.safe
    const R: Region = L.portrait
      ? { x0: s.x0, x1: s.x1, y0: s.y0 - 4, y1: L.cardTop[k] - 12 }
      : { x0: L.dockR + L.W * 0.035, x1: s.x1, y0: s.y0 - 4, y1: s.y1 }
    const rw = Math.max(80, R.x1 - R.x0)
    const rh = Math.max(80, R.y1 - R.y0)
    const pw = L.portrait ? Math.min(rw, rh * 0.8 * MOUNT_ASPECT) : Math.min(rw * 0.97, L.W * 0.52, rh * 0.74 * MOUNT_ASPECT)
    const ph = pw / MOUNT_ASPECT
    const pcx = (R.x0 + R.x1) / 2
    const pcy = R.y0 + ph / 2
    const my = Math.min(R.y1 - L.H * 0.02, pcy + ph / 2 + Math.max(L.H * 0.1, (rh - ph) * 0.62))
    return { pw, pcx, pcy, mx: pcx - pw * 0.04, my }
  }

  private siteShot(k: number, drift: number, out: Shot) {
    const L = this.lay!
    const s = SITES[k]
    const f = this.siteFrame(k)
    const aspect = L.W / Math.max(1, L.H)
    _p.set(s.x, this.siteH[k] + MARKER_H * 0.5, s.z)
    const e = drift - 0.5
    return place(out, _p, (f.mx / L.W) * 2 - 1, 1 - (f.my / L.H) * 2, s.dist * (1 - 0.035 * e), s.yaw + e * 0.09, s.pitch - e * 0.025, aspect)
  }

  /** each plate's pose while its site is active: in front of the drone, above its marker */
  private computePlates() {
    const L = this.lay!
    const aspect = L.W / Math.max(1, L.H)
    const tanH = Math.tan((FOV * DEG) / 2)
    for (let k = 0; k < NF; k++) {
      const s = SITES[k]
      const f = this.siteFrame(k)
      const sh = this.siteShot(k, 0.5, this.sa)
      const dist = s.dist
      basis(s.yaw, s.pitch)
      const Dp = dist * PLATE_DEPTH
      const hh = Dp * tanH
      const hw = hh * aspect
      const nx = (f.pcx / L.W) * 2 - 1
      const ny = 1 - (f.pcy / L.H) * 2
      const a = this.act[k]
      a.pos.copy(sh.pos).addScaledVector(_d, Dp).addScaledVector(_r, nx * hw).addScaledVector(_u, ny * hh)
      a.scale = (f.pw / L.W) * 2 * hw
      _m.makeBasis(_r, _u, this.tmp.copy(_d).negate())
      a.quat.setFromRotationMatrix(_m)
    }
  }

  /** a top-down view of a ground rectangle fitted into a screen region */
  private groundShot(out: Shot, cx: number, cz: number, w: number, d: number, yaw: number, pitch: number, reg: Region, lift: number) {
    const L = this.lay!
    const aspect = L.W / Math.max(1, L.H)
    const tanH = Math.tan((FOV * DEG) / 2)
    const fw = Math.max(0.1, (reg.x1 - reg.x0) / L.W)
    const fh = Math.max(0.1, (reg.y1 - reg.y0) / L.H)
    const dist = Math.max(w / 2 / (fw * tanH * aspect), (d * Math.sin(pitch)) / 2 / (fh * tanH))
    _p.set(cx, 1.2 * lift, cz)
    const nx = (((reg.x0 + reg.x1) / 2) / L.W) * 2 - 1
    const ny = 1 - (((reg.y0 + reg.y1) / 2) / L.H) * 2
    return place(out, _p, nx, ny, dist, yaw, pitch, aspect)
  }

  private introShot(u: number, out: Shot) {
    const L = this.lay!
    const s = L.safe
    const reg: Region = L.portrait
      ? { x0: 0, x1: L.W, y0: s.y0, y1: Math.max(s.y0 + 120, L.introTop - 10) }
      : { x0: Math.min(L.introR + L.W * 0.01, L.W * 0.46), x1: s.x1 + L.W * 0.01, y0: s.y0 - L.H * 0.02, y1: s.y1 + L.H * 0.02 }
    const e = ease.inOutQuad(clamp(u))
    // portrait: crop in on the route (the sheet bleeds off the sides)
    const w = L.portrait ? 45 : TERRAIN.width - 9
    const d = L.portrait ? 30 : TERRAIN.depth - 10
    return this.groundShot(out, TERRAIN.cx + 0.5, TERRAIN.cz + (L.portrait ? 3.5 : 1.9), w * lerp(1, 0.96, e), d * lerp(1, 0.96, e), lerp(0, 0.03, e), lerp(1.4, 1.32, e), reg, 0.1)
  }

  private gazShot(u: number, out: Shot) {
    const L = this.lay!
    const s = L.safe
    const reg: Region = L.portrait
      ? { x0: 0, x1: L.W, y0: s.y0 - 6, y1: Math.max(s.y0 + 100, L.gazTop - 6) }
      : { x0: L.gazR + L.W * 0.025, x1: s.x1 + L.W * 0.012, y0: s.y0 - L.H * 0.03, y1: s.y1 + L.H * 0.03 }
    const w = GRID.cols * GRID.size + 2.5
    const d = GRID.rows * GRID.size + 2.5
    const e = ease.inOutQuad(clamp(u))
    return this.groundShot(out, GRID.x0 + (GRID.cols * GRID.size) / 2 - 0.6, GRID.z0 + (GRID.rows * GRID.size) / 2 - 0.2, w * lerp(1, 0.985, e), d, lerp(-0.02, 0.01, e), lerp(1.36, 1.33, e), reg, 0.4)
  }

  private travel(a: Shot, b: Shot, t: number, climb: number, out: Shot) {
    const e = ease.inOutCubic(clamp(t))
    out.pos.lerpVectors(a.pos, b.pos, e)
    out.tgt.lerpVectors(a.tgt, b.tgt, e)
    out.fov = lerp(a.fov, b.fov, e)
    out.pos.y += Math.sin(Math.PI * clamp(t)) * climb
    return out
  }

  private shotAt(l: number, out: Shot) {
    if (l < DIVE_A) return this.introShot(l / DIVE_A, out)
    if (l < DIVE_B) return this.travel(this.introShot(1, this.sa), this.siteShot(0, 0, this.sb), (l - DIVE_A) / (DIVE_B - DIVE_A), 0, out)
    for (let k = 0; k < NF; k++) {
      const a = arriveAt(k)
      const d = departAt(k)
      if (l < d) {
        if (l < a && k > 0) {
          const [fa, fb] = flightIn(k)
          return this.travel(this.siteShot(k - 1, 1, this.sa), this.siteShot(k, 0, this.sb), (l - fa) / (fb - fa), 3.2, out)
        }
        return this.siteShot(k, clamp((l - a) / (d - a)), out)
      }
    }
    if (l < GZ_B) return this.travel(this.siteShot(NF - 1, 1, this.sa), this.gazShot(0, this.sb), (l - F1) / (GZ_B - F1), 4, out)
    if (l < OUT_A) return this.gazShot((l - GZ_B) / (OUT_A - GZ_B), out)
    this.gazShot(1, out)
    const t = ease.inOutCubic(clamp((l - OUT_A) / (1 - OUT_A)))
    this.tmp.subVectors(out.pos, out.tgt)
    out.pos.copy(out.tgt).addScaledVector(this.tmp, 1 + 0.4 * t)
    return out
  }

  // ------------------------------------------------------------------ frame

  update(local: number, frame: Frame, ctx: ChapterContext) {
    if (!this.ready) return
    const l = clamp(local)
    const still = this.reduced || frame.reducedMotion || !!frame.still
    this.ensureLayout(frame)
    this.shotAt(l, this.cur)

    // ---- the chart: flat print → relief → settles back for the overview
    const lift =
      l < DIVE_B
        ? lerp(0.06, 1, ease.inOutCubic(smoothstep(DIVE_A, DIVE_B, l)))
        : l < F1
          ? 1
          : l < OUT_A
            ? lerp(1, 0.42, ease.inOutCubic(smoothstep(F1, GZ_B, l)))
            : lerp(0.42, 0.08, ease.inOutCubic(smoothstep(OUT_A, 1, l)))
    const u = this.chart.uniforms
    u.uLift.value = lift
    u.uRipple.value = still ? 0 : 0.08
    const gazV = smoothstep(GZ_IN, GZ_B, l) * (1 - smoothstep(OUT_A, 0.99, l))
    u.uGrid.value = 0.4 * gazV
    // the chart prints outward from the first site as the chapter opens
    const pr = smoothstep(0.0, 0.055, l)
    u.uReveal.value.set(SITES[0].x + 6, SITES[0].z - 6, lerp(6, 90, pr), 12)

    // the active site's contours turn vermilion
    let hk = -1
    let ha = 0
    for (let k = 0; k < NF; k++) {
      const a = arriveAt(k)
      const d = departAt(k)
      const v = smoothstep(a - 0.016, a + 0.006, l) * (1 - smoothstep(d - 0.004, d + 0.014, l))
      if (v > ha) {
        ha = v
        hk = k
      }
    }
    // gazetteer: the current row's marker
    const inRows = l >= ROW0 - 0.004 && l <= GZ_OUT
    const scrollRow = clamp(Math.floor(((l - ROW0) / (ROW1 - ROW0)) * NR), 0, NR - 1)
    const selRow = gazV < 0.3 ? -1 : this.hoverRow >= 0 ? this.hoverRow : inRows ? scrollRow : -1
    if (hk >= 0 && ha > 0.001) u.uHi.value.set(SITES[hk].x, SITES[hk].z, 3.6, ha)
    else if (selRow >= 0) u.uHi.value.set(OTHERS[selRow].x, OTHERS[selRow].z, 2.4, gazV)
    else u.uHi.value.w = 0

    // ---- route: planned (ink) draws in with the intro, flown (vermilion) follows the drone
    this.base.uniforms.uProgress.value = ease.outCubic(smoothstep(0.012, 0.058, l))
    let flown = 0
    if (l >= DIVE_A) {
      flown = this.frac[0] * smoothstep(DIVE_A, DIVE_B, l)
      for (let k = 1; k < NF; k++) {
        const [fa, fb] = flightIn(k)
        if (l >= fa) flown = lerp(this.frac[k - 1], this.frac[k], ease.inOutCubic(smoothstep(fa, fb, l)))
      }
      if (l >= F1) flown = lerp(this.frac[NF - 1], 1, smoothstep(F1, GZ_B, l))
    }
    this.flown.uniforms.uProgress.value = flown
    this.base.uniforms.uOpacity.value = lerp(0.7, 0.45, gazV)
    // printed line weights: constant on screen; dashes sized from the view scale
    ctx.renderer.getDrawingBufferSize(this.res)
    const wpp = (2 * this.cur.pos.distanceTo(this.cur.tgt) * Math.tan((this.cur.fov * DEG) / 2)) / Math.max(1, frame.height)
    for (const r of this.lines) {
      r.uniforms.uLift.value = lift
      r.uniforms.uYOff.value = 0.04
      r.uniforms.uRes.value.copy(this.res)
      r.uniforms.uDpr.value = ctx.world.chart.uDpr.value
      r.setScale(wpp)
    }

    // ---- markers grow in with the intro; the nine grow for the gazetteer
    for (let k = 0; k < NF; k++) {
      const m = this.markers[k]
      const g = ease.outCubic(smoothstep(0.02 + k * 0.004, 0.036 + k * 0.004, l))
      m.setGrow(g * lerp(1, 0.7, gazV))
      m.group.position.y = this.siteH[k] * lift
    }
    for (let j = 0; j < NR; j++) {
      const m = this.others[j]
      const a = GZ_IN + 0.004 + j * 0.0035
      const g = ease.outCubic(smoothstep(a, a + 0.018, l)) * (1 - smoothstep(OUT_A, 0.985, l))
      const sel = j === selRow ? 1 : 0
      m.setGrow(g * (1 + 0.45 * sel))
      m.group.visible = g > 0.001
      m.material.color.copy(sel ? this.cSignal : this.cInk)
      m.group.position.y = this.otherH[j] * lift
    }

    // ---- lettering
    const introLab = 1 - smoothstep(DIVE_A, DIVE_B, l)
    // lettering reads a size larger from the overview heights
    const ov = Math.max(1 - smoothstep(DIVE_A, DIVE_B, l), smoothstep(F1, GZ_B, l))
    const labS = lerp(0.56, 1.3, 1 - smoothstep(0.6, 1, 1 - ov)) * lerp(1, 0.78, smoothstep(F1, GZ_B, l))
    for (let k = 0; k < NF; k++) {
      this.siteLabs[k].mesh.scale.setScalar(labS)
      const labV = smoothstep(0.026 + k * 0.004, 0.042 + k * 0.004, l)
      const activeV = k === hk ? ha : 0
      const v = labV * lerp(Math.max(lerp(0.95, 0.6, 1 - introLab), activeV), 0.42, gazV)
      this.siteLabs[k].mat.opacity = v
    }
    for (let j = 0; j < NR; j++) {
      const a = GZ_IN + 0.01 + j * 0.0035
      this.otherLabs[j].mat.opacity = smoothstep(a, a + 0.02, l) * (1 - smoothstep(OUT_A, 0.985, l))
    }
    for (const lab of this.waterLabs) lab.mat.opacity = smoothstep(0.02, 0.045, l) * lerp(0.9, 0.6, gazV)
    for (const lab of this.gridLabs) lab.mat.opacity = gazV
    const elevV = smoothstep(0.03, 0.05, l) * lerp(0.95, 0.55, gazV)
    for (const lab of this.elevLabs) lab.mat.opacity = elevV
    for (const lab of this.allLabs) {
      lab.mesh.position.y = (this.labY.get(lab) ?? 0) * lift + 0.05
      lab.mesh.visible = lab.mat.opacity > 0.003
    }

    // ---- plates
    for (let k = 0; k < NF; k++) this.updatePlate(k, l, lift)

    // ---- world: fog so distant land fades into the paper margin
    const wp = ctx.world.params
    const dc = this.cur.pos.distanceTo(this.cur.tgt)
    wp.fogNear = dc * 1.5
    wp.fogFar = dc * 3.8

    // ---- gazetteer rows
    if (selRow !== this.curRow) {
      this.rows.forEach((r, j) => r.classList.toggle('is-cur', j === selRow))
      this.curRow = selRow
      if (selRow >= 0 && selRow !== this.hoverRow) this.showRow(selRow, still)
    }

    // ---- DOM
    const introV = smoothstep(0.018, 0.036, l) * (1 - smoothstep(0.128, 0.142, l))
    reveal(this.intro, introV, 0)
    reveal(this.key, introV, 0)
    setRise(this.introTitle, l > 0.026 && l < 0.14)
    for (let k = 0; k < NF; k++) {
      const v = cardV(k, l)
      reveal(this.cards[k].root, v, 10)
      setRise(this.cards[k].name, v > 0.3)
    }
    const gv = smoothstep(GZ_IN, GZ_IN + 0.016, l) * (1 - smoothstep(GZ_OUT - 0.002, GZ_OUT + 0.008, l))
    reveal(this.gazDock, gv, 10)
    if (gv <= 0.01) this.hoverRow = -1
    setRise(this.gazTitle, gv > 0.35)
  }

  private updatePlate(k: number, l: number, lift: number) {
    const p = this.plates[k]
    const s = SITES[k]
    const r = riseOf(k, l)
    const e = ease.inOutCubic(r)
    const a = this.act[k]
    // rest: flat on the chart beside the site
    _p.set(s.rx, this.restY[k] * lift + 0.05, s.rz)
    p.root.position.lerpVectors(_p, a.pos, e)
    p.root.position.y += Math.sin(Math.PI * e) * 1.2
    p.root.quaternion.slerpQuaternions(_flat, a.quat, ease.inOutQuad(clamp(r * 1.15)))
    p.root.scale.setScalar(lerp(REST_W, a.scale, e))
    // at rest the plate is part of the chart (depth-tested); risen, it floats over everything
    const up = r > 0.02
    p.mountMat.depthTest = !up
    p.imageMat.depthTest = !up
    const dev = developOf(k, l)
    p.imageMat.uniforms.uDevelop.value = dev
    p.image.visible = dev > 0.001
    p.shadowMat.opacity = 0.55 * smoothstep(0.1, 0.6, r)
    p.shadow.visible = p.shadowMat.opacity > 0.003
    // intro: the sheet-index faces print in with the chart
    const inV = smoothstep(0.024 + k * 0.004, 0.04 + k * 0.004, l)
    p.root.visible = inV > 0.001
    p.mountMat.opacity = inV
    // leaders: plate's bottom corners → the marker head
    const lv = smoothstep(0.55, 0.95, r)
    p.leaderMat.opacity = 0.75 * lv
    p.leaders.visible = lv > 0.003
    if (p.leaders.visible) {
      p.root.updateMatrixWorld()
      const arr = p.leaderPos.array as Float32Array
      const hy = this.siteH[k] * lift + MARKER_H * 0.98
      for (let i = 0; i < 2; i++) {
        this.tmp.set(i === 0 ? -0.5 : 0.5, PLATE_BOTTOM, 0).applyMatrix4(p.root.matrixWorld)
        arr[i * 6] = this.tmp.x
        arr[i * 6 + 1] = this.tmp.y
        arr[i * 6 + 2] = this.tmp.z
        arr[i * 6 + 3] = s.x
        arr[i * 6 + 4] = hy
        arr[i * 6 + 5] = s.z
      }
      p.leaderPos.needsUpdate = true
    }
  }

  /** Mark whether the rows box overflows and which ends are scrolled away (CSS fades them). */
  private rowsEdges() {
    const box = this.rowsEl
    if (!box) return
    const over = box.scrollHeight > box.clientHeight + 1
    box.classList.toggle('is-over', over)
    box.toggleAttribute('data-lenis-prevent', over)
    box.classList.toggle('at-top', box.scrollTop <= 1)
    box.classList.toggle('at-end', box.scrollTop + box.clientHeight >= box.scrollHeight - 1)
  }

  private showRow(j: number, instant: boolean) {
    const box = this.rowsEl
    if (!box || box.scrollHeight <= box.clientHeight + 1) return
    const b = box.getBoundingClientRect()
    const r = this.rows[j].getBoundingClientRect()
    const pad = 6
    let top = box.scrollTop
    if (r.top < b.top + pad) top += r.top - b.top - pad
    else if (r.bottom > b.bottom - pad) top += r.bottom - b.bottom + pad
    else return
    box.scrollTo({ top, behavior: instant ? 'auto' : 'smooth' })
  }

  camera(_local: number, frame: Frame, out: CameraPose) {
    out.position.copy(this.cur.pos)
    out.target.copy(this.cur.tgt)
    out.fov = this.cur.fov
    out.roll = 0
    out.parallax = this.reduced ? 0 : 0.18
    // the drone's idle hover (never under reduced motion / Motion off)
    if (!(this.reduced || frame.reducedMotion || frame.still)) {
      const t = frame.time
      const k = this.cur.pos.distanceTo(this.cur.tgt) / 15
      out.position.y += Math.sin(t * 0.42) * 0.045 * k
      out.position.x += Math.sin(t * 0.27 + 1.3) * 0.035 * k
    }
  }

  onLeave() {
    this.hoverRow = -1
  }
}

export default function create(): Chapter {
  return new Work()
}
