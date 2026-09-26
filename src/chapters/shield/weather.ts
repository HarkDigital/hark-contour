import * as THREE from 'three'
import type { World } from '../../world/World'
import type { ChartMaterial } from '../../kit/chart'
import { C } from '../../kit/chart'
import { HEIGHT_GLSL } from '../../kit/terrain'

/*
 * THE WEATHER OVERPRINT — a second pass over the chart's own terrain mesh
 * (same geometry, same lift), printed in storm plum and alarm red:
 *
 *  - ISOBARS: isolines of an analytic pressure field (hPa), every 4 hPa, a
 *    bold line every 20. The field is a gentle gradient + a slow wave + a LOW
 *    (exponential well, elliptical, swirled into spiral arms) + a HIGH
 *    (wide Gaussian dome). The same field is evaluated on the CPU
 *    (pressureAt) so the isobar numbers sit exactly on their lines.
 *  - PRESSURE TINTS: stepped plum bands inside the low (every 8 hPa: the
 *    band edges fall on isobars), like layer tints for weather.
 *  - FRONTS: two polylines (uniform arrays) drawn analytically on the land —
 *    a cold front with triangles, a warm front with semicircles; they draw
 *    themselves out of the low and dissolve (frontolysis: the line breaks).
 *  - THE LETTER: one signed-distance block letter that is an L and becomes an
 *    H (the bar slides up into a crossbar, the right stem grows out of it).
 *  - THE WATCH: contours the radar sweep has just passed print in survey
 *    vermilion (the dial itself is radar.ts, a level disc over the site).
 *  - A WATER NAME knocks the isobars out along its baseline (a capsule).
 *  - THE VEIL: a feathered screen rectangle (NDC) where the chart fades back
 *    into the paper, a knock-out behind a heading set over the chart (tall
 *    screens: the offshore islet would otherwise sit under "24/7").
 *
 * Everything is premultiplied flat colour, anti-aliased with fwidth, faded
 * into the paper at the chart's margin and with distance like the chart.
 */

export const FN = 10

export interface WeatherUniforms {
  [name: string]: THREE.IUniform
  uLow: { value: THREE.Vector4 }
  uLowS: { value: THREE.Vector4 }
  uHigh: { value: THREE.Vector4 }
  uField: { value: THREE.Vector4 }
  uIso: { value: number }
  uWash: { value: number }
  uRedBelow: { value: number }
  uIsoC: { value: THREE.Color }
  uWashC: { value: THREE.Color }
  uAlarm: { value: THREE.Color }
  uColdC: { value: THREE.Color }
  uWarmC: { value: THREE.Color }
  uSignal: { value: THREE.Color }
  uLetterC: { value: THREE.Color }
  uLetter: { value: THREE.Vector4 }
  uLetterK: { value: THREE.Vector4 }
  uKnock: { value: THREE.Vector4 }
  uGap: { value: THREE.Vector4[] }
  uCold: { value: THREE.Vector2[] }
  uWarm: { value: THREE.Vector2[] }
  uFront: { value: THREE.Vector4 }
  uRadar: { value: THREE.Vector4 }
  uRadarK: { value: THREE.Vector4 }
  /** a water name's baseline (x0, z0, x1, z1): the isobars break around its letters */
  uName: { value: THREE.Vector4 }
  /** its half-height (world) and amount 0..1 */
  uNameK: { value: THREE.Vector2 }
  /** knock-out rectangle in NDC (x0, y0, x1, y1) */
  uVeil: { value: THREE.Vector4 }
  /** amount 0..1, feather x, feather y (NDC) */
  uVeilK: { value: THREE.Vector4 }
}

/** the pressure field's parameters (mirrors the uniforms; the CPU twin reads these) */
export interface Field {
  low: THREE.Vector4
  lowS: THREE.Vector4
  high: THREE.Vector4
  field: THREE.Vector4
}

/** CPU twin of the shader's pressure() — keep the two in lockstep. */
export function pressureAt(f: Field, x: number, z: number): number {
  const fl = f.field
  let p = fl.z + fl.x * x + fl.y * z
  p += fl.w * Math.sin(0.29 * x + 0.17 * z + 0.6) * Math.sin(0.21 * z - 0.13 * x + 1.3)
  // the low: an elliptical exponential well, swirled into spiral arms
  const lo = f.low
  const s = f.lowS
  const dx = x - lo.x
  const dz = z - lo.y
  const r = Math.sqrt(dx * dx + dz * dz)
  const a = s.w + s.x * Math.exp(-r / s.y)
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const ex = ca * dx - sa * dz
  const ez = (sa * dx + ca * dz) * s.z
  const re = Math.sqrt(ex * ex + ez * ez + 0.12)
  p -= lo.z * Math.exp(-re / lo.w)
  // the high: a wide dome
  const hi = f.high
  const hx = x - hi.x
  const hz = (z - hi.y) * 1.2
  p += hi.z * Math.exp(-(hx * hx + hz * hz) / (2 * hi.w * hi.w))
  return p
}

const VERT = /* glsl */ `
  attribute float aH;
  uniform float uLift, uBase, uSeaLift;
  varying vec3 vW;
  varying float vDepth;
  varying vec4 vClip;
  void main() {
    vec3 p = position;
    // exactly the chart's surface (the sea floor sinks by uSeaLift of the lift)
    p.y = uBase + (aH > 0.0 ? aH : aH * uSeaLift) * uLift;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vW = w.xyz;
    vec4 mv = viewMatrix * w;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    vClip = gl_Position;
  }
`

const FRAG = /* glsl */ `
  #define FN ${FN}
  ${HEIGHT_GLSL}
  uniform float uTime, uDpr, uFogNear, uFogFar;
  uniform vec3 uPaper;
  uniform vec4 uEdge;
  uniform float uEdgeFeather, uInterval, uUseTex;
  uniform sampler2D uHTex;
  uniform vec2 uHOrigin, uHStep, uHSize;

  uniform vec4 uLow, uLowS, uHigh, uField;
  uniform float uIso, uWash, uRedBelow;
  uniform vec3 uIsoC, uWashC, uAlarm, uColdC, uWarmC, uSignal, uLetterC;
  uniform vec4 uLetter, uLetterK, uKnock;
  uniform vec4 uGap[6];
  uniform vec2 uCold[FN];
  uniform vec2 uWarm[FN];
  uniform vec4 uFront;
  uniform vec4 uRadar, uRadarK;
  uniform vec4 uVeil, uVeilK, uName;
  uniform vec2 uNameK;
  varying vec3 vW;
  varying float vDepth;
  varying vec4 vClip;

  const float TAU = 6.2831853;

  float pressure(vec2 q) {
    float p = uField.z + dot(uField.xy, q);
    p += uField.w * sin(0.29 * q.x + 0.17 * q.y + 0.6) * sin(0.21 * q.y - 0.13 * q.x + 1.3);
    vec2 d = q - uLow.xy;
    float r = length(d);
    float a = uLowS.w + uLowS.x * exp(-r / uLowS.y);
    float ca = cos(a);
    float sa = sin(a);
    vec2 e = vec2(ca * d.x - sa * d.y, (sa * d.x + ca * d.y) * uLowS.z);
    float re = sqrt(dot(e, e) + 0.12);
    p -= uLow.z * exp(-re / uLow.w);
    vec2 h = q - uHigh.xy;
    h.y *= 1.2;
    p += uHigh.z * exp(-dot(h, h) / (2.0 * uHigh.w * uHigh.w));
    return p;
  }

  float isoLine(float f, float fw, float wpx) {
    float d = abs(fract(f - 0.5) - 0.5) / fw;
    float a = 1.0 - smoothstep(wpx * 0.5 - 0.5, wpx * 0.5 + 0.5, d);
    return a * (1.0 - smoothstep(0.22, 0.6, fw));
  }

  // premultiplied "over"
  vec4 over(vec4 dst, vec3 c, float a) {
    return vec4(c * a + dst.rgb * (1.0 - a), a + dst.a * (1.0 - a));
  }

  float box(vec2 p, vec2 c, vec2 hs) {
    vec2 d = abs(p - c) - hs;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  // nearest point on a polyline: distance, arc length there, signed side, total length
  void polyNearest(vec2 q, vec2 P[FN], out float dist, out float along, out float side, out float total) {
    dist = 1e5;
    along = 0.0;
    side = 0.0;
    float acc = 0.0;
    for (int i = 0; i < FN - 1; i++) {
      vec2 a = P[i];
      vec2 b = P[i + 1];
      vec2 ba = b - a;
      vec2 pa = q - a;
      float L2 = max(dot(ba, ba), 1e-6);
      float t = clamp(dot(pa, ba) / L2, 0.0, 1.0);
      float d = length(pa - ba * t);
      float len = sqrt(L2);
      if (d < dist) {
        dist = d;
        along = acc + t * len;
        side = (ba.y * pa.x - ba.x * pa.y) / len;
      }
      acc += len;
    }
    total = acc;
  }

  void main() {
    vec2 q = vW.xz;
    float px = max(uDpr, 0.5);

    // ---------------- every derivative up front (uniform control flow)
    float p = pressure(q);
    float fP = p / 4.0;
    float fwP = max(fwidth(fP), 1e-5);
    float fI = p / 20.0;
    float fwI = max(fwidth(fI), 1e-5);
    float fwQ = max(length(fwidth(q)), 1e-5);

    vec2 tuv = ((q - uHOrigin) / uHStep + 0.5) / uHSize;
    float hgt = chartHeight(uHTex, tuv, uHSize);
    float fC = hgt / uInterval;
    float fwC = max(fwidth(fC), 1e-5);

    vec2 dr = q - uRadar.xy;
    float rr = length(dr);

    // (a uniform branch: the fronts cost nothing while they are off the chart)
    float cD = 1e5;
    float cA = 0.0;
    float cS = 0.0;
    float cT = 1.0;
    float wD = 1e5;
    float wA = 0.0;
    float wS = 0.0;
    float wT = 1.0;
    if (uFront.w > 0.001) {
      polyNearest(q, uCold, cD, cA, cS, cT);
      polyNearest(q, uWarm, wD, wA, wS, wT);
    }
    float fH = dot(q, vec2(0.7071, -0.7071)) / 0.2;
    float hatch = isoLine(fH, max(fwidth(fH), 1e-5), 1.0 * px);
    float fwCA = max(fwidth(cA), 1e-5);
    float fwWA = max(fwidth(wA), 1e-5);

    // the letter, in its own frame (x right, y up on screen; uLetter.w = yaw)
    vec2 ld = q - uLetter.xy;
    float cy = cos(uLetter.w);
    float sy = sin(uLetter.w);
    // screen right = (cos yaw, -sin yaw), screen up = (-sin yaw, -cos yaw)
    vec2 lp = vec2(dot(ld, vec2(cy, -sy)), dot(ld, vec2(-sy, -cy))) / max(uLetter.z, 1e-3);
    float m = uLetterK.x;
    float stemL = box(lp, vec2(-0.43, 0.0), vec2(0.13, 1.0));
    // the bar rises like a barometer's mercury; the right stem draws up out of the L's foot
    float bar = box(lp, vec2(0.0, mix(-0.87, 0.0, m)), vec2(mix(0.56, 0.43, m), mix(0.13, 0.11, m)));
    float top = mix(-1.0, 1.0, m);
    float stemR = m > 0.001 ? box(lp, vec2(0.43, (top - 1.0) * 0.5), vec2(0.13, (top + 1.0) * 0.5)) : 1e3;
    float letter = min(stemL, min(bar, stemR)) * uLetter.z;
    float fwL = max(fwidth(letter), 1e-5);

    // ---------------- pressure tints (stepped every 8 hPa, inside the low)
    float band = clamp(floor((1016.0 - p) / 8.0), 0.0, 5.0);
    float washA = (band < 0.5 ? 0.0 : 0.02 + band * 0.125) * uWash;

    // knock the tints and lines out under the letter
    float kn = uKnock.w * (1.0 - smoothstep(uKnock.z - fwQ, uKnock.z + fwQ, distance(q, uKnock.xy)));
    washA *= 1.0 - kn;

    vec4 acc = vec4(0.0);
    acc = over(acc, uWashC, washA);

    // ---------------- isobars (gaps where their numbers sit)
    float gap = 1.0;
    for (int i = 0; i < 6; i++) {
      vec4 g = uGap[i];
      gap *= 1.0 - g.w * (1.0 - smoothstep(g.z * 0.7, g.z, distance(q, g.xy)));
    }
    {
      vec2 na = uName.xy;
      vec2 nb = uName.zw - na;
      float nt = clamp(dot(q - na, nb) / max(dot(nb, nb), 1e-6), 0.0, 1.0);
      gap *= 1.0 - uNameK.y * (1.0 - smoothstep(uNameK.x * 0.75, uNameK.x, distance(q, na + nb * nt)));
    }
    float lineA = max(isoLine(fP, fwP, 1.15 * px), isoLine(fI, fwI, 2.2 * px));
    lineA *= uIso * gap * (1.0 - kn);
    float level = floor(fP + 0.5) * 4.0;
    float red = step(level, uRedBelow);
    vec3 isoCol = mix(uIsoC, uAlarm, red * uWash);
    acc = over(acc, isoCol, lineA * mix(0.85, 1.0, red));

    // ---------------- fronts
    float hatchA = 0.0;
    float coldA = 0.0;
    float warmA = 0.0;
    float lw = 0.036;
    float fk = uFront.w;
    float diss = uFront.z;
    // frontolysis: the line breaks into ever shorter dashes, then fades
    float brk = 1.0 - 0.8 * diss;
    {
      // cold front: triangles
      float drawn = 1.0 - smoothstep(uFront.x * cT - fwCA, uFront.x * cT, cA);
      float dash = 1.0 - smoothstep(brk * 0.6 - fwCA, brk * 0.6, mod(cA, 0.6));
      float core = 1.0 - smoothstep(lw - fwQ, lw + fwQ, cD);
      float per = 1.05;
      float u = mod(cA + per * 0.5, per) - per * 0.5;
      float sc = 1.0 - diss;
      float triH = 0.3 * sc;
      float triB = 0.23 * sc;
      float tri = min(cS, (triH * (1.0 - abs(u) / max(triB, 1e-3)) - cS) * 0.7);
      float triA = smoothstep(-fwQ, fwQ, tri) * step(0.55, cA) * step(cA, cT - 0.35) * step(0.02, sc);
      float fade = drawn * fk * (1.0 - smoothstep(0.55, 1.0, diss)) * (1.0 - kn);
      // showers along the cold front (hatched, like a printed precipitation area)
      float band2 = (1.0 - smoothstep(0.62 - fwQ, 0.62 + fwQ, cD)) * step(0.7, cA);
      hatchA = max(hatchA, band2 * fade * (1.0 - diss));
      coldA = max(core * dash, triA) * fade;
    }
    {
      // warm front: semicircles
      float drawn = 1.0 - smoothstep(uFront.y * wT - fwWA, uFront.y * wT, wA);
      float dash = 1.0 - smoothstep(brk * 0.6 - fwWA, brk * 0.6, mod(wA, 0.6));
      float core = 1.0 - smoothstep(lw - fwQ, lw + fwQ, wD);
      float per = 1.05;
      float u = mod(wA + per * 0.5, per) - per * 0.5;
      float sc = 1.0 - diss;
      float semi = min(wS, 0.21 * sc - length(vec2(u, wS)));
      float semiA = smoothstep(-fwQ, fwQ, semi) * step(0.55, wA) * step(wA, wT - 0.35) * step(0.02, sc);
      float fade = drawn * fk * (1.0 - smoothstep(0.55, 1.0, diss)) * (1.0 - kn);
      // the wide rain shield ahead of the warm front
      float band2 = (1.0 - smoothstep(1.7 - fwQ, 1.7 + fwQ, wD)) * smoothstep(0.3 - fwQ, 0.3 + fwQ, wS) * step(0.7, wA);
      hatchA = max(hatchA, band2 * fade * (1.0 - diss));
      warmA = max(core * dash, semiA) * fade;
    }

    // precipitation hatching under the fronts, then the fronts
    acc = over(acc, uColdC, hatchA * hatch * 0.5);
    acc = over(acc, uColdC, coldA);
    acc = over(acc, uWarmC, warmA);

    // ---------------- the watch: contours the sweep has just passed print vermilion
    float R = uRadarK.y;
    float inR = 1.0 - smoothstep(R - 0.1, R, rr);
    float ang = atan(dr.y, dr.x);
    float behind = mod(uRadar.z - ang, TAU);
    float contourHi = isoLine(fC, fwC, 1.7 * px) * exp(-behind * 1.2) * inR * step(0.0, hgt) * uUseTex;
    acc = over(acc, uSignal, contourHi * 0.95 * uRadar.w * uRadarK.z);

    // a hairline around the letter's knockout while the storm is on
    float kring = (1.0 - smoothstep(0.4 * px, 1.3 * px, abs(distance(q, uKnock.xy) - uKnock.z) / fwQ)) * uKnock.w * uWash;
    acc = over(acc, uIsoC, kring * 0.8);

    // ---------------- the letter (L → H)
    float la = (1.0 - smoothstep(-fwL, fwL, letter)) * uLetterK.y;
    acc = over(acc, uLetterC, la);

    // the veil: chart and overprint fade back into the paper behind a heading
    vec2 ndc = vClip.xy / vClip.w;
    vec2 vo = max(abs(ndc - (uVeil.xy + uVeil.zw) * 0.5) - (uVeil.zw - uVeil.xy) * 0.5, 0.0) / max(uVeilK.yz, vec2(1e-3));
    float veil = uVeilK.x * (1.0 - smoothstep(0.0, 1.0, length(vo)));
    acc = over(acc, uPaper, veil);

    // the chart's margin, then distance, fade into the paper
    vec2 ed = uEdge.zw - abs(q - uEdge.xy);
    float margin = uEdgeFeather > 0.0 ? smoothstep(0.0, uEdgeFeather, min(ed.x, ed.y)) : 1.0;
    float fog = 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
    acc *= margin * fog;
    gl_FragColor = acc;
  }
`

export function weatherMaterial(world: World, chart: ChartMaterial) {
  const cu = chart.uniforms
  const u: WeatherUniforms = {
    uTime: world.chart.uTime,
    uDpr: world.chart.uDpr,
    uFogNear: world.chart.uFogNear,
    uFogFar: world.chart.uFogFar,
    uPaper: world.chart.uPaper,
    // share the chart's own lift, sea lift, margin and height texture by reference
    uLift: cu.uLift,
    uSeaLift: cu.uSeaLift,
    uBase: cu.uBase,
    uEdge: cu.uEdge,
    uEdgeFeather: cu.uEdgeFeather,
    uInterval: cu.uInterval,
    uUseTex: cu.uUseTex,
    uHTex: cu.uHTex,
    uHOrigin: cu.uHOrigin,
    uHStep: cu.uHStep,
    uHSize: cu.uHSize,
    uLow: { value: new THREE.Vector4(0, 0, 0, 3) },
    uLowS: { value: new THREE.Vector4(0, 3, 1, 0) },
    uHigh: { value: new THREE.Vector4(0, 0, 0, 6) },
    uField: { value: new THREE.Vector4(0, 0, 1013, 0) },
    uIso: { value: 1 },
    uWash: { value: 0 },
    uRedBelow: { value: 0 },
    uIsoC: { value: new THREE.Color(C.storm) },
    uWashC: { value: new THREE.Color(C.storm) },
    uAlarm: { value: new THREE.Color(C.alarm) },
    uColdC: { value: new THREE.Color(C.storm) },
    uWarmC: { value: new THREE.Color(C.alarm) },
    uSignal: { value: new THREE.Color(C.signal) },
    uLetterC: { value: new THREE.Color(C.alarm) },
    uLetter: { value: new THREE.Vector4(0, 0, 1, 0) },
    uLetterK: { value: new THREE.Vector4(0, 0, 0, 0) },
    uKnock: { value: new THREE.Vector4(0, 0, 1, 0) },
    uGap: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 1, 0)) },
    uCold: { value: Array.from({ length: FN }, () => new THREE.Vector2()) },
    uWarm: { value: Array.from({ length: FN }, () => new THREE.Vector2()) },
    uFront: { value: new THREE.Vector4(0, 0, 0, 0) },
    uRadar: { value: new THREE.Vector4(0, 0, 0, 0) },
    uRadarK: { value: new THREE.Vector4(1.2, 3.6, 1, 0) },
    uName: { value: new THREE.Vector4(0, 0, 0, 0) },
    uNameK: { value: new THREE.Vector2(0.4, 0) },
    uVeil: { value: new THREE.Vector4(0, 0, 0, 0) },
    uVeilK: { value: new THREE.Vector4(0, 0.1, 0.1, 0) },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    // the chart's height-texture sampling mode (H_MANUAL where float filtering is missing)
    defines: { ...(chart.defines ?? {}) },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
    toneMapped: false,
  })
  return { mat, u }
}
