import * as THREE from 'three'
import type { Chapter } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { ease, segment, smoothstep } from '../../core/math'
import { chartMaterial } from '../../kit/chart'
import { terrainGeometry, heightRange } from '../../kit/terrain'
import { markField } from '../../kit/markField'
import { simplex2, ridged, fbm } from '../../kit/noise'
import type { ChartMaterial } from '../../kit/chart'
import '../chapter.css'

/*
 * HERO (placeholder). Pattern: an intro beat with the manifesto + scroll hint,
 * a middle beat for the signature animation, and a payoff with the tagline
 * and two CTAs (land('work') / land('contact')). Replace the scene entirely.
 */
export default function create(): Chapter {
  const group = new THREE.Group()
  // FOUNDATION DEMO (the hero agent replaces this): the mark as an island
  const S = 9
  let mat: ChartMaterial
  let intro: HTMLElement
  let payoff: HTMLElement
  let title: HTMLElement
  return {
    id: 'hero',
    group,
    anchors: [0.8],
    init(ctx) {
      const mf = markField()
      const n = simplex2(3)
      const height = (x: number, z: number) => {
        const d = mf.sdf(x / S, -z / S) * S
        if (d < 0) {
          const u = Math.min(1, -d / 0.9)
          return 2.2 * (1 - (1 - u) * (1 - u)) + ridged(n, x * 0.35, z * 0.35, 4) * u * 0.9 + 0.02
        }
        return -1.1 * (1 - Math.exp(-d / 1.4)) + fbm(n, x * 0.2, z * 0.2, 3) * 0.12 * Math.min(1, d)
      }
      const geo = terrainGeometry({ width: 34, depth: 26, seg: ctx.mobile ? 150 : 220, height })
      const { hMin, hMax } = heightRange(geo)
      mat = chartMaterial(ctx.world, { terrain: geo, hMin: 0, hMax, interval: 0.14, waterSpacing: 0.09, waterLines: 7, lift: 0 })
      void hMin
      group.add(new THREE.Mesh(geo, mat))
      intro = el('div', 'ph-copy', undefined, ctx.stage)
      el('p', 'hud-eyebrow', MICROCOPY.signalEyebrow, intro)
      el('p', 'hud-body', BRAND.manifesto, intro)
      el('p', 'hud-label', MICROCOPY.scrollHint + ' ↓', intro)
      payoff = el('div', 'ph-copy', undefined, ctx.stage)
      title = rise(el('h1', 'hud-title', undefined, payoff), 'Make the internet <em>listen.</em>')
      const ctas = el('div', 'ph-ctas', undefined, payoff)
      const see = el('button', 'hud-btn', 'See the work', ctas)
      see.type = 'button'
      see.addEventListener('click', () => window.__hark?.land('work'))
      const start = el('a', 'hud-btn hud-btn--ghost', 'Start a project', ctas)
      start.href = '#contact'
      start.addEventListener('click', e => {
        if (!window.__hark) return
        e.preventDefault()
        window.__hark.land('contact')
      })
    },
    update(local, frame, ctx) {
      mat.uniforms.uLift.value = ease.inOutCubic(segment(local, 0.08, 0.5))
      mat.uniforms.uRipple.value = ctx.reducedMotion || frame.still ? 0 : 0.08
      reveal(intro, 1 - smoothstep(0.08, 0.14, local))
      reveal(payoff, smoothstep(0.62, 0.7, local) * (1 - smoothstep(0.93, 0.97, local)))
      setRise(title, local > 0.64 && local < 0.95)
    },
    camera(local, frame, out) {
      const t = ease.inOutCubic(segment(local, 0.06, 0.6))
      const portrait = frame.height > frame.width
      const dist = portrait ? 30 : 17
      // straight down onto the flat chart, then a low oblique over the relief
      const tilt = 0.02 + t * 0.95
      out.position.set(-2.5 * t, Math.cos(tilt) * dist + 0.5, Math.sin(tilt) * dist + 1)
      out.target.set(-1.2 * t, 0, 0)
      out.fov = 40
      out.roll = 0
      out.parallax = 0.25
    },
  }
}
