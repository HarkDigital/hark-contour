import { BRAND, SHEET } from '../content'
import { CHAPTERS } from '../chapters/index'
import { holdInert, releaseInert } from './inert'
import { ISLAND_VIEWBOX } from './island'
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
 * finish() is a MATCH CUT onto the hero's printed sheet. The hero publishes
 * its first-frame island on <html> (--hark-isl-x / --hark-isl-y: the mark's
 * centre, --hark-isl-h: its on-screen height, CSS px). The island (mark and
 * rings) glides and scales to exactly that place (~0.64 s, a FLIP transform;
 * its hairlines stay hairlines all the way) while the margins and the readout
 * fade; a field of contour lines prints round it, and the paper DRAINS, band
 * by band, outward from the island (each band snaps away whole, so the edge
 * is always a crisp contour line — the site's chapter cut, "contour flood",
 * in reverse). The WebGL sheet prints outward from the same island underneath,
 * and once it has, the loader's island fades into it. The neatline stays: the
 * chrome's collar sits on the same line.
 * No published island (or the story isn't at the hero's first frame): the
 * rings pulse outward and the drain opens from the loader's own island.
 * finish() resolves as the drain begins (main.ts fires 'hark:reveal', so the
 * hero's own entrance rides it); the node removes itself after.
 *
 * Rules: shows at least ~1.2 s, never hangs (every wait is a timer, never an
 * animation frame, so a background tab still finishes; the glide is drawn by
 * animation frames but lands by timer), the page behind is inert while it's
 * up, skip (?nointro) removes it at once. Reduced motion (or Motion switched
 * off earlier this session): no glide, no pulse, no drain — the sheet simply
 * crossfades onto the scene.
 *
 * API used by main.ts: createLoader(root, { skip }) → { progress(0..1), finish() }.
 */

const MIN_MS = 1200
/** once finish() is called: the last rings close */
const CLOSE_MS = 260
/** (no match) the rings pulse outward, the contour field prints across the sheet */
const PULSE_MS = 240
/** (match) the island glides onto the hero's island */
const MOVE_MS = 640
/** (match) the contour field prints this far into the glide */
const FIELD_AT = 0.55
/** the paper drains away, band by band */
const DRAIN_MS = 620
/** (match) the island holds once the drain begins, while the sheet prints it underneath … */
const HOLD_MS = 470
/** … then fades into it */
const ISL_FADE_MS = 420
/** drain bands (contour steps from the island to past the corners) */
const BANDS = 9
const WATER_RINGS = 6
/** island SVG viewBox width, and its width in mark heights (the viewBox spans 1560 units; the mark's coast 1000) */
const VB = parseFloat(ISLAND_VIEWBOX.split(' ')[2]) || 1560
const ISL_PER_MARK = VB / 1000
/** the hero's first frame holds its sheet this far into the chapter */
const HERO_FIRST = 0.07

const wait = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)
const inOutCubic = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2)

interface IslandRect {
  /** the mark's centre (CSS px, viewport) */
  x: number
  y: number
  /** the mark's on-screen height (CSS px) */
  h: number
}

/** The hero's first-frame island, as the hero chapter publishes it on <html>; null when absent. */
function heroIsland(W: number, H: number): IslandRect | null {
  try {
    // the story must be on the hero's first frame (a #hash or ?c= deep link lands elsewhere)
    const st = window.__hark?.engine?.state
    if (st && (st.slots[st.index]?.def.id !== 'hero' || st.local > HERO_FIRST)) return null
    const cs = getComputedStyle(document.documentElement)
    const x = parseFloat(cs.getPropertyValue('--hark-isl-x'))
    const y = parseFloat(cs.getPropertyValue('--hark-isl-y'))
    const h = parseFloat(cs.getPropertyValue('--hark-isl-h'))
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(h)) return null
    if (h < 16 || x < 0 || y < 0 || x > W || y > H) return null
    return { x, y, h }
  } catch {
    return null
  }
}

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
      <p class="ld-margin ld-margin--tr">${SHEET.name(1, CHAPTERS[0]?.label ?? 'Relief')}</p>
      <p class="ld-margin ld-margin--bl">Scale ${SHEET.scale}</p>
      <p class="ld-margin ld-margin--br">Contour interval 20 m</p>
      <div class="ld-core">
        <div class="ld-island">${islandSvg('ld-isl', { water: WATER_RINGS, ringAttrs: 'pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1"' })}</div>
        <p class="ld-read"><span class="ld-k">Surveying</span><span class="ld-num">000</span><span class="ld-unit">%</span></p>
      </div>
    </div>
  </div>`
  // the loader's neatline stands in for the chrome's (same line, same ink) until the match cut ends:
  // two semi-transparent hairlines stacked would print darker, then snap lighter at teardown
  const html = document.documentElement
  html.classList.add('ld-up')
  const handFrame = () => html.classList.remove('ld-up')
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
  const island = root.querySelector<HTMLElement>('.ld-island')!
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
  let moveRaf = 0
  let alive = true
  /** finish() has begun the exit: the progress loop stops */
  let exiting = false

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
    if (!exiting) raf = requestAnimationFrame(frame)
  }
  apply()
  raf = requestAnimationFrame(frame)

  const teardown = () => {
    if (!alive) return
    alive = false
    if (raf) cancelAnimationFrame(raf)
    if (moveRaf) cancelAnimationFrame(moveRaf)
    window.removeEventListener('resize', sizePaper)
    unsize()
    releaseInert('loader')
    handFrame()
    root.remove()
  }

  /* ------------------------------------------------ the exit (finish) */

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

  /** print the contour field round (cx, cy), first line at r0 (index every 5th); the drain follows it */
  const printField = (cx: number, cy: number, r0: number) => {
    const reach = Math.max(r0 * 1.5, Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.32)
    const blobs: string[] = []
    for (let k = 0; k < BANDS; k++) {
      const f = k / (BANDS - 1)
      blobs.push(blob(k, cx, cy, r0 + (reach - r0) * Math.pow(f, 1.12)))
    }
    field.innerHTML = blobs
      .map((d, k) => `<path class="ld-line${(k + 1) % 5 === 0 ? ' is-index' : ''}" d="${d}"/>`)
      .join('')
    wrap.classList.add('is-field')
    return { blobs, lines: [...field.querySelectorAll<SVGPathElement>('path')] }
  }

  /** band by band: the hole snaps out to the next contour; its edge is the front */
  const drain = async ({ blobs, lines }: ReturnType<typeof printField>) => {
    draining = true
    // the scene shows through from here on: let the pointer reach it
    root.style.pointerEvents = 'none'
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

  /**
   * The match cut: the island (mark and rings) glides onto the hero's island, a
   * FLIP transform about its centre. Drawn by animation frames, landed by a timer
   * (a background tab still ends in place). --u follows the scale, so the
   * coast and the rings keep their true hairline widths all the way.
   */
  const glide = (to: IslandRect) => {
    const box = island.getBoundingClientRect()
    const w = Math.max(1, box.width)
    const k1 = (to.h * ISL_PER_MARK) / w
    const dx = to.x - (box.left + box.width / 2)
    const dy = to.y - (box.top + box.height / 2)
    const set = (e: number) => {
      const k = 1 + (k1 - 1) * e
      island.style.transform = `translate(${(dx * e).toFixed(2)}px, ${(dy * e).toFixed(2)}px) scale(${k.toFixed(4)})`
      isl.style.setProperty('--u', (VB / (w * k)).toFixed(3))
    }
    const t0 = performance.now()
    const step = (ms: number) => {
      moveRaf = 0
      const v = clamp01((ms - t0) / MOVE_MS)
      set(inOutCubic(v))
      if (v < 1 && alive) moveRaf = requestAnimationFrame(step)
    }
    moveRaf = requestAnimationFrame(step)
    return wait(MOVE_MS).then(() => {
      if (moveRaf) cancelAnimationFrame(moveRaf)
      moveRaf = 0
      set(1)
    })
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
      exiting = true
      if (calm) {
        // no glide, no pulse, no drain: the sheet simply crossfades onto the scene
        wrap.classList.add('is-out')
        handFrame()
        releaseInert('loader')
        root.style.pointerEvents = 'none'
        window.setTimeout(teardown, 420)
        await wait(60)
        return
      }
      releaseInert('loader')
      const to = heroIsland(W, H)
      if (!to) {
        // no island to cut to: the rings pulse outward, the paper drains from the loader's own island
        window.setTimeout(teardown, PULSE_MS + DRAIN_MS * 1.6 + 400)
        // the sheet (and its neatline) fades: the chrome's own collar shows as the paper drains
        handFrame()
        const box = isl.getBoundingClientRect()
        const cx = box.width ? box.left + box.width / 2 : W / 2
        const cy = box.height ? box.top + box.height / 2 : H / 2
        const f = printField(cx, cy, Math.max(24, Math.min(box.width || 120, 260) * 0.22))
        wrap.classList.add('is-pulse')
        void wait(PULSE_MS)
          .then(() => drain(f))
          .catch(() => {})
          .then(() => teardown())
        // hand over as the drain begins, so the scene's own reveal rides it
        await wait(PULSE_MS)
        return
      }
      // the match cut: every step is a timer, so a hidden tab still finishes; a
      // safety net removes the sheet even if something below throws
      window.setTimeout(teardown, MOVE_MS + DRAIN_MS * 1.6 + HOLD_MS + ISL_FADE_MS + 400)
      wrap.classList.add('is-match')
      const run = async () => {
        const landed = glide(to)
        await wait(MOVE_MS * FIELD_AT)
        // the survey prints round the island's destination; the paper drains from just outside its rings
        const f = printField(to.x, to.y, to.h * 1.02)
        await landed
        const drained = drain(f)
        // the sheet prints the same island underneath; then the loader's island fades into it
        await wait(HOLD_MS)
        wrap.classList.add('is-landed')
        await Promise.all([drained, wait(ISL_FADE_MS)])
      }
      void run()
        .catch(() => {})
        .then(() => teardown())
      // hand over as the drain begins (the island has landed), so the scene's own reveal rides it
      await wait(MOVE_MS)
    },
  }
}
