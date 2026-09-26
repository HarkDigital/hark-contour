import { simplex2, fbm, ridged, falloff } from '../../kit/noise'

/*
 * SURVEY — the land of the work chapter: one coastal survey region, a river
 * valley meeting the sea. North is -z (map up), the sea lies to the south.
 *
 *   - a coastline of bays and headlands (Echo Bay in the middle, where the
 *     river's estuary opens), two islands offshore
 *   - a coastal plain rising to rolling hills, then a mountain range in the
 *     north-east (ridged detail at modest amplitude, never crenellated)
 *   - a U-shaped river valley winding down from the range to the Sound; its
 *     lower estuary is water, the upper river is a drawn blue line
 *   - six SURVEY SITES on gentle benches along the route, and nine smaller
 *     sites dotted across the rest of the sheet
 *
 * The height fn is sampled ~250k times at init (terrainGeometry): the coast
 * is a lookup table by x, and the expensive noise only runs where it shows.
 */

export const TERRAIN = { cx: 1, cz: -5.5, width: 72, depth: 54 }

/** the region the route and the fifteen sites live in (for framing) */
export const ROI = { x0: -27, x1: 29, z0: -21, z1: 14 }

/** grid (graticule) for the gazetteer's references: columns A.. west→east, rows 1.. north→south */
export const GRID = { size: 7, x0: -28, z0: -21, cols: 8, rows: 5 }

export function gridRef(x: number, z: number): string {
  const c = Math.max(0, Math.min(GRID.cols - 1, Math.floor((x - GRID.x0) / GRID.size)))
  const r = Math.max(0, Math.min(GRID.rows - 1, Math.floor((z - GRID.z0) / GRID.size)))
  return `${String.fromCharCode(65 + c)}${r + 1}`
}

const nA = simplex2(11)
const nB = simplex2(23)
const nC = simplex2(37)

const g = (x: number, s: number) => Math.exp(-(x * x) / (s * s))
const sstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/* ---- the coastline, z of the shore for each x (tabulated) ---- */
const CX0 = -46
const CX1 = 48
const CSTEP = 0.05
const CN = Math.ceil((CX1 - CX0) / CSTEP) + 1
const COAST = new Float32Array(CN)
for (let i = 0; i < CN; i++) {
  const x = CX0 + i * CSTEP
  COAST[i] =
    5.2 -
    8.6 * g(x + 3.2, 5.4) + // Echo Bay
    5.6 * g(x + 19.5, 4.4) + // west headland
    6.4 * g(x - 22.5, 3.4) + // east headland
    2.2 * g(x - 8.6, 2.1) + // a point on the bay's east shore
    -1.8 * g(x - 14.5, 2.6) + // a cove
    -1.2 * g(x + 28, 3) + // a bight in the west
    0.9 * nA(x * 0.1, 3.3) +
    0.35 * nA(x * 0.31, 9.1)
}
export function coastZ(x: number): number {
  const f = (Math.min(CX1, Math.max(CX0, x)) - CX0) / CSTEP
  const i = Math.min(CN - 2, Math.floor(f))
  const t = f - i
  return COAST[i] + (COAST[i + 1] - COAST[i]) * t
}

/* ---- the river: x of its thalweg for each z (north of the bay) ---- */
export const RIVER_MOUTH_Z = -2.2
export function riverX(z: number): number {
  const u = Math.max(0, RIVER_MOUTH_Z - z)
  return -3.2 + u * 0.3 + 2.0 * Math.sin(u * 0.32) - 0.8 * Math.sin(u * 0.14)
}
/** valley floor height along the river (rises upstream) */
const floorAt = (z: number) => 0.06 + Math.max(0, RIVER_MOUTH_Z - 2 - z) * 0.085

/* ---- sites ---- */
export interface Site {
  x: number
  z: number
  /** where the flat plate rests (world xz of its centre) */
  rx: number
  rz: number
  /** label side: 1 right, -1 left */
  side: number
  /** camera: yaw (0 = from the south, looking north), pitch (down), distance */
  yaw: number
  pitch: number
  dist: number
}

export const SITES: Site[] = [
  { x: -19.5, z: 8.4, rx: -22.4, rz: 4.6, side: -1, yaw: 0.26, pitch: 0.76, dist: 15 },
  { x: -10.8, z: 1.2, rx: -16.2, rz: -3.2, side: -1, yaw: -0.18, pitch: 0.78, dist: 15 },
  { x: -1.2, z: -7.8, rx: 3.9, rz: -4.6, side: 1, yaw: 0.34, pitch: 0.8, dist: 15.5 },
  { x: 8.6, z: -14.2, rx: 3.6, rz: -18.4, side: -1, yaw: 0.58, pitch: 0.74, dist: 16 },
  { x: 17.6, z: -4.6, rx: 12.4, rz: -2.4, side: 1, yaw: 0.2, pitch: 0.78, dist: 15.5 },
  { x: 22.2, z: 9.0, rx: 16.8, rz: 12.4, side: -1, yaw: -0.28, pitch: 0.74, dist: 15 },
]

/** the nine more: small markers across the rest of the sheet */
export const OTHERS: { x: number; z: number; side: number }[] = [
  { x: -26.2, z: -4.8, side: 1 },
  { x: -15.4, z: -11.4, side: 1 },
  { x: -7.2, z: -18.6, side: 1 },
  { x: 14.6, z: -18.2, side: 1 },
  { x: 24.8, z: -12.8, side: -1 },
  { x: 27.2, z: -2.2, side: -1 },
  { x: 9.9, z: 5.6, side: 1 },
  { x: 5.4, z: 0.4, side: 1 },
  { x: -26.4, z: -16, side: 1 },
]

/** route control points (a Catmull-Rom spline runs through them; the sites are on it) */
export const ROUTE: [number, number][] = [
  [-26.5, 10.3],
  [-22.6, 9.6],
  [SITES[0].x, SITES[0].z],
  [-16.5, 6.4],
  [-13.8, 3.4],
  [SITES[1].x, SITES[1].z],
  [-8.2, -1.4],
  [-4.6, -4.6],
  [SITES[2].x, SITES[2].z],
  [2.4, -10.6],
  [5.2, -12.6],
  [SITES[3].x, SITES[3].z],
  [12.6, -12.4],
  [15.4, -8.6],
  [SITES[4].x, SITES[4].z],
  [19.8, -0.4],
  [20.4, 4.8],
  [SITES[5].x, SITES[5].z],
  [23.4, 11.2],
]

/* ---- the land ---- */

// survey benches: each site sits on a gentle shelf at its own level
const BENCH_R0 = 1.1
const BENCH_R1 = 3.1
const benches: { x: number; z: number; h: number }[] = []

function raw(x: number, z: number): number {
  // inland distance (approximate), with two islands
  let c = coastZ(x) - z
  // the islands (their shoreline noise only near them: it fades to 0 by r1)
  const d1 = Math.hypot((x - 5.5) * 0.9, (z - 12.2) * 1.25)
  const w1 = falloff(d1, 2.6, 4.4)
  c = Math.max(c, 1.9 - d1 + (w1 > 0 ? 0.45 * w1 * nA(x * 0.45, z * 0.45) : 0))
  const d2 = Math.hypot((x - 12.8) * 1.2, z - 11.4)
  const w2 = falloff(d2, 1.8, 3.4)
  c = Math.max(c, 1.2 - d2 + (w2 > 0 ? 0.3 * w2 * nA(x * 0.6 + 4, z * 0.6) : 0))
  if (c <= 0) {
    // the sea: a shelf falling away, with a whisper of relief on the bed
    const k = Math.min(1, -c * 0.6)
    return -1.8 * (1 - Math.exp(c / 2.6)) + 0.12 * nB(x * 0.12, z * 0.12) * k * k
  }
  const inland = sstep(0, 3.5, c)
  // the coastal rise: a terrace, then the slopes
  let h = 1.5 * (1 - Math.exp(-c / 3.2)) + 1.1 * sstep(4, 14, c)
  // broad rolling hills (low frequency: a few landforms, not a rash of knolls)
  h += fbm(nB, x * 0.048, z * 0.048, 3, 2.0, 0.4) * 1.25 * inland
  // Signal Hill on the bay's west shore, the east headland's point
  h += 1.7 * g(Math.hypot(x + 10.6, z + 0.6), 3.4) * inland
  h += 1.4 * g(Math.hypot(x - 22.2, z - 7.6), 3.6) * inland
  // the range: along the north of the sheet, highest to the north-east
  const rng = falloff(Math.abs(z + 17.5), 0, 14) * (0.55 + 0.45 * sstep(-26, 6, x))
  if (rng > 0) {
    const mass = 2.2 + 1.6 * (fbm(nC, x * 0.042, z * 0.042, 3, 2.0, 0.45) * 0.5 + 0.5)
    h += rng * (mass + ridged(nC, x * 0.075, z * 0.075, 3, 2.05, 0.45) * 1.1)
  }
  // the river valley (north of the bay): U-shaped, flattening toward its floor
  if (z < RIVER_MOUTH_Z + 3) {
    const d = Math.abs(x - riverX(z) + 0.4 * nA(z * 0.45, 7.7))
    if (d < 8) {
      const mask = sstep(RIVER_MOUTH_Z + 3, RIVER_MOUTH_Z - 1, z)
      const v = falloff(d, 0.6, 6.4) * mask
      h = h * (1 - v) + (floorAt(z) + 0.25 * (d / 6.4) ** 2) * v
      // the lower estuary is open water, widening into the bay
      const wid = sstep(RIVER_MOUTH_Z - 5, RIVER_MOUTH_Z + 2, z)
      const est = sstep(RIVER_MOUTH_Z - 6.5, RIVER_MOUTH_Z - 2.5, z) * falloff(d, 0.3 + 0.5 * wid, 1.1 + 1.2 * wid)
      h = h * (1 - est) - 0.3 * est
    }
  }
  // keep the shore itself calm: land meets the sea at exactly 0
  const sh = sstep(0, 1.1, c)
  return h * sh + (1 - sh) * c * 0.4
}

for (const s of SITES) {
  let sum = 0
  let n = 0
  for (let a = 0; a < 8; a++) {
    sum += raw(s.x + Math.cos(a) * 1.2, s.z + Math.sin(a) * 1.2)
    n++
  }
  benches.push({ x: s.x, z: s.z, h: Math.max(0.35, (sum / n + raw(s.x, s.z)) / 2) })
}

export function height(x: number, z: number): number {
  let h = raw(x, z)
  for (let i = 0; i < benches.length; i++) {
    const b = benches[i]
    const dx = x - b.x
    const dz = z - b.z
    if (dx > BENCH_R1 || dx < -BENCH_R1 || dz > BENCH_R1 || dz < -BENCH_R1) continue
    const w = falloff(Math.sqrt(dx * dx + dz * dz), BENCH_R0, BENCH_R1)
    if (h > 0) h = h * (1 - w) + b.h * w
  }
  return h
}

/** max height over a rectangle (for laying a flat plate over rough ground) */
export function maxOver(cx: number, cz: number, hw: number, hd: number): number {
  let m = -Infinity
  for (let j = 0; j <= 6; j++)
    for (let i = 0; i <= 6; i++) m = Math.max(m, height(cx - hw + (2 * hw * i) / 6, cz - hd + (2 * hd * j) / 6))
  return m
}

/** Catmull-Rom through the control points, sampled every `step` world units (approx.) */
export function spline(pts: [number, number][], step = 0.25): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const n = Math.max(2, Math.ceil(len / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** the upper river as a drawn line: from the range down to the head of the estuary */
export function riverLine(): [number, number][] {
  const out: [number, number][] = []
  for (let z = -24; z <= -3.2; z += 0.3) out.push([riverX(z), z])
  return out
}

/** height gradient (central differences) */
export function grad(x: number, z: number, e = 0.05): [number, number] {
  return [(height(x + e, z) - height(x - e, z)) / (2 * e), (height(x, z + e) - height(x, z - e)) / (2 * e)]
}

/**
 * Walk from (x, z) onto the nearest contour at `level` (a few Newton steps
 * along the gradient). Returns null where the ground is too flat to find it.
 */
export function onContour(x: number, z: number, level: number): [number, number] | null {
  let px = x
  let pz = z
  for (let i = 0; i < 8; i++) {
    const [gx, gz] = grad(px, pz)
    const g2 = gx * gx + gz * gz
    if (g2 < 1e-4) return null
    const d = height(px, pz) - level
    px -= (d * gx) / g2
    pz -= (d * gz) / g2
    if (Math.abs(d) < 1e-3) break
  }
  return Math.abs(height(px, pz) - level) < 0.02 && Math.hypot(px - x, pz - z) < 3 ? [px, pz] : null
}

/** where contour elevations are lettered (seeds: each snaps to its nearest index contour) */
export const CONTOUR_SEEDS: [number, number][] = [
  [-23, -9],
  [-12.5, -7],
  [-5, -13.5],
  [5.8, -8.6],
  [19.5, -15],
  [13.6, 0.8],
  [-18, 3],
  [0.5, -22.5],
  [26.5, -5.5],
]

/** summits for spot heights: the highest point in each of a few search boxes */
export const SPOT_BOXES: [number, number, number, number][] = [
  [-13.5, -3.5, -7.5, 2],
  [16, -24, 30, -16],
  [-4, -25, 8, -17],
  [19, 4, 25, 9],
]
export function summit(b: [number, number, number, number]): [number, number, number] {
  let best: [number, number, number] = [b[0], b[1], -Infinity]
  for (let z = b[1]; z <= b[3]; z += 0.35)
    for (let x = b[0]; x <= b[2]; x += 0.35) {
      const h = height(x, z)
      if (h > best[2]) best = [x, z, h]
    }
  return best
}
