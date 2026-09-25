import { logoShapes } from '../logo/logo'

/*
 * The Hark mark as a signed distance field, so it can become LAND: an island
 * whose coastline is the mark, a massif whose ridgelines follow it, rings of
 * water-lining that echo its outline outward.
 *
 *   const mf = markField()                      // ~25 ms at res 640, build once
 *   const d = mf.sdf(x, y)                      // mark units (mark is 1 tall), < 0 inside
 *   // on the ground plane (north = -z): mf.sdf(x / S, -z / S) * S for a mark S units tall
 *
 * The field is the exact Euclidean distance to the rasterised outline
 * (Felzenszwalb EDT on both sides), smoothed so contours drawn from it are
 * clean curves, not pixel staircases. Outside the padded domain it grows
 * with the distance to the domain box.
 */

export interface MarkField {
  /** signed distance in mark units (negative inside the mark) */
  sdf(x: number, y: number): number
  /** half-extent of the sampled square domain (mark units) */
  extent: number
}

const INF = 1e20

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/** squared distance (px²) from every cell to the nearest cell where `seed` is true */
function edt2d(seed: Uint8Array, n: number): Float64Array {
  const grid = new Float64Array(n * n)
  for (let i = 0; i < n * n; i++) grid[i] = seed[i] ? 0 : INF
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = grid[y * n + x]
    edt1d(f, n, d, v, z)
    for (let y = 0; y < n; y++) grid[y * n + x] = d[y]
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) f[x] = grid[y * n + x]
    edt1d(f, n, d, v, z)
    for (let x = 0; x < n; x++) grid[y * n + x] = d[x]
  }
  return grid
}

function blur(src: Float32Array, n: number, r: number) {
  const tmp = new Float32Array(n * n)
  const w = 2 * r + 1
  for (let y = 0; y < n; y++) {
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[y * n + Math.min(n - 1, Math.max(0, x))]
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = acc / w
      acc += src[y * n + Math.min(n - 1, x + r + 1)] - src[y * n + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(n - 1, Math.max(0, y)) * n + x]
    for (let y = 0; y < n; y++) {
      src[y * n + x] = acc / w
      acc += tmp[Math.min(n - 1, y + r + 1) * n + x] - tmp[Math.max(0, y - r) * n + x]
    }
  }
}

let cache: MarkField | null = null

export function markField({ res = 640, extent = 0.95 } = {}): MarkField {
  if (cache && cache.extent === extent) return cache
  const n = res
  const c = document.createElement('canvas')
  c.width = c.height = n
  const x = c.getContext('2d', { willReadFrequently: true })!
  x.fillStyle = '#000'
  x.fillRect(0, 0, n, n)
  x.fillStyle = '#fff'
  // mark units → canvas px (y up in mark space, down on the canvas)
  const toPx = (u: number) => ((u + extent) / (2 * extent)) * n
  const toPy = (v: number) => ((extent - v) / (2 * extent)) * n
  for (const s of logoShapes()) {
    x.beginPath()
    const pts = s.getPoints(64)
    pts.forEach((p, i) => (i ? x.lineTo(toPx(p.x), toPy(p.y)) : x.moveTo(toPx(p.x), toPy(p.y))))
    x.closePath()
    for (const h of s.holes) {
      const hp = h.getPoints(64)
      hp.forEach((p, i) => (i ? x.lineTo(toPx(p.x), toPy(p.y)) : x.moveTo(toPx(p.x), toPy(p.y))))
      x.closePath()
    }
    x.fill('evenodd')
  }
  const img = x.getImageData(0, 0, n, n).data
  const inside = new Uint8Array(n * n)
  const outside = new Uint8Array(n * n)
  for (let i = 0; i < n * n; i++) {
    const on = img[i * 4] > 127
    inside[i] = on ? 1 : 0
    outside[i] = on ? 0 : 1
  }
  const dOut = edt2d(inside, n) // distance to the mark, for outside cells
  const dIn = edt2d(outside, n) // distance to the background, for inside cells
  const px = (2 * extent) / n
  const field = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) {
    field[i] = inside[i] ? -(Math.sqrt(dIn[i]) - 0.5) * px : (Math.sqrt(dOut[i]) - 0.5) * px
  }
  blur(field, n, 2)
  blur(field, n, 1)

  const sdf = (u: number, v: number) => {
    const fx = ((u + extent) / (2 * extent)) * n - 0.5
    const fy = ((extent - v) / (2 * extent)) * n - 0.5
    const cx = Math.min(n - 1.001, Math.max(0, fx))
    const cy = Math.min(n - 1.001, Math.max(0, fy))
    const ix = Math.floor(cx)
    const iy = Math.floor(cy)
    const tx = cx - ix
    const ty = cy - iy
    const i0 = iy * n + ix
    const a = field[i0] + (field[i0 + 1] - field[i0]) * tx
    const b = field[i0 + n] + (field[i0 + n + 1] - field[i0 + n]) * tx
    let d = a + (b - a) * ty
    // beyond the sampled square: keep growing with the distance to it
    const ox = Math.max(0, Math.abs(u) - extent)
    const oy = Math.max(0, Math.abs(v) - extent)
    if (ox > 0 || oy > 0) d += Math.hypot(ox, oy)
    return d
  }
  cache = { sdf, extent }
  return cache
}
