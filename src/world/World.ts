import * as THREE from 'three'
import type { Frame } from '../core/types'

/*
 * The shared world of Hark Contour: the CHART PAPER everything is printed on.
 *
 *  - a camera-centred dome in paper tones: the horizon is blank paper, so any
 *    land seen obliquely dissolves into the chart's margin, never into a sky
 *  - scene.fog toward the same paper colour (built-in materials) and the
 *    matching shared uniforms for the chart shader (src/kit/chart.ts)
 *  - the HILLSHADE light (`sun`): cartographic convention, from the upper
 *    left / north-west; every chart material shades its relief with it
 *  - a soft key + hemisphere fill for real 3D props (markers, the benchmark,
 *    layered models). Lights are never toggled, only their intensity moves.
 *
 * Chapters set world.params every frame they care (the engine resets them to
 * defaults first); values are damped so cuts never pop.
 *
 *   ctx.world.params.fogNear = 18; ctx.world.params.fogFar = 60
 *   ctx.world.params.sun.set(-1, 1.1, -0.8)
 *   const mat = chartMaterial(ctx.world, {...})   // picks up world.chart
 */

export interface WorldParams {
  /** the chart paper: horizon, fog and the colour distant land fades into */
  paper: THREE.ColorRepresentation
  /** dome zenith (a touch deeper than the paper) */
  sky: THREE.ColorRepresentation
  /** fog distances from the camera (world units) */
  fogNear: number
  fogFar: number
  /** hillshade light direction (FROM), used by every chart material */
  sun: THREE.Vector3
  /** key light for 3D props: direction it comes FROM, and strength */
  keyDir: THREE.Vector3
  key: number
  /** hemisphere fill strength */
  fill: number
}

export const WORLD_DEFAULTS = {
  paper: '#f2ecdf',
  sky: '#ebe3d1',
  fogNear: 26,
  fogFar: 120,
  key: 2.2,
  fill: 1.35,
}

/** Uniforms every chart material shares by reference (updated once per frame here). */
export interface ChartShared {
  uTime: { value: number }
  uSun: { value: THREE.Vector3 }
  uPaper: { value: THREE.Color }
  uFogNear: { value: number }
  uFogFar: { value: number }
  /** device pixels per CSS pixel of the frame being drawn (line widths are in CSS px) */
  uDpr: { value: number }
}

export class World {
  /** the live world (set by the engine's constructor); prefer ctx.world in chapters */
  static current: World | null = null
  object = new THREE.Group()
  key: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  fog: THREE.Fog
  params: WorldParams = {
    ...WORLD_DEFAULTS,
    sun: new THREE.Vector3(-1, 1.25, -0.9),
    keyDir: new THREE.Vector3(-0.6, 0.9, 0.45),
  }
  /** shared chart-shader uniforms (src/kit/chart.ts reads these) */
  chart: ChartShared = {
    uTime: { value: 0 },
    uSun: { value: new THREE.Vector3(-1, 1.25, -0.9).normalize() },
    uPaper: { value: new THREE.Color(WORLD_DEFAULTS.paper) },
    uFogNear: { value: WORLD_DEFAULTS.fogNear },
    uFogFar: { value: WORLD_DEFAULTS.fogFar },
    uDpr: { value: 1 },
  }
  private cur = {
    paper: new THREE.Color(),
    sky: new THREE.Color(),
    fogNear: WORLD_DEFAULTS.fogNear,
    fogFar: WORLD_DEFAULTS.fogFar,
    sun: new THREE.Vector3(),
    key: WORLD_DEFAULTS.key,
    fill: WORLD_DEFAULTS.fill,
  }
  private first = true
  private uniforms = { uPaper: { value: new THREE.Color() }, uSky: { value: new THREE.Color() } }
  private tmpA = new THREE.Color()
  private tmpB = new THREE.Color()
  private tmpV = new THREE.Vector3()

  constructor(
    scene: THREE.Scene,
    _mobile: boolean,
    private renderer?: THREE.WebGLRenderer,
  ) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: false,
        fog: false,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uPaper, uSky;
          varying vec3 vDir;
          float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          void main() {
            float h = normalize(vDir).y;
            vec3 c = mix(uPaper, uSky, smoothstep(0.08, 0.9, h));
            c += (hash(gl_FragCoord.xy) - 0.5) / 255.0; // dither: no banding
            gl_FragColor = vec4(c, 1.0);
          }
        `,
      }),
    )
    dome.frustumCulled = false
    dome.renderOrder = -10
    this.object.add(dome)

    World.current = this
    // the kit's terrain builder checks float-texture filtering support
    ;(globalThis as { __harkRenderer?: THREE.WebGLRenderer }).__harkRenderer = renderer
    this.fog = new THREE.Fog(WORLD_DEFAULTS.paper, WORLD_DEFAULTS.fogNear, WORLD_DEFAULTS.fogFar)
    scene.fog = this.fog

    this.key = new THREE.DirectionalLight(0xfff6e8, WORLD_DEFAULTS.key)
    scene.add(this.key)
    scene.add(this.key.target)
    this.hemi = new THREE.HemisphereLight(0xfbf6ec, 0xb9a88c, WORLD_DEFAULTS.fill)
    scene.add(this.hemi)
  }

  resetParams() {
    const p = this.params
    p.paper = WORLD_DEFAULTS.paper
    p.sky = WORLD_DEFAULTS.sky
    p.fogNear = WORLD_DEFAULTS.fogNear
    p.fogFar = WORLD_DEFAULTS.fogFar
    p.key = WORLD_DEFAULTS.key
    p.fill = WORLD_DEFAULTS.fill
    p.sun.set(-1, 1.25, -0.9)
    p.keyDir.set(-0.6, 0.9, 0.45)
  }

  update(frame: Frame, camera: THREE.Camera) {
    const p = this.params
    const c = this.cur
    this.tmpA.set(p.paper)
    this.tmpB.set(p.sky)
    this.tmpV.copy(p.sun).normalize()
    if (this.first) {
      c.paper.copy(this.tmpA)
      c.sky.copy(this.tmpB)
      c.fogNear = p.fogNear
      c.fogFar = p.fogFar
      c.sun.copy(this.tmpV)
      c.key = p.key
      c.fill = p.fill
      this.first = false
    }
    const k = 1 - Math.exp(-5 * frame.dt)
    c.paper.lerp(this.tmpA, k)
    c.sky.lerp(this.tmpB, k)
    c.fogNear += (p.fogNear - c.fogNear) * k
    c.fogFar += (p.fogFar - c.fogFar) * k
    c.sun.lerp(this.tmpV, k).normalize()
    c.key += (p.key - c.key) * k
    c.fill += (p.fill - c.fill) * k

    this.uniforms.uPaper.value.copy(c.paper)
    this.uniforms.uSky.value.copy(c.sky)
    this.fog.color.copy(c.paper)
    this.fog.near = c.fogNear
    this.fog.far = c.fogFar

    const s = this.chart
    s.uTime.value = frame.time
    s.uSun.value.copy(c.sun)
    s.uPaper.value.copy(c.paper)
    s.uFogNear.value = c.fogNear
    s.uFogFar.value = c.fogFar
    s.uDpr.value = this.renderer ? this.renderer.getPixelRatio() : 1

    this.key.intensity = c.key
    this.key.position.copy(camera.position).addScaledVector(this.tmpV.copy(p.keyDir).normalize(), 50)
    this.key.target.position.copy(camera.position)
    this.key.target.updateMatrixWorld()
    this.hemi.intensity = c.fill
    this.object.position.copy(camera.position)
  }
}
