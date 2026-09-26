import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'

/*
 * Hark Contour sound: the air above a chart, and a survey that listens
 * (WebAudio only, no files).
 *
 *   wind     a soft air bed: two decorrelated pink-noise streams (left and
 *            right) through slowly wandering band-passes, each swelling on
 *            its own long breath, plus a faint high "air" layer that opens a
 *            touch while you scroll (the drone in flight) and the occasional
 *            slow gust. Each chapter sets its own colour; the storm (shield)
 *            is darker and fuller.
 *   pings    SONAR, very sparse (one every ~12–20 s at rest): a pure sine
 *            blip that falls a hair in pitch, answered by a long ping-pong
 *            echo that darkens as it goes (the survey listening back),
 *            into an open, airy room. Pitches from a calm pentatonic set per
 *            chapter. The chrome's sonar glyph answers each one (onPing).
 *   cut()    a page turn: a short paper rustle (a band-passed noise sweep
 *            with a crinkled envelope) over a soft breath of air, then one
 *            quiet ping in the new chapter's key.
 *   blip()   a small tick: a pencil tap (a tiny noise click + a short sine).
 *   tone()   a pure sine a chapter may ask for (also via 'hark:tone' events).
 *
 * Off by default. Sound only ever starts from a real gesture: the toggle's
 * own click / tap / Enter / Space. A remembered "on" (localStorage) waits for
 * the first real activation (a click or tap, or Enter / Space on a control;
 * never Tab, arrows or scrolling). Faded out and suspended while the tab is
 * hidden. On iOS the audio session is set to "playback" so the silent switch
 * doesn't swallow it. Levels stay very low, behind a gentle compressor.
 */

const STORE_KEY = 'hark-contour:sound'

function stored(): boolean | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

interface Mode {
  /** sonar pitches (MIDI) */
  pings: number[]
  /** wind band centre (Hz) */
  wind: number
  /** wind level multiplier */
  gust: number
  /** seconds between pings at rest: [min, max] */
  every: [number, number]
  /** ping level multiplier */
  level: number
}

const MODES: Record<string, Mode> = {
  hero: { pings: [76, 79, 81, 84], wind: 460, gust: 1, every: [11, 17], level: 1 },
  work: { pings: [74, 76, 79, 81], wind: 500, gust: 0.9, every: [12, 18], level: 0.9 },
  services: { pings: [79, 81, 84, 86], wind: 540, gust: 0.9, every: [12, 18], level: 0.9 },
  // soundings: lower, a touch more often
  voices: { pings: [69, 72, 74, 76], wind: 400, gust: 0.85, every: [10, 16], level: 1 },
  // the storm: darker, fuller wind; rarer, lower pings
  shield: { pings: [64, 67, 69], wind: 300, gust: 1.9, every: [15, 22], level: 0.75 },
  process: { pings: [76, 78, 81, 83], wind: 480, gust: 0.9, every: [12, 18], level: 0.9 },
  contact: { pings: [79, 84, 86, 88], wind: 520, gust: 1, every: [10, 16], level: 1 },
}

const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Spacebar'])
const CONTROL = 'a[href], button, [role="button"], [role="switch"], summary, input, select, textarea'
const MASTER_LEVEL = 0.65
const WIND_LEVEL = 0.07
const TONE_MAX = 0.03
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const rand = (a: number, b: number) => a + Math.random() * (b - a)

function setAudioSession(type: string) {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = type
  } catch {
    /* not supported */
  }
}

export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []
  /** called as each sonar ping sounds (the chrome's glyph answers it) */
  onPing: (() => void)[] = []

  private ctx: AudioContext | null = null
  private master!: GainNode
  private dry!: GainNode
  private room!: GainNode
  private echo!: GainNode
  private windGain!: GainNode
  private windBands: BiquadFilterNode[] = []
  private airGain!: GainNode
  private white: AudioBuffer | null = null
  private toneOsc: OscillatorNode | null = null
  private toneGain: GainNode | null = null

  private chapter = 'hero'
  private modeKey = ''
  private mode: Mode = MODES.hero
  private nextPing = 0
  private nextGust = 0
  private lastAirAt = 0
  private air = 0
  private lastCut = 0
  private lastBlip = 0
  private suspendTimer = 0
  private pingTimers: number[] = []
  private hidden = typeof document !== 'undefined' && document.hidden
  /** a remembered "on" waiting for the first real gesture */
  private armed = false
  private gestureBound = false
  private toneHz = 440
  private toneLevel = 0

  constructor() {
    this.armed = stored() === true
    if (this.armed) this.waitForGesture()
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden
      this.applyRunning()
    })
    window.addEventListener('hark:tone', e => {
      const d = (e as CustomEvent<{ hz?: number; level?: number }>).detail
      if (d && typeof d.hz === 'number') this.tone(d.hz, d.level ?? 0)
    })
  }

  /** was sound on last visit? (it still needs a gesture to start) */
  get remembered() {
    return stored() === true
  }

  /** Flip sound on/off. Call from a user gesture (click / key). */
  toggle() {
    this.armed = false
    this.setEnabled(!this.enabled)
    try {
      localStorage.setItem(STORE_KEY, this.enabled ? '1' : '0')
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }

  /** Follow the story: wind colour per chapter, sparse pings, air from scroll speed. */
  update(frame: Frame, state: EngineState) {
    const slot = state.slots[state.index]
    if (slot) this.chapter = slot.def.id
    const ctx = this.live()
    if (!ctx) return
    if (this.chapter !== this.modeKey) this.setMode(this.chapter, ctx)
    const now = ctx.currentTime
    const v = Math.min(3, Math.abs(frame.velocity || 0))

    // the drone in flight: the high air opens a little while scrolling
    if (now - this.lastAirAt > 0.12) {
      this.lastAirAt = now
      const target = 0.008 + v * 0.006
      if (Math.abs(target - this.air) > 0.001) {
        this.air = target
        this.airGain.gain.setTargetAtTime(target, now, 0.6)
      }
    }

    // a slow gust now and then
    if (!this.nextGust) this.nextGust = now + rand(6, 10)
    if (now >= this.nextGust) {
      const base = WIND_LEVEL * this.mode.gust
      const g = this.windGain.gain
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.setTargetAtTime(base * rand(1.5, 1.9), now, 1.4)
      g.setTargetAtTime(base, now + rand(2.6, 3.6), 1.8)
      this.nextGust = now + rand(9, 15)
    }

    // sonar, very sparse
    if (!this.nextPing) this.nextPing = now + rand(3, 6)
    if (now >= this.nextPing) {
      const p = this.mode.pings
      this.ping(ctx, now + 0.02, p[Math.floor(Math.random() * p.length)], 0.024 * this.mode.level, rand(-0.5, 0.5))
      const [a, b] = this.mode.every
      this.nextPing = now + rand(a, b)
    }
  }

  /** A chapter cut: a page turns (paper rustle), then a soft ping in the new key. */
  cut(_from: number, _to: number) {
    const ctx = this.live()
    if (!ctx || !this.white) return
    const now = ctx.currentTime
    if (now - this.lastCut < 0.5) return
    this.lastCut = now

    // the rustle: band-passed noise sweeping up, with a crinkled envelope
    const src = ctx.createBufferSource()
    src.buffer = this.white
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 0.9
    bp.frequency.setValueAtTime(1700, now)
    bp.frequency.exponentialRampToValueAtTime(4300, now + 0.3)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 900
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    let t = now + 0.012
    g.gain.exponentialRampToValueAtTime(0.03, t)
    // crinkle: a few quick, uneven steps as the sheet bends
    for (let i = 0; i < 9; i++) {
      t += rand(0.018, 0.04)
      g.gain.linearRampToValueAtTime(rand(0.008, 0.042) * (1 - i / 12), t)
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
    src.connect(bp).connect(hp).connect(g)
    const pan = this.panner(ctx, rand(-0.3, 0.3))
    g.connect(pan).connect(this.dry)
    const send = ctx.createGain()
    send.gain.value = 0.3
    g.connect(send).connect(this.room)
    src.start(now, Math.random() * 3)
    src.stop(t + 0.12)

    // the breath of air the page pushes
    const w = ctx.createBufferSource()
    w.buffer = this.white
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 420
    const wg = ctx.createGain()
    wg.gain.setValueAtTime(0.0001, now)
    wg.gain.exponentialRampToValueAtTime(0.05, now + 0.12)
    wg.gain.exponentialRampToValueAtTime(0.0001, now + 0.55)
    w.connect(lp).connect(wg).connect(this.dry)
    w.start(now, Math.random() * 3)
    w.stop(now + 0.6)

    // then one quiet ping in the new chapter's key
    const m = MODES[this.chapter] ?? this.mode
    this.ping(ctx, now + 0.34, m.pings[0], 0.014 * m.level, 0, false)
  }

  /** A small tick (nav, buttons): a pencil tap. `pitch` lifts it a little. No-op while off. */
  blip(pitch = 0) {
    const ctx = this.live()
    if (!ctx || !this.white) return
    const now = ctx.currentTime
    if (now - this.lastBlip < 0.06) return
    this.lastBlip = now
    const p = Math.max(0, Math.min(12, Math.round(pitch)))
    // the tap
    const n = ctx.createBufferSource()
    n.buffer = this.white
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 3200
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.0001, now)
    ng.gain.exponentialRampToValueAtTime(0.028, now + 0.002)
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.025)
    n.connect(hp).connect(ng).connect(this.dry)
    n.start(now, Math.random() * 3)
    n.stop(now + 0.04)
    // the lead's tiny ring
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.value = 1900 * Math.pow(2, p / 24)
    const og = ctx.createGain()
    og.gain.setValueAtTime(0.0001, now)
    og.gain.exponentialRampToValueAtTime(0.01, now + 0.003)
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.08)
    o.connect(og).connect(this.dry)
    o.start(now)
    o.stop(now + 0.1)
  }

  /** A pure sine a chapter may ask for: level 0..1 (0 releases it). */
  tone(hz: number, level: number) {
    if (Number.isFinite(hz) && hz > 20 && hz < 12000) this.toneHz = hz
    this.toneLevel = clamp01(Number.isFinite(level) ? level : 0)
    this.applyTone()
  }

  /* ------------------------------------------------------------ internals */

  private live() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.hidden || ctx.state !== 'running') return null
    return ctx
  }

  /** Silence for good (the GPU context is gone), without touching the stored preference. */
  stop() {
    this.setEnabled(false)
  }

  private setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    setAudioSession(on ? 'playback' : 'auto')
    if (on) {
      try {
        this.ensureGraph()
      } catch (err) {
        console.warn('[hark] audio unavailable', err)
      }
    }
    this.applyRunning(true)
    for (const fn of this.onChange) fn(on)
  }

  /** Resume + fade in, or fade out + suspend, from enabled / hidden. */
  private applyRunning(greet = false) {
    const ctx = this.ctx
    if (!ctx) return
    clearTimeout(this.suspendTimer)
    const now = ctx.currentTime
    if (this.enabled && !this.hidden) {
      ctx
        .resume()
        .then(() => {
          if (!this.enabled || this.hidden) return
          if (ctx.state !== 'running') return this.waitForGesture()
          const t = ctx.currentTime
          this.master.gain.cancelScheduledValues(t)
          this.master.gain.setValueAtTime(this.master.gain.value, t)
          this.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.8)
          this.modeKey = ''
          this.setMode(this.chapter, ctx)
          this.applyTone()
          this.nextPing = t + rand(4, 7)
          // "on": one sonar ping, the survey saying hello
          if (greet) this.ping(ctx, t + 0.12, this.mode.pings[1] ?? this.mode.pings[0], 0.022, -0.2)
        })
        .catch(() => this.waitForGesture())
    } else {
      for (const id of this.pingTimers) clearTimeout(id)
      this.pingTimers = []
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.setTargetAtTime(0, now, this.hidden ? 0.05 : 0.25)
      this.suspendTimer = window.setTimeout(
        () => {
          if (!this.enabled || this.hidden) ctx.suspend().catch(() => {})
        },
        this.hidden ? 300 : 1300,
      )
    }
  }

  /** Start audio on the first real gesture (a remembered "on", or a blocked resume). */
  private waitForGesture() {
    if (this.gestureBound) return
    this.gestureBound = true
    let sx = 0
    let sy = 0
    const events = ['click', 'keydown', 'touchstart', 'touchend'] as const
    const handler = (e: Event) => {
      if (e.type === 'touchstart') {
        const t = (e as TouchEvent).touches[0]
        if (t) {
          sx = t.clientX
          sy = t.clientY
        }
        return
      }
      if (e.type === 'touchend') {
        // a tap, not a scroll or a swipe
        const t = (e as TouchEvent).changedTouches[0]
        if (!t || Math.hypot(t.clientX - sx, t.clientY - sy) > 12) return
      }
      // keyboard: only Enter / Space on a control is "play"; Tab and friends are just moving around
      if (e instanceof KeyboardEvent) {
        if (!ACTIVATE_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
        if (!(e.target as Element | null)?.closest?.(CONTROL)) return
      }
      for (const ev of events) window.removeEventListener(ev, handler, true)
      this.gestureBound = false
      const onToggle = (e.target as Element | null)?.closest?.('[data-sound-toggle]')
      if (this.armed) {
        this.armed = false
        // the toggle's own click decides for itself
        if (!onToggle) this.setEnabled(true)
      } else if (this.enabled) this.applyRunning()
    }
    for (const ev of events) window.addEventListener(ev, handler, { capture: true, passive: true })
  }

  private ensureGraph() {
    if (this.ctx) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC({ latencyHint: 'playback' })
    this.ctx = ctx
    const sr = ctx.sampleRate

    // master → high-pass → gentle compression → out
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 45
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -26
    comp.knee.value = 18
    comp.ratio.value = 3
    comp.attack.value = 0.01
    comp.release.value = 0.4
    this.master.connect(hp).connect(comp).connect(ctx.destination)

    this.dry = ctx.createGain()
    this.dry.connect(this.master)

    // an open, airy room: a generated stereo impulse (~2.6 s), bright at first
    const irLen = Math.floor(sr * 2.6)
    const ir = ctx.createBuffer(2, irLen, sr)
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c)
      let lp = 0
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen
        const k = 0.25 + 0.6 * t // the tail darkens slowly
        lp = lp * k + (Math.random() * 2 - 1) * (1 - k)
        d[i] = lp * Math.pow(1 - t, 3) * (i < sr * 0.02 ? i / (sr * 0.02) : 1)
      }
    }
    const verb = ctx.createConvolver()
    verb.buffer = ir
    this.room = ctx.createGain()
    const wet = ctx.createGain()
    wet.gain.value = 1.3
    this.room.connect(verb).connect(wet).connect(this.master)

    // the listening echo: a ping-pong delay whose repeats darken as they go
    this.echo = ctx.createGain()
    const dl = ctx.createDelay(1.5)
    const dr = ctx.createDelay(1.5)
    dl.delayTime.value = 0.41
    dr.delayTime.value = 0.41
    const lpl = ctx.createBiquadFilter()
    const lpr = ctx.createBiquadFilter()
    lpl.type = lpr.type = 'lowpass'
    lpl.frequency.value = 2100
    lpr.frequency.value = 1700
    const fbl = ctx.createGain()
    const fbr = ctx.createGain()
    fbl.gain.value = 0.46
    fbr.gain.value = 0.46
    this.echo.connect(dl)
    dl.connect(lpl).connect(fbl).connect(dr)
    dr.connect(lpr).connect(fbr).connect(dl)
    const merge = ctx.createChannelMerger(2)
    lpl.connect(merge, 0, 0)
    lpr.connect(merge, 0, 1)
    const echoOut = ctx.createGain()
    echoOut.gain.value = 0.7
    merge.connect(echoOut)
    echoOut.connect(this.master)
    const echoVerb = ctx.createGain()
    echoVerb.gain.value = 0.35
    echoOut.connect(echoVerb).connect(this.room)

    // noise: white (rustle, ticks, air) and two decorrelated pinks (the wind)
    const nLen = Math.floor(sr * 6)
    this.white = ctx.createBuffer(1, nLen, sr)
    const wd = this.white.getChannelData(0)
    for (let i = 0; i < nLen; i++) wd[i] = Math.random() * 2 - 1
    const pink = () => {
      const b = ctx.createBuffer(1, nLen, sr)
      const d = b.getChannelData(0)
      let b0 = 0
      let b1 = 0
      let b2 = 0
      for (let i = 0; i < nLen; i++) {
        const w = Math.random() * 2 - 1
        b0 = 0.99765 * b0 + w * 0.099046
        b1 = 0.963 * b1 + w * 0.2965164
        b2 = 0.57 * b2 + w * 1.0526913
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16
      }
      return b
    }

    // the wind: L and R streams through wandering band-passes, each breathing
    this.windGain = ctx.createGain()
    this.windGain.gain.value = WIND_LEVEL
    const windMerge = ctx.createChannelMerger(2)
    this.windBands = [0, 1].map(ch => {
      const src = ctx.createBufferSource()
      src.buffer = pink()
      src.loop = true
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 0.65
      bp.frequency.value = this.mode.wind * (ch ? 1.18 : 1)
      // the band wanders (a slow whistle in the air)
      const wander = ctx.createOscillator()
      wander.frequency.value = ch ? 0.037 : 0.029
      const wAmt = ctx.createGain()
      wAmt.gain.value = 110
      wander.connect(wAmt).connect(bp.frequency)
      wander.start()
      // and swells on its own long breath
      const sw = ctx.createGain()
      sw.gain.value = 0.62
      const br = ctx.createOscillator()
      br.frequency.value = ch ? 0.061 : 0.045
      const brAmt = ctx.createGain()
      brAmt.gain.value = 0.36
      br.connect(brAmt).connect(sw.gain)
      br.start(ctx.currentTime + ch * 2.3)
      src.connect(bp).connect(sw).connect(windMerge, 0, ch)
      src.start(0, ch * 2.7)
      return bp
    })
    windMerge.connect(this.windGain).connect(this.dry)
    const windSend = ctx.createGain()
    windSend.gain.value = 0.18
    this.windGain.connect(windSend).connect(this.room)

    // the high air: faint high-passed hiss, breathing slowly
    const hiss = ctx.createBufferSource()
    hiss.buffer = this.white
    hiss.loop = true
    const hhp = ctx.createBiquadFilter()
    hhp.type = 'highpass'
    hhp.frequency.value = 5200
    const hlp = ctx.createBiquadFilter()
    hlp.type = 'lowpass'
    hlp.frequency.value = 11000
    this.airGain = ctx.createGain()
    this.air = 0.008
    this.airGain.gain.value = this.air
    const airLfo = ctx.createOscillator()
    airLfo.frequency.value = 0.052
    const airAmt = ctx.createGain()
    airAmt.gain.value = 0.004
    airLfo.connect(airAmt).connect(this.airGain.gain)
    airLfo.start()
    hiss.connect(hhp).connect(hlp).connect(this.airGain).connect(this.panner(ctx, -0.15)).connect(this.dry)
    hiss.start(0, 1.1)

    // a pure tone a chapter may ask for
    this.toneOsc = ctx.createOscillator()
    this.toneOsc.type = 'sine'
    this.toneOsc.frequency.value = this.toneHz
    this.toneGain = ctx.createGain()
    this.toneGain.gain.value = 0
    this.toneOsc.connect(this.toneGain).connect(this.dry)
    this.toneOsc.start()
  }

  private panner(ctx: AudioContext, pan: number): AudioNode {
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      return p
    }
    return ctx.createGain()
  }

  private setMode(id: string, ctx: AudioContext) {
    const m = MODES[id] ?? MODES.hero
    this.modeKey = id
    this.mode = m
    const now = ctx.currentTime
    // the wind changes colour slowly with the chapter
    this.windBands.forEach((bp, ch) => bp.frequency.setTargetAtTime(m.wind * (ch ? 1.18 : 1), now, 1.6))
    this.windGain.gain.setTargetAtTime(WIND_LEVEL * m.gust, now, 1.8)
  }

  /** a sonar ping: a falling sine blip into the listening echo and the room */
  private ping(ctx: AudioContext, at: number, midi: number, level: number, pan: number, notify = true) {
    if (level <= 0) return
    const f = mtof(midi)
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(f * 1.012, at)
    o.frequency.exponentialRampToValueAtTime(f, at + 0.05)
    const o2 = ctx.createOscillator()
    o2.type = 'sine'
    o2.frequency.value = f / 2
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(level, at + 0.005)
    g.gain.exponentialRampToValueAtTime(level * 0.35, at + 0.12)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 1.1)
    const g2 = ctx.createGain()
    g2.gain.value = 0.3
    o.connect(g)
    o2.connect(g2).connect(g)
    const p = this.panner(ctx, pan)
    g.connect(p)
    const d = ctx.createGain()
    d.gain.value = 0.55
    p.connect(d).connect(this.dry)
    const e = ctx.createGain()
    e.gain.value = 0.6
    p.connect(e).connect(this.echo)
    const r = ctx.createGain()
    r.gain.value = 0.4
    p.connect(r).connect(this.room)
    o.start(at)
    o2.start(at)
    o.stop(at + 1.2)
    o2.stop(at + 1.2)
    if (notify && this.onPing.length) {
      const ms = Math.max(0, (at - ctx.currentTime) * 1000)
      const id = window.setTimeout(() => {
        this.pingTimers = this.pingTimers.filter(x => x !== id)
        if (!this.enabled || this.hidden) return
        for (const fn of this.onPing) fn()
      }, ms)
      this.pingTimers.push(id)
    }
  }

  private applyTone() {
    const ctx = this.ctx
    if (!ctx || !this.toneOsc || !this.toneGain) return
    const now = ctx.currentTime
    this.toneOsc.frequency.setTargetAtTime(this.toneHz, now, 0.08)
    this.toneGain.gain.setTargetAtTime(this.toneLevel * TONE_MAX, now, 0.12)
  }
}
