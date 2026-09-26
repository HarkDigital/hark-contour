/*
 * Reference-counted "the scene is covered" holds. The phone-landscape rotate
 * card and the mobile menu sheet are both opaque paper: while either covers
 * the chart the engine skips rendering (engine.paused), so an unseen scene
 * never burns battery. Two covers can overlap (a phone turned sideways with
 * the menu open); the scene only runs again once both have let go.
 *
 * Holds may be taken before the engine exists; they apply once bindScene()
 * runs.
 */

interface Pausable {
  paused: boolean
}

let target: Pausable | null = null
const holds = new Set<string>()

const apply = () => {
  if (target) target.paused = holds.size > 0
}

export function bindScene(engine: Pausable) {
  target = engine
  apply()
}

export function holdScene(key: string) {
  holds.add(key)
  apply()
}

export function releaseScene(key: string) {
  if (holds.delete(key)) apply()
}
