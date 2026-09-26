import { el, rise, setRise } from '../../core/dom'
import { SECTIONS, SERVICES } from '../../content'
import { iconSvg } from './icons'
import type { Summit } from './range'

/*
 * DOM for Summits. Scroll decides WHAT is on screen (the intro or which
 * summit's legend entry); CSS decides HOW it arrives (words drawn on left
 * to right, a short ease), so wherever the scroll rests the copy is exact.
 *
 *   intro  eyebrow · "Eleven ways to be heard." · sheet marginalia
 *   card   a legend box: [symbol] NN / 11 ─── ▲ elev · title · blurb · tags ·
 *          the 01–11 index (buttons land on each summit's anchor)
 *
 * All eleven entries share one grid cell, so the card never changes size.
 * metrics() reports the live layout (offset*, no transforms) so the drone
 * frames the range into the space the copy leaves free.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const setOn = (node: Element, on: boolean, cls = 'is-on') => {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on)
}

export interface HudMetrics {
  /** right edge of the card column (landscape) */
  colRight: number
  /** the card's box (stage px) */
  cardTop: number
  cardLeft: number
  cardBottom: number
  /** top + right edge of the intro block */
  introTop: number
  introRight: number
  safeTop: number
  safeBottom: number
  gutter: number
  valid: boolean
}

export class Hud {
  private intro: HTMLElement
  private introTitle: HTMLElement
  private col: HTMLElement
  private card: HTMLElement
  private cur: HTMLElement
  private elev: HTMLElement
  private icons: HTMLElement[] = []
  private items: { root: HTMLElement; title: HTMLElement }[] = []
  private keys: HTMLButtonElement[] = []
  private probeTop: HTMLElement
  private probeBottom: HTMLElement
  private shown = -2
  private dirty = true
  private m: HudMetrics = {
    colRight: 0,
    cardTop: 0,
    cardLeft: 0,
    cardBottom: 0,
    introTop: 0,
    introRight: 0,
    safeTop: 0,
    safeBottom: 0,
    gutter: 16,
    valid: false,
  }

  constructor(
    private stage: HTMLElement,
    private summits: Summit[],
    onKey: (k: number) => void,
  ) {
    /* intro: straight on the chart, over the sound */
    this.intro = el('div', 'su-intro', undefined, stage)
    el('p', 'hud-eyebrow su-intro-eyebrow', SECTIONS.services.eyebrow, this.intro)
    this.introTitle = rise(el('h2', 'hud-h2 su-intro-title', undefined, this.intro), 'Eleven ways to be <em>heard.</em>')
    const meta = el('div', 'su-intro-meta', undefined, this.intro)
    meta.setAttribute('aria-hidden', 'true')
    el('p', 'hud-coord su-intro-sheet', `Sheet 03 · The Summits · ${pad(SERVICES.length)} benchmarks · contour interval 100 m`, meta)

    /* the legend box */
    this.col = el('div', 'su-col', undefined, stage)
    this.card = el('div', 'su-card hud-panel', undefined, this.col)
    const head = el('div', 'su-head', undefined, this.card)
    const key = el('div', 'su-key-symbol', undefined, head)
    key.setAttribute('aria-hidden', 'true')
    for (const s of SERVICES) {
      const wrap = el('span', 'su-sym', undefined, key)
      wrap.innerHTML = iconSvg(s.slug)
      this.icons.push(wrap)
    }
    const count = el('p', 'hud-label su-count', undefined, head)
    this.cur = el('span', 'su-cur', '01', count)
    el('span', 'su-of', ` / ${pad(SERVICES.length)}`, count)
    el('span', 'su-rule', undefined, head).setAttribute('aria-hidden', 'true')
    this.elev = el('p', 'hud-coord su-elev', '', head)
    this.elev.setAttribute('aria-hidden', 'true')

    const stack = el('div', 'su-stack', undefined, this.card)
    for (const s of SERVICES) {
      const root = el('div', 'su-item', undefined, stack)
      const title = rise(el('h3', 'hud-h2 su-title', undefined, root), s.title)
      el('p', 'hud-body su-blurb', s.blurb, root)
      const tags = el('ul', 'hud-tags su-tags', undefined, root)
      for (const t of s.tags) el('li', 'hud-tag', t, tags)
      this.items.push({ root, title })
    }

    const keys = el('div', 'su-keys', undefined, this.card)
    SERVICES.forEach((s, k) => {
      const b = el('button', 'su-keybtn', s.num, keys)
      b.type = 'button'
      b.title = s.title
      b.setAttribute('aria-label', `${s.num} ${s.title}`)
      b.addEventListener('click', () => onKey(k))
      this.keys.push(b)
    })

    /* layout probes on the safe bands (the camera fit reads their offsets) */
    this.probeTop = el('div', 'su-probe su-probe--top', undefined, stage)
    this.probeBottom = el('div', 'su-probe su-probe--bottom', undefined, stage)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => (this.dirty = true))
      for (const n of [stage, this.col, this.card, this.intro, this.probeTop, this.probeBottom]) ro.observe(n)
    }
    window.addEventListener('resize', () => (this.dirty = true))
  }

  /** Where the copy sits (stage px; offset* ignore transforms). Re-measured only after a resize. */
  metrics(): HudMetrics {
    if (this.dirty) {
      const m = this.m
      const h = this.stage.offsetHeight
      if (!h) return m
      this.dirty = false
      m.colRight = this.col.offsetLeft + this.card.offsetLeft + this.card.offsetWidth
      m.cardTop = this.col.offsetTop + this.card.offsetTop
      m.cardLeft = this.col.offsetLeft + this.card.offsetLeft
      m.cardBottom = m.cardTop + this.card.offsetHeight
      m.introTop = this.intro.offsetTop
      m.introRight = this.intro.offsetLeft + this.intro.offsetWidth
      m.safeTop = this.probeTop.offsetTop
      m.safeBottom = h - (this.probeBottom.offsetTop + this.probeBottom.offsetHeight)
      m.gutter = this.col.offsetLeft
      m.valid = m.colRight > 0 && m.cardTop > 0
    }
    return this.m
  }

  update(introOn: boolean, shown: number) {
    setOn(this.intro, introOn)
    setRise(this.introTitle, introOn)
    const cardOn = shown >= 0
    setOn(this.col, cardOn)
    if (shown !== this.shown) {
      this.shown = shown
      this.items.forEach((it, k) => {
        const on = k === shown
        setOn(it.root, on)
        setRise(it.title, on)
      })
      this.icons.forEach((ic, k) => setOn(ic, k === shown))
      this.keys.forEach((b, k) => {
        setOn(b, k === shown)
        if (k === shown) b.setAttribute('aria-current', 'true')
        else b.removeAttribute('aria-current')
      })
      if (cardOn) {
        this.cur.textContent = SERVICES[shown].num
        this.elev.textContent = `▲ ${this.summits[shown].elev} m`
      }
    }
  }
}
