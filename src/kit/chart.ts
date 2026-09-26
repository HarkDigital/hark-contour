import * as THREE from 'three'
import type { World } from '../world/World'
import type { TerrainData } from './terrain'

/*
 * THE CHART KIT — Hark Contour's shared visual language. Every chapter is a
 * printed topographic chart that can rise into 3D relief.
 *
 *   C                       the palette (hex, sRGB) — matches the CSS tokens
 *   chartMaterial(world, o) the terrain shader for terrainGeometry() (pass
 *                           `terrain: geo` for smooth texture-drawn lines):
 *                           layer tints + NW hillshade + contour lines (index
 *                           every 5th) + water with water-lining rings that
 *                           drift outward like sound + coastline + optional
 *                           graticule + highlight + "print-on" reveal + fog
 *   labelTexture / mapLabel map lettering (Newsreader italic for water,
 *                           letter-spaced Overpass caps for places, Overpass
 *                           Mono for coordinates) with a paper halo
 *   marker()                a printed survey marker: ground ring + stem + head
 *   routeRibbon()           a dashed route that draws itself (uProgress)
 *   ensureFonts()           await before drawing any canvas text
 *
 * Everything is flat printed colour: MeshBasicMaterial / ShaderMaterial with
 * toneMapped false, lit only by the chart's own hillshade. Real lights
 * (world.key / world.hemi) are for the few true 3D props.
 *
 * Contour lines are analytic (fwidth), so they stay 1 px crisp at any zoom
 * and fade out instead of moiréing where they crowd. Keep terrain meshes
 * unrotated (translate only): the hillshade reads slopes in world XZ.
 */

/** Palette (sRGB hex). Paper, ink, contour browns, layer tints, water blues, survey vermilion. */
export const C = {
  paper: '#f2ecdf',
  paper2: '#e9e1cf',
  paperDeep: '#dcd1b9',
  ink: '#2b2521',
  inkSoft: '#5b5047',
  contour: '#a0714a',
  index: '#6f4528',
  /** layer tints, lowland → summit (no greens: sand, ochre, umber, rock, snow) */
  tints: ['#efe8d4', '#e6dbbd', '#d9c7a0', '#c8ad86', '#b39a7e', '#ece6da'],
  water: '#c4dae0',
  waterDeep: '#9dbfcc',
  waterLine: '#4f86a2',
  coast: '#2e5d75',
  grid: '#7fa2b3',
  /** survey vermilion: routes, markers, the active contour — the concept accent */
  signal: '#d2462a',
  /** vermilion dark enough for small text on paper (≥ 4.5:1) */
  signalText: '#a8341a',
  /** the storm (shield chapter only) */
  storm: '#4a3566',
  alarm: '#b3241c',
} as const

export interface ChartOptions {
  /** contour interval in height units (default 0.2) */
  interval?: number
  /** every Nth contour is an index contour (default 5) */
  index?: number
  /** contour width in CSS px (default 1.0) */
  line?: number
  /** index contour width in CSS px (default 1.9) */
  indexLine?: number
  /** coastline width in CSS px (default 1.6) */
  coastLine?: number
  /** tint ramp range (pass heightRange(geo)); default -1..4 */
  hMin?: number
  hMax?: number
  /** 0 smooth tints .. 1 stepped layer tints (default 0.7) */
  stepped?: number
  /** hillshade strength 0..1 (default 0.85) */
  shade?: number
  /** hillshade exaggeration (default 1) */
  relief?: number
  /** 0 blank paper (linework only) .. 1 full tints (default 1) */
  tint?: number
  /** contour/coast line opacity (default 1) */
  lines?: number
  /** 1: height < 0 is water; 0: all land (default 1) */
  water?: number
  /** water-lining rings off the coast (default 5) */
  waterLines?: number
  /** height step between water-lining rings (default interval * 0.7) */
  waterSpacing?: number
  /** water-lining drift, rings per second outward (default 0.08; 0 under reduced motion) */
  ripple?: number
  /** graticule opacity (default 0) and spacing in world units (default 4) */
  grid?: number
  gridSize?: number
  /** initial lift 0 (flat printed map) .. 1 (full relief) (default 1) */
  lift?: number
  /** how far the sea floor sinks with the lift, 0..1 (default 1; 0 keeps the sea a flat plane) */
  seaLift?: number
  /** fog on (default true) */
  fog?: boolean
  /**
   * the terrainGeometry this material draws: lines come from its fine
   * height texture, the tint range defaults to its heights, and the chart
   * fades into the paper margin near its edges (see `edge`)
   */
  terrain?: THREE.BufferGeometry
  /** width of the fade into paper at the terrain's edges, world units (default 12% of the short side; 0 = none) */
  edge?: number
}

export interface ChartUniforms {
  [name: string]: THREE.IUniform
  uLift: { value: number }
  /** 0..1 how far the sea floor sinks with the lift (0 = the sea stays a flat plane) */
  uSeaLift: { value: number }
  uBase: { value: number }
  uInterval: { value: number }
  uIndex: { value: number }
  uLine: { value: number }
  uIndexLine: { value: number }
  uCoastLine: { value: number }
  uHMin: { value: number }
  uHMax: { value: number }
  uStepped: { value: number }
  uShade: { value: number }
  uRelief: { value: number }
  uTint: { value: number }
  uLines: { value: number }
  uWater: { value: number }
  uWaterLines: { value: number }
  uWaterSpacing: { value: number }
  uRipple: { value: number }
  uGrid: { value: number }
  uGridSize: { value: number }
  uFog: { value: number }
  /** highlight: x, z (world), radius, amount 0..1 — contours inside turn vermilion */
  uHi: { value: THREE.Vector4 }
  /** print-on reveal: x, z (world), radius, feather — outside is blank paper */
  uReveal: { value: THREE.Vector4 }
  /** fine height texture + mapping (set from `terrain`) */
  uHTex: { value: THREE.Texture | null }
  uHOrigin: { value: THREE.Vector2 }
  uHStep: { value: THREE.Vector2 }
  uHSize: { value: THREE.Vector2 }
  uUseTex: { value: number }
  /** the chart's rectangle (cx, cz, half width, half depth) and its paper-margin fade */
  uEdge: { value: THREE.Vector4 }
  uEdgeFeather: { value: number }
  uTints: { value: THREE.Color[] }
  uContour: { value: THREE.Color }
  uIndexC: { value: THREE.Color }
  uWaterC: { value: THREE.Color }
  uWaterDeep: { value: THREE.Color }
  uWaterLineC: { value: THREE.Color }
  uCoast: { value: THREE.Color }
  uGridC: { value: THREE.Color }
  uHiC: { value: THREE.Color }
}

export type ChartMaterial = THREE.ShaderMaterial & { uniforms: ChartUniforms }

const CHART_VERT = /* glsl */ `
  attribute float aH;
  attribute vec2 aG;
  uniform float uLift, uBase, uSeaLift;
  varying float vH;
  varying vec2 vG;
  varying vec3 vW;
  varying float vDepth;
  void main() {
    vec3 p = position;
    // land rises with uLift; the sea floor by uSeaLift of that (0 keeps the sea a flat plane)
    p.y = uBase + (aH > 0.0 ? aH : aH * uSeaLift) * uLift;
    vH = aH;
    vG = aG;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vW = w.xyz;
    vec4 mv = viewMatrix * w;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const CHART_FRAG = /* glsl */ `
  uniform float uTime, uDpr, uFogNear, uFogFar, uFog;
  uniform vec3 uSun, uPaper;
  uniform float uInterval, uIndex, uLine, uIndexLine, uCoastLine, uHMin, uHMax, uStepped, uShade, uRelief;
  uniform float uTint, uLines, uWater, uWaterLines, uWaterSpacing, uRipple, uGrid, uGridSize;
  uniform vec4 uHi, uReveal, uEdge;
  uniform float uUseTex, uEdgeFeather;
  uniform sampler2D uHTex;
  uniform vec2 uHOrigin, uHStep, uHSize;
  uniform vec3 uTints[6];
  uniform vec3 uContour, uIndexC, uWaterC, uWaterDeep, uWaterLineC, uCoast, uGridC, uHiC;
  varying float vH;
  varying vec2 vG;
  varying vec3 vW;
  varying float vDepth;

  // an isoline of f (1 per integer), wpx device px wide; fades out where lines crowd (no moiré)
  float isoLine(float f, float fw, float wpx) {
    float d = abs(fract(f - 0.5) - 0.5) / fw;
    float a = 1.0 - smoothstep(wpx * 0.5 - 0.5, wpx * 0.5 + 0.5, d);
    return a * (1.0 - smoothstep(0.22, 0.6, fw));
  }

  vec3 tintRamp(float t) {
    float s = clamp(t, 0.0, 1.0) * 5.0;
    float i = floor(s);
    float f = s - i;
    vec3 a = uTints[0];
    vec3 b = uTints[1];
    if (i >= 1.0) { a = uTints[1]; b = uTints[2]; }
    if (i >= 2.0) { a = uTints[2]; b = uTints[3]; }
    if (i >= 3.0) { a = uTints[3]; b = uTints[4]; }
    if (i >= 4.0) { a = uTints[4]; b = uTints[5]; }
    if (i >= 5.0) { a = uTints[5]; b = uTints[5]; f = 0.0; }
    return mix(a, b, f);
  }

  void main() {
    // the fine height texture where there is one (smooth lines), else the mesh's
    vec2 tuv = ((vW.xz - uHOrigin) / uHStep + 0.5) / uHSize;
    float h = mix(vH, texture2D(uHTex, tuv).r, uUseTex);
    float px = max(uDpr, 0.5);

    // every derivative up front, in uniform control flow
    float fC = h / uInterval;
    float fwC = max(fwidth(fC), 1e-5);
    float fI = h / (uInterval * uIndex);
    float fwI = max(fwidth(fI), 1e-5);
    float fwH = max(fwidth(h), 1e-5);
    float fWl = -h / uWaterSpacing - uTime * uRipple;
    float fwWl = max(fwidth(fWl), 1e-5);
    vec2 gP = vW.xz / uGridSize;
    vec2 fwG = max(fwidth(gP), vec2(1e-5));

    // layer tints (stepped by index band)
    float t = (h - uHMin) / max(uHMax - uHMin, 1e-3);
    float bands = max(1.0, (uHMax - uHMin) / (uInterval * uIndex));
    float tq = (floor(clamp(t, 0.0, 0.9999) * bands) + 0.5) / bands;
    vec3 land = tintRamp(mix(t, tq, uStepped));
    land = mix(uPaper, land, uTint);

    // printed hillshade from the full relief (the same whether the map is flat or lifted)
    vec3 n = normalize(vec3(-vG.x * uRelief, 1.0, -vG.y * uRelief));
    vec3 L = normalize(uSun);
    float lam = dot(n, L);
    float sh = clamp(1.0 + uShade * 1.05 * (lam - L.y), 0.42, 1.22);
    land *= sh;

    // water + water-lining rings drifting out from the coast
    float wet = uWater * (1.0 - smoothstep(-fwH, fwH, h));
    float k = -h / uWaterSpacing;
    vec3 water = mix(uWaterC, uWaterDeep, clamp(k / max(uWaterLines * 1.6, 1.0), 0.0, 1.0));
    water = mix(uPaper, water, uTint);
    float wl = isoLine(fWl, fwWl, 0.9 * px) * smoothstep(0.25, 0.7, k) * (1.0 - smoothstep(uWaterLines - 1.5, uWaterLines + 0.2, k));
    vec3 col = mix(land, water, wet);
    col = mix(col, uWaterLineC, wl * wet * 0.8 * uLines);

    // contours (land), highlighted vermilion near uHi
    float hi = uHi.w * (1.0 - smoothstep(uHi.z * 0.65, uHi.z, distance(vW.xz, uHi.xy)));
    float cl = isoLine(fC, fwC, uLine * px * (1.0 + hi * 0.5));
    float il = isoLine(fI, fwI, uIndexLine * px * (1.0 + hi * 0.35));
    float landMask = 1.0 - wet;
    col = mix(col, mix(uContour, uHiC, hi), cl * uLines * landMask * 0.85);
    col = mix(col, mix(uIndexC, uHiC, hi), il * uLines * landMask);

    // coastline
    float cw = uCoastLine * px;
    float coast = uWater * (1.0 - smoothstep(cw * 0.5 - 0.5, cw * 0.5 + 0.5, abs(h) / fwH));
    col = mix(col, uCoast, coast * uLines);

    // graticule
    vec2 dg = abs(fract(gP - 0.5) - 0.5) / fwG;
    float g = (1.0 - smoothstep(0.5 * px - 0.5, 0.5 * px + 0.5, min(dg.x, dg.y))) * (1.0 - smoothstep(0.2, 0.6, max(fwG.x, fwG.y)));
    col = mix(col, uGridC, g * uGrid);

    // print-on reveal: beyond the radius the chart isn't printed yet
    float rd = distance(vW.xz, uReveal.xy);
    float printed = 1.0 - smoothstep(uReveal.z - uReveal.w, uReveal.z, rd);
    col = mix(uPaper, col, printed);

    // the chart's own margin, then distance, fade into the paper
    vec2 ed = uEdge.zw - abs(vW.xz - uEdge.xy);
    float margin = uEdgeFeather > 0.0 ? smoothstep(0.0, uEdgeFeather, min(ed.x, ed.y)) : 1.0;
    col = mix(uPaper, col, margin);
    col = mix(col, uPaper, smoothstep(uFogNear, uFogFar, vDepth) * uFog);
    gl_FragColor = vec4(col, 1.0);
  }
`

/**
 * The terrain shader. Pass `world` (ctx.world) so it shares the paper, fog,
 * hillshade light, time and DPR. Animate its uniforms directly:
 *   mat.uniforms.uLift.value = smoothstep(0.1, 0.5, local)       // flat → relief
 *   mat.uniforms.uHi.value.set(x, z, 2.5, 1)                        // highlight a summit
 *   mat.uniforms.uReveal.value.set(0, 0, radius, 0.6)               // print outward
 * Clone per chapter; never share one between an InstancedMesh and a Mesh.
 */
export function chartMaterial(world: World, o: ChartOptions = {}): ChartMaterial {
  const interval = o.interval ?? 0.2
  const td = o.terrain?.userData as TerrainData | undefined
  const hasTex = !!td?.heightTex
  const edge = td ? (o.edge ?? 0.12 * Math.min(td.width, td.depth)) : 0
  const u: ChartUniforms = {
    ...world.chart,
    uLift: { value: o.lift ?? 1 },
    uSeaLift: { value: o.seaLift ?? 1 },
    uBase: { value: 0 },
    uInterval: { value: interval },
    uIndex: { value: o.index ?? 5 },
    uLine: { value: o.line ?? 1.0 },
    uIndexLine: { value: o.indexLine ?? 1.9 },
    uCoastLine: { value: o.coastLine ?? 1.6 },
    uHMin: { value: o.hMin ?? (td ? Math.max(0, td.hMin) : -1) },
    uHMax: { value: o.hMax ?? (td ? td.hMax : 4) },
    uStepped: { value: o.stepped ?? 0.7 },
    uShade: { value: o.shade ?? 0.85 },
    uRelief: { value: o.relief ?? 1 },
    uTint: { value: o.tint ?? 1 },
    uLines: { value: o.lines ?? 1 },
    uWater: { value: o.water ?? 1 },
    uWaterLines: { value: o.waterLines ?? 5 },
    uWaterSpacing: { value: o.waterSpacing ?? interval * 0.7 },
    uRipple: { value: o.ripple ?? 0.08 },
    uGrid: { value: o.grid ?? 0 },
    uGridSize: { value: o.gridSize ?? 4 },
    uFog: { value: o.fog === false ? 0 : 1 },
    uHi: { value: new THREE.Vector4(0, 0, 1, 0) },
    uReveal: { value: new THREE.Vector4(0, 0, 1e5, 1) },
    uHTex: { value: hasTex ? td!.heightTex : null },
    uHOrigin: { value: td ? td.origin.clone() : new THREE.Vector2() },
    uHStep: { value: td ? td.step.clone() : new THREE.Vector2(1, 1) },
    uHSize: { value: td ? td.size.clone() : new THREE.Vector2(1, 1) },
    uUseTex: { value: hasTex ? 1 : 0 },
    uEdge: { value: td ? new THREE.Vector4(td.cx, td.cz, td.width / 2, td.depth / 2) : new THREE.Vector4(0, 0, 1e5, 1e5) },
    uEdgeFeather: { value: edge },
    uTints: { value: C.tints.map(c => new THREE.Color(c)) },
    uContour: { value: new THREE.Color(C.contour) },
    uIndexC: { value: new THREE.Color(C.index) },
    uWaterC: { value: new THREE.Color(C.water) },
    uWaterDeep: { value: new THREE.Color(C.waterDeep) },
    uWaterLineC: { value: new THREE.Color(C.waterLine) },
    uCoast: { value: new THREE.Color(C.coast) },
    uGridC: { value: new THREE.Color(C.grid) },
    uHiC: { value: new THREE.Color(C.signal) },
  }
  const m = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: CHART_VERT,
    fragmentShader: CHART_FRAG,
    toneMapped: false,
  }) as ChartMaterial
  return m
}

/* ------------------------------------------------------------------ lettering */

export const FONTS = {
  display: '"Newsreader Variable", Georgia, serif',
  sans: '"Overpass Variable", system-ui, sans-serif',
  mono: '"Overpass Mono Variable", ui-monospace, monospace',
}

let fontsReady: Promise<void> | null = null
/** Resolve once the three faces are loaded for canvas drawing (await before labelTexture). */
export function ensureFonts(): Promise<void> {
  if (fontsReady) return fontsReady
  const f = document.fonts
  if (!f?.load) return (fontsReady = Promise.resolve())
  fontsReady = Promise.all([
    f.load(`400 32px ${FONTS.display}`),
    f.load(`italic 400 32px ${FONTS.display}`),
    f.load(`600 32px ${FONTS.display}`),
    f.load(`400 32px ${FONTS.sans}`),
    f.load(`700 32px ${FONTS.sans}`),
    f.load(`500 32px ${FONTS.mono}`),
  ])
    .then(() => undefined)
    .catch(() => undefined)
  return fontsReady
}

export interface LabelOptions {
  font?: keyof typeof FONTS
  /** CSS px of the glyphs on the canvas (drawn at 2x) */
  size?: number
  weight?: number
  italic?: boolean
  color?: string
  /** letter spacing in em (drawn per glyph: Safari has no canvas letterSpacing) */
  tracking?: number
  uppercase?: boolean
  /** paper halo behind the letters (map-label knockout); null for none */
  halo?: string | null
  haloWidth?: number
}

/** Draw one line of map lettering into a texture. aspect = width / height. */
export function labelTexture(text: string, o: LabelOptions = {}): { texture: THREE.CanvasTexture; aspect: number } {
  const size = o.size ?? 48
  const scale = 2
  const t = o.uppercase ? text.toUpperCase() : text
  const font = `${o.italic ? 'italic ' : ''}${o.weight ?? 400} ${size * scale}px ${FONTS[o.font ?? 'sans']}`
  const c = document.createElement('canvas')
  const x = c.getContext('2d')!
  x.font = font
  const track = (o.tracking ?? 0) * size * scale
  const chars = Array.from(t)
  const adv = chars.map(ch => x.measureText(ch).width)
  const textW = adv.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1)
  const halo = o.halo === undefined ? C.paper : o.halo
  const hw = (o.haloWidth ?? 0.22) * size * scale
  const pad = Math.ceil(hw + size * scale * 0.2)
  c.width = Math.ceil(textW + pad * 2)
  c.height = Math.ceil(size * scale * 1.35 + pad * 2)
  x.font = font
  x.textBaseline = 'middle'
  x.lineJoin = 'round'
  const y = c.height / 2
  const drawAll = (fn: (ch: string, px: number) => void) => {
    let px = pad
    chars.forEach((ch, i) => {
      fn(ch, px)
      px += adv[i] + track
    })
  }
  if (halo) {
    x.strokeStyle = halo
    x.lineWidth = hw
    drawAll((ch, px) => x.strokeText(ch, px, y))
  }
  x.fillStyle = o.color ?? C.ink
  drawAll((ch, px) => x.fillText(ch, px, y))
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return { texture, aspect: c.width / c.height }
}

/**
 * A lettered plane `height` world units tall. flat = lies on the ground
 * (reads from above, like map lettering); otherwise it stands facing +z.
 */
export function mapLabel(text: string, o: LabelOptions & { height?: number; flat?: boolean } = {}): THREE.Mesh {
  const { texture, aspect } = labelTexture(text, o)
  const hgt = o.height ?? 0.4
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(hgt * aspect, hgt),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
  )
  if (o.flat) m.rotation.x = -Math.PI / 2
  m.renderOrder = 2
  return m
}

/* ------------------------------------------------------------------ markers + routes */

export interface MarkerOptions {
  color?: THREE.ColorRepresentation
  /** stem height in world units (default 1.2) */
  height?: number
  /** ground ring radius (default 0.18) */
  radius?: number
}

/**
 * A printed survey marker: a ground ring, a hairline stem and a head dot, in
 * flat colour. group.position = the ground point. Animate `grow` 0..1.
 */
export function marker(o: MarkerOptions = {}) {
  const color = new THREE.Color(o.color ?? C.signal)
  const h = o.height ?? 1.2
  const r = o.radius ?? 0.18
  const group = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false })
  const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.72, r, 40), mat)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.01
  const dot = new THREE.Mesh(new THREE.CircleGeometry(r * 0.28, 24), mat)
  dot.rotation.x = -Math.PI / 2
  dot.position.y = 0.012
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.ink), toneMapped: false }))
  const head = new THREE.Mesh(new THREE.SphereGeometry(r * 0.42, 20, 14), mat)
  group.add(ring, dot, stem, head)
  const setGrow = (g: number) => {
    const k = Math.max(0.0001, g)
    stem.scale.y = h * k
    stem.position.y = (h * k) / 2
    head.position.y = h * k
    head.visible = g > 0.02
    stem.visible = g > 0.02
    ring.scale.setScalar(0.4 + 0.6 * Math.min(1, g * 1.5))
  }
  setGrow(1)
  return { group, ring, stem, head, material: mat, setGrow }
}

/**
 * A route drawn on the land: a flat ribbon through `points` (world, already
 * draped — see drape() in terrain.ts), dashed, drawing itself as
 * uniforms.uProgress goes 0 → 1.
 */
export function routeRibbon(points: THREE.Vector3[], o: { width?: number; color?: THREE.ColorRepresentation; dash?: number; gap?: number } = {}) {
  const w = (o.width ?? 0.06) / 2
  const n = points.length
  const pos = new Float32Array(n * 2 * 3)
  const dist = new Float32Array(n * 2)
  const side = new Float32Array(n * 2)
  let acc = 0
  const tan = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += points[i].distanceTo(points[i - 1])
    const a = points[Math.max(0, i - 1)]
    const b = points[Math.min(n - 1, i + 1)]
    tan.subVectors(b, a)
    tan.y = 0
    tan.normalize()
    const nx = -tan.z * w
    const nz = tan.x * w
    const p = points[i]
    pos.set([p.x + nx, p.y, p.z + nz, p.x - nx, p.y, p.z - nz], i * 6)
    dist[i * 2] = dist[i * 2 + 1] = acc
    side[i * 2] = 1
    side[i * 2 + 1] = -1
  }
  const idx: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    // wound to face up (+y) for any direction of travel: visible from above with FrontSide
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aDist', new THREE.BufferAttribute(dist, 1))
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  geo.setIndex(idx)
  const uniforms = {
    uProgress: { value: 1 },
    uLength: { value: acc },
    uDash: { value: o.dash ?? 0.22 },
    uGap: { value: o.gap ?? 0.12 },
    uColor: { value: new THREE.Color(o.color ?? C.signal) },
    uOpacity: { value: 1 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      attribute float aDist;
      attribute float aSide;
      varying float vDist;
      varying float vSide;
      void main() {
        vDist = aDist;
        vSide = aSide;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress, uLength, uDash, uGap, uOpacity;
      uniform vec3 uColor;
      varying float vDist;
      varying float vSide;
      void main() {
        float period = uDash + uGap;
        float ph = mod(vDist, period);
        float fw = max(fwidth(vDist), 1e-5);
        float dash = uGap <= 0.0 ? 1.0 : (1.0 - smoothstep(uDash - fw, uDash + fw, ph)) * smoothstep(0.0, fw, ph);
        float drawn = 1.0 - smoothstep(uProgress * uLength - fw, uProgress * uLength + fw, vDist);
        float fs = max(fwidth(vSide), 1e-5);
        float edge = 1.0 - smoothstep(1.0 - fs * 1.5, 1.0, abs(vSide));
        float a = dash * drawn * edge * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 3
  return { mesh, uniforms, length: acc }
}
