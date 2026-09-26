import * as THREE from 'three'
import { markField, type MarkField } from '../../kit/markField'
import { simplex2, fbm } from '../../kit/noise'

/*
 * HERO LAND — the Hark mark as an island massif on the chart.
 *
 * World layout (y up, north = -z, the mark reads upright from above):
 *   the mark is S units tall, centred on (X0, Z0). The centre sits half a
 *   graticule cell off the world origin so the chart's graticule lines
 *   (multiples of GRID) run between the strokes, never through the summit.
 *
 * Profile: the coast IS the mark's outline (markField, d = 0). Each stroke
 * rises from a clean coast on smooth shoulders to a long rounded crest along
 * its medial axis (a blend of a linear and a smoothstep ramp of the inside
 * distance, so the coast keeps a real gradient and the crest rolls over);
 * crest heights wander gently along the strokes (low-frequency fbm), with a
 * whisper of fine relief so the contours breathe instead of running as
 * perfect offsets. The diamond is a small pyramid-like peak (its contours are
 * concentric diamonds). The sea shelves away exponentially, so the
 * water-lining rings echo the outline and spread as they go out. Three small
 * islets sit in the open north-east and south-west water.
 */

/** mark height (world units) */
export const S = 10
/** graticule spacing (world units) */
export const GRID = 3.75
/** the island's centre (the diamond summit) */
export const X0 = GRID / 2
export const Z0 = GRID / 2
/** the printed sheet: half-size of its neatline square */
export const HALF = 7.5
/** crest height of the strokes, and the diamond peak */
export const RIDGE = 0.56
export const PEAK = 0.74
/** sea: depth it shelves to, and the shelving length */
export const SEA_D = 1.0
export const SEA_L = 1.5
/** once lifted, the sea floor sinks only this fraction of its depth (the sea stays a calm, nearly flat plane) */
export const SEA_K = 0.1
/** contour interval (world units) */
export const INTERVAL = 0.1

/** mark-space radius (L1) of the diamond's own ground */
const DIAM_L1 = 0.1
/** inside-distance (mark units) at which a stroke / the diamond reaches its crest */
const W_STROKE = 0.045
const W_DIAMOND = 0.047
/** half-diagonal of the diamond (mark units) */
const DIAM_HALF = 0.0763

interface Islet {
  x: number
  z: number
  r: number
  h: number
  seed: number
}

/** mark-space (u right, v up) → world xz */
export const toWorld = (u: number, v: number): [number, number] => [X0 + u * S, Z0 - v * S]

function smax(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.max(a, b) + h * h * k * 0.25
}

export interface Land {
  mf: MarkField
  /** full-relief height, world units (< 0 is water) */
  height: (x: number, z: number) => number
  /** the height the lifted geometry actually shows (sea floor flattened by SEA_K) */
  surface: (x: number, z: number) => number
  /** summit of the diamond peak (world, full relief) */
  summit: THREE.Vector3
  /** crest lines of the two strokes (world xz), tip to tip, point-symmetric */
  crestA: [number, number][]
  crestB: [number, number][]
}

export function buildLand(): Land {
  const mf = markField()
  const n1 = simplex2(11)
  const n2 = simplex2(29)
  const n3 = simplex2(47)
  const islets: Islet[] = [
    { x: 0.415, y: 0.405, r: 0.043, h: 0.2, seed: 1.3 },
    { x: 0.5, y: 0.305, r: 0.021, h: 0.11, seed: 7.1 },
    { x: -0.52, y: -0.5, r: 0.026, h: 0.13, seed: 3.7 },
  ].map(i => {
    const [x, z] = toWorld(i.x, i.y)
    return { x, z, r: i.r * S, h: i.h, seed: i.seed }
  })

  const markHeight = (x: number, z: number) => {
    const u = (x - X0) / S
    const v = (Z0 - z) / S
    const d = mf.sdf(u, v) * S
    if (d < 0) {
      if (Math.abs(u) + Math.abs(v) < DIAM_L1) {
        // the diamond: a peak with straight flanks whose corners round off toward a cone
        const k = Math.min(1, -d / (W_DIAMOND * S))
        const r = Math.hypot(x - X0, z - Z0) / (0.8 * DIAM_HALF * S)
        const cone = Math.max(0, 1 - r)
        return PEAK * Math.pow(k, 1.12) * (0.62 + 0.38 * cone)
      }
      const k = Math.min(1, -d / (W_STROKE * S))
      // the crest climbs to a few distinct summits along each stroke, with cols between
      const c = Math.min(1, Math.max(0, 0.5 + 0.75 * fbm(n1, x * 0.23 + 3.1, z * 0.23 - 1.7, 2)))
      const crest = RIDGE * (0.4 + 0.6 * c * c * (3 - 2 * c))
      // concave flanks: gentle foothills at the coast, steepening to the crest
      const prof = 0.3 * k + 0.7 * k * k
      // spurs and gullies on the flanks (none at the coast or on the crest line)
      const gully = fbm(n2, x * 1.45, z * 1.45, 2) * 4 * k * (1 - k)
      return crest * prof + 0.1 * gully * crest
    }
    return -SEA_D * (1 - Math.exp(-d / SEA_L))
  }

  const height = (x: number, z: number) => {
    let h = markHeight(x, z)
    for (let i = 0; i < islets.length; i++) {
      const it = islets[i]
      const dx = x - it.x
      const dz = z - it.z
      const rd = Math.sqrt(dx * dx + dz * dz)
      if (rd > 7) continue
      // an irregular shore (noise on the radius, near the islet only), a rounded top
      let q = rd / it.r
      if (q < 3) q += 0.2 * (1 - Math.max(0, q - 1.5) / 1.5) * Math.min(1, q) * n3(x * 1.4 + it.seed, z * 1.4 - it.seed)
      const hi = q < 1 ? it.h * (1 - q * q) : -SEA_D * (1 - Math.exp(-((q - 1) * it.r) / SEA_L))
      h = smax(h, hi, 0.06)
    }
    return h
  }

  const surface = (x: number, z: number) => {
    const h = height(x, z)
    return h > 0 ? h : h * SEA_K
  }

  const [sx, sz] = toWorld(0, 0)
  const summit = new THREE.Vector3(sx, height(sx, sz), sz)

  // crest lines: seed on each diagonal (NW and SE of the diamond), march both ways along the medial axis
  const seedA = seedOnStroke(mf, -1, 1)
  const seedB = seedOnStroke(mf, 1, -1)
  const D = Math.SQRT1_2
  const aNE = march(mf, seedA, [D, D])
  const aSW = march(mf, seedA, [-D, -D])
  const bNE = march(mf, seedB, [D, D])
  const bSW = march(mf, seedB, [-D, -D])
  // A: its left-loop tip → diagonal → upper loop → upper tip; B mirrors it (right tip → … → bottom tip)
  const A = smoothLine([...aSW.reverse(), ...aNE.slice(1)])
  const B = smoothLine([...bNE.reverse(), ...bSW.slice(1)])
  return {
    mf,
    height,
    surface,
    summit,
    crestA: A.map(([u, v]) => toWorld(u, v)),
    crestB: B.map(([u, v]) => toWorld(u, v)),
  }
}

/** the most-inside point of the stroke crossing the ray from the centre toward (dx, dy) */
function seedOnStroke(mf: MarkField, dx: number, dy: number): [number, number] {
  const l = Math.hypot(dx, dy)
  let best = 0.14
  let bd = Infinity
  for (let t = 0.08; t < 0.26; t += 0.002) {
    const d = mf.sdf((dx / l) * t, (dy / l) * t)
    if (d < bd) {
      bd = d
      best = t
    }
  }
  return [(dx / l) * best, (dy / l) * best]
}

/** walk the medial axis of a stroke from p along dir until the stroke thins out (near a tip) */
function march(mf: MarkField, p0: [number, number], dir0: [number, number]): [number, number][] {
  const out: [number, number][] = [p0]
  let p = p0
  let dx = dir0[0]
  let dy = dir0[1]
  const step = 0.006
  for (let i = 0; i < 700; i++) {
    const qx = p[0] + dx * step
    const qy = p[1] + dy * step
    // search across the stroke for its most-inside point
    const px = -dy
    const py = dx
    let bt = 0
    let bd = Infinity
    const N = 17
    const R = 0.03
    const ds: number[] = []
    for (let k = 0; k < N; k++) {
      const t = -R + (2 * R * k) / (N - 1)
      const d = mf.sdf(qx + px * t, qy + py * t)
      ds.push(d)
      if (d < bd) {
        bd = d
        bt = k
      }
    }
    let t = -R + (2 * R * bt) / (N - 1)
    if (bt > 0 && bt < N - 1) {
      // parabolic refinement
      const a = ds[bt - 1]
      const b = ds[bt]
      const c = ds[bt + 1]
      const den = a - 2 * b + c
      if (den > 1e-9) t += ((a - c) / (2 * den)) * ((2 * R) / (N - 1))
    }
    if (bd > -0.024) break
    const nx = qx + px * t
    const ny = qy + py * t
    let ex = nx - p[0]
    let ey = ny - p[1]
    const el = Math.hypot(ex, ey) || 1
    ex /= el
    ey /= el
    // never turn back on ourselves
    if (ex * dx + ey * dy < 0.5) break
    // low-pass the heading so the walk doesn't wobble between pixels of the field
    dx = dx * 0.35 + ex * 0.65
    dy = dy * 0.35 + ey * 0.65
    const dl = Math.hypot(dx, dy) || 1
    dx /= dl
    dy /= dl
    p = [nx, ny]
    out.push(p)
  }
  return out
}

/** a few passes of neighbour averaging (ends pinned), then resample evenly */
function smoothLine(pts: [number, number][]): [number, number][] {
  let a = pts.map(p => [p[0], p[1]] as [number, number])
  for (let pass = 0; pass < 6; pass++) {
    const b = a.map(p => [p[0], p[1]] as [number, number])
    for (let i = 1; i < a.length - 1; i++) {
      b[i][0] = (a[i - 1][0] + 2 * a[i][0] + a[i + 1][0]) / 4
      b[i][1] = (a[i - 1][1] + 2 * a[i][1] + a[i + 1][1]) / 4
    }
    a = b
  }
  return a
}

/**
 * Lay a polyline (world xz) on the lifted land: y = surface + offset, sampled
 * every `step` units. Build it at full relief; scale the mesh's y by the lift.
 */
export function drapeFull(points: [number, number][], land: Land, offset = 0.05, step = 0.08): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i]
    const [x1, z1] = points[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      const x = x0 + (x1 - x0) * t
      const z = z0 + (z1 - z0) * t
      out.push(new THREE.Vector3(x, land.surface(x, z) + offset, z))
    }
  }
  const [xl, zl] = points[points.length - 1]
  out.push(new THREE.Vector3(xl, land.surface(xl, zl) + offset, zl))
  return out
}
