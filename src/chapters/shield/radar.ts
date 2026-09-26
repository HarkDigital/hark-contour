import * as THREE from 'three'
import { C } from '../../kit/chart'

/*
 * THE WATCH — a weather-station dial laid level over the site: range rings
 * that drift slowly outward (the water-lining motif, heard as a signal), a
 * bearing ring with 5° ticks (long every 45°), and a radar sweep with a
 * short fading trail. Flat vermilion, premultiplied, drawn over the land so
 * the dial stays a true circle however high the relief rises around it.
 * The contours the sweep has just passed are lit in the chart overprint
 * (weather.ts reads the same angle).
 */

export interface RadarUniforms {
  [name: string]: THREE.IUniform
  uDpr: { value: number }
  uCentre: { value: THREE.Vector2 }
  /** sweep angle (world, atan2(z, x)), amount 0..1 */
  uSweep: { value: THREE.Vector2 }
  /** ring spacing, radius, sweep on (0 under calm), ring drift phase */
  uK: { value: THREE.Vector4 }
  uColor: { value: THREE.Color }
  uInk: { value: THREE.Color }
}

export function radarDisc(radius: number, dpr: { value: number }) {
  const u: RadarUniforms = {
    uDpr: dpr,
    uCentre: { value: new THREE.Vector2() },
    uSweep: { value: new THREE.Vector2() },
    uK: { value: new THREE.Vector4(0.85, radius, 1, 0) },
    uColor: { value: new THREE.Color(C.signal) },
    uInk: { value: new THREE.Color(C.ink) },
  }
  const geo = new THREE.CircleGeometry(radius + 0.45, 128)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uDpr;
      uniform vec2 uCentre, uSweep;
      uniform vec4 uK;
      uniform vec3 uColor, uInk;
      varying vec3 vW;
      const float TAU = 6.2831853;

      float isoLine(float f, float fw, float wpx) {
        float d = abs(fract(f - 0.5) - 0.5) / fw;
        float a = 1.0 - smoothstep(wpx * 0.5 - 0.5, wpx * 0.5 + 0.5, d);
        return a * (1.0 - smoothstep(0.22, 0.6, fw));
      }
      vec4 over(vec4 dst, vec3 c, float a) {
        return vec4(c * a + dst.rgb * (1.0 - a), a + dst.a * (1.0 - a));
      }

      void main() {
        float px = max(uDpr, 0.5);
        vec2 d = vW.xz - uCentre;
        float r = length(d);
        float R = uK.y;
        float fR = r / uK.x - uK.w;
        float fwR = max(fwidth(fR), 1e-5);
        float fwQ = max(length(fwidth(vW.xz)), 1e-5);

        float inR = 1.0 - smoothstep(R - fwQ, R + fwQ, r);
        float fadeR = smoothstep(0.25, 0.9, r) * (1.0 - smoothstep(R * 0.7, R - 0.05, r));
        float rings = isoLine(fR, fwR, 1.1 * px) * fadeR;
        float outer = 1.0 - smoothstep(0.7 * px, 1.5 * px, abs(r - R) / fwQ);
        float inner = 1.0 - smoothstep(0.4 * px, 1.2 * px, abs(r - R + 0.12) / fwQ);

        float ang = atan(d.y, d.x);
        float tk = abs(fract(ang / TAU * 72.0 + 0.5) - 0.5) * TAU / 72.0 * r;
        float major = step(0.5, 1.0 - abs(fract(ang / TAU * 8.0 + 0.5) - 0.5) * 16.0);
        float tickLen = mix(0.13, 0.3, major);
        float ticks = (1.0 - smoothstep(0.45 * px, 1.3 * px, tk / fwQ)) * step(R, r) * step(r, R + tickLen);

        float behind = mod(uSweep.x - ang, TAU);
        float trail = exp(-behind * 2.6) * inR * smoothstep(0.1, 0.5, r);
        float sweepLine = (1.0 - smoothstep(0.35 * px, 1.25 * px, r * abs(sin(ang - uSweep.x)) / fwQ)) * step(0.0, cos(ang - uSweep.x)) * inR;

        float on = uSweep.y;
        vec4 acc = vec4(0.0);
        acc = over(acc, uColor, trail * 0.2 * uK.z);
        acc = over(acc, uColor, rings * 0.6);
        acc = over(acc, uColor, max(outer * 0.9, inner * 0.45));
        acc = over(acc, uColor, ticks * 0.9);
        acc = over(acc, uColor, sweepLine * 0.85 * (1.0 - 0.45 * r / R) * uK.z);
        gl_FragColor = acc * on;
      }
    `,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 2
  mesh.frustumCulled = false
  return { mesh, u }
}
