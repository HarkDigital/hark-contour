import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/*
 * Post-processing: Scene (MSAA only here) → Sanitize (NaN guard) → Bloom
 * (off unless a chapter asks) → Output → FINAL.
 *
 * Hark Contour's FINAL pass is the printed chart:
 *  - paper tooth: a static fibre/tooth texture in CSS-pixel space (paper
 *    doesn't shimmer, so it never animates)
 *  - a warm, faint edge darkening like an old chart's margin
 *  - `contour` (0..1): the frame redrawn as the contour lines of its OWN
 *    brightness, in contour-brown ink on paper — chapters can use it as an
 *    effect ("the view becomes a map of itself")
 *  - THE CUT, "contour flood": a drifting relief's elevation bands cover
 *    the frame one layer at a time (each band snaps in whole, so the front
 *    is always a crisp contour line); at the boundary the frame is pure
 *    chart, identical on both sides (a seamless swap); after it the bands
 *    drain away and the next chapter shows through, lowest ground first
 *
 * Keep the Post API (params / resetParams / setSize / render / compileAsync /
 * setFadeTone / cutSide / isFrameTarget) and the uTransition / uFade / uFlash /
 * uGlitch uniforms — the engine drives them.
 */

/** hex → raw sRGB components (the final pass runs after OutputPass, in display space) */
function srgb(hex: string): THREE.Vector3 {
  const n = parseInt(hex.replace('#', ''), 16)
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const PAPER = '#f2ecdf'
const LINE = '#8c5f3d'
const INDEX = '#5e3b22'

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    /** 0..1, peaks exactly at a chapter boundary (engine-driven) */
    uTransition: { value: 0 },
    /** -1 approaching the boundary, +1 after it (engine-driven) */
    uCutSide: { value: 1 },
    /** 0..1 paper shake a chapter can add (sparingly) */
    uGlitch: { value: 0 },
    uGrain: { value: 0.05 },
    uVignette: { value: 0.16 },
    /** 0..1 wash to white paper */
    uFlash: { value: 0 },
    /** 0..1 fade to uFadeColor (reduced-motion cuts, flings) */
    uFade: { value: 0 },
    /** 0..1 the frame as the isolines of its own brightness */
    uContour: { value: 0 },
    /** isolines per unit of brightness */
    uDensity: { value: 11 },
    uPaper: { value: srgb(PAPER) },
    uLineC: { value: srgb(LINE) },
    uIndexC: { value: srgb(INDEX) },
    uFadeColor: { value: srgb(PAPER) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uDpr, uTransition, uCutSide, uGlitch, uGrain, uVignette, uFlash, uFade, uContour, uDensity;
    uniform vec2 uResolution;
    uniform vec3 uPaper, uLineC, uIndexC, uFadeColor;
    varying vec2 vUv;

    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float s = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) {
        s += a * vnoise(p);
        p = p * 2.03 + 17.1;
        a *= 0.5;
      }
      return s;
    }
    float isoLine(float f, float fw, float wpx) {
      float d = abs(fract(f - 0.5) - 0.5) / fw;
      return (1.0 - smoothstep(wpx * 0.5 - 0.5, wpx * 0.5 + 0.5, d)) * (1.0 - smoothstep(0.2, 0.6, fw));
    }

    void main() {
      vec2 uv = vUv;
      float g = clamp(uGlitch, 0.0, 1.0);
      uv += g * 0.003 * vec2(sin(uv.y * 40.0 + uTime * 9.0), cos(uv.x * 30.0 + uTime * 7.0));
      vec3 col = texture2D(tDiffuse, uv).rgb;

      float aspect = uResolution.x / max(uResolution.y, 1.0);
      vec2 q = (vUv - 0.5) * vec2(aspect, 1.0);
      float t = clamp(uTransition, 0.0, 1.0);

      // --- the frame as a map of itself (chapter effect, off by default) ---
      if (uContour > 0.001) {
        float bright = dot(col, vec3(0.299, 0.587, 0.114));
        vec2 r = 13.0 * max(uDpr, 0.5) / uResolution;
        float acc = bright * 2.0;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.7853982;
          acc += dot(texture2D(tDiffuse, vUv + r * vec2(cos(a), sin(a))).rgb, vec3(0.299, 0.587, 0.114));
        }
        float fb = acc / 10.0 * uDensity;
        float lb = isoLine(fb, max(fwidth(fb), 1e-4), 1.1 * max(uDpr, 0.5));
        col = mix(col, mix(uPaper, uLineC, lb * 0.85), clamp(uContour, 0.0, 1.0));
      }

      // --- THE CUT: contour flood ---------------------------------------------
      // A relief R (identical on both sides of the boundary: its drift is 0 at
      // t = 1, and it flows one way through the cut) floods the frame band by
      // band, like layers of a relief model being laid; each band snaps in as
      // a unit, so the front is always a crisp contour line. At the boundary
      // the whole frame is the chart; after it, the bands drain away and the
      // next chapter shows through, lowest ground first.
      float drift = (1.0 - t) * uCutSide * 0.55;
      float R = fbm(q * 2.1 + vec2(drift, drift * 0.45) + 3.7);
      float dens = 9.0;
      float fR = R * dens;
      float fwR = max(fwidth(fR), 1e-4);
      float fR5 = fR / 5.0;
      float fwR5 = max(fwidth(fR5), 1e-4);
      float px = max(uDpr, 0.5);
      float lvl = mix(0.4, 8.8, smoothstep(0.06, 0.88, t));
      float lvlQ = floor(lvl) + smoothstep(0.35, 0.65, fract(lvl));
      float cover = t > 0.001 ? 1.0 - smoothstep(lvlQ - fwR, lvlQ + fwR, fR) : 0.0;
      float ln = isoLine(fR, fwR, 1.1 * px);
      float ix = isoLine(fR5, fwR5, 2.0 * px);
      // the flood front: the band edge, drawn a touch heavier
      float front = (1.0 - smoothstep(0.9 * px, 1.9 * px, abs(fR - lvlQ) / fwR)) * step(0.001, t) * (1.0 - step(8.7, lvlQ));
      vec3 chart = mix(uPaper, uLineC, ln * 0.78);
      chart = mix(chart, uIndexC, max(ix, front));
      col = mix(col, chart, cover);

      // --- paper ------------------------------------------------------------
      vec2 cp = gl_FragCoord.xy / px; // CSS px: the tooth has a physical size
      float tooth = vnoise(cp * 0.85) * 0.55 + vnoise(cp * 0.21 + 11.0) * 0.3 + vnoise(vec2(cp.x * 0.035, cp.y * 0.6) + 5.0) * 0.15;
      col *= 1.0 + (tooth - 0.5) * uGrain;

      // warm margin
      float v = smoothstep(0.55, 1.35, length((vUv - 0.5) * 2.0 * vec2(1.0, 0.9)));
      col = mix(col, col * vec3(0.9, 0.84, 0.76), v * uVignette);

      col = mix(col, vec3(1.0, 0.996, 0.98), clamp(uFlash, 0.0, 1.0));
      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

/** minimum seconds between two white-flash onsets (WCAG 2.3.1) */
const FLASH_GAP = 0.4

export type PostParams = {
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  /** kept for API parity; the printed look has none */
  aberration: number
  /** paper tooth 0..~0.12 */
  grain: number
  /** warm margin 0..1 */
  vignette: number
  /** paper shake 0..1 */
  glitch: number
  /** wash to white 0..1 */
  flash: number
  exposure: number
  /** 0..1 the frame as the isolines of its own brightness */
  contour: number
  /** isolines per unit brightness for `contour` (and the cut) */
  density: number
}

/** Printed colours sit below 1.0, so bloom is OFF unless a chapter asks for it. */
export const POST_DEFAULTS: PostParams = {
  bloomStrength: 0,
  bloomRadius: 0.4,
  bloomThreshold: 1.0,
  aberration: 0,
  grain: 0.05,
  vignette: 0.16,
  glitch: 0,
  flash: 0,
  exposure: 1,
  contour: 0,
  density: 11,
}

/**
 * Scrubs NaN/Inf and clamps runaway HDR right after the scene render. A single
 * bad fragment would otherwise smear across the whole frame through bloom.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), c.a);
    }
  `,
}

/**
 * Renders the scene into its own target (the only multisampled one) and
 * copies it through the NaN guard into the composer's read buffer.
 */
class ScenePass extends Pass {
  target: THREE.WebGLRenderTarget
  material: THREE.ShaderMaterial
  private quad: FullScreenQuad

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    w: number,
    h: number,
    samples: number,
  ) {
    super()
    this.needsSwap = false
    this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples })
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SanitizeShader.uniforms),
      vertexShader: SanitizeShader.vertexShader,
      fragmentShader: SanitizeShader.fragmentShader,
    })
    this.quad = new FullScreenQuad(this.material)
  }

  setSamples(n: number) {
    if (this.target.samples === n) return
    this.target.samples = n
    this.target.dispose() // re-created with the new sample count on next use
  }

  setSize(w: number, h: number) {
    this.target.setSize(w, h)
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    this.material.uniforms.tDiffuse.value = this.target.texture
    renderer.setRenderTarget(read)
    this.quad.render(renderer)
  }

  dispose() {
    this.target.dispose()
    this.material.dispose()
    this.quad.dispose()
  }
}

export class Post {
  composer: EffectComposer
  scenePass: ScenePass
  bloom: UnrealBloomPass
  final: ShaderPass
  /**
   * Chapters write targets here every frame (the engine resets them to
   * defaults first); values are damped so nothing pops at a cut.
   */
  params: PostParams = { ...POST_DEFAULTS }
  private current: PostParams = { ...POST_DEFAULTS }
  transition = 0
  /** -1 while approaching a chapter boundary, +1 after it (engine-driven) */
  cutSide = 1
  fade = 0
  private lastFlashAt = -1e9
  private flashLive = false
  private flashOk = true

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    // single-sampled ping-pong targets (the composer clones this one)
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType })
    this.composer = new EffectComposer(renderer, rt)
    this.scenePass = new ScenePass(scene, camera, size.x, size.y, Post.samplesFor(renderer.getPixelRatio()))
    this.composer.addPass(this.scenePass)
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0, 0.4, 1.0)
    this.bloom.enabled = false
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.final = new ShaderPass(FinalShader)
    this.composer.addPass(this.final)
  }

  /** Colour of the calm (reduced-motion / Motion off) fade: the paper. */
  setCutColor(color: string) {
    ;(this.final.uniforms.uFadeColor.value as THREE.Vector3).copy(srgb(color))
  }

  /** Engine hook (kept for compatibility; themes may tint the fade by scene tone). */
  setFadeTone(_tone: number) {}

  resetParams() {
    Object.assign(this.params, POST_DEFAULTS)
  }

  /**
   * Compile every post-processing shader in parallel so the first composer
   * render doesn't block on synchronous links.
   */
  compileAsync(): Promise<unknown> {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const b = this.bloom as unknown as Record<string, unknown>
    const mats: THREE.Material[] = []
    const add = (m: unknown) => {
      if (m && (m as THREE.Material).isMaterial) mats.push(m as THREE.Material)
    }
    for (const pass of this.composer.passes) add((pass as unknown as { material?: unknown }).material)
    for (const m of (b.separableBlurMaterials as unknown[]) ?? []) add(m)
    add(b.compositeMaterial)
    add(b.blendMaterial)
    add(b.materialHighPassFilter)
    add(b.copyMaterial)
    return Promise.all(mats.map(m => this.renderer.compileAsync(new THREE.Mesh(quad.geometry, m), cam).catch(() => {})))
  }

  /**
   * True for targets that hold the FRAME (the scene target and the composer's
   * ping-pong targets). Materials that draw differently into an offscreen
   * pass test with this.
   */
  isFrameTarget(rt: THREE.WebGLRenderTarget | null) {
    return rt === this.scenePass.target || rt === this.composer.renderTarget1 || rt === this.composer.renderTarget2
  }

  /** 4x MSAA on the scene render unless the frame is already supersampled */
  static samplesFor(dpr: number) {
    return dpr < 1.75 ? 4 : 0
  }

  setSize(w: number, h: number, dpr: number) {
    this.scenePass.setSamples(Post.samplesFor(dpr))
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloom.resolution.set((w * dpr) / 2, (h * dpr) / 2)
    this.final.uniforms.uResolution.value.set(w * dpr, h * dpr)
    this.final.uniforms.uDpr.value = dpr
  }

  render(dt: number, time: number) {
    const k = 1 - Math.exp(-6 * dt)
    const c = this.current
    const p = this.params
    for (const key of Object.keys(p) as (keyof PostParams)[]) {
      // flash & glitch respond instantly so chapters can punch them
      c[key] = key === 'flash' || key === 'glitch' ? p[key] : c[key] + (p[key] - c[key]) * k
    }
    // flash budget (WCAG 2.3.1): a flash starting within FLASH_GAP of the last is dropped
    if (c.flash > 0.02) {
      if (!this.flashLive) {
        this.flashLive = true
        this.flashOk = time - this.lastFlashAt >= FLASH_GAP
        if (this.flashOk) this.lastFlashAt = time
      }
      if (!this.flashOk) c.flash = 0
    } else this.flashLive = false
    // a pass that adds nothing costs nothing
    this.bloom.enabled = c.bloomStrength > 0.01
    this.bloom.strength = c.bloomStrength
    this.bloom.radius = c.bloomRadius
    this.bloom.threshold = c.bloomThreshold
    this.renderer.toneMappingExposure = c.exposure
    const u = this.final.uniforms
    u.uTime.value = time
    u.uTransition.value = this.transition
    u.uCutSide.value = this.cutSide
    u.uGlitch.value = c.glitch
    u.uGrain.value = c.grain
    u.uVignette.value = c.vignette
    u.uFlash.value = c.flash
    u.uContour.value = c.contour
    u.uDensity.value = c.density
    u.uFade.value = this.fade
    this.composer.render(dt)
  }
}
