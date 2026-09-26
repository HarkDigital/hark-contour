import * as THREE from 'three'
import { C } from '../../kit/chart'
import type { World } from '../../world/World'

/*
 * The survey traverse along the crest: a dashed vermilion line that draws
 * itself summit to summit behind the drone.
 *
 * Why not the kit's routeRibbon: a flat ribbon laid on a knife-edge crest
 * is seen almost edge-on from a low drone (sub-pixel, it vanishes). This
 * is a SCREEN-SPACE polyline instead: each vertex is pushed sideways in
 * device pixels, perpendicular to the line's own projected direction, so
 * the stroke keeps a constant printed width at any distance or angle; the
 * dashes are measured in world units along the ground (like a surveyed
 * route on a chart), and it is pulled a hair toward the camera so its own
 * crest never swallows it (nearer ridges still hide it).
 *
 *   uniforms.uProgress  0 → 1 draws it (in world distance along the route)
 *   uniforms.uLift      follows the chart's uLift (heights scale with it)
 */

const VERT = /* glsl */ `
  attribute vec3 aPrev;
  attribute vec3 aNext;
  attribute float aSide;
  attribute float aDist;
  uniform vec2 uRes;
  uniform float uWidth, uDpr, uLift, uPull;
  varying float vDist;
  varying float vSide;
  vec4 proj(vec3 p) {
    vec3 q = vec3(p.x, p.y * uLift, p.z);
    q += (cameraPosition - q) * uPull;
    return projectionMatrix * viewMatrix * vec4(q, 1.0);
  }
  void main() {
    vec4 c = proj(position);
    vec4 a = proj(aPrev);
    vec4 b = proj(aNext);
    vec2 sa = a.xy / max(a.w, 1e-4) * uRes;
    vec2 sb = b.xy / max(b.w, 1e-4) * uRes;
    vec2 d = sb - sa;
    float len = length(d);
    d = len > 1e-5 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-d.y, d.x);
    float px = uWidth * 0.5 + 1.0 / max(uDpr, 0.5);
    c.xy += n * aSide * px * 2.0 / uRes * c.w;
    vDist = aDist;
    vSide = aSide * px;
    gl_Position = c.w > 0.0 ? c : vec4(2.0, 2.0, 2.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  uniform float uProgress, uLength, uDash, uGap, uOpacity, uWidth, uDpr;
  uniform vec3 uColor;
  varying float vDist;
  varying float vSide;
  void main() {
    float fw = max(fwidth(vDist), 1e-5);
    float period = uDash + uGap;
    float ph = mod(vDist, period);
    float dash = uGap <= 0.0 ? 1.0 : (1.0 - smoothstep(uDash - fw, uDash + fw, ph)) * smoothstep(0.0, fw, ph);
    float head = uProgress * uLength;
    float drawn = 1.0 - smoothstep(head - fw, head + fw, vDist);
    // a crisp stroke uWidth CSS px wide (one device pixel of AA)
    float e = 0.5 / max(uDpr, 0.5);
    float edge = 1.0 - smoothstep(uWidth * 0.5 - e, uWidth * 0.5 + e, abs(vSide));
    float a = dash * drawn * edge * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`

export interface Traverse {
  mesh: THREE.Mesh
  uniforms: {
    uProgress: { value: number }
    uLift: { value: number }
    uOpacity: { value: number }
    uRes: { value: THREE.Vector2 }
    uWidth: { value: number }
  }
  /** world length (3D) along the points */
  length: number
  /** cumulative distance at each point */
  dist: Float32Array
}

export function traverse(
  points: THREE.Vector3[],
  world: World,
  o: {
    width?: number
    dash?: number
    gap?: number
    color?: THREE.ColorRepresentation
    pull?: number
  } = {},
): Traverse {
  const n = points.length
  const pos = new Float32Array(n * 2 * 3)
  const prev = new Float32Array(n * 2 * 3)
  const next = new Float32Array(n * 2 * 3)
  const side = new Float32Array(n * 2)
  const distA = new Float32Array(n * 2)
  const dist = new Float32Array(n)
  let acc = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += points[i].distanceTo(points[i - 1])
    dist[i] = acc
    const p = points[i]
    const a = points[Math.max(0, i - 1)]
    const b = points[Math.min(n - 1, i + 1)]
    for (let s = 0; s < 2; s++) {
      const k = i * 2 + s
      pos.set([p.x, p.y, p.z], k * 3)
      prev.set([a.x, a.y, a.z], k * 3)
      next.set([b.x, b.y, b.z], k * 3)
      side[k] = s === 0 ? 1 : -1
      distA[k] = acc
    }
  }
  const idx: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aPrev', new THREE.BufferAttribute(prev, 3))
  geo.setAttribute('aNext', new THREE.BufferAttribute(next, 3))
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  geo.setAttribute('aDist', new THREE.BufferAttribute(distA, 1))
  geo.setIndex(idx)
  const uniforms = {
    uProgress: { value: 0 },
    uLength: { value: acc },
    uDash: { value: o.dash ?? 0.34 },
    uGap: { value: o.gap ?? 0.2 },
    uColor: { value: new THREE.Color(o.color ?? C.signal) },
    uOpacity: { value: 1 },
    uRes: { value: new THREE.Vector2(1440, 900) },
    uWidth: { value: o.width ?? 2.2 },
    uDpr: world.chart.uDpr,
    uLift: { value: 1 },
    uPull: { value: o.pull ?? 0.012 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 4
  return { mesh, uniforms, length: acc, dist }
}
