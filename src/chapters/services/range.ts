import * as THREE from 'three'
import { SERVICES } from '../../content'
import { simplex2, fbm, ridged, type Noise2 } from '../../kit/noise'
import type { HeightFn } from '../../kit/terrain'

/*
 * THE RANGE — eleven summits on one ridgeline, a sound in front of them.
 *
 * Plan view (north = -z): the crest runs west → east in a shallow arc that
 * bows toward the viewer (+z), so a drone flying along its south face
 * orbits the massif. The relief is built the way a cartographer would
 * sketch it before drawing contours:
 *
 *   crest    an arête: a crest-height profile along x (pointed summits,
 *            rounded cols at ~60% of their neighbours) times a sharp,
 *            concave cross-profile, so the contours pinch into V's on the
 *            ridge and spread on the lower flanks
 *   summits  a pyramid on each peak (pointed, slightly rounded tip)
 *   spurs    two ridges run south off every summit (toward the viewer) and
 *            one north, dying away downhill: the classic re-entrant V
 *            pattern of a mountain face, with gullies between
 *   texture  a whisper of ridged noise on the steep ground only
 *   base     smoothly graded foothills falling to a winding coast, a low
 *            plain behind — monotonic slopes, so there are no stray
 *            closed "blob" contours on flat ground
 *   valleys  three V-valleys run from the cols to the sea (contours bend
 *            into upstream V's across them; a river threads each floor)
 *   sound    south of the coast the land drops under the water, with two
 *            islets for their own water-lining rings
 *
 * Heights are world units; one contour interval (0.3) = 100 m decorative,
 * sea level at 0. The height fn runs ~350k times at build, so x-only
 * terms are cached per column and far spurs/cones are rejected early.
 */

export interface Summit {
  index: number
  x: number
  z: number
  /** actual ground height at the summit */
  h: number
  /** decorative elevation figure, metres (NOT a claim) */
  elev: string
  /** label stagger row for the wide view (0 = shortest leader) */
  row: number
}

/** contour interval (world units) and the chart's decorative scale: one interval = 100 m */
export const INTERVAL = 0.3
export const METRES = 100 / INTERVAL

/** summit spacing along the crest (world units) */
export const SPACING = 6.1
const N = SERVICES.length
/** designed peak heights: the range climbs to 07 (the drone's summit) and falls away east */
const PEAKS = [3.5, 4.4, 3.9, 4.8, 4.2, 5.2, 5.9, 4.9, 5.45, 4.45, 3.75]
/** col heights between summit k and k+1, as a fraction of the lower neighbour */
const COLS = [0.62, 0.56, 0.64, 0.58, 0.66, 0.7, 0.6, 0.66, 0.57, 0.63]
/** where each col sits between its summits (0..1) */
const COLAT = [0.46, 0.55, 0.43, 0.52, 0.58, 0.45, 0.54, 0.47, 0.56, 0.5]
/** summits step a little off the arc (in z), alternating, so the crest wanders */
const OFFSET = [0.5, -0.8, 0.6, -0.4, 0.9, -0.7, 0.3, -0.9, 0.7, -0.5, 0.4]
const JITTER_X = [-0.3, 0.4, -0.2, 0.3, -0.4, 0.1, 0.0, 0.35, -0.25, 0.2, -0.1]
/** south spur bearings (radians off due south, west spur negative) */
const SPUR_W = [-0.62, -0.48, -0.7, -0.55, -0.44, -0.66, -0.5, -0.6, -0.46, -0.68, -0.55]
const SPUR_E = [0.5, 0.64, 0.46, 0.7, 0.56, 0.42, 0.62, 0.5, 0.66, 0.48, 0.58]
/** wide-view label rows (3 staggers so long names never collide) */
const ROWS = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1]

/** the crest's plan: a shallow arc bowing toward the viewer */
export const ridgeZ = (x: number) => -0.0062 * x * x

export interface Range {
  height: HeightFn
  summits: Summit[]
  /** crest polyline (x, z) from summit 01 to 11, through the cols */
  crest: [number, number][]
  /** plan distance of each summit along `crest` */
  crestAt: number[]
  crestLength: number
  /** the sound's centre (for the water label) */
  sound: THREE.Vector2
  /** where the coast lies due south of each summit (x, z) — the drone frames the shore */
  coast: [number, number][]
  /** river centrelines (x, z), col → sea */
  rivers: [number, number][][]
  hMax: number
}

/** polynomial smooth max */
function smax(a: number, b: number, k: number) {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k))
  return b + (a - b) * h + k * h * (1 - h)
}

interface Spur {
  ox: number
  oz: number
  dx: number
  dz: number
  h: number
  len: number
  decay: number
}

export function buildRange(): Range {
  const n1: Noise2 = simplex2(211)
  const n2: Noise2 = simplex2(977)
  const x0 = -((N - 1) / 2) * SPACING
  const sx: number[] = []
  const sz: number[] = []
  for (let i = 0; i < N; i++) {
    const x = x0 + i * SPACING + JITTER_X[i]
    sx.push(x)
    sz.push(ridgeZ(x) + OFFSET[i])
  }
  const spurs: Spur[] = []
  for (let i = 0; i < N; i++) {
    const add = (a: number, h: number, len: number, decay: number) =>
      spurs.push({
        ox: sx[i],
        oz: sz[i],
        dx: Math.sin(a),
        dz: Math.cos(a),
        h: PEAKS[i] * h,
        len,
        decay,
      })
    add(SPUR_W[i], 0.8, 11, 3.5)
    add(SPUR_E[i], 0.78, 11, 3.3)
    add(Math.PI + (i % 2 ? 0.28 : -0.3), 0.72, 8, 2.8)
  }

  // x-only terms, cached per column (the terrain samples the same x on every row)
  const segOf = (x: number) => {
    let k = Math.max(0, Math.min(N - 2, Math.floor((x - sx[0]) / SPACING)))
    while (k < N - 2 && x > sx[k + 1]) k++
    while (k > 0 && x < sx[k]) k--
    return k
  }
  const crestHeight = (x: number) => {
    if (x <= sx[0]) return PEAKS[0] * Math.exp(-(sx[0] - x) / 4.2)
    if (x >= sx[N - 1]) return PEAKS[N - 1] * Math.exp(-(x - sx[N - 1]) / 4.2)
    const k = segOf(x)
    const t = (x - sx[k]) / (sx[k + 1] - sx[k])
    const ts = COLAT[k]
    const col = COLS[k] * Math.min(PEAKS[k], PEAKS[k + 1])
    if (t < ts) {
      const a = 1 - t / ts
      return col + (PEAKS[k] - col) * Math.pow(a, 1.65)
    }
    const a = (t - ts) / (1 - ts)
    return col + (PEAKS[k + 1] - col) * Math.pow(a, 1.65)
  }
  const crestZ = (x: number) => {
    if (x <= sx[0]) return ridgeZ(x) + OFFSET[0]
    if (x >= sx[N - 1]) return ridgeZ(x) + OFFSET[N - 1]
    const k = segOf(x)
    const t = (x - sx[k]) / (sx[k + 1] - sx[k])
    const s = t * t * (3 - 2 * t)
    return ridgeZ(x) + OFFSET[k] + (OFFSET[k + 1] - OFFSET[k]) * s
  }
  const coastZ = (x: number) => 10.8 + 2.4 * n2(x * 0.045, 3.1) + 1.2 * n2(x * 0.11, 7.7) - 0.0022 * x * x
  const cache = new Map<number, [number, number, number]>()
  const column = (x: number) => {
    let c = cache.get(x)
    if (!c) {
      c = [crestHeight(x), crestZ(x), coastZ(x)]
      cache.set(x, c)
    }
    return c
  }

  // three valleys run from the cols down to the coast: the contours bend
  // into upstream V's across them, and a river threads each floor
  const valleys = [2, 5, 8].map((k, v) => {
    const x = sx[k] + (sx[k + 1] - sx[k]) * COLAT[k]
    return {
      x,
      z0: crestZ(x) + 1.4,
      amp: [0.9, -1.1, 0.8][v],
      ph: [0.4, 1.7, 2.9][v],
    }
  })
  const valleyX = (vx: { x: number; z0: number; amp: number; ph: number }, z: number) =>
    vx.x + vx.amp * Math.sin((z - vx.z0) * 0.34 + vx.ph) * Math.min(1, (z - vx.z0) / 4)

  const W = 2.9
  const R = 2.5
  const height: HeightFn = (x, z) => {
    const [ch, cz0, coast] = column(x)
    const d = z - cz0
    // the arête: sharp crest, concave flanks (a slightly rounded edge)
    const ad = Math.sqrt(d * d + 0.09) - 0.3
    let m = ch * Math.exp(-ad / W)
    // pyramids on the summits + spurs, merged with a smooth max
    const k0 = Math.max(0, segOf(x) - 1)
    const k1 = Math.min(N - 1, k0 + 3)
    for (let i = k0; i <= k1; i++) {
      const rx = x - sx[i]
      const rz = z - sz[i]
      const r = Math.sqrt(rx * rx + rz * rz + 0.04) - 0.2
      if (r < 12) m = smax(m, PEAKS[i] * Math.exp(-r / R), 0.35)
    }
    for (let j = k0 * 3; j < (k1 + 1) * 3; j++) {
      const s = spurs[j]
      const px = x - s.ox
      const pz = z - s.oz
      const along = px * s.dx + pz * s.dz
      if (along < 0 || along > s.len) continue
      const across = Math.abs(px * s.dz - pz * s.dx)
      const w = 0.75 + 0.14 * along
      if (across > 5 * w) continue
      const fade = along > s.len - 3 ? (s.len - along) / 3 : 1
      const v = s.h * Math.exp(-along / s.decay) * Math.exp(-across / w) * fade
      m = smax(m, v, 0.3)
    }
    // a whisper of gullies on the steep ground only
    const steep = Math.min(1, m / 2.4)
    const top = Math.min(1, Math.max(0, (m - 3.4) / 1.2))
    const gully = 0.36 * steep * (1 - top)
    if (gully > 0.004) m += (ridged(n1, x * 0.34, z * 0.34, 3) - 0.5) * gully

    // graded base: foothills fall south to the coast, a low plain lies behind
    let base: number
    if (d > 0) base = 0.46 + 0.95 * Math.exp(-d / 6.5)
    else base = 0.44 + 0.97 * Math.exp(d / 5.5)
    base += 0.09 * fbm(n2, x * 0.05, z * 0.05, 2)
    let h = base + m

    // the valleys (V-shaped, widening downstream)
    for (let v = 0; v < 3; v++) {
      const vx = valleys[v]
      const dz = z - vx.z0
      if (dz <= 0) continue
      const dx = (x - valleyX(vx, z)) / (1.25 + 0.1 * dz)
      if (dx * dx > 60) continue
      const ramp = Math.min(1, dz / 5.5)
      // a rounded V: contours bend into soft upstream chevrons
      h -= (0.46 * ramp * ramp * (3 - 2 * ramp)) / (1 + dx * dx * (1 + 0.6 * Math.abs(dx)))
    }

    // the sound: the land drops under the coast
    const t = Math.min(1, Math.max(0, (z - (coast - 3.2)) / 8.5))
    h -= 2.4 * t * t * (3 - 2 * t)
    // two islets out in the sound (east of the headline), with their own rings
    const i1x = (x - 13.5) / 1.5
    const i1z = (z - 17.2) / 1.05
    h += 2.95 / (1 + (i1x * i1x + i1z * i1z) * 1.5)
    const i2x = (x - 19.2) / 1.0
    const i2z = (z - 19.4) / 0.8
    h += 2.65 / (1 + (i2x * i2x + i2z * i2z) * 1.8)
    return h
  }

  const summits: Summit[] = []
  let hMax = 0
  for (let i = 0; i < N; i++) {
    // settle the benchmark on the true local top
    let bx = sx[i]
    let bz = sz[i]
    let bh = height(bx, bz)
    for (let it = 0; it < 4; it++) {
      const st = 0.3 / (it + 1)
      for (const [ox, oz] of [
        [st, 0],
        [-st, 0],
        [0, st],
        [0, -st],
      ]) {
        const hh = height(bx + ox, bz + oz)
        if (hh > bh) {
          bh = hh
          bx += ox
          bz += oz
        }
      }
    }
    hMax = Math.max(hMax, bh)
    // decorative elevation (metres; sea level is h = 0, one contour = 100 m): marginalia, not a claim
    const metres = Math.round(bh * METRES)
    summits.push({
      index: i,
      x: bx,
      z: bz,
      h: bh,
      elev: metres.toLocaleString('en-US'),
      row: ROWS[i],
    })
  }

  // the crest traverse: summit → col → summit along the TRUE ridge line
  // (for each x, the highest ground across the crest), lightly smoothed
  const crest: [number, number][] = []
  const crestAt: number[] = []
  const steps = 18
  for (let i = 0; i < N - 1; i++) {
    const a = summits[i]
    const b = summits[i + 1]
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
      const t = k / steps
      const x = a.x + (b.x - a.x) * t
      if (k === 0 || k === steps) {
        crest.push(k === 0 ? [a.x, a.z] : [b.x, b.z])
        continue
      }
      const zc = crestZ(x)
      let bestZ = zc
      let bestH = -Infinity
      for (let j = -36; j <= 36; j++) {
        const z = zc + j * 0.05
        const hh = height(x, z)
        if (hh > bestH) {
          bestH = hh
          bestZ = z
        }
      }
      crest.push([x, bestZ])
    }
  }
  // smooth the traced line (keep the benchmarks exactly)
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 1; j < crest.length - 1; j++) {
      if (j % steps === 0) continue
      crest[j][1] = (crest[j - 1][1] + 2 * crest[j][1] + crest[j + 1][1]) / 4
    }
  }
  let acc = 0
  for (let j = 0; j < crest.length; j++) {
    if (j > 0) acc += Math.hypot(crest[j][0] - crest[j - 1][0], crest[j][1] - crest[j - 1][1])
    if (j % steps === 0) crestAt.push(acc)
  }

  // the rivers: each valley floor from just below its col to the sea
  const rivers: [number, number][][] = valleys.map(vx => {
    const pts: [number, number][] = []
    for (let z = vx.z0 + 3.2; z < 40; z += 0.3) {
      const x = valleyX(vx, z)
      pts.push([x, z])
      if (height(x, z) < -0.25) break
    }
    return pts
  })

  const coast: [number, number][] = summits.map(p => {
    let z = p.z + 4
    while (z < 32 && height(p.x, z) > 0) z += 0.25
    return [p.x, z]
  })

  return {
    height,
    coast,
    rivers,
    summits,
    crest,
    crestAt,
    crestLength: acc,
    sound: new THREE.Vector2(-2, 18),
    hMax,
  }
}
