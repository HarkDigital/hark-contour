import * as THREE from 'three'
import { nextFrame } from '../../core/yield'

/*
 * The model's height field, sampled ONCE on a regular grid, then shared by
 * everything in the chapter so the chart, the draft, the boards and the
 * survey all agree to the pixel:
 *
 *   Field.sample(x, z)  bilinear lookup (clamped at the edges: the far sea is
 *                       flat, so the terrain around the grid stays seamless)
 *   contourLoops()      marching squares → closed loops at one level
 *   boardGeometry()     one layer of the relief model: the region above a
 *                       contour, cut as a flat board with vertical walls
 *   drawTimeTexture()   for every contour, the moment the draftsman's pen
 *                       passes each point (the line-draw reveal)
 */

export interface Field {
  nx: number
  nz: number
  x0: number
  z0: number
  step: number
  data: Float32Array
  sample(x: number, z: number): number
}

export interface Rect {
  x0: number
  x1: number
  z0: number
  z1: number
}

/**
 * Sample `height` over `r` every `step` world units, in slices of ~`sliceMs`
 * with a frame yield between them (no long task, even on a slow phone).
 */
export async function buildField(height: (x: number, z: number) => number, r: Rect, step: number, sliceMs = 8): Promise<Field> {
  const nx = Math.round((r.x1 - r.x0) / step) + 1
  const nz = Math.round((r.z1 - r.z0) / step) + 1
  const data = new Float32Array(nx * nz)
  let t0 = performance.now()
  for (let j = 0; j < nz; j++) {
    const z = r.z0 + j * step
    const row = j * nx
    for (let i = 0; i < nx; i++) data[row + i] = height(r.x0 + i * step, z)
    if (j < nz - 1 && performance.now() - t0 > sliceMs) {
      await nextFrame()
      t0 = performance.now()
    }
  }
  const x0 = r.x0
  const z0 = r.z0
  const sample = (x: number, z: number) => {
    let fx = (x - x0) / step
    let fz = (z - z0) / step
    fx = fx < 0 ? 0 : fx > nx - 1.0001 ? nx - 1.0001 : fx
    fz = fz < 0 ? 0 : fz > nz - 1.0001 ? nz - 1.0001 : fz
    const i = fx | 0
    const j = fz | 0
    const tx = fx - i
    const tz = fz - j
    const k = j * nx + i
    const a = data[k] + (data[k + 1] - data[k]) * tx
    const b = data[k + nx] + (data[k + nx + 1] - data[k + nx]) * tx
    return a + (b - a) * tz
  }
  return { nx, nz, x0, z0, step, data, sample }
}

/** A closed loop [x0, z0, x1, z1, …] (the last point connects to the first). */
export type Loop = Float32Array

/**
 * Marching squares over the sub-rectangle `r` of the field: every closed
 * contour at `level`. The rectangle's border counts as below the level, so
 * every loop closes.
 */
export function contourLoops(f: Field, level: number, r: Rect): Loop[] {
  const i0 = Math.max(0, Math.floor((r.x0 - f.x0) / f.step))
  const i1 = Math.min(f.nx - 1, Math.ceil((r.x1 - f.x0) / f.step))
  const j0 = Math.max(0, Math.floor((r.z0 - f.z0) / f.step))
  const j1 = Math.min(f.nz - 1, Math.ceil((r.z1 - f.z0) / f.step))
  const W = i1 - i0 + 1
  const H = j1 - j0 + 1
  // local copy with a forced-low border (and no sample exactly on the level)
  const v = new Float32Array(W * H)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let s = f.data[(j + j0) * f.nx + (i + i0)]
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) s = Math.min(s, level - 1)
      if (s === level) s += 1e-6
      v[j * W + i] = s
    }
  }
  const nH = (W - 1) * H // horizontal edges: (i,j)-(i+1,j)
  const edgeX = new Float32Array(nH + W * (H - 1))
  const edgeZ = new Float32Array(edgeX.length)
  const hasPt = new Uint8Array(edgeX.length)
  const link = new Int32Array(edgeX.length * 2).fill(-1)
  const X = (i: number) => f.x0 + (i + i0) * f.step
  const Z = (j: number) => f.z0 + (j + j0) * f.step
  const hEdge = (i: number, j: number) => {
    const id = j * (W - 1) + i
    if (!hasPt[id]) {
      const a = v[j * W + i]
      const b = v[j * W + i + 1]
      const t = (level - a) / (b - a)
      edgeX[id] = X(i) + t * f.step
      edgeZ[id] = Z(j)
      hasPt[id] = 1
    }
    return id
  }
  const vEdge = (i: number, j: number) => {
    const id = nH + j * W + i
    if (!hasPt[id]) {
      const a = v[j * W + i]
      const b = v[(j + 1) * W + i]
      const t = (level - a) / (b - a)
      edgeX[id] = X(i)
      edgeZ[id] = Z(j) + t * f.step
      hasPt[id] = 1
    }
    return id
  }
  const connect = (a: number, b: number) => {
    link[a * 2 + (link[a * 2] < 0 ? 0 : 1)] = b
    link[b * 2 + (link[b * 2] < 0 ? 0 : 1)] = a
  }
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = v[j * W + i] > level ? 1 : 0
      const b = v[j * W + i + 1] > level ? 2 : 0
      const c = v[(j + 1) * W + i + 1] > level ? 4 : 0
      const d = v[(j + 1) * W + i] > level ? 8 : 0
      const k = a | b | c | d
      if (k === 0 || k === 15) continue
      // edges: bottom (a-b), right (b-c), top (d-c), left (a-d)
      const B = () => hEdge(i, j)
      const Rt = () => vEdge(i + 1, j)
      const T = () => hEdge(i, j + 1)
      const L = () => vEdge(i, j)
      switch (k) {
        case 1:
        case 14:
          connect(L(), B())
          break
        case 2:
        case 13:
          connect(B(), Rt())
          break
        case 3:
        case 12:
          connect(L(), Rt())
          break
        case 4:
        case 11:
          connect(Rt(), T())
          break
        case 6:
        case 9:
          connect(B(), T())
          break
        case 7:
        case 8:
          connect(L(), T())
          break
        case 5:
        case 10: {
          // saddle: resolve by the cell's center
          const ctr = (v[j * W + i] + v[j * W + i + 1] + v[(j + 1) * W + i + 1] + v[(j + 1) * W + i]) / 4 > level
          if ((k === 5) === ctr) {
            connect(L(), T())
            connect(B(), Rt())
          } else {
            connect(L(), B())
            connect(Rt(), T())
          }
          break
        }
      }
    }
  }
  // walk the links into loops
  const seen = new Uint8Array(edgeX.length)
  const loops: Loop[] = []
  const buf: number[] = []
  for (let s = 0; s < edgeX.length; s++) {
    if (!hasPt[s] || seen[s] || link[s * 2] < 0) continue
    buf.length = 0
    let prev = -1
    let cur = s
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1
      const px = edgeX[cur]
      const pz = edgeZ[cur]
      const n = buf.length
      if (n < 2 || Math.abs(buf[n - 2] - px) + Math.abs(buf[n - 1] - pz) > 1e-4) buf.push(px, pz)
      const a = link[cur * 2]
      const b = link[cur * 2 + 1]
      const next = a !== prev ? a : b
      prev = cur
      cur = next
    }
    if (buf.length >= 8) {
      const n = buf.length
      if (Math.abs(buf[0] - buf[n - 2]) + Math.abs(buf[1] - buf[n - 1]) < 1e-4) buf.length -= 2
      loops.push(new Float32Array(buf))
    }
  }
  return loops
}

/** Signed area (x, z); positive = counter-clockwise in a right-handed x/z frame seen from +y. */
export function loopArea(l: Loop): number {
  let a = 0
  const n = l.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += l[i * 2] * l[j * 2 + 1] - l[j * 2] * l[i * 2 + 1]
  }
  return a / 2
}

export function loopLength(l: Loop): number {
  let s = 0
  const n = l.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s += Math.hypot(l[j * 2] - l[i * 2], l[j * 2 + 1] - l[i * 2 + 1])
  }
  return s
}

function inside(l: Loop, x: number, z: number): boolean {
  let c = false
  const n = l.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = l[i * 2]
    const zi = l[i * 2 + 1]
    const xj = l[j * 2]
    const zj = l[j * 2 + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

/**
 * One board of the stacked relief model: everything above `level`, a flat
 * top at `top` and vertical walls down to `bottom`. Attributes: position,
 * normal (walls: horizontal, pointing out of the board), aTop (1 top, 0
 * wall), aV (0 at a wall's foot → 1 at its top edge).
 */
export function boardGeometry(f: Field, loops: Loop[], level: number, bottom: number, top: number, minArea = 0.02): THREE.BufferGeometry | null {
  const keep = loops.filter(l => Math.abs(loopArea(l)) >= minArea)
  if (!keep.length) return null
  // outer loops vs holes: a loop inside an odd number of others is a hole
  const depth = keep.map((l, i) => {
    let d = 0
    for (let k = 0; k < keep.length; k++) if (k !== i && inside(keep[k], l[0], l[1])) d++
    return d
  })
  const pos: number[] = []
  const nor: number[] = []
  const aTop: number[] = []
  const aV: number[] = []
  const idx: number[] = []
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, t: number, vv: number) => {
    pos.push(x, y, z)
    nor.push(nx, ny, nz)
    aTop.push(t)
    aV.push(vv)
    return pos.length / 3 - 1
  }
  // walls, with smooth normals pointing away from the solid
  for (const l of keep) {
    const n = l.length / 2
    const segN: number[] = []
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const dx = l[j * 2] - l[i * 2]
      const dz = l[j * 2 + 1] - l[i * 2 + 1]
      const len = Math.hypot(dx, dz) || 1
      let nx = dz / len
      let nz = -dx / len
      const mx = (l[i * 2] + l[j * 2]) / 2
      const mz = (l[i * 2 + 1] + l[j * 2 + 1]) / 2
      if (f.sample(mx + nx * 0.03, mz + nz * 0.03) > level) {
        nx = -nx
        nz = -nz
      }
      segN.push(nx, nz)
    }
    const base = pos.length / 3
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n
      let nx = segN[p * 2] + segN[i * 2]
      let nz = segN[p * 2 + 1] + segN[i * 2 + 1]
      const len = Math.hypot(nx, nz) || 1
      nx /= len
      nz /= len
      push(l[i * 2], bottom, l[i * 2 + 1], nx, 0, nz, 0, 0)
      push(l[i * 2], top, l[i * 2 + 1], nx, 0, nz, 0, 1)
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const a = base + i * 2
      const b = base + j * 2
      // wind so the face looks along its outward normal
      const ex = l[j * 2] - l[i * 2]
      const ez = l[j * 2 + 1] - l[i * 2 + 1]
      // for triangle (a0, b0, a1): normal ∝ (e × up) = (-ez, 0, ex)·(-1)… test against the wall normal
      const fx = ez
      const fz = -ex
      const out = fx * segN[i * 2] + fz * segN[i * 2 + 1] > 0
      if (out) idx.push(a, a + 1, b, b, a + 1, b + 1)
      else idx.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  // tops: each outer loop with the holes directly inside it
  for (let i = 0; i < keep.length; i++) {
    if (depth[i] % 2 === 1) continue
    const outer = keep[i]
    const holes: Loop[] = []
    for (let k = 0; k < keep.length; k++) {
      if (depth[k] === depth[i] + 1 && inside(outer, keep[k][0], keep[k][1])) holes.push(keep[k])
    }
    const toV = (l: Loop) => {
      const a: THREE.Vector2[] = []
      for (let q = 0; q < l.length; q += 2) a.push(new THREE.Vector2(l[q], l[q + 1]))
      return a
    }
    const c = toV(outer)
    const hs = holes.map(toV)
    const tris = THREE.ShapeUtils.triangulateShape(c, hs)
    const all = c.concat(...hs)
    const base = pos.length / 3
    for (const p of all) push(p.x, top, p.y, 0, 1, 0, 1, 1)
    for (const t of tris) {
      const [a, b, cc] = t
      // face up (+y): (b - a) × (c - a) must have a positive y
      const ux = all[b].x - all[a].x
      const uz = all[b].y - all[a].y
      const vx = all[cc].x - all[a].x
      const vz = all[cc].y - all[a].y
      const ny = uz * vx - ux * vz
      if (ny > 0) idx.push(base + a, base + b, base + cc)
      else idx.push(base + a, base + cc, base + b)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(aTop, 1))
  g.setAttribute('aV', new THREE.Float32BufferAttribute(aV, 1))
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
  g.computeBoundingSphere()
  return g
}

export interface DrawTime {
  texture: THREE.DataTexture
  origin: THREE.Vector2
  step: number
  size: THREE.Vector2
  /** draft-clock time per world unit of pen travel (for dotted lines) */
  perUnit: number
}

/**
 * The line-draw reveal: every contour gets a start time (the coast first,
 * then each level up the hill, overlapping) and its pen travels along it at
 * one steady speed. Each texel near a line stores the time the pen passes
 * it (0..1 of the draft clock); texels far from every line hold 2 (never).
 * `levels[k]` are the loops of level k (0 = the coast).
 */
export function drawTimeTexture(levels: Loop[][], r: Rect, step: number): DrawTime {
  const W = Math.round((r.x1 - r.x0) / step) + 1
  const H = Math.round((r.z1 - r.z0) / step) + 1
  const t = new Float32Array(W * H).fill(2)
  const dist = new Float32Array(W * H).fill(1e9)
  // one pen speed for every line; each level starts a beat after the one below
  let longest = 0
  for (const ls of levels) for (const l of ls) longest = Math.max(longest, loopLength(l))
  const nL = levels.length
  const stagger = 0.62 / Math.max(1, nL - 1)
  const coastDur = 0.36
  const perUnit = coastDur / Math.max(1e-3, longest)
  let tMax = 0
  const rad = 2.4
  const R = Math.ceil(rad)
  for (let k = 0; k < nL; k++) {
    const t0 = k * stagger
    for (const l of levels[k]) {
      const n = l.length / 2
      // start at the loop's south-western-most point, like a draftsman working round
      let s = 0
      let best = Infinity
      for (let i = 0; i < n; i++) {
        const v = l[i * 2] - l[i * 2 + 1]
        if (v < best) {
          best = v
          s = i
        }
      }
      // always travel the same way round (counter-clockwise seen from above)
      const dir = loopArea(l) > 0 ? 1 : -1
      let acc = 0
      let px = l[s * 2]
      let pz = l[s * 2 + 1]
      for (let q = 0; q <= n; q++) {
        const i = (((s + q * dir) % n) + n) % n
        const x = l[i * 2]
        const z = l[i * 2 + 1]
        acc += Math.hypot(x - px, z - pz)
        px = x
        pz = z
        const time = t0 + acc * perUnit
        if (q === n) break
        tMax = Math.max(tMax, time)
        // splat into nearby texels, nearest point wins
        const fx = (x - r.x0) / step
        const fz = (z - r.z0) / step
        const ci = Math.round(fx)
        const cj = Math.round(fz)
        for (let dj = -R; dj <= R; dj++) {
          const jj = cj + dj
          if (jj < 0 || jj >= H) continue
          for (let di = -R; di <= R; di++) {
            const ii = ci + di
            if (ii < 0 || ii >= W) continue
            const d = (ii - fx) * (ii - fx) + (jj - fz) * (jj - fz)
            if (d > rad * rad) continue
            const o = jj * W + ii
            if (d < dist[o]) {
              dist[o] = d
              t[o] = time
            }
          }
        }
      }
    }
  }
  // normalise to the draft clock (the last pen lifts at 1)
  const inv = 1 / Math.max(1e-3, tMax)
  for (let i = 0; i < t.length; i++) if (t[i] < 1.5) t[i] *= inv
  const texture = new THREE.DataTexture(t, W, H, THREE.RedFormat, THREE.FloatType)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  return {
    texture,
    origin: new THREE.Vector2(r.x0, r.z0),
    step,
    size: new THREE.Vector2(W, H),
    perUnit: perUnit * inv,
  }
}
