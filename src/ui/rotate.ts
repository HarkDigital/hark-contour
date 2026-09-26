import { holdInert, releaseInert } from './inert'
import { SITE } from '../content'
import { islandSvg, sizeIsland } from './mark'

/*
 * Phone-landscape suggestion: a LEGEND BOX on blank chart paper (the scene
 * is paused underneath). Contour is drawn for portrait on phones, so a
 * short, touch-first landscape viewport is offered "Turn your phone upright"
 * beside a hairline phone that turns upright once (never a loop), the island
 * emblem, and "Continue anyway". Tablets and laptops in landscape are taller
 * than 500px and never see it.
 *
 * It is a suggestion, never a lock (WCAG 1.3.4): "Continue anyway" releases
 * it for the rest of the session. While it shows, the skip link and the
 * linear copy layer in #track stay reachable, and their focus pills paint
 * above the card (it sits at z 25: over the chrome (10) and the stages (5),
 * under #track:focus-within (30) and the skip link (120)); only the chrome
 * and the stages behind it are inert.
 *
 * API: mountRotateGate(onChange?) / unmountRotateGate(). Safe to call more
 * than once: later calls just add their onChange listener.
 */

export const ROTATE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

const DISMISS_KEY = 'hark-contour:rotate-ok'
const wasDismissed = () => {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}
const rememberDismissed = () => {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* blocked storage: the choice lasts until reload */
  }
}

// a hairline phone that turns upright once (with a dashed survey arc)
const PHONE = `<svg class="rot-phone" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <g class="rot-phone-g">
    <rect class="rot-body" x="19" y="6" width="26" height="52" rx="4"/>
    <path class="rot-speaker" d="M29 11h6"/>
    <circle class="rot-home" cx="32" cy="52.5" r="1.6"/>
  </g>
  <path class="rot-arc" d="M8 44a25 25 0 0 1 3-26"/>
  <path class="rot-arc-h" d="M7.6 20.6l3.4-3.2 2.3 4.1"/>
</svg>`

let gate: {
  el: HTMLElement
  mq: MediaQueryList
  sync: () => void
  listeners: ((shown: boolean) => void)[]
  on: () => boolean
  unsize: () => void
} | null = null

export function mountRotateGate(onChange?: (shown: boolean) => void) {
  if (gate) {
    if (onChange) {
      gate.listeners.push(onChange)
      onChange(gate.on())
    }
    return
  }
  if (typeof matchMedia === 'undefined') return
  let dismissed = wasDismissed()
  const el = document.createElement('div')
  el.className = 'rot'
  // non-modal: the copy layer behind it stays in reach
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-labelledby', 'rot-title')
  el.setAttribute('aria-describedby', 'rot-sub')
  el.tabIndex = -1
  el.innerHTML = `
    <div class="rot-card hud-panel">
      <div class="rot-art" aria-hidden="true">${PHONE}</div>
      <div class="rot-text">
        <p class="rot-k" aria-hidden="true">Sheet orientation</p>
        <h2 class="rot-title" id="rot-title">Turn your phone <em>upright</em></h2>
        <p class="rot-sub" id="rot-sub">${SITE.name} is drawn for portrait.</p>
        <p class="rot-actions"><button class="hud-btn hud-btn--ghost rot-go" type="button">Continue anyway</button></p>
      </div>
      <div class="rot-isl" aria-hidden="true">${islandSvg('rot-isl-svg', { water: 4 })}</div>
    </div>
    <p class="sr-only" aria-live="assertive" data-rot-live></p>`
  // right after the skip link: Tab goes skip link → this card → the page
  const skip = document.querySelector('.skip-link')
  if (skip && skip.parentNode === document.body) skip.after(el)
  else document.body.prepend(el)

  const live = el.querySelector<HTMLElement>('[data-rot-live]')!
  const go = el.querySelector<HTMLButtonElement>('.rot-go')!
  const isl = el.querySelector<SVGSVGElement>('.rot-isl-svg')!
  const mq = matchMedia(ROTATE_QUERY)
  const listeners: ((shown: boolean) => void)[] = onChange ? [onChange] : []
  let on = false
  let unsize = () => {}
  const sync = () => {
    const want = mq.matches && !dismissed
    if (want === on) return
    on = want
    el.classList.toggle('is-on', on)
    document.documentElement.classList.toggle('is-rotate', on)
    if (on) {
      // only the layers the card hides; the skip link and #track stay reachable
      holdInert('rotate', ['chrome', 'stages'].map(id => document.getElementById(id)))
      unsize = sizeIsland(isl)
      // focus stranded in a now-inert layer (or on <body>) comes to the card;
      // a reader already in the copy layer or on the skip link stays put
      const a = document.activeElement
      const keep = a instanceof HTMLElement && a !== document.body && (a.closest('#track') || a.matches('.skip-link'))
      if (!keep) el.focus({ preventScroll: true })
      // the phone turns upright once, after the card is on screen
      el.classList.remove('is-turned')
      void el.offsetWidth
      window.setTimeout(() => {
        if (on) el.classList.add('is-turned')
      }, 260)
      // a live region only speaks when its text changes after it is shown
      window.setTimeout(() => {
        if (on) live.textContent = `Turn your phone upright. ${SITE.name} is drawn for portrait.`
      }, 60)
    } else {
      releaseInert('rotate')
      unsize()
      live.textContent = ''
    }
    for (const fn of listeners) fn(on)
  }

  go.addEventListener('click', () => {
    const hadFocus = el.contains(document.activeElement)
    dismissed = true
    rememberDismissed()
    sync()
    if (!hadFocus) return
    // the card is gone: hand focus to the story, like the skip link does
    const main = document.getElementById('track')
    if (main && !main.closest('[inert], [aria-hidden="true"]')) main.focus({ preventScroll: true })
    else (document.activeElement as HTMLElement | null)?.blur?.()
  })

  mq.addEventListener?.('change', sync)
  gate = { el, mq, sync, listeners, on: () => on, unsize: () => unsize() }
  sync()
}

/** The plain HTML page reads fine in any orientation. */
export function unmountRotateGate() {
  if (!gate) return
  const was = gate.on()
  gate.mq.removeEventListener?.('change', gate.sync)
  gate.unsize()
  gate.el.remove()
  document.documentElement.classList.remove('is-rotate')
  releaseInert('rotate')
  if (was) for (const fn of gate.listeners) fn(false)
  gate = null
}
