import type * as THREE from 'three'
import type { World } from '../../world/World'
import { chartMaterial, type ChartMaterial } from '../../kit/chart'
import { simplex2, fbm } from '../../kit/noise'

/*
 * THE BAY — the voices chapter's nautical chart.
 *
 * Plan view (x east, z south; north is -z, up the screen):
 *
 *        ~~~~~~~~ north shore (hills) ~~~~~~~~~~~~~~~~
 *     NW point                                   \
 *        P1 ─── P2 ─── P3                         |  east
 *                        \        · islet         |  headland
 *   (rose)     P6 ─── P5 ─ P4                    /
 *                (sand bank)
 *                \                          (island)
 *                 P7 ────── P8
 *              open water → the paper margin (south / west)
 *
 * Land is a smooth signed "shore potential" s(x, z) (world units, > 0 land):
 * shoulders rise inland from the coast, the sea floor falls away offshore
 * (depth = D · (1 − e^(−d / L))), so the coast is crisp, the water-lining is
 * even, and the isobaths spread as the bay deepens toward its mouth.
 * Heights are small (land ≲ 2.6, sea ≳ −0.62) so the lifted chart stays a
 * printed sheet: the water barely sinks under the overlays.
 */

export const BAY = { width: 104, depth: 78, cx: 0, cz: 2 }
/** decorative soundings: fathoms per height unit */
export const FATHOMS = 40
/** isobath step (height units) — every 3 fathoms, a bolder line every 4th */
export const ISO = 0.075

export interface Station {
  x: number
  z: number
  /** which side of the station the lettering sits on */
  side: 1 | -1
}

/** the eight sounding stations, in survey order (lane by lane) */
export const STATIONS: Station[] = [
  { x: -14, z: -5.5, side: 1 },
  { x: -1.5, z: -8.5, side: 1 },
  { x: 11, z: -5, side: 1 },
  { x: 14.5, z: 5.5, side: -1 },
  { x: 3, z: 9.5, side: 1 },
  { x: -9, z: 6, side: 1 },
  { x: -5, z: 19, side: 1 },
  { x: 9, z: 21.5, side: -1 },
]

/** the survey launch point (a benchmark on the NW point) */
export const LAUNCH = { x: -28.5, z: -6.5 }
/** the compass rose, in open water west of the bay */
export const ROSE = { x: -24, z: 9.5, r: 6.4 }

const smax = (a: number, b: number, k: number) => {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (a - b)) / k))
  return b + (a - b) * h + k * h * (1 - h)
}

/** Build the bay's height function (seeded; cheap enough for ~360k samples). */
export function bayHeight() {
  const n = simplex2(41)
  const m = simplex2(7)
  return (x: number, z: number) => {
    // north shore, a wandering line of coves
    const wig = 2.1 * Math.sin(0.12 * x + 0.7) + 0.95 * Math.sin(0.27 * x + 2.3) + 0.42 * Math.sin(0.58 * x + 1.1)
    const sN = -(z + 15.5) + wig
    // the east headland, reaching south and hooking west at its tip
    let sE = x - 25 + 1.5 * Math.sin(0.2 * z + 0.4) + 0.7 * Math.sin(0.46 * z + 1.9)
    sE = Math.min(sE, (9 - z) * 0.85)
    const hx = x - 22.5
    const hz = z - 7.5
    const hook = 2.6 - Math.sqrt(hx * hx * 0.55 + hz * hz * 1.4)
    // the NW point (the launch site)
    const px = x + 30
    const pz = z + 8
    const point = 4.2 - Math.sqrt(px * px * 0.9 + pz * pz * 0.42)
    // a long barrier island across the south-east, sheltering the bay
    const ax = x - 33
    const az = z - 15
    const t = Math.min(1, Math.max(0, (ax * -29 + az * 14.5) / (29 * 29 + 14.5 * 14.5)))
    const qx = ax + 29 * t
    const qz = az - 14.5 * t
    const bar = 0.5 + 2.1 * Math.sqrt(Math.max(0, Math.sin(Math.PI * t))) - Math.sqrt(qx * qx + qz * qz)
    // a rocky islet mid-bay
    const lx = x - 9
    const lz = z - 0.5
    const islet = 1.25 - Math.sqrt(lx * lx * 1.1 + lz * lz * 1.7)
    let s = smax(smax(smax(sN, sE, 3.2), hook, 2.2), point, 2.6)
    s = smax(s, bar, 1.6)
    s = smax(s, islet, 0.8)
    // coastline warp (coves, shoals) — one small fbm
    const w = fbm(n, x * 0.085, z * 0.085, 3)
    s += 1.35 * w
    if (s > 0) {
      // shoulders inland, low hills behind
      const base = 2.2 * (1 - Math.exp(-s / 4.2))
      const hill = s > 1.5 ? 0.55 * fbm(m, x * 0.12, z * 0.12, 2) * Math.min(1, (s - 1.5) / 4) : 0
      return base + hill * base * 0.5
    }
    const d = -s
    // the bay deepens toward its mouth (south-west), with a soft channel
    const mouth = Math.min(1, Math.max(0, (z + 6 + (-x - 4) * 0.6) / 34))
    const D = 0.44 + 0.2 * mouth
    let depth = D * (1 - Math.exp(-d / 6.2))
    depth += 0.05 * w * Math.min(1, d / 4)
    // a sand bank in the middle of the bay: shoals to a fathom, never dries
    const bx = x + 5
    const bz = z - 13.5
    depth *= 1 - 0.95 * Math.exp(-(bx * bx) / 60 - (bz * bz) / 9)
    return -Math.max(0.0005, depth)
  }
}

/**
 * The chart material, with a nautical overlay spliced into the kit shader:
 * isobaths (depth contours) offshore of the water-lining, turning a deeper
 * blue as the water deepens, a bolder line every 4th, and stepped depth
 * tints (shallows blue, deep water paler — the chart convention).
 * If the kit's shader text ever changes shape, the splice is skipped and
 * the plain chart remains.
 */
export function bayMaterial(world: World, geo: THREE.BufferGeometry, mobile: boolean): ChartMaterial & { uniforms: { uIso: { value: number }; uIsoOn: { value: number } } } {
  const mat = chartMaterial(world, {
    terrain: geo,
    interval: 0.14,
    index: 5,
    hMin: 0,
    waterSpacing: 0.021,
    waterLines: 5,
    grid: 0.42,
    gridSize: 12,
    lift: 0,
    stepped: 0.75,
    shade: 0.8,
    relief: 1.6,
    line: mobile ? 0.9 : 1,
  })
  const u = mat.uniforms as ChartMaterial['uniforms'] & { uIso: { value: number }; uIsoOn: { value: number } }
  u.uIso = { value: ISO }
  u.uIsoOn = { value: 1 }
  // chart blues for a nautical sheet: shallows tinted, deep water paler
  u.uWaterC.value.set('#b6d2db')
  u.uWaterDeep.value.set('#e4ebe5')
  u.uGridC.value.set('#8aa9b6')

  let fs = mat.fragmentShader
  const waterA = 'vec3 water = mix(uWaterC, uWaterDeep, clamp(k / max(uWaterLines * 1.6, 1.0), 0.0, 1.0));'
  const coastA = 'col = mix(col, uCoast, coast * uLines);'
  if (fs.includes(waterA) && fs.includes(coastA) && fs.includes('void main()')) {
    fs = fs.replace('void main()', 'uniform float uIso, uIsoOn;\n  void main()')
    fs = fs.replace(
      waterA,
      /* glsl */ `float depB = max(-h, 0.0);
    // band edges sit on isobaths (the first one past the water-lining), where a line covers them
    float band = clamp((floor(depB / uIso) - 1.0) / 5.0, 0.0, 1.0);
    vec3 water = mix(uWaterC, uWaterDeep, mix(clamp(k / max(uWaterLines * 1.6, 1.0), 0.0, 1.0), band, uIsoOn));`,
    )
    fs = fs.replace(
      coastA,
      /* glsl */ `${coastA}
    // isobaths: depth contours beyond the water-lining, a deeper blue offshore
    float fB = depB / uIso;
    float fwB = max(fwidth(fB), 1e-5);
    float isoA = isoLine(fB, fwB, 0.85 * px);
    float isoI = isoLine(fB * 0.25, fwB * 0.25, 1.6 * px);
    float beyond = smoothstep(uIso * 1.2, uIso * 1.6, depB);
    vec3 isoC = mix(uWaterLineC, uCoast, smoothstep(uIso, uIso * 7.0, depB));
    col = mix(col, isoC, max(isoA * 0.7, isoI * 0.92) * beyond * wet * uLines * uIsoOn);`,
    )
    mat.fragmentShader = fs
  }
  return mat as ChartMaterial & { uniforms: { uIso: { value: number }; uIsoOn: { value: number } } }
}
