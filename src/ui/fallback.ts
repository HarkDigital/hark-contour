import { BRAND, CONTACT, MICROCOPY, SHEET } from '../content'
import { CHAPTER_COPY_IDS, buildChapterCopy } from '../core/srContent'
import { CHAPTERS } from '../chapters/index'
import { CONCEPT_TAG, WORDMARK, islandSvg, markSvg, sizeIsland } from './mark'
import { unmountRotateGate } from './rotate'
import { releaseInert } from './inert'

/*
 * The plain HTML version: for browsers without WebGL2, the "Read as a page"
 * link (?read), and the last resort if boot fails. Every chapter's copy, in
 * story order (CHAPTERS), visible, as a clean PRINTED CHART page: chart
 * paper inside a double neatline, Newsreader titles (the italic vermilion
 * accent of a lettered water name), Overpass text, Overpass Mono marginalia
 * in the collar (sheet number, scale, the studio's coordinates — decorative),
 * and the Hark mark as a small topographic island at the head of the sheet.
 * Same copy as the live site, verbatim, from srContent (buildChapterCopy).
 * Styled by the .fb-* rules in ui.css.
 *
 * Landmarks: the banner <header> sits just before <main id="track">, so
 * "Skip to content" (#track) lands on the story itself, past the navigation.
 *
 * Where it opens: at `at` when given, else at the chapter the live story was
 * showing (the chrome notes it with noteChapter(), so a GPU context lost for
 * good lands the reader where they were), else at the #hash ("Read as a page"
 * links to ?read#<chapter>). "View the live site" keeps the section being
 * read as its #hash, so the way back lands on the same chapter.
 */

let liveChapter = ''
/** the chapter the live story is on (chrome.ts), for a fallback that takes over mid-visit */
export function noteChapter(id: string) {
  liveChapter = id
}

const BUSINESS: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  voices: 'Clients',
  shield: 'Security',
  process: 'Process',
  contact: 'Contact',
}
const pad = (n: number) => String(n).padStart(2, '0')

export function renderFallback(root: HTMLElement, at?: string) {
  document.documentElement.classList.add('no-webgl')
  document.documentElement.classList.remove('menu-open', 'is-rotate', 'ld-up')
  unmountRotateGate()
  // boot can fail while the loader or the menu still holds the page inert: let go
  releaseInert('loader')
  releaseInert('menu')
  document.getElementById('loader')?.remove()
  document.getElementById('gl')?.remove()
  root.style.pointerEvents = 'auto'
  root.inert = false

  // the collar (decorative neatline + marginalia) and the banner, around <main>
  document.querySelector('.fb-collar')?.remove()
  document.getElementById('fb-head')?.remove()
  const collar = document.createElement('div')
  collar.className = 'fb-collar'
  collar.setAttribute('aria-hidden', 'true')
  collar.innerHTML = `<i class="fb-ticks fb-ticks--t"></i><i class="fb-ticks fb-ticks--b"></i>`
  document.body.prepend(collar)

  // opened from "Read as a page" in a browser that can run the live site: offer the way back
  const params = new URLSearchParams(location.search)
  let live = ''
  let liveBase = ''
  if (params.has('read')) {
    params.delete('read')
    const q = params.toString()
    liveBase = `${location.pathname}${q ? `?${q}` : ''}`
    live = `<a class="fb-link fb-live" href="${liveBase}${location.hash}">View the live site</a>`
  }

  const header = document.createElement('header')
  header.className = 'fb-head'
  header.id = 'fb-head'
  header.innerHTML = `
    <p class="fb-margin" aria-hidden="true"><span>${BRAND.short} · Sheet index</span><span>${MICROCOPY.coordinates}</span></p>
    <div class="fb-bar">
      <a class="fb-brand" href="#hero" aria-label="${BRAND.name}, top of page">
        <span class="fb-mark" aria-hidden="true">${markSvg('fb-mark-svg')}</span>
        <span class="fb-brand-text" aria-hidden="true">${WORDMARK}${CONCEPT_TAG}</span>
      </a>
      <nav class="fb-nav" aria-label="Primary">
        <a class="fb-link" href="#work">Work</a>
        <a class="fb-link" href="#services">Services</a>
        <a class="fb-link" href="#contact">Contact</a>
        ${live}
        <a class="hud-btn fb-cta" href="${CONTACT.href}">Start a project</a>
      </nav>
    </div>`
  root.parentNode?.insertBefore(header, root)

  root.innerHTML = ''
  root.classList.add('fb')
  const order = CHAPTERS.map(c => c.id).filter(id => CHAPTER_COPY_IDS.includes(id))
  for (const id of CHAPTER_COPY_IDS) if (!order.includes(id)) order.push(id)
  order.forEach((id, i) => {
    const copy = buildChapterCopy(id, true)
    if (!copy) return
    // heading Tab stops only drive the live story
    copy.querySelectorAll('h1[tabindex], h2[tabindex]').forEach(h => h.removeAttribute('tabindex'))
    // item "stops" only steer the live story; here they're just text
    copy.querySelectorAll<HTMLAnchorElement>('a[data-anchor][href^="#"]:not([data-land])').forEach(a => {
      const span = document.createElement('span')
      span.textContent = a.textContent
      a.replaceWith(span)
    })
    const label = CHAPTERS.find(c => c.id === id)?.label ?? ''
    const sec = document.createElement('section')
    sec.className = `fb-sec fb-sec--${id}`
    sec.id = id
    const heading = copy.querySelector<HTMLElement>('h1, h2')
    if (heading) {
      heading.id = `fb-${id}-title`
      sec.setAttribute('aria-labelledby', heading.id)
    }
    const kicker = document.createElement('p')
    kicker.className = 'fb-k'
    kicker.setAttribute('aria-hidden', 'true')
    kicker.innerHTML = `<span class="fb-k-n">${pad(i + 1)}</span><span class="fb-k-l">${label}</span><i></i><span class="fb-k-b">${BUSINESS[id] ?? ''}</span>`
    sec.append(kicker)
    // the head of the sheet: the island emblem beside the hero copy
    if (i === 0) {
      const emb = document.createElement('div')
      emb.className = 'fb-emblem'
      emb.setAttribute('aria-hidden', 'true')
      emb.innerHTML = islandSvg('fb-isl', { water: 6 })
      sec.append(emb)
    }
    sec.append(copy)
    root.appendChild(sec)
  })
  const isl = root.querySelector<SVGSVGElement>('.fb-isl')
  if (isl) sizeIsland(isl)

  const foot = document.createElement('footer')
  foot.className = 'fb-foot'
  foot.innerHTML = `
    <span class="fb-foot-mark" aria-hidden="true">${markSvg('fb-foot-svg')}</span>
    <p class="fb-foot-t">${BRAND.tagline}</p>
    <p class="fb-foot-m" aria-hidden="true"><span>Contour interval 20 m</span><span class="fb-scale"><i></i><i></i><i></i><i></i></span><span>${SHEET.scale}</span></p>`
  root.appendChild(foot)

  // open at the chapter asked for, the one the live story was on, or the #hash
  const ids = [...root.querySelectorAll<HTMLElement>('.fb-sec')].map(el => el.id)
  let hash = ''
  try {
    hash = decodeURIComponent(location.hash.slice(1))
  } catch {
    /* malformed hash */
  }
  const target = [at, liveChapter, hash].find(id => !!id && ids.includes(id)) ?? ''
  const place = () => {
    const sec = target && target !== ids[0] ? document.getElementById(target) : null
    if (sec) sec.scrollIntoView({ block: 'start' })
    else if (liveChapter || at) window.scrollTo(0, 0) // taking over mid-visit: start at the top
  }
  place()
  // once more after layout settles (fonts, the banner) so the heading sits exactly at the top
  requestAnimationFrame(() => requestAnimationFrame(place))
  document.fonts?.ready.then(() => requestAnimationFrame(place)).catch(() => {})

  // "View the live site" returns to the section being read
  const liveLink = header.querySelector<HTMLAnchorElement>('.fb-live')
  if (liveLink) {
    const secs = [...root.querySelectorAll<HTMLElement>('.fb-sec')]
    let raf = 0
    let last = ''
    const sync = () => {
      raf = 0
      const line = innerHeight * 0.35
      let id = secs[0]?.id ?? ''
      for (const el of secs) if (el.getBoundingClientRect().top <= line) id = el.id
      // scrolled to the end: the last section, even when it cannot reach the line
      const doc = document.documentElement
      if (secs.length && scrollY + innerHeight >= doc.scrollHeight - 4) id = secs[secs.length - 1].id
      if (id === last) return
      last = id
      liveLink.setAttribute('href', id && id !== secs[0]?.id ? `${liveBase}#${id}` : liveBase)
    }
    addEventListener(
      'scroll',
      () => {
        if (!raf) raf = requestAnimationFrame(sync)
      },
      { passive: true },
    )
    requestAnimationFrame(sync)
  }
}
