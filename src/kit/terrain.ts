import * as THREE from 'three'

/*
 * Height-field terrain for the chart material (src/kit/chart.ts).
 *
 * The geometry is a flat XZ grid; each vertex carries its FULL-relief height
 * (`aH`) and slope (`aG` = dh/dx, dh/dz). The chart shader lifts it by the
 * `uLift` uniform (0 = the flat printed map, 1 = full 3D relief), so a
 * chapter can animate "the map rises into land" for free, and the contour
 * lines always sit on the same ground whether the map is flat or lifted.
 *
 *   const height = (x, z) => ...            // world units, < 0 is water
 *   const geo = terrainGeometry({ width: 40, depth: 40, seg: 200, height })
 *   const land = new THREE.Mesh(geo, chartMaterial(ctx.world, { terrain: geo, interval: 0.25 }))
 *   // place props with the same function: prop.position.y = height(x, z) * lift
 *
 * The height function is sampled ONCE on a fine grid (seg × detail per side):
 * the mesh takes every `detail`-th sample, and the full field becomes a
 * linear-filtered height texture the chart shader draws its lines from — so
 * contours are smooth curves at any zoom. Keep ~200 segments on desktop and
 * ~130 on mobile (ctx.mobile); the height fn must be cheap (it runs
 * (seg*detail)² times — cache SDF/noise lookups, yield with nextFrame() between
 * big terrains).
 */

export type HeightFn = (x: number, z: number) => number

export interface TerrainOptions {
  width: number
  depth: number
  /** mesh segments along x (default 200) */
  seg?: number
  /** mesh segments along z (default: keeps cells square) */
  segZ?: number
  /**
   * height-texture samples per mesh cell (default 3). The chart shader draws
   * contours, coast and water lines from this finer texture, so lines are
   * smooth curves instead of triangle facets. 2 is plenty on phones.
   */
  detail?: number
  height: HeightFn
  /** world-space centre of the grid (default 0, 0) */
  cx?: number
  cz?: number
}

/** What terrainGeometry leaves in geo.userData (chartMaterial reads it via `terrain: geo`). */
export interface TerrainData {
  hMin: number
  hMax: number
  /** fine height field (R channel, world units), linear-filtered */
  heightTex: THREE.DataTexture
  /** world x/z of texel 0's centre, and world units per texel */
  origin: THREE.Vector2
  step: THREE.Vector2
  size: THREE.Vector2
  width: number
  depth: number
  cx: number
  cz: number
}

function floatLinear(): boolean {
  const r = (globalThis as { __harkRenderer?: THREE.WebGLRenderer }).__harkRenderer
  return !!r && r.extensions.has('OES_texture_float_linear')
}

export function terrainGeometry(o: TerrainOptions): THREE.BufferGeometry {
  const sx = Math.max(2, Math.round(o.seg ?? 200))
  const sz = Math.max(2, Math.round(o.segZ ?? (sx * o.depth) / o.width))
  const m = Math.max(1, Math.round(o.detail ?? 3))
  const cx = o.cx ?? 0
  const cz = o.cz ?? 0
  // the fine field: (sx*m+1) × (sz*m+1) samples; mesh vertices are every m-th
  const tx = sx * m + 1
  const tz = sz * m + 1
  const dxT = o.width / (sx * m)
  const dzT = o.depth / (sz * m)
  const x0 = cx - o.width / 2
  const z0 = cz - o.depth / 2
  const field = new Float32Array(tx * tz)
  let hMin = Infinity
  let hMax = -Infinity
  for (let j = 0; j < tz; j++) {
    const z = z0 + j * dzT
    for (let i = 0; i < tx; i++) {
      const h = o.height(x0 + i * dxT, z)
      field[j * tx + i] = h
      if (h < hMin) hMin = h
      if (h > hMax) hMax = h
    }
  }
  const at = (i: number, j: number) => field[Math.min(tz - 1, Math.max(0, j)) * tx + Math.min(tx - 1, Math.max(0, i))]

  const nx = sx + 1
  const nz = sz + 1
  const pos = new Float32Array(nx * nz * 3)
  const uv = new Float32Array(nx * nz * 2)
  const hArr = new Float32Array(nx * nz)
  const gArr = new Float32Array(nx * nz * 2)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      const fi = i * m
      const fj = j * m
      pos[k * 3] = x0 + fi * dxT
      pos[k * 3 + 1] = 0
      pos[k * 3 + 2] = z0 + fj * dzT
      uv[k * 2] = i / sx
      uv[k * 2 + 1] = 1 - j / sz
      hArr[k] = at(fi, fj)
      // slope over one mesh cell (smooth hillshade), from the fine field
      gArr[k * 2] = (at(fi + m, fj) - at(fi - m, fj)) / (2 * m * dxT)
      gArr[k * 2 + 1] = (at(fi, fj + m) - at(fi, fj - m)) / (2 * m * dzT)
    }
  }
  const index = new (nx * nz > 65535 ? Uint32Array : Uint16Array)(sx * sz * 6)
  let n = 0
  for (let j = 0; j < sz; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * nx + i
      const b = a + 1
      const c = a + nx
      const d = c + 1
      // split each cell along the diagonal whose heights agree better (fewer creases)
      if (Math.abs(hArr[a] - hArr[d]) < Math.abs(hArr[b] - hArr[c])) {
        index[n++] = a
        index[n++] = c
        index[n++] = d
        index[n++] = a
        index[n++] = d
        index[n++] = b
      } else {
        index[n++] = a
        index[n++] = c
        index[n++] = b
        index[n++] = b
        index[n++] = c
        index[n++] = d
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setAttribute('aH', new THREE.BufferAttribute(hArr, 1))
  geo.setAttribute('aG', new THREE.BufferAttribute(gArr, 2))
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  // bounds cover the full relief (lift ≤ 1) so frustum culling never clips a lifted map
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(x0, Math.min(0, hMin), z0),
    new THREE.Vector3(x0 + o.width, Math.max(0, hMax), z0 + o.depth),
  )
  geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere())

  // float-linear where the GPU filters float textures, else half float (always filterable)
  let tex: THREE.DataTexture
  if (floatLinear()) {
    tex = new THREE.DataTexture(field, tx, tz, THREE.RedFormat, THREE.FloatType)
  } else {
    const half = new Uint16Array(field.length)
    for (let i = 0; i < field.length; i++) half[i] = THREE.DataUtils.toHalfFloat(field[i])
    tex = new THREE.DataTexture(half, tx, tz, THREE.RedFormat, THREE.HalfFloatType)
  }
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  const data: TerrainData = {
    hMin,
    hMax,
    heightTex: tex,
    origin: new THREE.Vector2(x0, z0),
    step: new THREE.Vector2(dxT, dzT),
    size: new THREE.Vector2(tx, tz),
    width: o.width,
    depth: o.depth,
    cx,
    cz,
  }
  geo.userData = data
  return geo
}

/** Height range of a terrainGeometry (for the chart material's tint ramp). */
export function heightRange(geo: THREE.BufferGeometry): { hMin: number; hMax: number } {
  const d = geo.userData as TerrainData
  return { hMin: d.hMin, hMax: d.hMax }
}

/**
 * Sample points along a polyline laid on the terrain (routes, ridgelines).
 * Returns world points at `lift`, raised `offset` above the ground.
 */
export function drape(points: [number, number][], height: HeightFn, { lift = 1, offset = 0.02, step = 0.25 } = {}) {
  const out: THREE.Vector3[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i]
    const [x1, z1] = points[i + 1]
    const len = Math.hypot(x1 - x0, z1 - z0)
    const n = Math.max(1, Math.ceil(len / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      const x = x0 + (x1 - x0) * t
      const z = z0 + (z1 - z0) * t
      out.push(new THREE.Vector3(x, height(x, z) * lift + offset, z))
    }
  }
  const [xl, zl] = points[points.length - 1]
  out.push(new THREE.Vector3(xl, height(xl, zl) * lift + offset, zl))
  return out
}
