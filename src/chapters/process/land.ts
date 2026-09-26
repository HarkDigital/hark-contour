import { simplex2, fbm, ridged } from '../../kit/noise'

/*
 * THE MODEL'S LAND — one island, surveyed, drafted, stacked and finished.
 *
 * A believable island about 14 × 10 world units: a main summit to the
 * north-east, a ridge falling south-west over a saddle to a lower western
 * summit, spurs to a south-east headland and a northern point, a sheltered
 * bay on the south coast (the survey station stands on its shore) and a
 * small islet off the east. Heights are world units (1 unit ≈ 100 m on the
 * decorative marginalia); < 0 is sea.
 *
 * Shaped from smooth ridge "capsules" merged with a smooth max on a low
 * coastal shelf, with gentle fbm for contour character and shallow gullies
 * down the flanks. Cheap enough to run ~300k times at init.
 */

/** contour interval (world units) — the draft, the chart and the boards all share it */
export const INTERVAL = 0.2
/** decorative meters per world unit (spot heights and contour values in the marginalia) */
export const METERS = 100

export type V2 = [number, number]

/** points of interest, world x/z (north = -z) */
export const POI = {
  summit: [2.35, -1.15] as V2,
  west: [-3.55, 0.35] as V2,
  saddle: [-0.75, -0.05] as V2,
  station: [-1.7, 1.75] as V2,
  bay: [0.35, 2.2] as V2,
  cove: [0.25, -2.75] as V2,
  headland: [5.3, 2.35] as V2,
  north: [3.1, -3.9] as V2,
  islet: [8.15, -0.95] as V2,
}

/** the island's bounding box (with a margin of sea), for the survey and board grids */
export const BOUNDS = { x0: -8.4, x1: 9.0, z0: -6.4, z1: 5.4 }

interface Ridge {
  ax: number
  az: number
  bx: number
  bz: number
  ha: number
  hb: number
  ra: number
  rb: number
}

const R = (a: V2, b: V2, ha: number, hb: number, ra: number, rb: number): Ridge => ({
  ax: a[0],
  az: a[1],
  bx: b[0],
  bz: b[1],
  ha,
  hb,
  ra,
  rb,
})

/** smooth max; the blend narrows toward sea level so the open sea never inflates */
function smax(a: number, b: number, k: number) {
  const m = Math.max(a, b)
  const kk = k * Math.min(1, m / 0.7) + 1e-4
  const h = Math.max(kk - Math.abs(a - b), 0) / kk
  return m + h * h * kk * 0.25
}

export function makeLand(seed = 23) {
  const n = simplex2(seed)
  const g = simplex2(seed + 7)
  const P = POI
  const ridges: Ridge[] = [
    // main massif: summit → saddle → western summit
    R(P.summit, [0.9, -0.5], 2.3, 1.72, 2.1, 2.2),
    R([0.9, -0.5], P.saddle, 1.72, 1.3, 2.2, 1.9),
    R(P.saddle, P.west, 1.3, 1.62, 1.9, 2.0),
    // the western summit's long tail to the south-west point
    R(P.west, [-6.0, 2.3], 1.62, 0.5, 2.0, 1.7),
    // spurs: south-east headland, northern point, a short east shoulder
    R(P.summit, [4.1, 1.0], 2.3, 1.15, 2.0, 1.9),
    R([4.1, 1.0], P.headland, 1.15, 0.55, 1.9, 1.5),
    R(P.summit, P.north, 2.3, 0.7, 2.0, 1.6),
    R(P.summit, [5.0, -1.6], 2.3, 0.9, 2.0, 1.6),
    // the islet
    R(P.islet, [8.5, -0.3], 0.74, 0.58, 0.95, 0.8),
  ]
  const nr = ridges.length
  /** the nearest ridge (in ridge radii) of the last sample: the sea floor keeps falling away from every hill */
  let u2min = 1e9

  /** gaussian cross-profile of one ridge capsule */
  const ridgeH = (r: Ridge, x: number, z: number) => {
    const dx = r.bx - r.ax
    const dz = r.bz - r.az
    const len2 = dx * dx + dz * dz
    let t = ((x - r.ax) * dx + (z - r.az) * dz) / len2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const px = x - (r.ax + dx * t)
    const pz = z - (r.az + dz * t)
    const s = t * t * (3 - 2 * t)
    const crest = r.ha + (r.hb - r.ha) * s
    const rad = r.ra + (r.rb - r.ra) * t
    const u2 = (px * px + pz * pz) / (rad * rad)
    if (u2 < u2min) u2min = u2
    return crest * Math.exp(-u2 * 1.35)
  }

  return function height(x: number, z: number): number {
    // far out at sea: flat deep water, no work
    if (x < BOUNDS.x0 - 3 || x > BOUNDS.x1 + 3 || z < BOUNDS.z0 - 3 || z > BOUNDS.z1 + 3) return -1.1
    // a gentle domain warp so every crest and coast wanders a little
    const wx = x + fbm(g, x * 0.11, z * 0.11, 2) * 0.9
    const wz = z + fbm(g, x * 0.11 + 5.2, z * 0.11 - 3.1, 2) * 0.9
    let land = 0
    u2min = 1e9
    for (let i = 0; i < nr; i++) land = smax(land, ridgeH(ridges[i], wx, wz), 0.4)
    land -= 0.3 * Math.max(0, Math.sqrt(u2min) - 1.5)
    // the coastal shelf: a low apron the hills stand on, sloping gently to the sea
    const ex = wx / 6.5
    const ez = (wz + 0.25) / 4.7
    const e = Math.sqrt(ex * ex + ez * ez)
    const shelf = 0.66 * (1 - smoothstep(0.28, 1.06, e)) - 0.4 * smoothstep(0.95, 1.6, e)
    land = smax(land, shelf, 0.3)
    // a sheltered bay in the south coast (the survey station stands on its western shore)
    const bx = (wx - P.bay[0]) / 1.7
    const bz = (wz - P.bay[1]) / 1.15
    const cx = (wx - P.cove[0]) / 1.5
    const cz = (wz - P.cove[1]) / 1.0
    land -= 0.46 * Math.exp(-(bx * bx + bz * bz)) + 0.36 * Math.exp(-(cx * cx + cz * cz))
    // contour character: soft undulation, shallow gullies down the flanks
    const on = Math.min(1, land / 0.55)
    const flank = Math.min(1, land / 0.9) * (1 - 0.6 * Math.min(1, Math.max(0, (land - 1.6) / 0.6)))
    land += fbm(n, wx * 0.34, wz * 0.34, 3) * 0.1 * on
    land -= (ridged(n, wx * 0.6 + 11, wz * 0.6 - 4, 2) - 0.45) * 0.15 * flank
    let h = land - 0.34
    // the sea floor shelves away evenly (evenly spaced water-lining off the coast)
    // …then drops away past the last ring, so the sea's tint vignettes into the paper
    if (h < 0) h = -1.1 * (1 - Math.exp(h * 2.1)) - 0.9 * smoothstep(-0.4, -0.72, h)
    return h
  }
}

function smoothstep(a: number, b: number, v: number) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
