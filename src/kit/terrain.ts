import * as THREE from 'three'
import { nextFrame } from '../core/yield'

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
  /**
   * true where the GPU can't filter float textures: the texture is NEAREST
   * and shaders must read it through HEIGHT_GLSL's chartHeight() with the
   * H_MANUAL define (heightDefines(geo)) for a full-precision bilinear
   */
  manual: boolean
}

/**
 * GLSL: sample a terrain height texture. Include it in any shader that reads
 * a TerrainData.heightTex and pass `defines: heightDefines(geo)`:
 *   float h = chartHeight(uHTex, uv, uHSize);
 * Hardware bilinear where float filtering exists; else an exact fp32 bilinear
 * from four texelFetch taps (half float would make contours jagged).
 */
export const HEIGHT_GLSL = /* glsl */ `
  float chartHeight(sampler2D t, vec2 uv, vec2 size) {
  #ifdef H_MANUAL
    vec2 p = uv * size - 0.5;
    vec2 i = floor(p);
    vec2 f = p - i;
    ivec2 hi = ivec2(size) - 1;
    ivec2 a = clamp(ivec2(i), ivec2(0), hi);
    ivec2 b = clamp(ivec2(i) + 1, ivec2(0), hi);
    float h00 = texelFetch(t, a, 0).r;
    float h10 = texelFetch(t, ivec2(b.x, a.y), 0).r;
    float h01 = texelFetch(t, ivec2(a.x, b.y), 0).r;
    float h11 = texelFetch(t, b, 0).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  #else
    return texture2D(t, uv).r;
  #endif
  }
`

/** The shader defines a terrain's height texture needs (see HEIGHT_GLSL). */
export function heightDefines(geo?: THREE.BufferGeometry): Record<string, string> {
  return (geo?.userData as TerrainData | undefined)?.manual ? { H_MANUAL: '' } : {}
}

function floatLinear(): boolean {
  const r = (globalThis as { __harkRenderer?: THREE.WebGLRenderer }).__harkRenderer
  return !!r && r.extensions.has('OES_texture_float_linear')
}

function layout(o: TerrainOptions) {
  const sx = Math.max(2, Math.round(o.seg ?? 200))
  const sz = Math.max(2, Math.round(o.segZ ?? (sx * o.depth) / o.width))
  const m = Math.max(1, Math.round(o.detail ?? 3))
  const cx = o.cx ?? 0
  const cz = o.cz ?? 0
  // the fine field: (sx*m+1) × (sz*m+1) samples; mesh vertices are every m-th
  const tx = sx * m + 1
  const tz = sz * m + 1
  return { sx, sz, m, cx, cz, tx, tz, dxT: o.width / (sx * m), dzT: o.depth / (sz * m), x0: cx - o.width / 2, z0: cz - o.depth / 2 }
}

function sampleRow(o: TerrainOptions, L: ReturnType<typeof layout>, field: Float32Array, j: number) {
  const z = L.z0 + j * L.dzT
  const row = j * L.tx
  for (let i = 0; i < L.tx; i++) field[row + i] = o.height(L.x0 + i * L.dxT, z)
}

export function terrainGeometry(o: TerrainOptions): THREE.BufferGeometry {
  const L = layout(o)
  const field = new Float32Array(L.tx * L.tz)
  for (let j = 0; j < L.tz; j++) sampleRow(o, L, field, j)
  return build(o, L, field)
}

/**
 * terrainGeometry() without a long task: samples the height field in slices
 * of ~`sliceMs`, yielding a frame between them (the loader keeps animating).
 * Prefer it in chapter init for any terrain over ~100k samples.
 */
export async function terrainGeometryAsync(o: TerrainOptions, sliceMs = 8): Promise<THREE.BufferGeometry> {
  const L = layout(o)
  const field = new Float32Array(L.tx * L.tz)
  let t0 = performance.now()
  for (let j = 0; j < L.tz; j++) {
    sampleRow(o, L, field, j)
    if (performance.now() - t0 > sliceMs) {
      await nextFrame()
      t0 = performance.now()
    }
  }
  return build(o, L, field)
}

function build(o: TerrainOptions, L: ReturnType<typeof layout>, field: Float32Array): THREE.BufferGeometry {
  const { sx, sz, m, cx, cz, tx, tz, dxT, dzT, x0, z0 } = L
  let hMin = Infinity
  let hMax = -Infinity
  for (let i = 0; i < field.length; i++) {
    const h = field[i]
    if (h < hMin) hMin = h
    if (h > hMax) hMax = h
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

  // exact float heights: hardware-filtered where the GPU filters float
  // textures; else NEAREST + chartHeight()'s manual bilinear (H_MANUAL)
  const manual = !floatLinear()
  const tex = new THREE.DataTexture(field, tx, tz, THREE.RedFormat, THREE.FloatType)
  tex.magFilter = manual ? THREE.NearestFilter : THREE.LinearFilter
  tex.minFilter = manual ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = !manual
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
    manual,
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
