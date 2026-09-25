import * as THREE from 'three'
import { logoGeometry, logoParts } from '../logo/logo'
import { clamp } from '../core/math'
import type { CameraPose, Frame } from '../core/types'
import { World } from '../world/World'
import { chartMaterial } from '../kit/chart'
import { terrainGeometry, heightRange } from '../kit/terrain'
import { simplex2, fbm } from '../kit/noise'

/*
 * Shared helpers for the starter's placeholder chapters. Each chapter is a
 * working, content-complete example of the Chapter API — replace the scene
 * with the concept's own, keep the patterns:
 *   - everything derived from `local` (screenshots jump to any value)
 *   - copy in ctx.stage inside .hud-panel, revealed with rise()/setRise()
 *   - items stepped with beat(), chapter.anchors pointing at each item
 *   - in/out beats kept clear of the engine's cut window (first/last ~6%)
 */

/** The Hark mark as a lit 3D block with a glowing diamond — a stand-in hero object. */
export function placeholderMark(color = '#c9ced6'): THREE.Group {
  const g = new THREE.Group()
  const body = new THREE.Mesh(
    logoGeometry({ depth: 0.22 }),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.1 }),
  )
  g.add(body)
  const diamond = new THREE.Mesh(
    new THREE.ShapeGeometry(logoParts().diamond),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff').multiplyScalar(1.6), toneMapped: false }),
  )
  diamond.position.z = 0.125
  g.add(diamond)
  return g
}

/** A small printed chart (rolling land + water) so placeholder scenes read as Contour. */
export function placeholderFloor(size = 30, y = -1.4): THREE.Mesh {
  const n = simplex2(size | 0)
  const height = (x: number, z: number) => fbm(n, x * 0.07, z * 0.07, 5) * 2.4 + 0.3
  const geo = terrainGeometry({ width: size, depth: size, seg: 160, height })
  const { hMin, hMax } = heightRange(geo)
  const mesh = new THREE.Mesh(geo, chartMaterial(World.current!, { terrain: geo, hMin, hMax, interval: 0.15 }))
  mesh.position.y = y
  return mesh
}

/**
 * Step through `count` items between local `a` and `b`.
 * Returns the current index, the progress inside its slot (0..1), and the
 * local value at the centre of each slot (use those for chapter.anchors).
 */
export function beat(local: number, count: number, a: number, b: number) {
  const span = (b - a) / count
  const idx = Math.min(count - 1, Math.max(0, Math.floor((local - a) / span)))
  const phase = clamp((local - a - idx * span) / span)
  const active = local >= a && local <= b
  return { idx, phase, active, centers: Array.from({ length: count }, (_, i) => a + span * (i + 0.55)) }
}

/**
 * Frame the placeholder subject (at the origin) clear of the copy: to the
 * right on landscape screens (copy lives on the left), smaller and above
 * center on portrait (copy lives at the top and bottom). `amount` 0..1 eases
 * between a centred shot and the offset one.
 */
export function framedCamera(out: CameraPose, frame: Frame, amount = 1, dist = 7.5) {
  const portrait = frame.height > frame.width
  if (portrait) {
    out.position.set(0, 0.3, dist * 1.45)
    out.target.set(0, -0.35 * amount, 0)
  } else {
    out.position.set(-2.1 * amount, 0.5, dist)
    out.target.set(-1.5 * amount, 0, 0)
  }
  out.fov = 40
  out.parallax = 0.3
}
