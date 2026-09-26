import type { Engine, EngineState } from '../core/Engine'
import type { Frame } from '../core/types'
import type { Sound } from './sound'
import { BRAND, MICROCOPY } from '../content'
import { CONCEPT_TAG, WORDMARK, islandSvg, markSvg, sizeIsland } from './mark'
import { holdInert, releaseInert } from './inert'
import { mountRotateGate } from './rotate'
import { bindScene, holdScene, releaseScene } from './scene'
import { noteChapter } from './fallback'

/*
 * Persistent chrome: the MARGINALIA of a printed chart. Everything sits in
 * small paper label boxes (paper fill, an ink hairline, square corners) so
 * the lettering holds ≥ 4.5:1 over paper, tinted land, water — and flips to
 * ink boxes with paper lettering over a dark scene (any stage that marks
 * itself .is-dark — the storm, if it ever goes dark). No backdrop-filter
 * anywhere in the chrome.
 *
 *   collar        a hairline neatline inset round the viewport with graticule
 *                 ticks (decorative; the loader draws the same one)
 *   top-left      the title block: the Hark mark in ink, the "Hark.Digital"
 *                 wordmark (its dot a vermilion survey station) and a small
 *                 "Concept · Contour" tag (→ the start)
 *   top-right     an index strip: Work · Services · Contact, divided by
 *                 hairlines (the chapter you are in carries a vermilion
 *                 route underline), and the vermilion "Start a project".
 *                 ≤ 720px: a "Menu" box opens a full-screen paper sheet (a
 *                 real modal dialog: focus trap, Escape, inert background
 *                 with a fallback, focus returns to Menu; the chapter layer
 *                 is hidden and the scene paused underneath): a gazetteer of
 *                 the seven sheets in Newsreader, 'Start a project', 'Read
 *                 as a page', the Sound / Motion switches and the email.
 *   bottom-left   "Preferences" (a named region): Sound (a sonar glyph that
 *                 answers each ping once) and Motion (a drone seen from
 *                 above), both aria-pressed. Motion off sets html.motion-off
 *                 and engine.motion = false, is remembered for the session
 *                 and starts off under prefers-reduced-motion. Small phones:
 *                 glyph-only boxes (the names stay as accessible names).
 *   bottom-right  a MAP SCALE BAR: "03 / 07 · Summits · Services" over seven
 *                 alternating ink / paper segments (the current one survey
 *                 vermilion; each a ≥ 24px button named for its chapter;
 *                 hovering one cues "Go to …"), numbered at the divisions
 *                 like a real scale, beside a north arrow (decorative; hidden
 *                 on small phones). The readout keeps one width (the widest
 *                 of every readout and cue), so the segments never move
 *                 under the pointer. (The studio's coordinates are lettered
 *                 in the hero's sheet margin and at the Benchmark, not here.)
 *   Read as a page  the static page (?read#<chapter you are on>): the last
 *                 chrome Tab stop, visually hidden until focused; the menu
 *                 sheet carries it too.
 *
 * API used by main.ts: createChrome(root, engine, sound) → { update(frame, state) }.
 * Navigation always uses engine.land(id) (lands on settled copy; long jumps cut).
 */

/** Plain business names beside each chapter's poetic label. */
const BUSINESS: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  voices: 'Clients',
  shield: 'Security',
  process: 'Process',
  contact: 'Contact',
}
const NAV = ['work', 'services', 'contact']
const MENU_QUERY = '(max-width: 720px)'
const MOTION_KEY = 'hark-contour:motion'
const READ_LABEL = 'Read as a page'
/** the static page (main.ts renders the fallback for ?read; it scrolls to the #chapter) */
const readHref = (id: string) => `?read#${id}`

const readMotion = (fallback: boolean) => {
  try {
    const v = sessionStorage.getItem(MOTION_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch {
    /* blocked storage: the default for this visit */
  }
  return fallback
}
const rememberMotion = (on: boolean) => {
  try {
    sessionStorage.setItem(MOTION_KEY, on ? '1' : '0')
  } catch {
    /* blocked storage: the choice lasts until reload */
  }
}
const pad = (n: number) => String(n).padStart(2, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/* glyphs (decorative; stroked in currentColor) */
const MENU_IC = `<svg class="ch-ic" viewBox="0 0 18 12" aria-hidden="true" focusable="false"><path d="M1.5 2h15M1.5 6h15M1.5 10h9"/></svg>`
const CLOSE_IC = `<svg class="ch-ic" viewBox="0 0 18 12" aria-hidden="true" focusable="false"><path d="M4.5 1l9 10M13.5 1l-9 10"/></svg>`
/** a sounding: a point with rings spreading out (the outer ring answers each ping) */
const SONAR = `<svg class="ch-glyph ch-sonar" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle class="ch-sonar-dot" cx="5" cy="10" r="2"/><path class="ch-sonar-a" d="M8.6 6.2a5.4 5.4 0 0 1 0 7.6"/><path class="ch-sonar-b" d="M11.4 3.4a9.4 9.4 0 0 1 0 13.2"/><path class="ch-sonar-p" d="M14.2 1.2a12.6 12.6 0 0 1 0 17.6"/><path class="ch-slash" d="M3 17L17 3"/></svg>`
/** a survey drone from above: four rotors on an X frame */
const DRONE = `<svg class="ch-glyph ch-drone" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path class="ch-drone-f" d="M5.5 5.5l9 9M14.5 5.5l-9 9"/><rect class="ch-drone-b" x="8" y="8" width="4" height="4"/><circle cx="4.6" cy="4.6" r="3"/><circle cx="15.4" cy="4.6" r="3"/><circle cx="4.6" cy="15.4" r="3"/><circle cx="15.4" cy="15.4" r="3"/><path class="ch-slash" d="M3 17L17 3"/></svg>`
/** north arrow: a needle, half inked, with an N */
const NORTH = `<svg class="ch-north-svg" viewBox="0 0 14 30" aria-hidden="true" focusable="false"><text x="7" y="7.6" text-anchor="middle">N</text><path class="ch-north-l" d="M7 11.5L10.6 27L7 24.2z"/><path class="ch-north-r" d="M7 11.5L3.4 27L7 24.2z"/></svg>`

export function createChrome(root: HTMLElement, engine: Engine, sound: Sound) {
  const slots = engine.slots
  const total = slots.length
  const indexOf = (id: string) => slots.findIndex(s => s.def.id === id)
  const biz = (id: string, fallback = '') => BUSINESS[id] ?? fallback
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  // the rotate card and the menu sheet are opaque paper: either one pauses
  // the scene underneath (ref-counted: engine.paused while either is shown)
  bindScene(engine)
  mountRotateGate(shown => (shown ? holdScene('rotate') : releaseScene('rotate')))

  // ---------------------------------------------------------------- markup

  const brandInner = `<span class="ch-mark" aria-hidden="true">${markSvg('ch-mark-svg')}</span>
      <span class="ch-brand-text" aria-hidden="true">${WORDMARK}${CONCEPT_TAG}</span>`

  const links = NAV.filter(id => indexOf(id) >= 0)
    .map(id => `<li><a class="ch-link" href="#${id}" data-go="${id}">${biz(id)}</a></li>`)
    .join('')

  const segs = slots
    .map(
      (s, i) =>
        `<li><button class="ch-seg" type="button" data-go="${s.def.id}" aria-label="${esc(biz(s.def.id, s.def.label))}: chapter ${i + 1} of ${total}, ${esc(s.def.label)}"><i aria-hidden="true"></i><b aria-hidden="true">${i + 1}</b></button></li>`,
    )
    .join('')

  const menuItems = slots
    .map(
      (s, i) =>
        `<li style="--i:${i}"><a class="ch-ml" href="#${s.def.id}" data-go="${s.def.id}" aria-label="${esc(biz(s.def.id, s.def.label))}, chapter ${i + 1} of ${total}: ${esc(s.def.label)}">
          <span class="ch-ml-n" aria-hidden="true">${pad(i + 1)}</span>
          <span class="ch-ml-name" aria-hidden="true">${esc(biz(s.def.id, s.def.label))}</span>
          <span class="ch-ml-dots" aria-hidden="true"></span>
          <span class="ch-ml-lab" aria-hidden="true">${esc(s.def.label)}</span>
        </a></li>`,
    )
    .join('')

  let motionOn = readMotion(!reduced)
  const soundBtn = (extra = '') =>
    `<button class="ch-tgl ch-sound${extra}" type="button" data-sound-toggle aria-pressed="false">${SONAR}<span class="ch-tgl-k">${MICROCOPY.audio}</span><span class="ch-tgl-st" aria-hidden="true">${MICROCOPY.audioOff}</span></button>`
  const motionBtn = (extra = '') =>
    `<button class="ch-tgl ch-motion${extra}" type="button" data-motion-toggle aria-pressed="${motionOn}">${DRONE}<span class="ch-tgl-k">${MICROCOPY.motion}</span><span class="ch-tgl-st" aria-hidden="true">${motionOn ? MICROCOPY.audioOn : MICROCOPY.audioOff}</span></button>`
  const first = slots[0]?.def.id ?? 'hero'

  root.innerHTML = `
  <div class="chr">
    <div class="ch-frame" aria-hidden="true"><i class="ch-ticks ch-ticks--t"></i><i class="ch-ticks ch-ticks--b"></i><i class="ch-ticks ch-ticks--l"></i><i class="ch-ticks ch-ticks--r"></i></div>
    <header class="ch-top">
      <a class="ch-brand ch-box" href="#${first}" data-go="${first}" aria-label="${esc(BRAND.name)}, back to the start">
        ${brandInner}
      </a>
      <nav class="ch-nav ch-box" aria-label="Primary">
        <ul class="ch-links">${links}</ul>
        <a class="hud-btn ch-cta" href="#contact" data-go="contact" data-focus>Start a project</a>
      </nav>
      <button class="ch-menu-btn ch-box" type="button" aria-expanded="false" aria-controls="ch-menu" aria-haspopup="dialog">
        <span class="ch-menu-t">Menu</span>${MENU_IC}
      </button>
    </header>

    <div class="ch-bottom">
      <section class="ch-prefs ch-box" aria-label="Preferences">${soundBtn()}${motionBtn()}</section>
      <div class="ch-scale ch-box">
        <span class="ch-north" aria-hidden="true">${NORTH}</span>
        <div class="ch-scale-main">
          <p class="ch-read" aria-hidden="true"><span class="ch-read-n"></span><span class="ch-read-l"></span><span class="ch-read-b"></span></p>
          <div class="ch-scale-row">
            <nav class="ch-chapters" aria-label="Chapters"><ol class="ch-segs"><li class="ch-seg0" aria-hidden="true">0</li>${segs}</ol></nav>
          </div>
        </div>
      </div>
      <a class="ch-readpage" href="${readHref(first)}" data-read>${READ_LABEL}</a>
    </div>

    <div class="ch-menu" id="ch-menu" role="dialog" aria-modal="true" aria-labelledby="ch-menu-title" data-lenis-prevent hidden>
      <div class="ch-menu-isl" aria-hidden="true">${islandSvg('ch-menu-isl-svg', { water: 6 })}</div>
      <div class="ch-menu-top">
        <span class="ch-brand ch-menu-brand" aria-hidden="true">${brandInner}</span>
        <button class="ch-menu-btn ch-menu-close ch-box" type="button">
          <span class="ch-menu-t">Close</span>${CLOSE_IC}
        </button>
      </div>
      <div class="ch-menu-body">
        <p class="hud-eyebrow ch-menu-eyebrow" id="ch-menu-title">Menu</p>
        <nav class="ch-menu-nav" aria-label="Chapters"><ol class="ch-menu-list">${menuItems}</ol></nav>
        <div class="ch-menu-foot">
          <a class="hud-btn ch-menu-cta" href="#contact" data-go="contact">Start a project</a>
          <a class="hud-btn hud-btn--ghost ch-menu-read" href="${readHref(first)}" data-read>${READ_LABEL}</a>
        </div>
        <div class="ch-menu-prefs" role="group" aria-label="Preferences">${soundBtn(' ch-menu-tgl')}${motionBtn(' ch-menu-tgl')}</div>
        <p class="ch-menu-mail"><a href="mailto:${BRAND.email}">${BRAND.email}</a></p>
      </div>
    </div>
  </div>`

  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!
  const chr = $('.chr')
  const top = $('.ch-top')
  const bottom = $('.ch-bottom')
  const menu = $('.ch-menu')
  const menuBtn = $<HTMLButtonElement>('.ch-top .ch-menu-btn')
  const menuClose = $<HTMLButtonElement>('.ch-menu-close')
  const navEls = [...root.querySelectorAll<HTMLAnchorElement>('.ch-link')]
  const segEls = [...root.querySelectorAll<HTMLButtonElement>('.ch-seg')]
  const menuLinks = [...root.querySelectorAll<HTMLAnchorElement>('.ch-ml')]
  const soundBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-sound-toggle]')]
  const motionBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-motion-toggle]')]
  const readN = $('.ch-read-n')
  const readL = $('.ch-read-l')
  const readB = $('.ch-read-b')
  const readEl = $('.ch-read')
  const readLinks = [...root.querySelectorAll<HTMLAnchorElement>('[data-read]')]
  const menuIsl = $<SVGSVGElement>('.ch-menu-isl-svg')
  let unsizeIsl: (() => void) | null = null

  // ---------------------------------------------------------------- navigation

  root.addEventListener('click', e => {
    const a = (e.target as Element).closest<HTMLElement>('[data-go]')
    if (!a || !root.contains(a)) return
    e.preventDefault()
    const id = a.dataset.go!
    const fromMenu = menuOpen && menu.contains(a)
    if (menuOpen) closeMenu(false)
    sound.blip(a.matches('.ch-cta, .ch-menu-cta') ? 5 : Math.max(0, indexOf(id)))
    if (indexOf(id) >= 0) engine.land(id)
    // keyboard activation (detail 0) hands focus on to the chapter's heading;
    // a tap in the sheet returns focus to Menu, the control that opened it
    const keyboard = e.detail === 0
    if (keyboard && (fromMenu || a.matches('.ch-link, .ch-seg, .ch-brand') || a.hasAttribute('data-focus')))
      engine.focusChapter(id)
    else if (fromMenu) menuBtn.focus({ preventScroll: true })
  })

  // ------------------------------------------------------------- the readout

  let lastIndex = -1
  let cueIndex = -1
  const letter = (n: Element, l: Element, b: Element, i: number, cue: boolean) => {
    const s = slots[i]
    if (!s) return false
    n.textContent = cue ? `Go to ${pad(i + 1)}` : `${pad(i + 1)} / ${pad(total)}`
    l.textContent = s.def.label
    b.textContent = biz(s.def.id, s.def.label)
    return true
  }
  const showReadout = (i: number, cue = false) => {
    if (letter(readN, readL, readB, i, cue)) readEl.classList.toggle('is-cue', cue)
  }

  // One width for the readout: the widest of all seven readouts and all seven
  // "Go to" cues, measured in an invisible copy that takes the same rules. The
  // box is anchored right, so a readout that changed width would slide every
  // segment sideways under the pointer (and under the focus ring). Measured
  // again once the fonts arrive and whenever a breakpoint changes the type.
  const probe = readEl.cloneNode(true) as HTMLElement
  probe.classList.add('ch-read--probe')
  readEl.after(probe)
  const probeN = probe.querySelector('.ch-read-n')!
  const probeL = probe.querySelector('.ch-read-l')!
  const probeB = probe.querySelector('.ch-read-b')!
  const fitReadout = () => {
    let w = 0
    for (let i = 0; i < total; i++)
      for (const cue of [false, true]) if (letter(probeN, probeL, probeB, i, cue)) w = Math.max(w, probe.getBoundingClientRect().width)
    readEl.style.minWidth = w > 0 ? `${Math.ceil(w)}px` : ''
  }
  fitReadout()
  document.fonts?.ready.then(fitReadout).catch(() => {})
  for (const q of ['(max-width: 480px)', '(max-width: 400px)', '(max-width: 350px)', '(orientation: landscape) and (max-height: 500px)']) {
    const mq = matchMedia(q)
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fitReadout)
    else mq.addListener?.(fitReadout)
  }
  segEls.forEach((b, i) => {
    const cue = () => {
      cueIndex = i
      showReadout(i, i !== lastIndex)
    }
    b.addEventListener('pointerenter', e => {
      if ((e as PointerEvent).pointerType !== 'touch') cue()
    })
    b.addEventListener('focus', cue)
    const uncue = () => {
      if (cueIndex !== i) return
      cueIndex = -1
      if (lastIndex >= 0) showReadout(lastIndex)
    }
    b.addEventListener('pointerleave', uncue)
    b.addEventListener('blur', uncue)
  })

  // --------------------------------------------------------------------- sound

  const syncSound = (on: boolean) => {
    for (const b of soundBtns) {
      b.setAttribute('aria-pressed', String(on))
      const st = b.querySelector('.ch-tgl-st')
      if (st) st.textContent = on ? MICROCOPY.audioOn : MICROCOPY.audioOff
    }
    chr.classList.toggle('is-sound', on)
  }
  for (const b of soundBtns) b.addEventListener('click', () => sound.toggle())
  sound.onChange.push(syncSound)
  syncSound(sound.enabled)
  // each sonar ping: the glyph's outer ring answers once (never with motion off)
  let pingTimer = 0
  sound.onPing.push(() => {
    if (reduced || !motionOn) return
    chr.classList.remove('is-ping')
    void chr.offsetWidth
    chr.classList.add('is-ping')
    clearTimeout(pingTimer)
    pingTimer = window.setTimeout(() => chr.classList.remove('is-ping'), 1600)
  })

  // -------------------------------------------------------------------- motion

  const syncMotion = () => {
    document.documentElement.classList.toggle('motion-off', !motionOn)
    engine.motion = motionOn
    chr.classList.toggle('is-still', !motionOn)
    for (const b of motionBtns) {
      b.setAttribute('aria-pressed', String(motionOn))
      const st = b.querySelector('.ch-tgl-st')
      if (st) st.textContent = motionOn ? MICROCOPY.audioOn : MICROCOPY.audioOff
    }
    window.dispatchEvent(new CustomEvent('hark:motion', { detail: { on: motionOn } }))
  }
  for (const b of motionBtns)
    b.addEventListener('click', () => {
      motionOn = !motionOn
      rememberMotion(motionOn)
      sound.blip(motionOn ? 4 : 1)
      syncMotion()
    })

  // --------------------------------------------------------------- menu sheet

  let menuOpen = false
  let hideTimer = 0
  const focusables = () =>
    [...menu.querySelectorAll<HTMLElement>('a[href], button')].filter(el => !el.hidden && el.getClientRects().length > 0)
  const openMenu = () => {
    if (menuOpen) return
    menuOpen = true
    clearTimeout(hideTimer)
    menu.hidden = false
    // flush the closed state so the sheet's unfold runs
    void menu.offsetWidth
    chr.classList.add('is-menu')
    // the chapter layer underneath is hidden while the sheet is up (ui.css)
    document.documentElement.classList.add('menu-open')
    menuBtn.setAttribute('aria-expanded', 'true')
    holdInert('menu', [
      document.getElementById('stages'),
      document.getElementById('track'),
      document.querySelector<HTMLElement>('.skip-link'),
      top,
      bottom,
    ])
    engine.lenis.stop()
    unsizeIsl = sizeIsland(menuIsl)
    // the sheet is opaque paper: hold the frame once it has unfolded
    hideTimer = window.setTimeout(
      () => {
        if (menuOpen) holdScene('menu')
      },
      reduced || !motionOn ? 0 : 380,
    )
    menu.scrollTop = 0
    const now = menuLinks[lastIndex] ?? menuLinks[0]
    now?.focus({ preventScroll: true })
    sound.blip(2)
  }
  const closeMenu = (restoreFocus = true) => {
    if (!menuOpen) return
    menuOpen = false
    clearTimeout(hideTimer)
    chr.classList.remove('is-menu')
    document.documentElement.classList.remove('menu-open')
    menuBtn.setAttribute('aria-expanded', 'false')
    releaseInert('menu')
    releaseScene('menu')
    engine.lenis.start()
    unsizeIsl?.()
    unsizeIsl = null
    hideTimer = window.setTimeout(
      () => {
        if (!menuOpen) menu.hidden = true
      },
      reduced || !motionOn ? 20 : 300,
    )
    if (restoreFocus) menuBtn.focus({ preventScroll: true })
  }
  menuBtn.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()))
  menuClose.addEventListener('click', () => closeMenu())
  // capture: the dialog's own trap runs ahead of the no-`inert` fallback in inert.ts
  window.addEventListener(
    'keydown',
    e => {
      if (!menuOpen) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu()
      } else if (e.key === 'Tab') {
        const f = focusables()
        if (!f.length) return
        const i = f.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i < 0 || i === f.length - 1 ? 0 : i + 1
        e.preventDefault()
        f[next].focus()
      }
    },
    true,
  )
  // widening past the menu breakpoint closes the sheet (the full nav is back)
  const narrow = matchMedia(MENU_QUERY)
  const onNarrow = (e: MediaQueryListEvent) => {
    if (!e.matches) closeMenu(false)
  }
  if (typeof narrow.addEventListener === 'function') narrow.addEventListener('change', onNarrow)
  else narrow.addListener?.(onNarrow)

  syncMotion()

  // -------------------------------------------------------------------- update

  let dark = false
  const letterIn = () => {
    // the new name is lettered on, left to right, like the chapter headings
    if (reduced || !motionOn || typeof readEl.animate !== 'function') return
    try {
      readEl.animate(
        [
          { clipPath: 'inset(-2px 100% -2px 0)', opacity: 0.3 },
          { clipPath: 'inset(-2px 0% -2px 0)', opacity: 1 },
        ],
        { duration: 560, easing: 'cubic-bezier(0.35, 0.6, 0.2, 1)' },
      )
    } catch {
      /* no clip-path animation: the text is simply there */
    }
  }

  return {
    update(_frame: Frame, state: EngineState) {
      const slot = state.slots[state.index]
      if (!slot) return

      // over a dark scene (a stage that marks itself .is-dark, e.g. the storm
      // at its height) the label boxes turn to ink with paper lettering
      const isDark = slot.stage.classList.contains('is-dark')
      if (isDark !== dark) {
        dark = isDark
        chr.classList.toggle('is-storm', dark)
      }

      if (state.index === lastIndex) return
      const firstRun = lastIndex < 0
      lastIndex = state.index
      // a segment still under the pointer keeps its cue, but "Go to" only while it is elsewhere
      if (cueIndex < 0) showReadout(state.index)
      else showReadout(cueIndex, cueIndex !== state.index)
      segEls.forEach((p, i) => {
        p.classList.toggle('is-on', i === state.index)
        if (i === state.index) p.setAttribute('aria-current', 'step')
        else p.removeAttribute('aria-current')
      })
      if (!firstRun) letterIn()
      const activeId = slot.def.id
      navEls.forEach(a => {
        const on = a.dataset.go === activeId
        a.classList.toggle('is-active', on)
        if (on) a.setAttribute('aria-current', 'location')
        else a.removeAttribute('aria-current')
      })
      menuLinks.forEach((a, i) => {
        a.classList.toggle('is-now', i === state.index)
        if (i === state.index) a.setAttribute('aria-current', 'location')
        else a.removeAttribute('aria-current')
      })
      chr.dataset.chapter = activeId
      // Read as a page opens the static copy at the chapter you are on
      const href = readHref(activeId)
      for (const a of readLinks) a.setAttribute('href', href)
      noteChapter(activeId)
    },
  }
}
