import * as THREE from 'three'
import type { World } from '../../world/World'
import { HEIGHT_GLSL, type TerrainData } from '../../kit/terrain'
import { C } from '../../kit/chart'
import type { DrawTime } from './field'

/*
 * The relief-model workshop's pieces, all flat printed color:
 *
 *   draftMaterial   a flat sheet over the chart: the survey grid's ticks, the
 *                   old dotted coastline, the contour draft (pencil, then ink,
 *                   with a vermilion pen tip), and the first board's contact
 *                   shadow on the chart
 *   boardMaterial   one layer of the stacked model: a layer-tinted top with an
 *                   inked rim, a pencil guide where the next board goes and a
 *                   soft contact shadow from it; darker cut walls, lit from
 *                   the north-west like the hillshade
 *   ringMaterial    sounding rings drifting out of the survey station, and
 *                   the measuring front (vermilion) sweeping the island
 *   station()       a total station on its tripod
 */

const ISO = /* glsl */ `
  float isoLine(float f, float fw, float wpx) {
    float d = abs(fract(f - 0.5) - 0.5) / fw;
    float a = 1.0 - smoothstep(wpx * 0.5 - 0.5, wpx * 0.5 + 0.5, d);
    return a * (1.0 - smoothstep(0.22, 0.6, fw));
  }
`

const WORLD_VERT = /* glsl */ `
  varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

function heightUniforms(td: TerrainData) {
  return {
    uHTex: { value: td.heightTex },
    uHOrigin: { value: td.origin.clone() },
    uHStep: { value: td.step.clone() },
    uHSize: { value: td.size.clone() },
  }
}

/* ------------------------------------------------------------------ the draft sheet */

export type DraftMaterial = ReturnType<typeof draftMaterial>

export function draftMaterial(world: World, td: TerrainData, dt: DrawTime, interval: number) {
  const uniforms = {
    ...heightUniforms(td),
    uDTex: { value: dt.texture as THREE.Texture },
    uDOrigin: { value: dt.origin.clone() },
    uDStep: { value: dt.step },
    uDSize: { value: dt.size.clone() },
    uPerUnit: { value: dt.perUnit },
    uDpr: world.chart.uDpr,
    uSun: world.chart.uSun,
    uInterval: { value: interval },
    uIndex: { value: 5 },
    /** the draft clocks (0..1): the pencil, then the ink following it */
    uPencil: { value: 0 },
    uInk: { value: 0 },
    /** the linework's opacity (hand-over to the chart's own printed lines) */
    uLines: { value: 1 },
    /** survey grid ticks */
    uTicks: { value: 0 },
    uTickSize: { value: 2 },
    /** where the survey grid thins out into the margin (x, z, inner radius, outer radius) */
    uTickFade: { value: new THREE.Vector4(1.3, -0.7, 10, 16) },
    /** the old dotted coastline under the survey */
    uOldCoast: { value: 0 },
    /** the first board's shadow on the chart, and that board's level */
    uShadow: { value: 0 },
    uShadowLevel: { value: interval },
    /** the sheet's rectangle (cx, cz, half width, half depth) and its fade into the margin */
    uEdge: { value: new THREE.Vector4(td.cx, td.cz, td.width / 2, td.depth / 2) },
    uFeather: { value: 0.14 * Math.min(td.width, td.depth) },
    uPencilC: { value: new THREE.Color('#8a837a') },
    uContourC: { value: new THREE.Color(C.contour) },
    uIndexC: { value: new THREE.Color(C.index) },
    uCoastC: { value: new THREE.Color(C.coast) },
    uTipC: { value: new THREE.Color(C.signal) },
    uTickC: { value: new THREE.Color('#6f8f9f') },
    uShadowC: { value: new THREE.Color('#4a3522') },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: td.manual ? { H_MANUAL: '' } : {},
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    vertexShader: WORLD_VERT,
    fragmentShader: /* glsl */ `
      ${HEIGHT_GLSL}
      uniform sampler2D uHTex, uDTex;
      uniform vec2 uHOrigin, uHStep, uHSize, uDOrigin, uDSize;
      uniform float uDStep, uPerUnit, uDpr, uInterval, uIndex, uPencil, uInk, uLines, uTicks, uTickSize, uOldCoast, uShadow, uShadowLevel, uFeather;
      uniform vec4 uEdge, uTickFade;
      uniform vec3 uSun, uPencilC, uContourC, uIndexC, uCoastC, uTipC, uTickC, uShadowC;
      varying vec3 vW;
      ${ISO}
      void main() {
        vec2 tuv = ((vW.xz - uHOrigin) / uHStep + 0.5) / uHSize;
        float h = chartHeight(uHTex, tuv, uHSize);
        vec2 duv = ((vW.xz - uDOrigin) / uDStep + 0.5) / uDSize;
        float T = texture2D(uDTex, duv).r;
        float px = max(uDpr, 0.5);

        // every derivative up front, in uniform control flow
        float fC = h / uInterval;
        float fwC = max(fwidth(fC), 1e-5);
        float fI = h / (uInterval * uIndex);
        float fwI = max(fwidth(fI), 1e-5);
        float fwH = max(fwidth(h), 1e-5);
        vec2 gP = vW.xz / uTickSize;
        vec2 fwG = max(fwidth(gP), vec2(1e-5));
        float dash = T / max(uPerUnit * 0.2, 1e-5);
        float fwD = max(fwidth(dash), 1e-5);

        // slope from the height texture (for the contact shadow)
        vec2 ex = vec2(1.0 / uHSize.x, 0.0);
        vec2 ez = vec2(0.0, 1.0 / uHSize.y);
        vec2 g = vec2(
          (chartHeight(uHTex, tuv + ex, uHSize) - chartHeight(uHTex, tuv - ex, uHSize)) / (2.0 * uHStep.x),
          (chartHeight(uHTex, tuv + ez, uHSize) - chartHeight(uHTex, tuv - ez, uHSize)) / (2.0 * uHStep.y)
        );

        float lvl = floor(fC + 0.5);
        float onLand = step(-0.5, lvl);
        float above = step(0.5, lvl);
        float isCoast = onLand * (1.0 - above);

        // ---- the draft: pencil first, ink over it, a vermilion tip on the ink pen
        float pen = 1.0 - smoothstep(uPencil - 0.006, uPencil, T);
        float ink = 1.0 - smoothstep(uInk - 0.006, uInk, T);
        float pl = isoLine(fC, fwC, 0.85 * px) * onLand;
        float cl = isoLine(fC, fwC, 1.0 * px) * above * 0.85;
        float il = isoLine(fI, fwI, 1.9 * px) * above;
        float cw = 1.6 * px;
        float coast = (1.0 - smoothstep(cw * 0.5 - 0.5, cw * 0.5 + 0.5, abs(h) / fwH));
        vec3 inkC = mix(uContourC, uIndexC, il);
        inkC = mix(inkC, uCoastC, coast);
        float aI = max(max(cl, il), coast) * ink;
        float tip = ink * (1.0 - smoothstep(0.0, 0.05, uInk - T));
        inkC = mix(inkC, uTipC, tip);
        float aP = pl * pen * (1.0 - ink) * 0.9;

        // the old coastline, dotted, before the survey is drafted
        float dots = 1.0 - smoothstep(0.24 - fwD, 0.24 + fwD, abs(fract(dash) - 0.5));
        float aO = isoLine(fC, fwC, 1.1 * px) * isCoast * dots * uOldCoast * step(T, 1.5) * (1.0 - pen);

        // survey grid ticks: small crosses at every grid intersection
        vec2 dg = abs(fract(gP - 0.5) - 0.5);
        vec2 dpx = dg / fwG;
        vec2 arm = 1.0 - smoothstep(vec2(0.07) - fwG, vec2(0.07) + fwG, dg);
        float lx = 1.0 - smoothstep(0.5 * px - 0.5, 0.5 * px + 0.5, dpx.x);
        float lz = 1.0 - smoothstep(0.5 * px - 0.5, 0.5 * px + 0.5, dpx.y);
        vec2 ed = uEdge.zw - abs(vW.xz - uEdge.xy);
        float margin = smoothstep(0.0, uFeather, min(ed.x, ed.y));
        float nearIsle = 1.0 - smoothstep(uTickFade.z, uTickFade.w, distance(vW.xz, uTickFade.xy));
        float aT = max(lx * arm.y, lz * arm.x) * 0.75 * uTicks * margin * nearIsle * (1.0 - smoothstep(0.2, 0.5, max(fwG.x, fwG.y)));

        // the first board's contact shadow on the chart (heavier on the side away from the light)
        float gl = length(g);
        vec2 sunXZ = normalize(uSun.xz + vec2(1e-5));
        float side = max(0.0, dot(g / max(gl, 1e-4), sunXZ));
        float dist = (uShadowLevel - h) / max(gl, 0.05);
        float aS = uShadow * (1.0 - smoothstep(0.0, 0.06 + 0.3 * side, dist)) * (0.1 + 0.16 * side) * step(-0.02, dist);

        // the linework hands over to the chart's own printed lines (the shadow stays)
        aT *= uLines;
        aO *= uLines;
        aP *= uLines;
        aI *= uLines;

        // composite (non-premultiplied "over", bottom to top)
        vec3 c = uShadowC * aS;
        float a = aS;
        c = uTickC * aT + c * (1.0 - aT);
        a = aT + a * (1.0 - aT);
        c = uPencilC * aO * 0.8 + c * (1.0 - aO * 0.8);
        a = aO * 0.8 + a * (1.0 - aO * 0.8);
        c = uPencilC * aP + c * (1.0 - aP);
        a = aP + a * (1.0 - aP);
        c = inkC * aI + c * (1.0 - aI);
        a = aI + a * (1.0 - aI);
        if (a < 0.003) discard;
        gl_FragColor = vec4(c / max(a, 1e-4), a);
      }
    `,
  })
  return { material, uniforms }
}

/* ------------------------------------------------------------------ a board */

export type BoardMaterial = ReturnType<typeof boardMaterial>

export function boardMaterial(world: World, td: TerrainData, level: number, next: number, top: THREE.Color, wall: THREE.Color) {
  const uniforms = {
    ...heightUniforms(td),
    uDpr: world.chart.uDpr,
    uSun: world.chart.uSun,
    uLevel: { value: level },
    uNext: { value: next },
    /** the board above: 0 not there yet → 1 settled (its contact shadow) */
    uAbove: { value: 0 },
    /** the pencil guide for the next board */
    uGuide: { value: 1 },
    uOpacity: { value: 1 },
    uTopC: { value: top },
    uWallC: { value: wall },
    uEdgeC: { value: new THREE.Color(C.index) },
    uGuideC: { value: new THREE.Color('#8a837a') },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: td.manual ? { H_MANUAL: '' } : {},
    transparent: true,
    toneMapped: false,
    vertexShader: /* glsl */ `
      attribute float aTop;
      attribute float aV;
      varying vec3 vW;
      varying vec3 vN;
      varying float vTop;
      varying float vV;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normal;
        vTop = aTop;
        vV = aV;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${HEIGHT_GLSL}
      uniform sampler2D uHTex;
      uniform vec2 uHOrigin, uHStep, uHSize;
      uniform float uDpr, uLevel, uNext, uAbove, uGuide, uOpacity;
      uniform vec3 uSun, uTopC, uWallC, uEdgeC, uGuideC;
      varying vec3 vW;
      varying vec3 vN;
      varying float vTop;
      varying float vV;
      void main() {
        vec2 tuv = ((vW.xz - uHOrigin) / uHStep + 0.5) / uHSize;
        float h = chartHeight(uHTex, tuv, uHSize);
        float fwH = max(fwidth(h), 1e-5);
        vec2 ex = vec2(1.0 / uHSize.x, 0.0);
        vec2 ez = vec2(0.0, 1.0 / uHSize.y);
        vec2 g = vec2(
          (chartHeight(uHTex, tuv + ex, uHSize) - chartHeight(uHTex, tuv - ex, uHSize)) / (2.0 * uHStep.x),
          (chartHeight(uHTex, tuv + ez, uHSize) - chartHeight(uHTex, tuv - ez, uHSize)) / (2.0 * uHStep.y)
        );
        float px = max(uDpr, 0.5);
        vec2 sunXZ = normalize(uSun.xz + vec2(1e-5));

        // top: the tint, an inked rim, the next board's pencil guide and its contact shadow
        float edge = 1.0 - smoothstep(1.2 * px - 0.5, 1.2 * px + 0.5, (h - uLevel) / fwH);
        float guide = (1.0 - smoothstep(0.45 * px - 0.5, 0.45 * px + 0.5, abs(h - uNext) / fwH)) * uGuide * (1.0 - uAbove);
        float gl = length(g);
        float side = max(0.0, dot(g / max(gl, 1e-4), sunXZ));
        float dist = (uNext - h) / max(gl, 0.05);
        float sh = uAbove * (1.0 - smoothstep(0.0, 0.05 + 0.26 * side, dist)) * (0.1 + 0.15 * side);
        vec3 top = uTopC * (1.0 - sh);
        top = mix(top, uGuideC, guide * 0.75);
        top = mix(top, uEdgeC, edge * 0.85);

        // walls: the cut edge of the board, lit from the north-west, darker at its foot
        vec2 n = normalize(vN.xz + vec2(1e-5));
        float lam = dot(n, sunXZ);
        float foot = 1.0 - 0.2 * (1.0 - smoothstep(0.0, 0.5, vV));
        vec3 wall = uWallC * (0.84 + 0.16 * lam) * foot;
        // a hairline where the wall meets the top (the board's printed face)
        wall = mix(wall, uEdgeC, smoothstep(0.9, 1.0, vV) * 0.3);

        vec3 col = mix(wall, top, step(0.5, vTop));
        gl_FragColor = vec4(col, uOpacity);
      }
    `,
  })
  return { material, uniforms }
}

/* ------------------------------------------------------------------ sounding rings */

export function ringMaterial(world: World) {
  const uniforms = {
    uDpr: world.chart.uDpr,
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector2() },
    /** the measuring front's radius (world units) and its visibility */
    uFront: { value: 0 },
    uFrontOn: { value: 0 },
    /** the idle sounding rings: visibility, reach, spacing, rings per second */
    uRings: { value: 0 },
    uReach: { value: 3.2 },
    uSpacing: { value: 0.42 },
    uRate: { value: 0.6 },
    uRingC: { value: new THREE.Color(C.waterLine) },
    uFrontC: { value: new THREE.Color(C.signal) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    vertexShader: WORLD_VERT,
    fragmentShader: /* glsl */ `
      uniform float uDpr, uTime, uFront, uFrontOn, uRings, uReach, uSpacing, uRate;
      uniform vec2 uCenter;
      uniform vec3 uRingC, uFrontC;
      varying vec3 vW;
      ${ISO}
      void main() {
        float r = distance(vW.xz, uCenter);
        float px = max(uDpr, 0.5);
        float f = r / uSpacing - uTime * uRate;
        float fw = max(fwidth(f), 1e-5);
        float fwr = max(fwidth(r), 1e-5);
        float ring = isoLine(f, fw, 1.0 * px);
        float env = (1.0 - smoothstep(uReach * 0.3, uReach, r)) * smoothstep(0.1, 0.35, r);
        float front = (1.0 - smoothstep(1.3 * px * 0.5 - 0.5, 1.3 * px * 0.5 + 0.5, abs(r - uFront) / fwr)) * uFrontOn;
        float a = max(ring * env * uRings * 0.85, front * 0.9);
        if (a < 0.004) discard;
        gl_FragColor = vec4(mix(uRingC, uFrontC, step(ring * env * uRings * 0.85, front * 0.9)), a);
      }
    `,
  })
  return { material, uniforms }
}

/* ------------------------------------------------------------------ the total station */

/** A total station on its tripod, ~0.62 units tall, standing at the group's origin. */
export function station() {
  const group = new THREE.Group()
  const ink = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.ink), toneMapped: false })
  const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.signal), toneMapped: false })
  const paper = new THREE.MeshBasicMaterial({ color: new THREE.Color('#efe7d6'), toneMapped: false })
  const H = 0.5
  const legGeo = new THREE.CylinderGeometry(0.011, 0.015, 1, 6)
  legGeo.translate(0, 0.5, 0)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4
    const foot = new THREE.Vector3(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2)
    const head = new THREE.Vector3(0, H, 0)
    const leg = new THREE.Mesh(legGeo, ink)
    leg.position.copy(foot)
    const dir = head.clone().sub(foot)
    leg.scale.y = dir.length()
    leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
    group.add(leg)
  }
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16), ink)
  plate.position.y = H + 0.01
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.07), red)
  body.position.y = H + 0.07
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.13, 10), paper)
  scope.rotation.z = Math.PI / 2
  scope.position.y = H + 0.1
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.02, 10), ink)
  cap.rotation.z = Math.PI / 2
  cap.position.set(0.07, H + 0.1, 0)
  group.add(plate, body, scope, cap)
  /** where sight lines leave the instrument (local) */
  const eye = new THREE.Vector3(0, H + 0.1, 0)
  return { group, eye, scope }
}
