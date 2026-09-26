import * as THREE from 'three'
import type { World } from '../../world/World'
import { C, FONTS, labelTexture, type LabelOptions } from '../../kit/chart'
import { mulberry32 } from '../../kit/noise'

/*
 * ECHO SOUNDING — the voices chapter's printed overlays on the water:
 *
 *   pingRings()   a sonar ping at a station: a wavefront (one bolder ring)
 *                 blooms out to uFront, a train of hairline rings drifts
 *                 outward behind it (uPhase counts rings emitted: scroll +
 *                 a slow idle pulse), fading with distance. Once the voice
 *                 has been heard, the rings settle into a static blue trace
 *                 (uTrace) around the station, like water-lining.
 *   letterPlane() map lettering that is LETTERED IN left → right (uReveal)
 *   soundings()   scattered depth figures (italic, meters + a subscript
 *                 fraction under ten) as one InstancedMesh over an atlas
 *
 * All flat printed colour, premultiplied alpha, fading into the paper with
 * the world's fog. Nothing here allocates per frame.
 */

const FOG_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

export interface PingRings {
  mesh: THREE.Mesh
  u: {
    uFront: { value: number }
    uPhase: { value: number }
    uActive: { value: number }
    uTrace: { value: number }
  }
}

/** A ping's ring field: a flat square 2·reach across, centred on the station. */
export function pingRings(world: World, reach: number, spacing: number): PingRings {
  const uniforms = {
    uFront: { value: 0 },
    uPhase: { value: 0 },
    uActive: { value: 0 },
    uTrace: { value: 0 },
    uReach: { value: reach },
    uSpacing: { value: spacing },
    uColA: { value: new THREE.Color(C.signal) },
    uColT: { value: new THREE.Color(C.waterLine) },
    uDpr: world.chart.uDpr,
    uFogNear: world.chart.uFogNear,
    uFogFar: world.chart.uFogFar,
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    toneMapped: false,
    vertexShader: FOG_VERT,
    fragmentShader: /* glsl */ `
      uniform float uFront, uPhase, uActive, uTrace, uReach, uSpacing, uDpr, uFogNear, uFogFar;
      uniform vec3 uColA, uColT;
      varying vec2 vUv;
      varying float vDepth;
      // 0..1 coverage of a line |d| px from its centre, w px wide
      float stroke(float dpx, float w) {
        return 1.0 - smoothstep(w * 0.5 - 0.5, w * 0.5 + 0.5, dpx);
      }
      void main() {
        vec2 p = (vUv - 0.5) * 2.0 * uReach;
        float r = length(p);
        float fw = max(fwidth(r), 1e-5);
        float px = max(uDpr, 0.5);

        // the ring train: a ring every uSpacing, drifting outward as uPhase grows
        float f = r / uSpacing - uPhase;
        float dRing = abs(fract(f + 0.5) - 0.5) * uSpacing / fw;
        float train = stroke(dRing, 1.3 * px);
        float inside = 1.0 - smoothstep(uFront - fw * 1.5, uFront, r);
        float fade = 1.0 - smoothstep(uReach * 0.22, uReach * 0.98, r);
        float core = smoothstep(0.32, 0.62, r);
        float a = train * inside * fade * core * 0.92;

        // the wavefront: one bolder ring, thinning as it travels
        float frontK = 1.0 - smoothstep(uReach * 0.55, uReach * 0.97, uFront);
        float front = stroke(abs(r - uFront) / fw, mix(1.3, 2.8, frontK) * px) * frontK * core;
        a = max(a, front);
        a *= uActive;

        // the settled trace: three still rings in chart blue
        float ft = r / (uSpacing * 0.62);
        float dT = abs(fract(ft + 0.5) - 0.5) * uSpacing * 0.62 / fw;
        float trace = stroke(dT, 0.9 * px) * (1.0 - smoothstep(uSpacing * 0.62 * 3.3, uSpacing * 0.62 * 3.6, r)) * smoothstep(0.4, 0.62, r);
        float at = trace * uTrace * 0.8;

        float fogK = 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
        vec3 col = uColA * a + uColT * at * (1.0 - a);
        float alpha = a + at * (1.0 - a);
        gl_FragColor = vec4(col, alpha) * fogK;
      }
    `,
  })
  const geo = new THREE.PlaneGeometry(reach * 2, reach * 2)
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 3
  return { mesh, u: uniforms }
}

export interface Letter {
  mesh: THREE.Mesh
  /** world width / height of the plane */
  width: number
  height: number
  /**
   * the letters' own box (no halo padding), mesh-local: x0..x1 along x from
   * the mesh origin, ±hz about it in z. For knocking linework out beneath.
   */
  ink: { x0: number; x1: number; hz: number }
  u: { uReveal: { value: number }; uOpacity: { value: number } }
  /** redraw (after late fonts) */
  redraw(): void
}

/**
 * Flat map lettering `height` world units tall (the canvas's full box, halo
 * padding included), lettered in left → right by u.uReveal 0..1.
 * anchor: 'left' puts the plane's left edge at the mesh origin, 'right' its
 * right edge, 'center' its centre.
 */
export function letterPlane(world: World, text: string, o: LabelOptions & { height: number; anchor?: 'left' | 'right' | 'center' }): Letter {
  let { texture, aspect } = labelTexture(text, o)
  texture.premultiplyAlpha = true
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  const uniforms = {
    uMap: { value: texture as THREE.Texture },
    uReveal: { value: 1 },
    uOpacity: { value: 1 },
    uFogNear: world.chart.uFogNear,
    uFogFar: world.chart.uFogFar,
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    toneMapped: false,
    vertexShader: FOG_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uReveal, uOpacity, uFogNear, uFogFar;
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        // a pen stroke's worth of soft edge, sweeping left to right
        float e = uReveal * 1.08;
        float shown = 1.0 - smoothstep(e - 0.08, e, vUv.x);
        float fogK = 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = t * (shown * uOpacity * fogK);
      }
    `,
  })
  const h = o.height
  const w = h * aspect
  const geo = new THREE.PlaneGeometry(w, h)
  const shift = o.anchor === 'right' ? -w / 2 : o.anchor === 'center' ? 0 : w / 2
  geo.translate(shift, 0, 0)
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geo, mat)
  // lettering prints last: its halo knocks the rings out around each glyph
  mesh.renderOrder = 6
  // the letters' box inside the canvas: labelTexture pads each side by the halo
  // plus a fifth of the (2x) em, and centres a line one em tall
  const cvH = (texture.image as HTMLCanvasElement).height || 1
  const em = (o.size ?? 48) * 2
  const pad = Math.ceil((o.haloWidth ?? 0.22) * em + em * 0.2)
  const perPx = h / cvH
  const ink = {
    x0: shift - w / 2 + pad * perPx,
    x1: shift + w / 2 - pad * perPx,
    // mixed case with ascenders + descenders spans about an em; capitals about 0.72
    hz: em * perPx * (o.uppercase ? 0.37 : 0.52),
  }
  return {
    mesh,
    width: w,
    height: h,
    ink,
    u: uniforms,
    redraw() {
      const next = labelTexture(text, o)
      next.texture.premultiplyAlpha = true
      next.texture.generateMipmaps = true
      next.texture.minFilter = THREE.LinearMipmapLinearFilter
      const old = uniforms.uMap.value
      uniforms.uMap.value = next.texture
      old.dispose()
      texture = next.texture
      aspect = next.aspect
    },
  }
}

/* ------------------------------------------------------------------ knock-out */

/** how many lettered boxes a route can be knocked out under */
export const KNOCK_MAX = 16

export interface Knock {
  /** world rects (x0, z0, x1, z1); unused entries lie far off the chart */
  rects: THREE.Vector4[]
  /** 0..1 per rect: how far the knock-out has printed (follow the lettering's reveal) */
  k: number[]
}

export function makeKnock(): Knock {
  return {
    rects: Array.from({ length: KNOCK_MAX }, () => new THREE.Vector4(1e5, 1e5, 1e5, 1e5)),
    k: new Array<number>(KNOCK_MAX).fill(0),
  }
}

/**
 * GLSL: knockOut(p) = 0 inside every (printed) lettered box, 1 clear of them
 * all, soft over a fifth of a unit outside each box. Bind the uniforms with
 * bindKnock(). Constant loop, no derivatives: callable anywhere.
 */
export const KNOCK_GLSL = /* glsl */ `
  uniform vec4 uKnock[${KNOCK_MAX}];
  uniform float uKnockK[${KNOCK_MAX}];
  float knockOut(vec2 p) {
    float m = 1.0;
    for (int i = 0; i < ${KNOCK_MAX}; i++) {
      vec4 r = uKnock[i];
      vec2 q = max(abs(p - (r.xy + r.zw) * 0.5) - (r.zw - r.xy) * 0.5, 0.0);
      m = min(m, mix(1.0, smoothstep(0.0, 0.2, length(q)), uKnockK[i]));
    }
    return m;
  }
`

export function bindKnock(mat: THREE.ShaderMaterial, knock: Knock) {
  mat.uniforms.uKnock = { value: knock.rects }
  mat.uniforms.uKnockK = { value: knock.k }
}

/**
 * Knock a route ribbon (kit routeRibbon) out under lettered boxes, as a
 * printed chart does: the line's alpha falls to 0 inside each rect, scaled
 * by knock.k. Splices the ribbon's own ShaderMaterial; if the kit's shader
 * text ever changes shape, the splice is skipped and the plain route
 * remains. Returns whether it applied.
 */
export function knockRoute(mat: THREE.ShaderMaterial, knock: Knock): boolean {
  const vsA = 'varying float vSide;'
  const vsB = 'gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);'
  const fsA = 'float a = dash * drawn * edge * uOpacity;'
  const vs = mat.vertexShader
  const fs = mat.fragmentShader
  if (!vs.includes(vsA) || !vs.includes(vsB) || !fs.includes(vsA) || !fs.includes(fsA)) return false
  mat.vertexShader = vs.replace(vsA, `${vsA}\n      varying vec2 vXZ;`).replace(vsB, `vXZ = (modelMatrix * vec4(position, 1.0)).xz;\n        ${vsB}`)
  mat.fragmentShader = fs.replace(vsA, `${vsA}\n      varying vec2 vXZ;\n${KNOCK_GLSL}`).replace(fsA, `${fsA}\n        a *= knockOut(vXZ);`)
  bindKnock(mat, knock)
  mat.needsUpdate = true
  return true
}

/* ------------------------------------------------------------------ soundings */

export interface Sounding {
  x: number
  z: number
  /** depth, meters */
  m: number
  /** 0..1 order of printing (reveal) */
  t: number
}

const COLS = 8
const ROWS = 16
const CW = 128
const CH = 64

/** "7₄" = 7.4 m: under ten meters a subscript tenth (decimeters), whole meters above */
function soundingText(m: number): [string, string] {
  if (m < 10) {
    const whole = Math.floor(m)
    const tenth = Math.floor((m - whole) * 10)
    return [String(whole), tenth > 0 ? String(tenth) : '']
  }
  return [String(Math.round(m)), '']
}

function drawAtlas(cv: HTMLCanvasElement, keys: string[]) {
  const x = cv.getContext('2d')!
  x.clearRect(0, 0, cv.width, cv.height)
  x.textBaseline = 'alphabetic'
  x.fillStyle = '#34566a'
  keys.forEach((k, i) => {
    const [a, b] = k.split('|')
    const cx = (i % COLS) * CW
    const cy = Math.floor(i / COLS) * CH
    x.font = `italic 400 44px ${FONTS.display}`
    const wa = x.measureText(a).width
    x.font = `italic 400 27px ${FONTS.display}`
    const wb = b ? x.measureText(b).width + 1 : 0
    const left = cx + (CW - wa - wb) / 2
    const base = cy + CH * 0.66
    x.font = `italic 400 44px ${FONTS.display}`
    x.fillText(a, left, base)
    if (b) {
      x.font = `italic 400 27px ${FONTS.display}`
      x.fillText(b, left + wa + 1, base + 8)
    }
  })
}

export interface Soundings {
  mesh: THREE.InstancedMesh
  u: { uOpacity: { value: number }; uPrint: { value: number } }
  redraw(): void
}

/**
 * The soundings as one InstancedMesh: each instance a flat quad showing one
 * atlas cell. `size` = world height of a cell (the figure is ~0.7 of it).
 * uPrint 0..1 prints them in `t` order (soft), uOpacity fades the lot.
 */
export function soundings(world: World, list: Sounding[], size: number): Soundings {
  const keys: string[] = []
  const index = new Map<string, number>()
  const cell = list.map(s => {
    const [a, b] = soundingText(s.m)
    const k = `${a}|${b}`
    let i = index.get(k)
    if (i === undefined && keys.length < COLS * ROWS) {
      i = keys.length
      index.set(k, i)
      keys.push(k)
    }
    return i ?? 0
  })
  const cv = document.createElement('canvas')
  cv.width = COLS * CW
  cv.height = ROWS * CH
  drawAtlas(cv, keys)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.premultiplyAlpha = true
  tex.anisotropy = 8
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter

  const geo = new THREE.PlaneGeometry(1, 1)
  geo.rotateX(-Math.PI / 2)
  const aCell = new Float32Array(list.length * 3)
  list.forEach((s, i) => {
    const c = cell[i]
    aCell[i * 3] = (c % COLS) / COLS
    // canvas rows run down; texture v runs up (flipY)
    aCell[i * 3 + 1] = 1 - (Math.floor(c / COLS) + 1) / ROWS
    aCell[i * 3 + 2] = s.t
  })
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(aCell, 3))
  const uniforms = {
    uMap: { value: tex as THREE.Texture },
    uCell: { value: new THREE.Vector2(1 / COLS, 1 / ROWS) },
    uOpacity: { value: 1 },
    uPrint: { value: 1 },
    uFogNear: world.chart.uFogNear,
    uFogFar: world.chart.uFogFar,
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    toneMapped: false,
    vertexShader: /* glsl */ `
      attribute vec3 aCell;
      uniform vec2 uCell;
      varying vec2 vUv;
      varying float vT;
      varying float vDepth;
      void main() {
        vUv = aCell.xy + uv * uCell;
        vT = aCell.z;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uOpacity, uPrint, uFogNear, uFogFar;
      varying vec2 vUv;
      varying float vT;
      varying float vDepth;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        float printed = 1.0 - smoothstep(uPrint * 1.2 - 0.2, uPrint * 1.2, vT);
        float fogK = 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = t * (printed * uOpacity * fogK * 0.92);
      }
    `,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, list.length)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const sc = new THREE.Vector3(size * (CW / CH), 1, size)
  const p = new THREE.Vector3()
  list.forEach((s, i) => {
    p.set(s.x, 0.012, s.z)
    m.compose(p, q, sc)
    mesh.setMatrixAt(i, m)
  })
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
  mesh.renderOrder = 2
  return {
    mesh,
    u: uniforms,
    redraw() {
      drawAtlas(cv, keys)
      tex.needsUpdate = true
    },
  }
}

/** Scatter soundings over the water on a jittered grid, clear of `keepOut` discs. */
export function scatterSoundings(
  height: (x: number, z: number) => number,
  o: {
    x0: number
    x1: number
    z0: number
    z1: number
    step: number
    minDepth: number
    /** meters of depth per height unit */
    meters: number
    /** discs [x, z, r] */
    keepOut: [number, number, number][]
    /** rectangles [x0, z0, x1, z1] */
    keepRect?: [number, number, number, number][]
    seed: number
  },
): Sounding[] {
  const rnd = mulberry32(o.seed)
  const out: Sounding[] = []
  for (let z = o.z0; z <= o.z1; z += o.step) {
    for (let x = o.x0; x <= o.x1; x += o.step) {
      const jx = x + (rnd() - 0.5) * o.step * 0.8
      const jz = z + (rnd() - 0.5) * o.step * 0.8
      const t = rnd()
      const h = height(jx, jz)
      if (-h < o.minDepth) continue
      let ok = true
      for (const [kx, kz, kr] of o.keepOut) {
        const dx = jx - kx
        const dz = jz - kz
        if (dx * dx + dz * dz < kr * kr) {
          ok = false
          break
        }
      }
      for (const [ax, az, bx, bz] of o.keepRect ?? []) {
        if (jx > ax && jx < bx && jz > az && jz < bz) ok = false
      }
      if (!ok) continue
      out.push({ x: jx, z: jz, m: -h * o.meters, t })
    }
  }
  return out
}
