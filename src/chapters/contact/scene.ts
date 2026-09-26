import * as THREE from 'three'
import type { World } from '../../world/World'
import { C, chartMaterial, labelTexture, type ChartMaterial, type LabelOptions } from '../../kit/chart'
import { terrainGeometryAsync, type HeightFn } from '../../kit/terrain'
import { simplex2, fbm } from '../../kit/noise'
import { nextFrame } from '../../core/yield'
import { DISC_R, releaseOnUpload } from './disc'

/*
 * The chart around the benchmark: a quiet knoll with a flat, round top where
 * the disc is set, rolling country falling away from it, a broad river to the
 * east and a narrower one to the west (the studio's home ground, loosely:
 * no real survey), map lettering draped on the land, a vermilion "you are
 * here" ring that draws itself round the disc, and the LISTENING RINGS: thin
 * water-lining-style circles that leave the disc and drift out across the
 * chart like sound (hark = listen).
 *
 * Every overlay (rings, lettering) reads the chart material's uLift / uBase
 * uniforms by reference, so it sits exactly on the land whether the map is
 * flat or lifted.
 */

/** height of the knoll's flat top (the benchmark sits here, full relief) */
export const TOP = 2.3
/** the knoll's flat top radius */
const TOP_R = 1.6

const sstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function makeHeight(): HeightFn {
  const n = simplex2(2016)
  const w = simplex2(1975)
  return (x: number, z: number) => {
    const r0 = Math.hypot(x, z)
    // the knoll: round flat top, soft shoulder, a long apron (slightly lobed, never a cone)
    const lobe = 1 + 0.16 * w(x * 0.11 + 3.1, z * 0.11 - 1.7) * sstep(TOP_R, TOP_R + 3, r0)
    const r = r0 * lobe
    const t = Math.min(1, Math.max(0, (r - TOP_R) / 5.6))
    const knoll = 1 - t * t * (3 - 2 * t)
    // rolling country beyond it, quiet on the top; higher hills to the north-west
    const quiet = sstep(TOP_R + 0.8, TOP_R + 5.5, r0)
    const nw = sstep(-4, 14, -x * 0.7 - z * 0.9)
    const roll = fbm(n, x * 0.07 + 4.2, z * 0.07 - 2.6, 4) * (0.55 + 0.75 * nw) * quiet
    let h = 0.5 + (TOP - 0.5) * knoll + roll + 0.7 * nw * quiet
    // the broad river (east) and the narrower one (west): smooth banks, shallow beds
    const ex = x - (10.4 + 2.2 * Math.sin(z * 0.12 + 0.5) + 0.1 * z)
    const eW = 2.3 + 0.5 * Math.sin(z * 0.23 + 1.3)
    const east = 1 - sstep(eW * 0.55, eW + 2.4, Math.abs(ex))
    const wx = x - (-10.2 + 1.5 * Math.sin(z * 0.19 + 2.1) - 0.12 * z)
    const wW = 1.05 + 0.25 * Math.sin(z * 0.31)
    const west = 1 - sstep(wW * 0.5, wW + 1.9, Math.abs(wx))
    const wet = Math.max(east, west)
    h = h * (1 - wet) + -0.62 * wet
    return h
  }
}

export interface ChartSet {
  land: THREE.Mesh
  chart: ChartMaterial
  height: HeightFn
  /** listening rings (uniforms) */
  rings: {
    mesh: THREE.Mesh
    u: {
      uPhase: { value: number }
      uReach: { value: number }
      uAmt: { value: number }
      uColor: { value: THREE.Color }
    }
  }
  /** the "you are here" ring (world y set per frame) */
  here: {
    mesh: THREE.Mesh
    u: { uDraw: { value: number }; uOpacity: { value: number }; uWidth: { value: number } }
  }
  labels: THREE.Mesh[]
  labelU: { uOpacity: { value: number } }
  redrawLabels(): void
}

const RING_VERT = /* glsl */ `
  attribute float aH;
  uniform float uLift, uBase;
  varying vec3 vW;
  varying float vDepth;
  void main() {
    vec3 p = position;
    p.y = uBase + aH * uLift;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vW = w.xyz;
    vec4 mv = viewMatrix * w;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

/*
 * Listening rings: packets of three hairline rings (a sound mark, "((("),
 * one packet every uPeriod units, leaving the disc and drifting outward
 * (uPhase, in packets), fading as they travel. The leading ring is the
 * strongest.
 */
const RING_FRAG = /* glsl */ `
  uniform float uPhase, uPeriod, uGap, uR0, uReach, uAmt, uDpr, uFogNear, uFogFar;
  uniform vec3 uColor;
  varying vec3 vW;
  varying float vDepth;
  void main() {
    float d = length(vW.xz);
    // sub-ring coordinate: one integer per ring slot (uGap apart), moving outward
    float slots = floor(uPeriod / uGap + 0.5);
    float g = (d - uR0) / uGap - uPhase * slots;
    float fw = max(fwidth(g), 1e-5);
    float px = max(uDpr, 0.5);
    float wpx = 1.5 * px;
    float dl = abs(fract(g - 0.5) - 0.5) / fw;
    float line = 1.0 - smoothstep(wpx * 0.5 - 0.5, wpx * 0.5 + 0.5, dl);
    line *= 1.0 - smoothstep(0.2, 0.55, fw);
    // which slot of the packet this ring is (2 = leading)
    float j = mod(floor(g + 0.5), slots);
    float w = j < 0.5 ? 0.42 : (j < 1.5 ? 0.7 : (j < 2.5 ? 1.0 : 0.0));
    // born at the disc's setting, fading as they travel out
    float born = smoothstep(uR0, uR0 + 0.5, d);
    float fade = 1.0 - smoothstep(uReach * 0.25, uReach, d);
    float fog = smoothstep(uFogNear, uFogFar, vDepth);
    float a = line * w * born * fade * (1.0 - fog) * uAmt;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`

const HERE_VERT = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/** a ring that draws itself clockwise from north (a pen circling the benchmark) */
const HERE_FRAG = /* glsl */ `
  uniform float uDraw, uOpacity, uRadius, uWidth;
  uniform vec3 uColor;
  varying vec2 vP;
  void main() {
    float r = length(vP);
    float fw = max(fwidth(r), 1e-5);
    float band = 1.0 - smoothstep(uWidth * 0.5 - fw, uWidth * 0.5 + fw, abs(r - uRadius));
    // angle from north (-z = +y in the ring's plane), clockwise seen from above
    float a = atan(vP.x, vP.y);
    float t = fract(a / 6.2831853 + 1.0);
    float fa = max(fwidth(t), 1e-5);
    float drawn = uDraw >= 1.0 ? 1.0 : 1.0 - smoothstep(uDraw - fa, uDraw + fa, t);
    float alpha = band * drawn * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`

const LABEL_VERT = /* glsl */ `
  attribute float aH;
  uniform float uLift, uBase;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vec3 p = position;
    p.y = uBase + aH * uLift + 0.03;
    vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const LABEL_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity, uFogNear, uFogFar;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float fog = smoothstep(uFogNear, uFogFar, vDepth);
    float a = t.a * uOpacity * (1.0 - fog);
    if (a < 0.004) discard;
    gl_FragColor = vec4(t.rgb, a);
  }
`

interface LabelSpec {
  text: string
  o: LabelOptions
  x: number
  z: number
  /** rotation about y (radians, + = counter-clockwise seen from above) */
  rot: number
  /** world height of the lettering */
  h: number
}

const LABELS: LabelSpec[] = [
  // place names: letter-spaced caps (decorative map lettering)
  { text: 'Philadelphia', o: { font: 'sans', weight: 700, uppercase: true, tracking: 0.42, size: 52, color: C.ink }, x: -0.4, z: -4.7, rot: 0.03, h: 0.44 },
  // water names: Newsreader italic, set along the flow
  { text: 'Delaware', o: { font: 'display', italic: true, size: 56, color: C.coast, halo: null }, x: 10.6, z: -3.5, rot: -1.43, h: 0.9 },
  { text: 'Schuylkill', o: { font: 'display', italic: true, size: 56, color: C.coast, halo: null }, x: -10.4, z: 1.6, rot: 1.36, h: 0.66 },
  // spot heights / sheet marginalia (decorative)
  { text: '× 212', o: { font: 'mono', weight: 500, size: 40, color: C.inkSoft }, x: -7.2, z: -10.5, rot: 0, h: 0.34 },
  { text: '× 164', o: { font: 'mono', weight: 500, size: 40, color: C.inkSoft }, x: 4.4, z: 6.8, rot: 0, h: 0.34 },
]

function drapedLabel(spec: LabelSpec, height: HeightFn, uniforms: Record<string, THREE.IUniform>, final: boolean) {
  const { texture, aspect } = labelTexture(spec.text, spec.o)
  if (final) releaseOnUpload(texture)
  const w = spec.h * aspect
  const geo = new THREE.PlaneGeometry(w, spec.h, Math.max(4, Math.ceil(w / 0.25)), 3)
  geo.rotateX(-Math.PI / 2)
  geo.rotateY(spec.rot)
  geo.translate(spec.x, 0, spec.z)
  const p = geo.attributes.position as THREE.BufferAttribute
  const aH = new Float32Array(p.count)
  for (let i = 0; i < p.count; i++) aH[i] = height(p.getX(i), p.getZ(i))
  geo.setAttribute('aH', new THREE.BufferAttribute(aH, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uMap: { value: texture } },
    vertexShader: LABEL_VERT,
    fragmentShader: LABEL_FRAG,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const m = new THREE.Mesh(geo, mat)
  m.renderOrder = 2
  return m
}

/**
 * @param fontsFinal the web fonts were in when this ran: the lettering is
 * final and its canvases are released after upload (else after redrawLabels)
 */
export async function buildChart(world: World, mobile: boolean, fontsFinal = true): Promise<ChartSet> {
  const height = makeHeight()
  // sampled in ~8 ms slices (≈ 360k samples on desktop: no long task)
  const geo = await terrainGeometryAsync({
    width: 60,
    depth: 60,
    seg: mobile ? 130 : 200,
    detail: mobile ? 2 : 3,
    height,
    cx: 0,
    cz: -3,
  })
  await nextFrame()
  const chart = chartMaterial(world, {
    terrain: geo,
    interval: 0.2,
    index: 5,
    hMin: 0,
    hMax: 6,
    stepped: 0.75,
    shade: 0.8,
    waterLines: 4,
    waterSpacing: 0.12,
    grid: 0,
    gridSize: 5,
    lift: 0,
    edge: 9,
  })
  const land = new THREE.Mesh(geo, chart)
  land.renderOrder = 0

  // listening rings: the same land, a second, transparent pass
  const ringU = {
    uLift: chart.uniforms.uLift,
    uBase: chart.uniforms.uBase,
    uDpr: world.chart.uDpr,
    uFogNear: world.chart.uFogNear,
    uFogFar: world.chart.uFogFar,
    uPhase: { value: 0 },
    uPeriod: { value: 3.2 },
    uGap: { value: 0.32 },
    uR0: { value: DISC_R * 1.62 },
    uReach: { value: 14 },
    uAmt: { value: 0 },
    uColor: { value: new THREE.Color('#bf3c20') },
  }
  const ringMesh = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: ringU,
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -3,
    }),
  )
  ringMesh.renderOrder = 1

  // "you are here"
  const hereU = {
    uDraw: { value: 1 },
    uOpacity: { value: 1 },
    uRadius: { value: DISC_R * 1.5 },
    uWidth: { value: 0.1 },
    uColor: { value: new THREE.Color('#bf3c20') },
  }
  const hereGeo = new THREE.RingGeometry(DISC_R * 1.3, DISC_R * 1.72, 128, 1)
  const hereMesh = new THREE.Mesh(
    hereGeo,
    new THREE.ShaderMaterial({
      uniforms: hereU,
      vertexShader: HERE_VERT,
      fragmentShader: HERE_FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }),
  )
  hereMesh.rotation.x = -Math.PI / 2
  hereMesh.renderOrder = 2

  const labelU = { uOpacity: { value: 1 } }
  const shared = {
    uLift: chart.uniforms.uLift,
    uBase: chart.uniforms.uBase,
    uFogNear: world.chart.uFogNear,
    uFogFar: world.chart.uFogFar,
    uOpacity: labelU.uOpacity,
  }
  const labels = LABELS.map(s => drapedLabel(s, height, shared, fontsFinal))
  const redrawLabels = () => {
    LABELS.forEach((s, i) => {
      const mat = labels[i].material as THREE.ShaderMaterial
      const old = mat.uniforms.uMap.value as THREE.Texture
      const { texture } = labelTexture(s.text, s.o)
      releaseOnUpload(texture)
      mat.uniforms.uMap.value = texture
      old.dispose()
    })
  }

  return {
    land,
    chart,
    height,
    rings: { mesh: ringMesh, u: ringU },
    here: { mesh: hereMesh, u: hereU },
    labels,
    labelU,
    redrawLabels,
  }
}
