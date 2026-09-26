import * as THREE from 'three'
import { SERVICES } from '../../content'
import { C, labelTexture, ensureFonts, type LabelOptions } from '../../kit/chart'
import type { World } from '../../world/World'
import type { Summit } from './range'
import { ATLAS_COLS, ATLAS_ROWS, signAtlas } from './icons'

/*
 * The panorama-board lettering on the range: every summit carries a survey
 * benchmark (a vermilion ▲ with a paper knockout dot), a hairline leader
 * rising off it, and its name 'NN · SERVICE TITLE' over a decorative
 * elevation, lettered in Overpass caps with a paper halo (the kit's
 * labelTexture). The ACTIVE summit's leader grows taller and turns
 * vermilion, its ▲ swells, and a little legend-key SIGN carrying the
 * service's map symbol rises on the leader's top, the name moving beside it
 * in vermilion.
 *
 * Everything here is a SCREEN-SPACE quad anchored to a world point: the
 * vertex shader projects the anchor and places the quad in device pixels,
 * snapped to the pixel grid. Lettering is drawn at its NATIVE size for this
 * screen (a small set for idle names, a large set for the active one,
 * crossfaded as a summit becomes active), so every name prints 1:1 — crisp
 * like ink, never a minified texture.
 *
 * ▲ and leaders depth-test against the land (pulled a little toward the
 * camera so their own summit never clips them); lettering and signs draw on
 * top of everything, like ink on the chart.
 */

/** lettering sizes, CSS px (small = idle, large = active) */
export const FONT = {
  titleS: 11,
  titleL: 15,
  numS: 11.5,
  numL: 14,
  elevS: 9.5,
  elevL: 11,
}

const VERT = /* glsl */ `
  uniform vec3 uAnchor;
  uniform vec2 uSize;
  uniform vec2 uOffset;
  uniform vec2 uPivot;
  uniform vec2 uRes;
  uniform float uPull, uDpr, uSnap;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 a = uAnchor + (cameraPosition - uAnchor) * uPull;
    vec4 clip = projectionMatrix * viewMatrix * vec4(a, 1.0);
    if (clip.w <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float dpr = max(uDpr, 0.5);
    vec2 res = uRes * dpr;
    vec2 anchorPx = (clip.xy / clip.w * 0.5 + 0.5) * res;
    vec2 corner = anchorPx + (uOffset - uPivot * uSize) * dpr;
    corner = mix(corner, floor(corner + 0.5), uSnap);
    vec2 p = corner + uv * uSize * dpr;
    gl_Position = vec4((p / res * 2.0 - 1.0) * clip.w, clip.z, clip.w);
  }
`

const LABEL_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity, uReveal, uAccent;
  uniform vec3 uAccentC;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    // lettered in, left to right (a soft pen edge)
    float r = uReveal * 1.12;
    float rv = 1.0 - smoothstep(r - 0.12, r, vUv.x);
    // the active name is re-inked in survey vermilion (the paper halo stays paper)
    float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    float ink = 1.0 - smoothstep(0.03, 0.6, lum);
    vec3 col = mix(c.rgb, uAccentC, ink * uAccent);
    float a = c.a * uOpacity * rv;
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`

const TRI_FRAG = /* glsl */ `
  uniform vec3 uFill, uHalo;
  uniform float uOpacity, uSizePx, uDpr;
  varying vec2 vUv;
  float sdTri(vec2 p) {
    const float k = 1.7320508;
    p.x = abs(p.x) - 1.0;
    p.y = p.y + 1.0 / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0, 0.0);
    return -length(p) * sign(p.y);
  }
  void main() {
    // the quad spans 3.2 triangle units; the triangle is 2 units wide
    vec2 p = (vUv - 0.5) * 3.2;
    float unitPx = uSizePx / 3.2;
    float aa = 0.75 / (unitPx * max(uDpr, 0.5));
    float d = sdTri(p);
    float fill = 1.0 - smoothstep(-aa, aa, d);
    float halo = 1.0 - smoothstep(-aa, aa, d - 2.0 / unitPx);
    float dotM = 1.0 - smoothstep(0.2 - aa, 0.2 + aa, length(p - vec2(0.0, -0.05)));
    vec3 col = mix(uHalo, uFill, fill);
    col = mix(col, uHalo, dotM * fill);
    float a = max(fill, halo * 0.92) * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
  }
`

const LEADER_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity, uWidth, uDpr;
  uniform vec2 uSize;
  varying vec2 vUv;
  void main() {
    float x = abs(vUv.x - 0.5) * uSize.x;
    float e = 0.5 / max(uDpr, 0.5);
    float a = 1.0 - smoothstep(uWidth * 0.5 - e, uWidth * 0.5 + e, x);
    a *= uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`

const SIGN_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec2 uCell;
  uniform vec2 uCellSize;
  uniform float uGrow, uOpacity;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, uCell + vUv * uCellSize);
    // rises out of the leader: revealed bottom → top
    float r = uGrow * 1.1;
    float rv = 1.0 - smoothstep(r - 0.1, r, vUv.y);
    float a = c.a * uOpacity * rv;
    if (a < 0.004) discard;
    gl_FragColor = vec4(c.rgb, a);
  }
`

type U<T> = { value: T }

interface QuadUniforms {
  [k: string]: THREE.IUniform
  uAnchor: U<THREE.Vector3>
  uSize: U<THREE.Vector2>
  uOffset: U<THREE.Vector2>
  uPivot: U<THREE.Vector2>
  uRes: U<THREE.Vector2>
  uPull: U<number>
  uDpr: U<number>
  uSnap: U<number>
  uOpacity: U<number>
}

const SHARED_GEO = new THREE.PlaneGeometry(1, 1)

function quad(
  frag: string,
  extra: Record<string, THREE.IUniform>,
  res: U<THREE.Vector2>,
  dpr: U<number>,
  depthTest: boolean,
  order: number,
) {
  const uniforms = {
    uAnchor: { value: new THREE.Vector3() },
    uSize: { value: new THREE.Vector2(10, 10) },
    uOffset: { value: new THREE.Vector2() },
    uPivot: { value: new THREE.Vector2(0.5, 0.5) },
    uRes: res,
    uPull: { value: 0 },
    uDpr: dpr,
    uSnap: { value: 0 },
    uOpacity: { value: 1 },
    ...extra,
  } as QuadUniforms
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest,
    toneMapped: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(SHARED_GEO, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = order
  mesh.visible = false
  return { mesh, u: uniforms }
}

interface Label {
  mesh: THREE.Mesh
  u: QuadUniforms & {
    uReveal: U<number>
    uAccent: U<number>
    uMap: U<THREE.Texture>
  }
  /** native quad size, CSS px */
  w: number
  h: number
  /** halo pad on each side, CSS px */
  pad: number
  /** the font px it was drawn for */
  font: number
}

/** a small/large pair of the same words, crossfaded by the active amount */
interface Pair {
  s: Label
  l: Label
}

export interface Pin {
  summit: Summit
  tri: { mesh: THREE.Mesh; u: QuadUniforms & { uSizePx: U<number> } }
  leader: {
    mesh: THREE.Mesh
    u: QuadUniforms & { uColor: U<THREE.Color>; uWidth: U<number> }
  }
  sign: { mesh: THREE.Mesh; u: QuadUniforms & { uGrow: U<number> } }
  title: Pair | null
  num: Pair | null
  elev: Pair | null
}

/** What the chapter decides for one summit each frame (CSS px, y up from the summit). */
export interface PinLayout {
  /** the summit's screen point is in front of the camera */
  ok: boolean
  /** 0..1: this summit is the active one */
  g: number
  /** leader length (px) */
  lead: number
  /** ▲ width (px) */
  tri: number
  /** sign size (px) */
  sign: number
  /** 0..1 lettered in */
  reveal: number
  /** marks (▲ + leader) opacity, and the lettering's own opacity */
  alpha: number
  textAlpha: number
  /** full names (true) or numbers only */
  full: boolean
  /** +1 name right of the sign, -1 left of it */
  side: number
  /** horizontal nudge for idle names near the screen edge */
  nudge: number
  /** idle name alignment on its leader: 0.5 centred over it, 0 flag to the right, 1 flag to the left */
  align: number
  /** 0..1 the elevation line under the name (off where the sheet is crowded) */
  elev: number
}

/** The lettering block's screen box (CSS px, y up from the summit), for decluttering. */
export interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** gap between a leader and a name flagged beside it (px) */
const FLAG = 6

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export class Annotations {
  group = new THREE.Group()
  pins: Pin[] = []
  /** the pixel ratio the lettering was drawn for */
  letteredDpr = 0
  private res: U<THREE.Vector2> = { value: new THREE.Vector2(1440, 900) }
  private dpr: U<number>
  private atlas: THREE.CanvasTexture
  private signalC = new THREE.Color(C.signal)
  private leaderInk = new THREE.Color(C.inkSoft)
  private busy = false

  constructor(summits: Summit[], world: World) {
    this.dpr = world.chart.uDpr
    this.atlas = signAtlas()
    const cw = 1 / ATLAS_COLS
    const ch = 1 / ATLAS_ROWS
    for (const s of summits) {
      const tri = quad(
        TRI_FRAG,
        {
          uFill: { value: new THREE.Color(C.signal) },
          uHalo: { value: new THREE.Color(C.paper) },
          uSizePx: { value: 16 },
        },
        this.res,
        this.dpr,
        true,
        6,
      )
      const leader = quad(
        LEADER_FRAG,
        {
          uColor: { value: new THREE.Color(C.inkSoft) },
          uWidth: { value: 1.2 },
        },
        this.res,
        this.dpr,
        true,
        5,
      )
      const col = s.index % ATLAS_COLS
      const row = Math.floor(s.index / ATLAS_COLS)
      const sign = quad(
        SIGN_FRAG,
        {
          uMap: { value: this.atlas },
          uCell: { value: new THREE.Vector2(col * cw, 1 - (row + 1) * ch) },
          uCellSize: { value: new THREE.Vector2(cw, ch) },
          uGrow: { value: 0 },
        },
        this.res,
        this.dpr,
        false,
        8,
      )
      tri.u.uPull.value = 0.035
      leader.u.uPull.value = 0.03
      tri.u.uPivot.value.set(0.5, 0.5)
      leader.u.uPivot.value.set(0.5, 0)
      sign.u.uPivot.value.set(0.5, 0)
      this.group.add(tri.mesh, leader.mesh, sign.mesh)
      this.pins.push({
        summit: s,
        tri: tri as unknown as Pin['tri'],
        leader: leader as unknown as Pin['leader'],
        sign: sign as unknown as Pin['sign'],
        title: null,
        num: null,
        elev: null,
      })
    }
  }

  /** Draw the lettering at this screen's pixel ratio (after the web fonts are in). */
  async letter(dpr: number) {
    if (this.busy) return
    this.busy = true
    try {
      await ensureFonts()
      const k = Math.max(1, Math.min(3, dpr))
      this.letteredDpr = k
      const make = (text: string, font: number, o: LabelOptions): Label => {
        // labelTexture draws glyphs at size × 2 canvas px: size = font × dpr / 2 prints 1:1
        const size = (font * k) / 2
        const { texture } = labelTexture(text, { ...o, size })
        texture.generateMipmaps = false
        texture.minFilter = THREE.LinearFilter
        texture.magFilter = THREE.LinearFilter
        texture.anisotropy = 1
        const q = quad(
          LABEL_FRAG,
          {
            uMap: { value: texture },
            uReveal: { value: 1 },
            uAccent: { value: 0 },
            uAccentC: { value: new THREE.Color(C.signalText) },
          },
          this.res,
          this.dpr,
          false,
          9,
        )
        q.u.uSnap.value = 1
        this.group.add(q.mesh)
        const img = texture.image as HTMLCanvasElement
        const glyph = size * 2
        const hw = (o.haloWidth ?? 0.22) * glyph
        const pad = Math.ceil(hw + glyph * 0.2)
        return {
          mesh: q.mesh,
          u: q.u as Label['u'],
          w: img.width / k,
          h: img.height / k,
          pad: pad / k,
          font,
        }
      }
      const drop = (p: Pair | null) => {
        if (!p) return
        for (const l of [p.s, p.l]) {
          this.group.remove(l.mesh)
          l.u.uMap.value.dispose()
          ;(l.mesh.material as THREE.ShaderMaterial).dispose()
        }
      }
      const titleO: LabelOptions = {
        font: 'sans',
        weight: 700,
        tracking: 0.13,
        uppercase: true,
        color: C.ink,
        haloWidth: 0.3,
      }
      const numO: LabelOptions = {
        font: 'sans',
        weight: 700,
        tracking: 0.06,
        color: C.ink,
        haloWidth: 0.3,
      }
      const elevO: LabelOptions = {
        font: 'mono',
        weight: 500,
        tracking: 0.02,
        color: C.inkSoft,
        haloWidth: 0.3,
      }
      for (const p of this.pins) {
        const s = SERVICES[p.summit.index]
        drop(p.title)
        drop(p.num)
        drop(p.elev)
        const title = `${s.num} · ${s.title}`
        p.title = {
          s: make(title, FONT.titleS, titleO),
          l: make(title, FONT.titleL, titleO),
        }
        p.num = {
          s: make(s.num, FONT.numS, numO),
          l: make(s.num, FONT.numL, numO),
        }
        const elev = `${p.summit.elev} m`
        p.elev = {
          s: make(elev, FONT.elevS, elevO),
          l: make(elev, FONT.elevL, elevO),
        }
      }
    } finally {
      this.busy = false
    }
  }

  setViewport(w: number, h: number) {
    this.res.value.set(Math.max(1, w), Math.max(1, h))
  }

  /** the lettering width (px, without the halo pad) of a name at the active amount g */
  nameWidth(p: Pin, full: boolean, g: number) {
    const pair = full ? p.title : p.num
    if (!pair) return 0
    const k = lerp(1, pair.l.font / pair.s.font, g)
    return (pair.s.w - 2 * pair.s.pad) * k
  }

  /** The lettering block's box for this layout (y up from the summit, x from it). */
  box(p: Pin, L: PinLayout, out: Box): Box {
    const g = L.g
    const nameW = this.nameWidth(p, L.full, g)
    const elevW = p.elev && L.elev > 0.5 ? (p.elev.s.w - 2 * p.elev.s.pad) * lerp(1, p.elev.l.font / p.elev.s.font, g) : 0
    const w = Math.max(nameW, elevW)
    const fontN = lerp(L.full ? FONT.titleS : FONT.numS, L.full ? FONT.titleL : FONT.numL, g)
    const fontE = lerp(FONT.elevS, FONT.elevL, g)
    const y = this.stackY(L, fontN, fontE)
    const signHalf = L.sign * 0.5 + 10
    if (L.elev <= 0.5) y.eIdle = y.nIdle = L.lead + 4 + fontN * 0.62
    // idle: over / beside the leader; active: beside the sign
    const xIdle0 = L.nudge + (0.5 - L.align) * 2 * FLAG - L.align * w
    const xAct0 = L.side > 0 ? signHalf : -signHalf - w
    out.x0 = lerp(xIdle0, xAct0, g)
    out.x1 = out.x0 + w
    out.y0 = lerp(y.eIdle, y.eAct, g) - fontE * 0.45
    out.y1 = lerp(y.nIdle, y.nAct, g) + fontN * 0.45
    if (g > 0.05) {
      out.x0 = Math.min(out.x0, -L.sign * 0.64)
      out.x1 = Math.max(out.x1, L.sign * 0.64)
    }
    return out
  }

  /** the stack's line heights (reused scratch: no per-frame allocation) */
  private sy = { eIdle: 0, nIdle: 0, nAct: 0, eAct: 0 }
  private stackY(L: PinLayout, fontN: number, fontE: number) {
    const y = this.sy
    y.eIdle = L.lead + 4 + fontE * 0.6
    y.nIdle = y.eIdle + fontE * 0.6 + 3 + fontN * 0.62
    y.nAct = L.lead + L.sign * 0.66
    y.eAct = L.lead + L.sign * 0.3
    return y
  }

  /** one lettering quad of a small/large pair */
  private place(
    lab: Label,
    wgt: number,
    font: number,
    yIdle: number,
    yAct: number,
    accent: number,
    a: number,
    s: Summit,
    ay: number,
    L: PinLayout,
    on: boolean,
    pivotX: number,
  ) {
    const show = on && wgt * a > 0.004
    lab.mesh.visible = show
    if (!show) return
    const g = L.g
    const k = font / lab.font
    lab.u.uAnchor.value.set(s.x, ay, s.z)
    lab.u.uSize.value.set(lab.w * k, lab.h * k)
    // the halo pad is compensated so the LETTERS (not the quad) meet the leader / sign
    const xAct = L.side * (L.sign * 0.5 + 10 - lab.pad * k)
    const xIdle = L.nudge + (0.5 - L.align) * 2 * (FLAG - lab.pad * k)
    lab.u.uPivot.value.set(pivotX, 0.5)
    lab.u.uOffset.value.set(lerp(xIdle, xAct, g), lerp(yIdle, yAct, g))
    lab.u.uReveal.value = L.reveal
    lab.u.uAccent.value = accent
    lab.u.uOpacity.value = L.textAlpha * wgt * a
    // snap only at rest (a crossfading pair is scaled, not native)
    lab.u.uSnap.value = g < 0.001 || g > 0.999 ? 1 : 0
  }

  /** Place one summit's pin for this frame. */
  layout(p: Pin, L: PinLayout, lift: number) {
    const s = p.summit
    const ay = s.h * lift
    const g = L.g
    const vis = L.ok && L.alpha > 0.003
    // ▲
    const tri = p.tri
    tri.mesh.visible = vis
    tri.u.uAnchor.value.set(s.x, ay, s.z)
    tri.u.uSizePx.value = L.tri * 1.6
    tri.u.uSize.value.set(L.tri * 1.6, L.tri * 1.6)
    tri.u.uOffset.value.set(0, L.tri * 0.12)
    tri.u.uOpacity.value = L.alpha
    // leader: from just over the ▲ to the lettering
    const y0 = L.tri * 0.72
    const leadLen = Math.max(0, L.lead - y0)
    const ld = p.leader
    ld.mesh.visible = vis && leadLen > 0.5
    ld.u.uAnchor.value.set(s.x, ay, s.z)
    ld.u.uSize.value.set(4, leadLen)
    ld.u.uOffset.value.set(0, y0)
    ld.u.uColor.value.copy(this.leaderInk).lerp(this.signalC, g)
    ld.u.uOpacity.value = L.alpha * lerp(0.8, 1, g)
    ld.u.uWidth.value = 1.1 + 0.5 * g

    // the sign sits on the leader's top
    const sg = p.sign
    const S = L.sign
    sg.mesh.visible = vis && g > 0.01 && S > 1
    sg.u.uAnchor.value.set(s.x, ay, s.z)
    sg.u.uSize.value.set(S * 1.28, S * 1.28)
    sg.u.uOffset.value.set(0, L.lead - S * 0.12)
    sg.u.uGrow.value = g
    sg.u.uOpacity.value = L.alpha * Math.min(1, g * 1.6)

    // lettering: centred over the leader (idle) → beside the sign (active)
    const name = L.full ? p.title : p.num
    const other = L.full ? p.num : p.title
    if (other) {
      other.s.mesh.visible = false
      other.l.mesh.visible = false
    }
    const fontN = lerp(L.full ? FONT.titleS : FONT.numS, L.full ? FONT.titleL : FONT.numL, g)
    const fontE = lerp(FONT.elevS, FONT.elevL, g)
    const y = this.stackY(L, fontN, fontE)
    // without its elevation line the name drops onto the leader
    const yN = lerp(L.lead + 4 + fontN * 0.62, y.nIdle, L.elev)
    const on = vis && L.reveal > 0.001 && L.textAlpha > 0.003
    const cross = sstep(0.3, 0.7, g)
    const pivotX = lerp(L.align, L.side > 0 ? 0 : 1, g)
    if (name) {
      this.place(name.s, 1 - cross, fontN, yN, y.nAct, g, 1, s, ay, L, on, pivotX)
      this.place(name.l, cross, fontN, yN, y.nAct, g, 1, s, ay, L, on, pivotX)
    }
    const ea = Math.max(L.elev, g)
    if (p.elev) {
      this.place(p.elev.s, 1 - cross, fontE, y.eIdle, y.eAct, 0, ea, s, ay, L, on, pivotX)
      this.place(p.elev.l, cross, fontE, y.eIdle, y.eAct, 0, ea, s, ay, L, on, pivotX)
    }
  }
}
