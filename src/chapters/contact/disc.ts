import * as THREE from 'three'
import { logoGeometry } from '../../logo/logo'
import { FONTS, ensureFonts } from '../../kit/chart'
import { BRAND } from '../../content'
import { nextFrame } from '../../core/yield'

/*
 * THE BENCHMARK — a brass survey disc set into the chart: the one true 3D prop
 * of the chapter (lit by world.key + hemi and a small warm environment map).
 *
 *   - a slightly domed face carrying the engraving as a canvas texture drawn
 *     north-up: 'HARK DIGITAL DESIGN' round the top of the rim, the locale
 *     ('PHILADELPHIA · EVERYWHERE · EST. 2016') round the bottom, both reading
 *     upright from the south, with a small engraved triangle at 3 and 9
 *     o'clock and two engraved circles framing the band
 *   - the Hark mark embossed, shallow, at the centre (logoGeometry)
 *   - a raised, rounded rim and a short skirt that sinks into the ground
 *   - a soft printed contact shadow so it sits in the paper
 *
 * group.position = the ground point under the disc's centre; +y up; the
 * engraving's "north" is -z (rotate the group about y to face a camera).
 */

/** disc radius (world units) */
export const DISC_R = 1.2
/** height of the engraved face above the ground */
const FACE_Y = 0.07
/** the face's dome (centre above the rim foot) */
const DOME = 0.03
/** the flat engraved face ends here; the raised rim starts */
const FACE_R = DISC_R * 0.87

export interface Benchmark {
  group: THREE.Group
  /** turns with the disc (yaw only) */
  spin: THREE.Group
  brass: THREE.MeshStandardMaterial
  markMat: THREE.MeshStandardMaterial
  shadow: THREE.Mesh
  /** draw the rim lettering again (after the web fonts arrive) */
  redraw(): void
  dispose(): void
}

/** A warm little studio for the brass to reflect: paper walls, a soft NW window, umber ground. */
function brassEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene()
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(10, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          float y = normalize(vDir).y;
          vec3 top = vec3(0.8, 0.73, 0.61);
          vec3 hor = vec3(0.62, 0.52, 0.38);
          vec3 low = vec3(0.12, 0.085, 0.05);
          vec3 c = mix(hor, top, smoothstep(0.0, 0.85, y));
          c = mix(c, low, 1.0 - smoothstep(-0.35, 0.02, y));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    }),
  )
  scene.add(dome)
  // the soft window (north-west, high) and a dim bounce card (south-east, low)
  const win = new THREE.Mesh(new THREE.PlaneGeometry(7, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.98, 0.9, 0.76) }))
  win.position.set(-5.2, 6.2, -4.6)
  win.lookAt(0, 0, 0)
  const card = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.42, 0.28) }))
  card.position.set(5, 1.2, 6)
  card.lookAt(0, 0, 0)
  scene.add(win, card)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const rt = pmrem.fromScene(scene, 0.035)
  pmrem.dispose()
  dome.geometry.dispose()
  ;(dome.material as THREE.Material).dispose()
  win.geometry.dispose()
  card.geometry.dispose()
  ;(win.material as THREE.Material).dispose()
  ;(card.material as THREE.Material).dispose()
  return rt
}

/**
 * A soft shoulder on the brass's lit colour (NoToneMapping): values below
 * the knee pass untouched, highlights roll off toward LIN_CEIL (≈ 0.945 on
 * screen, after the sRGB encode), so a glint on the rim or the mark's bevel
 * never clips to white.
 */
const KNEE = 0.6
const LIN_CEIL = 0.88
function softHighlights(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      /* glsl */ `{
        vec3 hkX = max(gl_FragColor.rgb, vec3(0.0));
        vec3 hkO = max(hkX - ${KNEE.toFixed(3)}, vec3(0.0));
        gl_FragColor.rgb = min(hkX, vec3(${KNEE.toFixed(3)})) + ${(LIN_CEIL - KNEE).toFixed(3)} * (vec3(1.0) - exp(-hkO / ${(LIN_CEIL - KNEE).toFixed(3)}));
      }
      #include <tonemapping_fragment>`,
    )
  }
  mat.customProgramCacheKey = () => 'hark-brass-knee'
}

/** After the texture's next upload, let the canvas go (the GPU copy is all that's drawn). */
export function releaseOnUpload(tex: THREE.Texture) {
  tex.onUpdate = () => {
    tex.onUpdate = null
    const c = tex.image as HTMLCanvasElement
    c.width = c.height = 1
  }
}

/** The rounded rim + skirt, as a lathe profile (r, y). */
function rimProfile(): THREE.Vector2[] {
  const pts: THREE.Vector2[] = []
  const lipH = 0.05
  const r0 = FACE_R
  const r1 = DISC_R
  // up from the face into a rounded lip, down the outside edge
  const n = 20
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = Math.PI * t
    const r = r0 + (r1 - r0) * (0.5 - 0.5 * Math.cos(a))
    const y = FACE_Y + lipH * Math.sin(a) ** 0.8 + (1 - t) * 0.0
    pts.push(new THREE.Vector2(r, y))
  }
  // the outside wall, then a skirt tucked under the ground
  pts.push(new THREE.Vector2(r1 + 0.004, FACE_Y - 0.03))
  pts.push(new THREE.Vector2(r1 + 0.008, -0.03))
  pts.push(new THREE.Vector2(r1 * 0.96, -0.08))
  // LatheGeometry wants the profile bottom → top for outward normals
  return pts.reverse()
}

/** Text drawn letter by letter along an arc (canvas px). */
function arcText(
  x: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  centre: number,
  track: number,
  bottom: boolean,
) {
  const chars = Array.from(text)
  const adv = chars.map(ch => x.measureText(ch).width)
  const total = adv.reduce((a, b) => a + b, 0) + track * (chars.length - 1)
  const span = total / radius
  // top: clockwise from the left; bottom: counter-clockwise from the left (upright from the south)
  let a = bottom ? centre + span / 2 : centre - span / 2
  for (let i = 0; i < chars.length; i++) {
    const half = adv[i] / 2 / radius
    a += bottom ? -half : half
    x.save()
    x.translate(cx + radius * Math.cos(a), cy + radius * Math.sin(a))
    x.rotate(bottom ? a - Math.PI / 2 : a + Math.PI / 2)
    x.fillText(chars[i], 0, 0)
    x.restore()
    a += bottom ? -(half + track / radius) : half + track / radius
  }
  return span
}

/** The face: warm-white base (the brass colour multiplies it) + dark engraving. */
function drawFace(c: HTMLCanvasElement) {
  const x = c.getContext('2d')!
  const S = c.width
  const cx = S / 2
  const cy = S / 2
  const R = S / 2 // = FACE_R
  x.clearRect(0, 0, S, S)
  x.fillStyle = '#ffffff'
  x.fillRect(0, 0, S, S)

  // turned-metal rings and a little age toward the rim (spacing scales with
  // the canvas, so the face reads the same at every device size)
  const k = S / 2048
  x.lineWidth = Math.max(0.5, k)
  for (let i = 0, r = 6 * k; r < R; i++, r += 3 * k) {
    x.strokeStyle = `rgba(120, 88, 40, ${0.035 + 0.03 * Math.abs(Math.sin((6 + 3 * i) * 0.37))})`
    x.beginPath()
    x.arc(cx, cy, r, 0, Math.PI * 2)
    x.stroke()
  }
  const g = x.createRadialGradient(cx, cy, R * 0.55, cx, cy, R)
  g.addColorStop(0, 'rgba(96, 66, 30, 0)')
  g.addColorStop(1, 'rgba(96, 66, 30, 0.2)')
  x.fillStyle = g
  x.fillRect(0, 0, S, S)

  const ink = '#3a2812'
  x.strokeStyle = ink
  x.fillStyle = ink
  // two engraved circles frame the lettering band
  const rOut = R * 0.955
  const rIn = R * 0.7
  x.lineWidth = S * 0.0045
  x.beginPath()
  x.arc(cx, cy, rOut, 0, Math.PI * 2)
  x.stroke()
  x.lineWidth = S * 0.004
  x.beginPath()
  x.arc(cx, cy, rIn, 0, Math.PI * 2)
  x.stroke()

  x.textAlign = 'center'
  x.textBaseline = 'middle'
  const mid = (rOut + rIn) / 2
  // top: the name, the larger letters
  const big = Math.round(S * 0.058)
  x.font = `700 ${big}px ${FONTS.sans}`
  const top = BRAND.name.toUpperCase()
  arcText(x, top, cx, cy + big * 0.04, mid + big * 0.02, -Math.PI / 2, big * 0.3, false)
  // bottom: the locale (verbatim pieces), a touch smaller
  const small = Math.round(S * 0.045)
  x.font = `700 ${small}px ${FONTS.sans}`
  const bottom = BRAND.locale.toUpperCase()
  arcText(x, bottom, cx, cy - small * 0.04, mid - small * 0.02, Math.PI / 2, small * 0.18, true)

  // the survey triangles at 3 and 9 o'clock
  const tri = (a: number) => {
    const px = cx + mid * Math.cos(a)
    const py = cy + mid * Math.sin(a)
    const s = S * 0.022
    x.beginPath()
    x.moveTo(px, py - s)
    x.lineTo(px + s * 1.05, py + s * 0.8)
    x.lineTo(px - s * 1.05, py + s * 0.8)
    x.closePath()
    x.fill()
  }
  tri(0)
  tri(Math.PI)
}

/**
 * @param fontsFinal the web fonts were already in when this ran, so the face
 * is final: its canvas is released after the first upload. Otherwise it's
 * released after redraw() (the fonts-ready pass).
 */
export async function buildBenchmark(renderer: THREE.WebGLRenderer, mobile: boolean, fontsFinal = true): Promise<Benchmark> {
  const group = new THREE.Group()
  const spin = new THREE.Group()
  group.add(spin)

  // built in three frame-sized steps (environment, face, mark): no long task on phones
  const env = brassEnvironment(renderer)
  await nextFrame()

  // the engraving: sized to what the face ever covers on screen (≈ 860 device
  // px at 1440×900 @2), smaller on phones
  const FACE_PX = mobile ? 768 : 1024
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = FACE_PX
  drawFace(canvas)
  const faceTex = new THREE.CanvasTexture(canvas)
  faceTex.colorSpace = THREE.SRGBColorSpace
  faceTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  if (fontsFinal) releaseOnUpload(faceTex)

  const brassColor = new THREE.Color('#b59c68')
  const brass = new THREE.MeshStandardMaterial({
    color: brassColor,
    metalness: 0.8,
    roughness: 0.42,
    envMap: env.texture,
    envMapIntensity: 0.9,
  })
  const faceMat = new THREE.MeshStandardMaterial({
    color: brassColor,
    metalness: 0.8,
    roughness: 0.4,
    map: faceTex,
    bumpMap: faceTex,
    bumpScale: 1.4,
    envMap: env.texture,
    envMapIntensity: 1,
  })
  const markMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#c4a86f'),
    metalness: 0.82,
    roughness: 0.34,
    envMap: env.texture,
    envMapIntensity: 0.95,
  })
  for (const m of [brass, faceMat, markMat]) softHighlights(m)

  // the domed face (planar UVs: canvas top = north = -z)
  const face = new THREE.RingGeometry(0, FACE_R, 160, 24)
  const pos = face.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i)) / FACE_R
    pos.setZ(i, FACE_Y + DOME * (1 - r * r))
  }
  face.rotateX(-Math.PI / 2)
  face.computeVertexNormals()
  const faceMesh = new THREE.Mesh(face, faceMat)
  spin.add(faceMesh)

  // the raised rim + skirt
  const rim = new THREE.LatheGeometry(rimProfile(), 160)
  const rimMesh = new THREE.Mesh(rim, brass)
  spin.add(rimMesh)

  await nextFrame()
  // the Hark mark, embossed at the centre (fits inside the inner engraved circle)
  const mg = logoGeometry({ depth: 0.05, bevelSize: 0.01, bevelThickness: 0.014, curveSegments: mobile ? 20 : 28 })
  const mp = mg.attributes.position as THREE.BufferAttribute
  let maxR = 0
  for (let i = 0; i < mp.count; i++) maxR = Math.max(maxR, Math.hypot(mp.getX(i), mp.getY(i)))
  const markScale = (FACE_R * 0.62) / Math.max(0.3, maxR)
  mg.rotateX(-Math.PI / 2)
  mg.scale(markScale, markScale * 0.9, markScale)
  mg.computeBoundingBox()
  const markMesh = new THREE.Mesh(mg, markMat)
  // sits on the dome's crown, its base a hair inside the face
  markMesh.position.y = FACE_Y + DOME - (mg.boundingBox!.min.y) - 0.012
  spin.add(markMesh)

  // the printed contact shadow (flat colour, soft)
  const sc = document.createElement('canvas')
  sc.width = sc.height = 256
  const sx = sc.getContext('2d')!
  const sg = sx.createRadialGradient(128, 128, 0, 128, 128, 128)
  sg.addColorStop(0, 'rgba(60, 40, 20, 0.7)')
  sg.addColorStop(0.62, 'rgba(60, 40, 20, 0.55)')
  sg.addColorStop(0.8, 'rgba(60, 40, 20, 0.16)')
  sg.addColorStop(1, 'rgba(60, 40, 20, 0)')
  sx.fillStyle = sg
  sx.fillRect(0, 0, 256, 256)
  const shadowTex = new THREE.CanvasTexture(sc)
  shadowTex.colorSpace = THREE.SRGBColorSpace
  releaseOnUpload(shadowTex)
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(DISC_R * 1.32, 64),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false, fog: false }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.set(0.1, 0.006, 0.08)
  shadow.renderOrder = 1
  group.add(shadow)

  return {
    group,
    spin,
    brass,
    markMat,
    shadow,
    redraw() {
      // (a released canvas is 1×1: resizing it back also clears it)
      if (canvas.width !== FACE_PX) canvas.width = canvas.height = FACE_PX
      drawFace(canvas)
      faceTex.needsUpdate = true
      releaseOnUpload(faceTex)
    },
    dispose() {
      env.dispose()
      faceTex.dispose()
      shadowTex.dispose()
    },
  }
}

/** Resolve when the rim lettering's face is ready to draw (never rejects). */
export const benchmarkFonts = () => ensureFonts()
