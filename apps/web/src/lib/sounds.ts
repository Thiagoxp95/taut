/**
 * The four sounds Taut makes (docs/build-plan-huddle-window.md D10, D14a).
 *
 * `pop` is a notification addressed to you; `ring` loops while a DM huddle invite is pending;
 * `pop-in` and `pop-out` are anybody arriving in or leaving a huddle you are in — including
 * you, when you start one, join one or leave one. One module, because they share the two
 * things that are easy to get wrong: the autoplay unlock and the mute flag.
 *
 * Browsers refuse `play()` until the page has seen a user gesture, and a refusal is a rejected
 * promise nobody is listening to — so the elements are primed on the first pointer or key
 * event and stay silent until then. Who each sound is *for* is the caller's decision: the
 * huddle provider plays your own arrival and departure, and D14a's roster diff below plays
 * everybody else's, seeded so walking into a full room is silent.
 */

const MUTED_KEY = 'taut.sounds.muted'

const SOURCES = {
  pop: '/sounds/pop.mp3',
  ring: '/sounds/ring.mp3',
  join: '/sounds/pop-in.mp3',
  leave: '/sounds/pop-out.mp3'
} as const

export type SoundName = keyof typeof SOURCES
/** Everything but `ring`, which loops and is started and stopped rather than played. */
export type OneShot = Exclude<SoundName, 'ring'>

const elements = new Map<SoundName, HTMLAudioElement>()
let unlocked = false

function element(name: SoundName): HTMLAudioElement | undefined {
  if (typeof Audio === 'undefined') return undefined
  const existing = elements.get(name)
  if (existing !== undefined) return existing
  const created = new Audio(SOURCES[name])
  created.preload = 'auto'
  created.loop = name === 'ring'
  elements.set(name, created)
  return created
}

export function soundsMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === '1'
  } catch {
    return false
  }
}

export function setSoundsMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTED_KEY, muted ? '1' : '0')
  } catch {
    // Blocked storage: the flag holds for this session only.
  }
  if (muted) stopRing()
}

/**
 * Opens the gate: in a browser on the first gesture, in the Electron shell immediately.
 *
 * Chrome counts a muted `play()`/`pause()` pair as the unlock, so priming every element on that
 * gesture makes the first real sound instant instead of arriving a beat late — and nobody hears
 * the priming itself.
 */
export function armSounds(): void {
  if (unlocked || typeof window === 'undefined') return

  /*
   * The Electron shell does not gate autoplay, and its huddle window never sees a gesture
   * before it needs a sound: the main window opens it and it joins on arrival (huddle-window
   * D6). Waiting for a pointer there would mean a silent huddle, so the shell is unlocked as
   * soon as it is armed and only the browser waits for the gesture.
   */
  if (window.taut !== undefined) {
    unlocked = true
    return
  }

  const unlock = (): void => {
    if (unlocked) return
    unlocked = true
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
    for (const name of Object.keys(SOURCES) as SoundName[]) {
      const audio = element(name)
      if (audio === undefined) continue
      audio.muted = true
      void audio
        .play()
        .then(() => {
          audio.pause()
          audio.currentTime = 0
          audio.muted = false
        })
        .catch(() => {
          audio.muted = false
        })
    }
  }

  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}

export function playSound(name: OneShot): void {
  if (!unlocked || soundsMuted()) return
  const audio = element(name)
  if (audio === undefined) return
  audio.currentTime = 0
  // A second notification while the first is still sounding, a tab going to sleep: neither is
  // worth an unhandled rejection.
  void audio.play().catch(() => undefined)
}

/**
 * How long `pop-out` stays audible, and `0` whenever nothing would be heard anyway.
 *
 * The shell's huddle window closes the moment you leave (huddle-window D13), and a destroyed
 * renderer takes its audio with it — so that close waits this out rather than cutting your own
 * pop-out off mid-pop.
 */
export function leaveSoundDelay(): number {
  return unlocked && !soundsMuted() ? 450 : 0
}

export function startRing(): void {
  if (!unlocked || soundsMuted()) return
  const audio = element('ring')
  if (audio === undefined) return
  if (!audio.paused) return
  audio.currentTime = 0
  void audio.play().catch(() => undefined)
}

export function stopRing(): void {
  const audio = elements.get('ring')
  if (audio === undefined) return
  audio.pause()
  audio.currentTime = 0
}

/**
 * The join/leave half of D14a, as a closure so the caller owns one per room.
 *
 * Feed it the *remote* identities on every snapshot, and `undefined` whenever the room is not
 * connected. The first connected list is a seed and plays nothing — walking into a huddle of
 * five must be silent — and every list after it is diffed by identity rather than by count,
 * so one person arriving as another leaves plays both sounds instead of nothing.
 */
export function createRosterSounds(): (identities: readonly string[] | undefined) => void {
  let known: ReadonlySet<string> | undefined

  return (identities) => {
    if (identities === undefined) {
      // Our own leave, or a drop. Re-seed on the next connect rather than pop for the room.
      known = undefined
      return
    }
    const next = new Set(identities)
    if (known === undefined) {
      known = next
      return
    }
    const previous = known
    known = next

    let arrived = false
    let left = false
    for (const identity of next) if (!previous.has(identity)) arrived = true
    for (const identity of previous) if (!next.has(identity)) left = true

    if (arrived) playSound('join')
    if (left) playSound('leave')
  }
}
