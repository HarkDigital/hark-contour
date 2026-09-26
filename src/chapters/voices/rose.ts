import * as THREE from 'three'
import type { World } from '../../world/World'
import { C, FONTS } from '../../kit/chart'

/*
 * A printed COMPASS ROSE for the bay: a true ring (degree ticks, labels every
 * 30°, a vermilion N), a magnetic ring set off by the (decorative) variation
 * in chart blue, and a sixteen-point star with split ink / paper halves — the
 * north point in survey vermilion. Drawn once into a canvas (transparent, so
 * the water tints show through) and inked on with an angular sweep (uDraw).
 */

const TAU = Math.PI * 2
/** decorative magnetic variation, degrees (west is negative) */
const VAR = -11.5

function drawRose(cv: HTMLCanvasElement) {
  const S = cv.width
  const x = cv.getContext('2d')!
  x.clearRect(0, 0, S, S)
  const c = S / 2
  const R = S * 0.485
  const pt = (deg: number, r: number): [number, number] => {
    const a = (deg * Math.PI) / 180
    return [c + Math.sin(a) * r, c - Math.cos(a) * r]
  }
  const circle = (r: number, lw: number, color: string) => {
    x.beginPath()
    x.arc(c, c, r, 0, TAU)
    x.lineWidth = lw
    x.strokeStyle = color
    x.stroke()
  }
  x.lineCap = 'butt'
  x.lineJoin = 'miter'

  /* ---- the true ring ---- */
  const rO = R * 0.985
  const rI = R * 0.925
  circle(rO, S * 0.0034, C.ink)
  circle(rI, S * 0.0016, C.ink)
  for (let d = 0; d < 360; d++) {
    const major = d % 10 === 0
    const mid = d % 5 === 0
    const len = (rO - rI) * (major ? 1 : mid ? 0.62 : 0.36)
    const [x0, y0] = pt(d, rI)
    const [x1, y1] = pt(d, rI + len)
    x.beginPath()
    x.moveTo(x0, y0)
    x.lineTo(x1, y1)
    x.lineWidth = S * (major ? 0.0017 : 0.0011)
    x.strokeStyle = C.ink
    x.stroke()
  }
  // labels every 30°, set tangent to the ring (tops outward)
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  for (let d = 30; d < 360; d += 30) {
    const [lx, ly] = pt(d, R * 0.862)
    x.save()
    x.translate(lx, ly)
    x.rotate((d * Math.PI) / 180)
    x.font = `500 ${Math.round(S * 0.03)}px ${FONTS.mono}`
    x.fillStyle = C.ink
    x.fillText(String(d), 0, 0)
    x.restore()
  }
  // north: a vermilion N
  {
    const [lx, ly] = pt(0, R * 0.852)
    x.font = `italic 500 ${Math.round(S * 0.062)}px ${FONTS.display}`
    x.fillStyle = C.signal
    x.fillText('N', lx, ly)
  }

  /* ---- the magnetic ring (rotated by the variation), chart blue ---- */
  const blue = C.coast
  const mO = R * 0.66
  const mI = R * 0.625
  circle(mO, S * 0.0013, blue)
  circle(mI, S * 0.0013, blue)
  for (let d = 0; d < 360; d += 5) {
    const dd = d + VAR
    const long = d % 30 === 0
    const [x0, y0] = pt(dd, mI)
    const [x1, y1] = pt(dd, long ? mO + R * 0.03 : mO)
    x.beginPath()
    x.moveTo(x0, y0)
    x.lineTo(x1, y1)
    x.lineWidth = S * 0.0012
    x.strokeStyle = blue
    x.stroke()
  }
  // magnetic north: a small open arrowhead
  {
    const [ax, ay] = pt(VAR, mO + R * 0.085)
    const [bx, by] = pt(VAR - 2.6, mO + R * 0.01)
    const [cx2, cy2] = pt(VAR + 2.6, mO + R * 0.01)
    x.beginPath()
    x.moveTo(ax, ay)
    x.lineTo(bx, by)
    x.lineTo(cx2, cy2)
    x.closePath()
    x.fillStyle = blue
    x.fill()
  }
  // "VAR 11°30′W" along the inside of the magnetic ring (lower left)
  {
    const text = 'VAR 11°30′W'
    const fs = Math.round(S * 0.021)
    x.font = `500 ${fs}px ${FONTS.mono}`
    x.fillStyle = blue
    const r = R * 0.575
    const chars = Array.from(text)
    const adv = chars.map(ch => x.measureText(ch).width + fs * 0.12)
    const total = adv.reduce((a, b) => a + b, 0)
    // bottom of the circle: text runs left → right as the angle decreases
    let a = 207 * (Math.PI / 180) + total / 2 / r
    chars.forEach((ch, i) => {
      const w = adv[i]
      const mid = a - w / 2 / r
      const px = c + Math.sin(mid) * r
      const py = c - Math.cos(mid) * r
      x.save()
      x.translate(px, py)
      x.rotate(mid - Math.PI)
      x.fillText(ch, 0, 0)
      x.restore()
      a -= w / r
    })
  }

  /* ---- the star: minor, intercardinal, then cardinal points on top ---- */
  const point = (deg: number, len: number, sw: number, spread: number, dark: string, light: string, edge: string, lw: number) => {
    const tip = pt(deg, len)
    const l = pt(deg - spread, sw)
    const r = pt(deg + spread, sw)
    // light half (anticlockwise side)
    x.beginPath()
    x.moveTo(c, c)
    x.lineTo(l[0], l[1])
    x.lineTo(tip[0], tip[1])
    x.closePath()
    x.fillStyle = light
    x.fill()
    x.lineWidth = lw
    x.strokeStyle = edge
    x.stroke()
    // dark half (clockwise side)
    x.beginPath()
    x.moveTo(c, c)
    x.lineTo(tip[0], tip[1])
    x.lineTo(r[0], r[1])
    x.closePath()
    x.fillStyle = dark
    x.fill()
    x.stroke()
  }
  x.lineJoin = 'round'
  for (let k = 0; k < 8; k++) point(22.5 + k * 45, R * 0.36, R * 0.05, 22.5, C.inkSoft, C.paper, C.inkSoft, S * 0.0012)
  for (let k = 0; k < 4; k++) point(45 + k * 90, R * 0.54, R * 0.085, 45, C.ink, C.paper, C.ink, S * 0.0014)
  for (let k = 0; k < 4; k++) {
    const north = k === 0
    point(k * 90, R * 0.8, R * 0.11, 45, north ? C.signal : C.ink, C.paper, north ? C.signal : C.ink, S * 0.0016)
  }
  // the hub
  x.beginPath()
  x.arc(c, c, R * 0.042, 0, TAU)
  x.fillStyle = C.paper
  x.fill()
  x.lineWidth = S * 0.0016
  x.strokeStyle = C.ink
  x.stroke()
  x.beginPath()
  x.arc(c, c, R * 0.014, 0, TAU)
  x.fillStyle = C.ink
  x.fill()
}

export interface Rose {
  mesh: THREE.Mesh
  uniforms: { uDraw: { value: number }; uOpacity: { value: number } }
  /** redraw the canvas (after late web fonts) */
  redraw(): void
}

/** The rose as a flat plane (2r across) lying on the water; place with mesh.position. */
export function makeRose(world: World, radius: number, mobile: boolean): Rose {
  const canvas = document.createElement('canvas')
  // the rose is at most ~900 device px across at 1440×900 @2 (the intro, top-down), ~1450 on a 5K
  // screen: 1536 keeps the degree figures and hairline ticks at ≥1 texel per pixel
  canvas.width = canvas.height = mobile ? 1024 : 1536
  drawRose(canvas)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.premultiplyAlpha = true
  tex.anisotropy = 8
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  const uniforms = {
    uMap: { value: tex as THREE.Texture },
    uDraw: { value: 1 },
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
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uDraw, uOpacity, uFogNear, uFogFar;
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        vec2 p = vUv - 0.5;
        // clockwise from north, 0..1: the rose is inked on as a sweep
        float a = fract(atan(p.x, p.y) / 6.2831853 + 1.0);
        float drawn = 1.0 - smoothstep(uDraw * 1.03 - 0.03, uDraw * 1.03, a);
        float fogK = 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
        float k = drawn * uOpacity * fogK;
        gl_FragColor = vec4(t.rgb * k, t.a * k);
      }
    `,
  })
  const geo = new THREE.PlaneGeometry(radius * 2, radius * 2)
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 2
  return {
    mesh,
    uniforms,
    redraw() {
      drawRose(canvas)
      tex.needsUpdate = true
    },
  }
}
