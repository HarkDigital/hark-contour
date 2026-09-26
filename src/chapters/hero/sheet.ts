import * as THREE from 'three'
import { C, labelTexture, type LabelOptions } from '../../kit/chart'

/*
 * The printed sheet around the hero chart: a thin inner neatline, a
 * graduated border (alternating ink bars every half graticule cell, like a
 * Swiss topographic sheet), and a heavier outer neatline — one merged mesh
 * that draws itself clockwise from the top-left corner (uDraw 0 → 1) — plus
 * the sheet's marginal lettering (flat labels lying on the paper).
 */

export interface SheetUniforms {
  uDraw: { value: number }
  uOpacity: { value: number }
  uColor: { value: THREE.Color }
}

export function sheetFrame(cx: number, cz: number, half: number, bars: number): { mesh: THREE.Mesh; uniforms: SheetUniforms } {
  const pos: number[] = []
  const tArr: number[] = []
  const idx: number[] = []
  const s = 2 * half
  const L = 4 * s
  const cl = (v: number) => Math.min(s, Math.max(0, v))
  // perimeter parameter (clockwise from the top-left corner) of a point beside side 0 top, 1 right, 2 bottom, 3 left
  const perim = (x: number, z: number, side: number) => {
    const lx = x - (cx - half)
    const lz = z - (cz - half)
    if (side === 0) return cl(lx) / L
    if (side === 1) return (s + cl(lz)) / L
    if (side === 2) return (3 * s - cl(lx)) / L
    return (4 * s - cl(lz)) / L
  }
  const quad = (x0: number, z0: number, x1: number, z1: number, side: number) => {
    const b = pos.length / 3
    const pts: [number, number][] = [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ]
    for (const [x, z] of pts) {
      pos.push(x, 0, z)
      tArr.push(perim(x, z, side))
    }
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2)
  }
  // a band from inset a to inset b outside the square (a < b), as four strips
  const band = (a: number, b: number) => {
    const x0 = cx - half
    const x1 = cx + half
    const z0 = cz - half
    const z1 = cz + half
    quad(x0 - b, z0 - b, x1 + b, z0 - a, 0)
    quad(x1 + a, z0 - a, x1 + b, z1 + a, 1)
    quad(x0 - b, z1 + a, x1 + b, z1 + b, 2)
    quad(x0 - b, z0 - a, x0 - a, z1 + a, 3)
  }
  const INNER = 0.028
  const B0 = 0.11
  const B1 = 0.24
  const HAIR = 0.018
  const OUT0 = 0.38
  const OUT1 = 0.45
  band(0, INNER)
  band(B0, B0 + HAIR)
  band(B1 - HAIR, B1)
  band(OUT0, OUT1)
  // graduated bars: every other cell, alternating clockwise round the corners (corner squares stay open)
  const cell = s / bars
  for (let k = 0; k < bars; k += 2) {
    const a = -half + k * cell
    const b = a + cell
    quad(cx + a, cz - half - B1, cx + b, cz - half - B0, 0)
    quad(cx + half + B0, cz + a, cx + half + B1, cz + b, 1)
    quad(cx - b, cz + half + B0, cx - a, cz + half + B1, 2)
    quad(cx - half - B1, cz - b, cx - half - B0, cz - a, 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(tArr, 1))
  geo.setIndex(idx)
  const uniforms = {
    uDraw: { value: 1 },
    uOpacity: { value: 1 },
    uColor: { value: new THREE.Color(C.ink) },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      attribute float aT;
      varying float vT;
      void main() {
        vT = aT;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uDraw, uOpacity;
      uniform vec3 uColor;
      varying float vT;
      void main() {
        float fw = max(fwidth(vT), 1e-5);
        float drawn = 1.0 - smoothstep(uDraw - fw, uDraw + fw, vT);
        float a = drawn * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 2
  mesh.frustumCulled = false
  return { mesh, uniforms }
}

/** a flat lettered plane lying on the paper; `anchor` 0 = left edge at x, 0.5 centred, 1 = right edge */
type FlatOpts = LabelOptions & { height: number; anchor?: number; rot?: number }

function flatGeometry(aspect: number, o: FlatOpts) {
  const w = o.height * aspect
  const geo = new THREE.PlaneGeometry(w, o.height)
  geo.translate((0.5 - (o.anchor ?? 0.5)) * w, 0, 0)
  geo.rotateX(-Math.PI / 2)
  if (o.rot) geo.rotateY(o.rot)
  return geo
}

export function flatLabel(text: string, o: FlatOpts): THREE.Mesh {
  const { texture, aspect } = labelTexture(text, o)
  const geo = flatGeometry(aspect, o)
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const m = new THREE.Mesh(geo, mat)
  m.renderOrder = 2
  m.userData.label = { text, o }
  return m
}

/** redraw a flat label (after the web fonts arrive: the metrics change too) */
export function redrawLabel(m: THREE.Mesh) {
  const info = m.userData.label as { text: string; o: FlatOpts } | undefined
  if (!info) return
  const mat = m.material as THREE.MeshBasicMaterial
  const { texture, aspect } = labelTexture(info.text, info.o)
  mat.map?.dispose()
  mat.map = texture
  mat.needsUpdate = true
  m.geometry.dispose()
  m.geometry = flatGeometry(aspect, info.o)
}
