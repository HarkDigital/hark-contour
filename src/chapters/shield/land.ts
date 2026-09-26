import { simplex2, fbm } from '../../kit/noise'
import type { HeightFn } from '../../kit/terrain'

/*
 * The small stretch of printed land under the weather chart: a rounded
 * headland in the north-east quadrant (your site sits on its point, at the
 * origin), a quiet sound to the west and south, three small islands off the
 * coast for the water-lining rings to circle. Believable, gentle profiles:
 * a coastal shelf that rises into rolling hills inland, and a shelving sea.
 */

/** where "your site" is (world XZ); the headland's point */
export const SITE = { x: 0, z: 0 }

/** the chart sheet (terrain rectangle) */
export const SHEET = { width: 60, depth: 48, cx: 1, cz: -3 }

const smin = (a: number, b: number, k: number) => {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k))
  return b + (a - b) * h - k * h * (1 - h)
}

export function makeLand(seed = 23): HeightFn {
  const n = simplex2(seed)
  const m = simplex2(seed + 7)
  return (x: number, z: number) => {
    // two coasts (west, south) joined by a rounded headland: d > 0 is land, ~distance inland
    const a = x + 1.35 + 0.85 * Math.sin(z * 0.34 + 0.9) + 0.9 * fbm(n, z * 0.12, 3.1, 2)
    const b = 1.25 - z + 0.75 * Math.sin(x * 0.31 - 0.2) + 0.9 * fbm(n, x * 0.12, 7.7, 2)
    const d = smin(a, b, 2.2)
    if (d > 0) {
      // a low coastal shelf, rising into rolling hills a few units inland
      const shelf = 1.25 * (1 - Math.exp(-d / 2.2))
      const t = Math.min(1, Math.max(0, (d - 1.2) / 6))
      const hills = (0.6 + 0.5 * fbm(m, x * 0.1, z * 0.1, 4)) * t * t * (3 - 2 * t) * 1.8
      return shelf + hills + 0.02
    }
    // a shelving sea, three islands off the coast
    let h = -1.4 * (1 - Math.exp(d / 2.4))
    const i1 = (x + 8.6) ** 2 + (z - 6.2) ** 2
    const i2 = (x + 12.5) ** 2 * 0.8 + (z + 0.5) ** 2 * 1.4
    const i3 = (x - 5.5) ** 2 + (z - 8.4) ** 2 * 0.7
    h += 2.1 * Math.exp(-i1 / 3.2) + 1.7 * Math.exp(-i2 / 1.9) + 1.6 * Math.exp(-i3 / 1.6)
    return h + 0.18 * fbm(m, x * 0.3, z * 0.3, 2) * Math.min(1, -d * 0.5)
  }
}
