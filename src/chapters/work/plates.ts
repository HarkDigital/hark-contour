import * as THREE from 'three'
import { C, FONTS } from '../../kit/chart'
import type { WorkItem } from '../../content'

/*
 * AERIAL PLATES — each featured project's screenshot mounted like a map
 * inset: a paper mount, a double ink neatline, corner registration ticks, a
 * caption strip, and the image window. At rest the plate lies flat on the
 * chart beside its site, showing its sheet-index face (a hatched window with
 * the site number); when its site is active it lifts off the chart, turns to
 * face the drone and the screenshot prints into the window, left → right.
 *
 * The plate's geometry is 1 world unit wide (scale it); +y is the caption's
 * "up", the face looks along +z.
 */

/** mount canvas layout (px) */
const MW = 1024
const SIDE = 34
const TOP = 34
const CAP = 74
const WIN_W = MW - SIDE * 2
const WIN_H = Math.round(WIN_W / 1.6)
const MH = TOP + WIN_H + CAP
/** mount aspect (width / height) */
export const MOUNT_ASPECT = MW / MH
/** the image window inside the unit-wide plate */
const WIN = {
  w: WIN_W / MW,
  h: WIN_H / MW,
  cx: 0,
  cy: (MH / 2 - TOP - WIN_H / 2) / MW,
}

export const isPreview = (url: string) => /harktest\.com/.test(url)
export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
const pad2 = (n: number) => String(n).padStart(2, '0')

/** draw text with per-glyph tracking (Safari has no canvas letterSpacing); returns the width */
function tracked(x: CanvasRenderingContext2D, s: string, px: number, py: number, track: number, align: 'left' | 'right' = 'left') {
  const chars = Array.from(s)
  const adv = chars.map(ch => x.measureText(ch).width)
  const w = adv.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1)
  let cx = align === 'right' ? px - w : px
  chars.forEach((ch, i) => {
    x.fillText(ch, cx, py)
    cx += adv[i] + track
  })
  return w
}

function drawMount(cv: HTMLCanvasElement, w: WorkItem, k: number, ref: string) {
  cv.width = MW
  cv.height = MH
  const x = cv.getContext('2d')!
  // paper, a shade lighter than the chart so the plate lifts off it
  x.fillStyle = '#f7f3ea'
  x.fillRect(0, 0, MW, MH)
  // double neatline
  x.strokeStyle = C.ink
  x.lineWidth = 3
  x.strokeRect(7.5, 7.5, MW - 15, MH - 15)
  x.lineWidth = 1.25
  x.strokeRect(14.5, 14.5, MW - 29, MH - 29)
  // the window: sheet-index face (hatched paper + the site number)
  const wx = SIDE
  const wy = TOP
  x.fillStyle = '#ebe3d2'
  x.fillRect(wx, wy, WIN_W, WIN_H)
  x.save()
  x.beginPath()
  x.rect(wx, wy, WIN_W, WIN_H)
  x.clip()
  x.strokeStyle = 'rgba(160, 113, 74, 0.35)'
  x.lineWidth = 2
  for (let d = -WIN_H; d < WIN_W; d += 26) {
    x.beginPath()
    x.moveTo(wx + d, wy + WIN_H)
    x.lineTo(wx + d + WIN_H, wy)
    x.stroke()
  }
  x.restore()
  x.fillStyle = '#ebe3d2'
  const numR = WIN_H * 0.36
  x.beginPath()
  x.arc(wx + WIN_W / 2, wy + WIN_H / 2, numR, 0, Math.PI * 2)
  x.fill()
  x.strokeStyle = C.signal
  x.lineWidth = 7
  x.stroke()
  x.fillStyle = C.ink
  x.textAlign = 'center'
  x.textBaseline = 'middle'
  x.font = `italic 400 ${Math.round(WIN_H * 0.46)}px ${FONTS.display}`
  x.fillText(pad2(k + 1), wx + WIN_W / 2, wy + WIN_H / 2 + WIN_H * 0.02)
  x.textAlign = 'left'
  // the window's own neatline
  x.strokeStyle = C.ink
  x.lineWidth = 2
  x.strokeRect(wx - 1, wy - 1, WIN_W + 2, WIN_H + 2)
  // corner registration ticks just outside the window
  x.lineWidth = 2
  const t = 16
  const corners: [number, number, number, number][] = [
    [wx, wy, -1, -1],
    [wx + WIN_W, wy, 1, -1],
    [wx, wy + WIN_H, -1, 1],
    [wx + WIN_W, wy + WIN_H, 1, 1],
  ]
  for (const [cx, cy, sx, sy] of corners) {
    x.beginPath()
    x.moveTo(cx + sx * 5, cy)
    x.lineTo(cx + sx * (5 + t), cy)
    x.moveTo(cx, cy + sy * 5)
    x.lineTo(cx, cy + sy * (5 + t))
    x.stroke()
  }
  // caption strip
  const cy = TOP + WIN_H + CAP / 2 + 3
  x.textBaseline = 'middle'
  x.fillStyle = C.signalText
  x.font = `700 21px ${FONTS.sans}`
  const lw = tracked(x, `PLATE ${pad2(k + 1)}`, SIDE, cy, 3.4)
  x.fillStyle = C.ink
  x.font = `700 21px ${FONTS.sans}`
  tracked(x, w.name.toUpperCase(), SIDE + lw + 22, cy, 3.2)
  x.fillStyle = C.inkSoft
  x.font = `500 19px ${FONTS.mono}`
  const right = `${hostOf(w.url)}${isPreview(w.url) ? ' · PREVIEW' : ''} · ${ref}`
  tracked(x, right.toUpperCase(), MW - SIDE, cy, 1.2, 'right')
  // a small vermilion rule between the plate number and the name
  x.fillStyle = C.signal
  x.fillRect(SIDE + lw + 8, cy - 9, 3, 18)
}

const IMAGE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
/* the screenshot prints into the window left → right behind a soft vermilion edge */
const IMAGE_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float uDevelop, uLevel, uHasMap;
  uniform vec3 uEdgeC;
  varying vec2 vUv;
  void main() {
    // a slightly raked print front sweeping left → right
    float x = vUv.x + (vUv.y - 0.5) * 0.06;
    float front = uDevelop * 1.16 - 0.08;
    float a = 1.0 - smoothstep(front - 0.035, front, x);
    float live = step(uDevelop, 0.999);
    float edge = smoothstep(front - 0.045, front - 0.012, x) * (1.0 - smoothstep(front - 0.012, front, x)) * live;
    vec3 img = texture2D(map, vUv).rgb * uLevel;
    vec3 col = mix(img, uEdgeC, edge * 0.75);
    float alpha = max(a, edge * 0.85) * uHasMap;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
  }
`

export interface Plate {
  /** positioned + oriented + scaled each frame */
  root: THREE.Group
  mount: THREE.Mesh
  mountMat: THREE.MeshBasicMaterial
  image: THREE.Mesh
  imageMat: THREE.ShaderMaterial
  shadow: THREE.Mesh
  shadowMat: THREE.MeshBasicMaterial
  canvas: HTMLCanvasElement
  mountTex: THREE.CanvasTexture
  leaders: THREE.LineSegments
  leaderMat: THREE.LineBasicMaterial
  leaderPos: THREE.BufferAttribute
  redraw(): void
}

let shadowTex: THREE.CanvasTexture | null = null
function softShadow(): THREE.CanvasTexture {
  if (shadowTex) return shadowTex
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 128
  const x = c.getContext('2d')!
  const g = x.createRadialGradient(64, 64, 10, 64, 64, 64)
  g.addColorStop(0, 'rgba(70, 45, 20, 0.55)')
  g.addColorStop(0.55, 'rgba(70, 45, 20, 0.22)')
  g.addColorStop(1, 'rgba(70, 45, 20, 0)')
  x.fillStyle = g
  x.fillRect(0, 0, 128, 128)
  shadowTex = new THREE.CanvasTexture(c)
  shadowTex.colorSpace = THREE.SRGBColorSpace
  return shadowTex
}

export function buildPlate(w: WorkItem, k: number, ref: string, placeholder: THREE.Texture): Plate {
  const root = new THREE.Group()
  const canvas = document.createElement('canvas')
  drawMount(canvas, w, k, ref)
  const mountTex = new THREE.CanvasTexture(canvas)
  mountTex.colorSpace = THREE.SRGBColorSpace
  mountTex.anisotropy = 8
  const mountMat = new THREE.MeshBasicMaterial({ map: mountTex, toneMapped: false, fog: false, transparent: true })
  const mount = new THREE.Mesh(new THREE.PlaneGeometry(1, 1 / MOUNT_ASPECT), mountMat)
  root.add(mount)

  const imageMat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: placeholder },
      uDevelop: { value: 0 },
      uLevel: { value: 0.95 },
      uHasMap: { value: 0 },
      uEdgeC: { value: new THREE.Color(C.signal) },
    },
    vertexShader: IMAGE_VERT,
    fragmentShader: IMAGE_FRAG,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  })
  const image = new THREE.Mesh(new THREE.PlaneGeometry(WIN.w, WIN.h), imageMat)
  image.position.set(WIN.cx, WIN.cy, 0.0015)
  root.add(image)

  // a soft lifted shadow behind the mount (a printed drop, not a light)
  const shadowMat = new THREE.MeshBasicMaterial({ map: softShadow(), transparent: true, depthWrite: false, toneMapped: false, fog: false, opacity: 0 })
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.22, 1.22 / MOUNT_ASPECT + 0.2), shadowMat)
  shadow.position.set(0.035, -0.05, -0.02)
  root.add(shadow)

  // leader lines: plate's bottom corners → the marker head (world space, updated per frame)
  const leaderPos = new THREE.BufferAttribute(new Float32Array(4 * 3), 3)
  leaderPos.setUsage(THREE.DynamicDrawUsage)
  const lg = new THREE.BufferGeometry()
  lg.setAttribute('position', leaderPos)
  lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  const leaderMat = new THREE.LineBasicMaterial({ color: new THREE.Color(C.ink), transparent: true, opacity: 0, toneMapped: false, fog: false })
  const leaders = new THREE.LineSegments(lg, leaderMat)
  leaders.frustumCulled = false
  leaders.renderOrder = 4

  return {
    root,
    mount,
    mountMat,
    image,
    imageMat,
    shadow,
    shadowMat,
    canvas,
    mountTex,
    leaders,
    leaderMat,
    leaderPos,
    redraw() {
      drawMount(canvas, w, k, ref)
      mountTex.needsUpdate = true
    },
  }
}

/** Local corner of the unit plate (bottom-left / bottom-right of the mount). */
export const PLATE_BOTTOM = -0.5 / MOUNT_ASPECT
