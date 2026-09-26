import * as THREE from 'three'

/*
 * A printed line on the chart: a polyline laid on the land, drawn with a
 * constant SCREEN width (a map's line weights don't change with zoom),
 * dashed along its length and drawing itself as uProgress goes 0 → 1.
 *
 * The points carry full-relief heights; the vertex shader follows the
 * chart's lift (uLift) so the line stays on the ground as the map rises.
 * Dash and gap are in world units: set them per frame from the view scale
 * (setScale) so dashes read the same size in the overview and up close.
 */

export interface PrintLine {
  mesh: THREE.Mesh
  uniforms: {
    uProgress: { value: number }
    uOpacity: { value: number }
    uColor: { value: THREE.Color }
    /** line width, CSS px */
    uWidth: { value: number }
    uDash: { value: number }
    uGap: { value: number }
    uLift: { value: number }
    uYOff: { value: number }
    uRes: { value: THREE.Vector2 }
    uDpr: { value: number }
    uLength: { value: number }
  }
  length: number
  /** dash/gap in CSS px at `worldPerPx` world units per CSS px */
  setScale(worldPerPx: number): void
}

export function printLine(
  points: THREE.Vector3[],
  o: { width?: number; color?: THREE.ColorRepresentation; dashPx?: number; gapPx?: number } = {},
): PrintLine {
  const n = points.length
  const pos = new Float32Array(n * 2 * 3)
  const prev = new Float32Array(n * 2 * 3)
  const next = new Float32Array(n * 2 * 3)
  const side = new Float32Array(n * 2)
  const dist = new Float32Array(n * 2)
  let acc = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z)
    const p = points[i]
    const a = points[Math.max(0, i - 1)]
    const b = points[Math.min(n - 1, i + 1)]
    for (let s = 0; s < 2; s++) {
      const k = i * 2 + s
      pos.set([p.x, p.y, p.z], k * 3)
      prev.set([a.x, a.y, a.z], k * 3)
      next.set([b.x, b.y, b.z], k * 3)
      side[k] = s === 0 ? 1 : -1
      dist[k] = acc
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
  geo.setAttribute('aDist', new THREE.BufferAttribute(dist, 1))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  if (geo.boundingSphere) geo.boundingSphere.radius += 2

  const dashPx = o.dashPx ?? 9
  const gapPx = o.gapPx ?? 6
  const uniforms = {
    uProgress: { value: 1 },
    uOpacity: { value: 1 },
    uColor: { value: new THREE.Color(o.color ?? '#d2462a') },
    uWidth: { value: o.width ?? 2.5 },
    uDash: { value: 0.3 },
    uGap: { value: 0.2 },
    uLift: { value: 1 },
    uYOff: { value: 0.03 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    uLength: { value: acc },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec3 aPrev;
      attribute vec3 aNext;
      attribute float aSide;
      attribute float aDist;
      uniform vec2 uRes;
      uniform float uWidth, uDpr, uLift, uYOff;
      varying float vDist;
      varying float vSide;
      vec4 clipOf(vec3 p) {
        p.y = p.y * uLift + uYOff;
        return projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
      void main() {
        vec4 c = clipOf(position);
        vec4 cp = clipOf(aPrev);
        vec4 cn = clipOf(aNext);
        vec2 sp = cp.xy / max(cp.w, 1e-4) * uRes;
        vec2 sn = cn.xy / max(cn.w, 1e-4) * uRes;
        vec2 d = sn - sp;
        float len = length(d);
        vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        // half the width (+1 px for the anti-aliased edge), in device px → NDC
        float hwid = uWidth * uDpr * 0.5 + 1.0;
        c.xy += nrm * aSide * hwid * 2.0 / uRes * c.w;
        vDist = aDist;
        vSide = aSide * hwid;
        gl_Position = c;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress, uLength, uDash, uGap, uOpacity, uWidth, uDpr;
      uniform vec3 uColor;
      varying float vDist;
      varying float vSide;
      void main() {
        float fw = max(fwidth(vDist), 1e-5);
        float period = uDash + uGap;
        float ph = mod(vDist, period);
        float dash = uGap <= 0.0 ? 1.0 : (1.0 - smoothstep(uDash - fw, uDash + fw, ph)) * smoothstep(0.0, fw, ph);
        float drawn = 1.0 - smoothstep(uProgress * uLength - fw, uProgress * uLength + fw, vDist);
        // coverage across the line: vSide is in device px from the centre
        float hw = uWidth * uDpr * 0.5;
        float edge = clamp(hw + 0.5 - abs(vSide), 0.0, 1.0);
        float a = dash * drawn * edge * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 3
  mesh.frustumCulled = false
  return {
    mesh,
    uniforms,
    length: acc,
    setScale(worldPerPx: number) {
      uniforms.uDash.value = dashPx * worldPerPx
      uniforms.uGap.value = gapPx * worldPerPx
    },
  }
}
