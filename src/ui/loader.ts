import { BRAND, MICROCOPY } from '../content'
import { holdInert, releaseInert } from './inert'
import { islandRingCount, islandSvg, sizeIsland } from './mark'

/*
 * Boot screen: "the sheet is surveyed".
 *
 * A blank sheet of chart paper inside a hairline neatline (the same collar
 * the chrome keeps). In the middle the Hark mark is drawn as a small
 * topographic island: first its coastline, then the contours rising inland
 * (the land fills with layer tints behind them), then the water-lining rings
 * spread outward one by one, like sound — as progress() rises
 * (stroke-dashoffset). A mono readout counts the survey: "Surveying 062 %".
 *
 * finish(): the island's rings pulse outward and become a field of contour
 * lines across the whole sheet; then the paper DRAINS, band by band from the
 * middle outward (each band snaps away whole, so the edge is always a crisp
 * contour line — the site's chapter cut, "contour flood", in reverse) to
 * reveal the scene (~0.9 s). finish() resolves as the drain begins (main.ts
 * fires 'hark:reveal', so the hero's own entrance rides it); the node
 * removes itself after.
 *
 * Rules: shows at least ~1.2 s, never hangs (every wait is a timer, never an
 * animation frame, so a background tab still finishes), the page behind is
 * inert while it's up, skip (?nointro) removes it at once. Reduced motion (or
 * Motion switched off earlier this session): no pulse, no drain — the sheet
 * simply fades.
 *
 * API used by main.ts: createLoader(root, { skip }) → { progress(0..1), finish() }.
 */

const MIN_MS = 1200
/** once finish() is called: the last rings close */
const CLOSE_MS = 260
/** the rings pulse outward, the contour field prints across the sheet */
const PULSE_MS = 240
/** the paper drains away, band by band */
const DRAIN_MS = 620
/** drain bands (contour steps from the middle to past the corners) */
const BANDS = 9
const WATER_RINGS = 6

const wait = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)

export function createLoader(root: HTMLElement, { skip = false } = {}) {
  if (skip) {
    root.remove()
    return { progress() {}, finish: () => Promise.resolve() }
  }

  let motionOff = false
  try {
    motionOff = sessionStorage.getItem('hark-contour:motion') === '0'
  } catch {
    /* blocked storage */
  }
  const calm = motionOff || matchMedia('(prefers-reduced-motion: reduce)').matches
  const rings = islandRingCount(WATER_RINGS)

  root.innerHTML = `
  <div class="ld${calm ? ' is-calm' : ''}">
    <svg class="ld-paper" aria-hidden="true" focusable="false" preserveAspectRatio="none"><path class="ld-paper-p" fill-rule="evenodd"/><g class="ld-field" fill="none"></g></svg>
    <p class="sr-only" role="status">Loading ${BRAND.name}</p>
    <div class="ld-sheet" aria-hidden="true">
      <div class="ld-frame"><i></i><i></i><i></i><i></i></div>
      <p class="ld-margin ld-margin--tl">${BRAND.short}</p>
      <p class="ld-margin ld-margin--tr">Sheet 01 · 1:24 000</p>
      <p class="ld-margin ld-margin--bl">${MICROCOPY.coordinates}</p>
      <p class="ld-margin ld-margin--br">Contour interval 20 m</p>
      <div class="ld-core">
        <div class="ld-island">${islandSvg('ld-isl', { water: WATER_RINGS, ringAttrs: 'pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"' })}</div>
        <p class="ld-read"><span class="ld-k">Surveying</span><span class="ld-num">000</span><span class="ld-unit">%</span></p>
      </div>
    </div>
  </div>`
  holdInert('loader', [
    document.getElementById('track'),
    document.getElementById('stages'),
    document.getElementById('chrome'),
    document.querySelector<HTMLElement>('.skip-link'),
  ])

  const wrap = root.querySelector<HTMLElement>('.ld')!
  const paperSvg = root.querySelector<SVGSVGElement>('.ld-paper')!
  const paper = root.querySelector<SVGPathElement>('.ld-paper-p')!
  const field = root.querySelector<SVGGElement>('.ld-field')!
  const isl = root.querySelector<SVGSVGElement>('.ld-isl')!
  const num = root.querySelector<HTMLElement>('.ld-num')!
  const ringEls: SVGPathElement[][] = Array.from({ length: rings }, () => [])
  root.querySelectorAll<SVGPathElement>('[data-ring]').forEach(p => ringEls[Number(p.dataset.ring)]?.push(p))
  const lands = [...root.querySelectorAll<SVGPathElement>('.isl-land')]

  const unsize = sizeIsland(isl)

  // the sheet of paper (a full rect; the drain cuts holes in it)
  let W = window.innerWidth
  let H = window.innerHeight
  const sizePaper = () => {
    W = Math.max(1, window.innerWidth)
    H = Math.max(1, window.innerHeight)
    paperSvg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    if (!draining) paper.setAttribute('d', `M0 0H${W}V${H}H0Z`)
  }
  let draining = false
  sizePaper()
  window.addEventListener('resize', sizePaper)

  const start = performance.now()
  let target = 0
  let shown = 0
  let finishing = false
  let lastPct = -1
  let lastT = start
  let raf = 0
  let alive = true

  // each ring draws over `span` of the progress; they start one after another
  const span = Math.min(0.5, 2.4 / rings)
  const apply = () => {
    for (let i = 0; i < rings; i++) {
      const t0 = rings > 1 ? (i * (1 - span)) / (rings - 1) : 0
      const v = clamp01((shown - t0) / span)
      const e = 1 - (1 - v) * (1 - v)
      const off = (1 - e).toFixed(4)
      for (const p of ringEls[i]) if (p.getAttribute('stroke-dashoffset') !== off) p.setAttribute('stroke-dashoffset', off)
      // the land tints fill in behind the coast (0) and each inland contour (1, 2)
      const land = lands[i]
      if (land) land.style.opacity = clamp01((v - 0.35) / 0.65).toFixed(3)
    }
    const pct = Math.round(shown * 100)
    if (pct !== lastPct) {
      lastPct = pct
      num.textContent = String(pct).padStart(3, '0')
    }
  }

  const frame = (ms: number) => {
    raf = 0
    if (!alive) return
    const dt = Math.min(0.05, Math.max(0, (ms - lastT) / 1000))
    lastT = ms
    // cosmetic easing toward the real progress; before finish() it may only
    // creep toward ~90% at the pace of the minimum time, so every ring has
    // time to draw and 100 always means "done"
    const cap = finishing ? 1 : Math.min(0.9, ((ms - start) / MIN_MS) * 0.9)
    const goal = Math.min(finishing ? 1 : target, cap)
    shown += (goal - shown) * (1 - Math.exp(-dt * (finishing ? 10 : 3.2)))
    if (Math.abs(goal - shown) < 0.002) shown = goal
    apply()
    if (!draining) raf = requestAnimationFrame(frame)
  }
  apply()
  raf = requestAnimationFrame(frame)

  const teardown = () => {
    if (!alive) return
    alive = false
    if (raf) cancelAnimationFrame(raf)
    window.removeEventListener('resize', sizePaper)
    unsize()
    releaseInert('loader')
    root.remove()
  }

  /* ------------------------------------------------ the drain (finish) */

  // nested contour blobs around the island, from the middle to past the corners
  const blob = (k: number, cx: number, cy: number, r: number) => {
    const n = 72
    let d = ''
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2
      const w =
        1 +
        0.075 * Math.sin(2 * a + 0.6 + 0.3 * k) +
        0.05 * Math.sin(3 * a + 2.1 - 0.2 * k) +
        0.028 * Math.sin(5 * a + 4 + 0.45 * k)
      const x = cx + Math.cos(a) * r * w
      const y = cy + Math.sin(a) * r * w * 0.86
      d += `${j ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
    }
    return `${d}Z`
  }

  const drain = async () => {
    draining = true
    const box = isl.getBoundingClientRect()
    const cx = box.width ? box.left + box.width / 2 : W / 2
    const cy = box.height ? box.top + box.height / 2 : H / 2
    const reach = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.32
    const r0 = Math.max(24, Math.min(box.width || 120, 260) * 0.22)
    const blobs: string[] = []
    for (let k = 0; k < BANDS; k++) {
      const f = k / (BANDS - 1)
      blobs.push(blob(k, cx, cy, r0 + (reach - r0) * Math.pow(f, 1.12)))
    }
    // the contour field printed across the sheet (index every 5th)
    field.innerHTML = blobs
      .map((d, k) => `<path class="ld-line${(k + 1) % 5 === 0 ? ' is-index' : ''}" d="${d}"/>`)
      .join('')
    const lines = [...field.querySelectorAll<SVGPathElement>('path')]
    wrap.classList.add('is-pulse')
    await wait(PULSE_MS)
    // band by band: the hole snaps out to the next contour; its edge is the front
    const rect = `M0 0H${W}V${H}H0Z`
    for (let k = 0; k < BANDS; k++) {
      paper.setAttribute('d', rect + blobs[k])
      lines.forEach((l, j) => {
        l.classList.toggle('is-gone', j < k)
        l.classList.toggle('is-front', j === k)
      })
      if (k === 0) wrap.classList.add('is-drain')
      // accelerating: the water leaves slowly, then all at once
      const f = k / (BANDS - 1)
      await wait((DRAIN_MS / BANDS) * (1.5 - f))
    }
  }

  return {
    progress(p: number) {
      const v = clamp01(Number.isFinite(p) ? p : 0)
      target = Math.max(target, v)
    },
    async finish(): Promise<void> {
      if (!alive) return
      const left = MIN_MS - (performance.now() - start)
      if (left > 0) await wait(left)
      // the last rings close, the count reaches 100
      finishing = true
      target = 1
      await wait(CLOSE_MS)
      shown = 1
      apply()
      if (calm) {
        // no pulse, no drain: the sheet simply fades onto the scene
        wrap.classList.add('is-out')
        releaseInert('loader')
        window.setTimeout(teardown, 420)
        await wait(60)
        return
      }
      releaseInert('loader')
      // every step is a timer, so a hidden tab still finishes; a safety net
      // removes the sheet even if something above throws
      window.setTimeout(teardown, PULSE_MS + DRAIN_MS * 1.6 + 400)
      void drain()
        .catch(() => {})
        .then(() => teardown())
      // hand over as the drain begins, so the scene's own reveal rides it
      await wait(PULSE_MS)
    },
  }
}
