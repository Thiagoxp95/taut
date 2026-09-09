/**
 * The one file in the web client that knows LiveKit exists (docs/build-plan-calls.md D12).
 *
 * `livekit-client` types go in, Taut shapes come out: components see `HuddleParticipant`
 * and `HuddleVideo`, never a `Room`, a `TrackPublication` or an SDK enum. A `RoomSnapshot`
 * is rebuilt on every SDK event and cached, so `useSyncExternalStore` can read it the same
 * way the rest of the app reads `lib/live.ts`.
 *
 * Remote audio is attached here too. LiveKit hands us media tracks, not sound: without an
 * `<audio>` element per subscribed track nobody hears anybody, and that is plumbing no
 * component should carry.
 */
import type { MemberKind } from '@taut/contract'
import {
  ConnectionQuality,
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
  type TrackPublication
} from 'livekit-client'

import { applySinkId, type DevicePreference } from '@/lib/devices'

export type HuddleConnection = 'idle' | 'connecting' | 'connected' | 'reconnecting'

export type SignalQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

/** A video track ready to be shown. `attach` returns its own undo, so effects stay one-liners. */
export interface HuddleVideo {
  readonly sid: string
  readonly source: 'camera' | 'screen'
  readonly attach: (element: HTMLVideoElement) => () => void
}

export interface HuddleParticipant {
  /** `<kind>:<memberId>` as LiveKit sees it (D5). Unique per room, so it keys the list. */
  readonly identity: string
  readonly kind: MemberKind
  /** The Taut member behind the identity — `usr_…` today, `agt_…` reserved. */
  readonly memberId: string
  /** What the token was minted with; the directory name wins wherever we have one. */
  readonly name: string
  readonly local: boolean
  readonly speaking: boolean
  readonly micMuted: boolean
  readonly quality: SignalQuality
  readonly camera: HuddleVideo | undefined
  readonly screen: HuddleVideo | undefined
}

export interface RoomSnapshot {
  readonly connection: HuddleConnection
  /** Local participant first, then remotes in the order LiveKit reports them. */
  readonly participants: readonly HuddleParticipant[]
  readonly micEnabled: boolean
  readonly cameraEnabled: boolean
  readonly screenShareEnabled: boolean
  /**
   * The browser refused the microphone. The huddle is still joined, listen-only — losing the
   * room because a permission prompt was dismissed is worse than being quiet in it.
   */
  readonly micDenied: boolean
}

export const EMPTY_SNAPSHOT: RoomSnapshot = {
  connection: 'idle',
  participants: [],
  micEnabled: false,
  cameraEnabled: false,
  screenShareEnabled: false,
  micDenied: false
}

const CONNECTION: Record<ConnectionState, HuddleConnection> = {
  [ConnectionState.Disconnected]: 'idle',
  [ConnectionState.Connecting]: 'connecting',
  [ConnectionState.Connected]: 'connected',
  [ConnectionState.Reconnecting]: 'reconnecting',
  [ConnectionState.SignalReconnecting]: 'reconnecting'
}

const QUALITY: Record<ConnectionQuality, SignalQuality> = {
  [ConnectionQuality.Excellent]: 'excellent',
  [ConnectionQuality.Good]: 'good',
  [ConnectionQuality.Poor]: 'poor',
  [ConnectionQuality.Lost]: 'lost',
  [ConnectionQuality.Unknown]: 'unknown'
}

/** `user:usr_1` → `{ kind: 'user', id: 'usr_1' }`; anything else stays whole and unmapped. */
export function parseIdentity(identity: string): { kind: MemberKind; memberId: string } {
  const separator = identity.indexOf(':')
  const kind = identity.slice(0, separator)
  if (kind === 'user' || kind === 'agent') {
    return { kind, memberId: identity.slice(separator + 1) }
  }
  return { kind: 'user', memberId: identity }
}

/**
 * One LiveKit room, wrapped. Created once per tab by the huddle provider (D13) and reused:
 * `connect` on a live room replaces whatever it was holding.
 */
export class HuddleRoom {
  #room: Room | null = null
  #snapshot: RoomSnapshot = EMPTY_SNAPSHOT
  #listeners = new Set<() => void>()
  #audio = new Map<string, HTMLMediaElement>()
  /**
   * `trackSid → the shape handed to components`, kept while the underlying track is the same
   * one. A tile re-attaches when its `HuddleVideo` changes identity, so rebuilding these on
   * every speaking change would tear the picture down several times a second.
   */
  #videos = new Map<string, { readonly track: object; readonly video: HuddleVideo }>()
  #micDenied = false
  #onEnded: (() => void) | undefined
  /**
   * What the pre-join dialog picked (docs/build-plan-huddle-window.md D3). Held here rather
   * than read at each call site: capture defaults must be in the `Room` before it publishes
   * anything, and every audio element attached later needs the same speaker.
   */
  #devices: DevicePreference = {}

  constructor() {
    this.subscribe = this.subscribe.bind(this)
    this.getSnapshot = this.getSnapshot.bind(this)
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot(): RoomSnapshot {
    return this.#snapshot
  }

  /**
   * Joins `url` with a room-scoped `token`. `onEnded` fires when the connection goes away
   * without us asking — a network drop past LiveKit's own retries, or the same user joining
   * from a second device (D6) — so the provider can drop the call it is holding.
   */
  async connect(url: string, token: string, onEnded: () => void): Promise<void> {
    await this.disconnect()
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Set before the first publish, or the mic opens on the default device and switches
      // audibly a moment later (D3).
      audioCaptureDefaults: { deviceId: this.#devices.micId },
      videoCaptureDefaults: { deviceId: this.#devices.cameraId }
    })
    this.#room = room
    this.#onEnded = onEnded
    this.#micDenied = false

    const refresh = (): void => this.#refresh()
    room
      .on(RoomEvent.ConnectionStateChanged, refresh)
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ParticipantNameChanged, refresh)
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ConnectionQualityChanged, refresh)
      .on(RoomEvent.TrackSubscribed, (track) => {
        this.#play(track)
        refresh()
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        this.#stop(track)
        refresh()
      })
      .on(RoomEvent.Disconnected, () => {
        // Only a disconnect we did not ask for reaches here with a room still set — our own
        // `disconnect` unsubscribes first. Read the handler before it is cleared.
        if (this.#room !== room) return
        const ended = this.#onEnded
        void this.disconnect()
        ended?.()
      })

    await room.connect(url, token)
    // Joining is always a click, so the gesture that unlocks autoplay is the one we are in.
    await room.startAudio().catch(() => undefined)
    this.#refresh()
  }

  /**
   * The devices this browser chose (D3). Called before `connect`, where it becomes the room's
   * capture defaults, and again whenever the dialog changes one mid-call.
   *
   * The speaker is the odd one out: it is not a capture device, so it reaches the room as a
   * `setSinkId` on every attached audio element, and Firefox and Safari — which have no such
   * method — silently keep the system default instead of failing the switch.
   */
  setDevices(devices: DevicePreference): void {
    this.#devices = devices
    const room = this.#room
    if (room === null) return
    const switchTo = (kind: MediaDeviceKind, deviceId: string | undefined): void => {
      if (deviceId === undefined) return
      // Unplugged between the pick and the switch is not worth ending a call over.
      void room.switchActiveDevice(kind, deviceId).catch(() => undefined)
    }
    switchTo('audioinput', devices.micId)
    switchTo('videoinput', devices.cameraId)
    for (const element of this.#audio.values()) void applySinkId(element, devices.speakerId)
  }

  /** `false` never fails; `true` can, and a refused prompt must not cost the huddle. */
  async setMicEnabled(enabled: boolean): Promise<void> {
    const room = this.#room
    if (room === null) return
    try {
      await room.localParticipant.setMicrophoneEnabled(enabled)
      this.#micDenied = false
    } catch {
      this.#micDenied = enabled
    }
    this.#refresh()
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    const room = this.#room
    if (room === null) return
    // A denied camera is the same non-event as a denied mic: stay in, stay dark (D16).
    await room.localParticipant.setCameraEnabled(enabled).catch(() => undefined)
    this.#refresh()
  }

  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    const room = this.#room
    if (room === null) return
    // Dismissing the picker rejects `getDisplayMedia`; that is a cancel, not an error.
    await room.localParticipant.setScreenShareEnabled(enabled).catch(() => undefined)
    this.#refresh()
  }

  async disconnect(): Promise<void> {
    const room = this.#room
    if (room === null) return
    this.#room = null
    this.#onEnded = undefined
    room.removeAllListeners()
    for (const element of this.#audio.values()) element.remove()
    this.#audio.clear()
    this.#videos.clear()
    await room.disconnect()
    this.#set(EMPTY_SNAPSHOT)
  }

  /** Audio needs an element in the document; video is attached by whoever renders the tile. */
  #play(track: RemoteTrack): void {
    if (track.kind !== Track.Kind.Audio) return
    const element = track.attach()
    element.style.display = 'none'
    document.body.append(element)
    // Each new element starts on the system default, so the chosen speaker is applied per
    // element rather than once per room (D3).
    void applySinkId(element, this.#devices.speakerId)
    this.#audio.set(track.sid ?? element.id, element)
  }

  #stop(track: RemoteTrack): void {
    if (track.kind !== Track.Kind.Audio) return
    for (const element of track.detach()) element.remove()
    if (track.sid !== undefined) this.#audio.delete(track.sid)
  }

  #video(
    publication: TrackPublication | undefined,
    source: 'camera' | 'screen'
  ): HuddleVideo | undefined {
    const track = publication?.videoTrack
    if (publication === undefined || track === undefined) return undefined
    const cached = this.#videos.get(publication.trackSid)
    if (cached !== undefined && cached.track === track) return cached.video
    const video: HuddleVideo = {
      sid: publication.trackSid,
      source,
      attach: (element) => {
        track.attach(element)
        return () => {
          track.detach(element)
        }
      }
    }
    this.#videos.set(publication.trackSid, { track, video })
    return video
  }

  #participant(participant: Participant, local: boolean): HuddleParticipant {
    const microphone = participant.getTrackPublication(Track.Source.Microphone)
    const { kind, memberId } = parseIdentity(participant.identity)
    return {
      identity: participant.identity,
      kind,
      memberId,
      // A token minted without a display name leaves the id as the only thing to show.
      name: participant.name !== undefined && participant.name !== '' ? participant.name : memberId,
      local,
      speaking: participant.isSpeaking,
      // No publication at all sounds the same to a listener as a muted one.
      micMuted: microphone === undefined || microphone.isMuted,
      quality: QUALITY[participant.connectionQuality],
      camera: this.#video(participant.getTrackPublication(Track.Source.Camera), 'camera'),
      screen: this.#video(participant.getTrackPublication(Track.Source.ScreenShare), 'screen')
    }
  }

  #refresh(): void {
    const room = this.#room
    if (room === null) {
      this.#set(EMPTY_SNAPSHOT)
      return
    }
    const local = room.localParticipant
    this.#set({
      connection: CONNECTION[room.state],
      participants: [
        this.#participant(local, true),
        ...[...room.remoteParticipants.values()].map((participant) =>
          this.#participant(participant, false)
        )
      ],
      micEnabled: local.isMicrophoneEnabled,
      cameraEnabled: local.isCameraEnabled,
      screenShareEnabled: local.isScreenShareEnabled,
      micDenied: this.#micDenied
    })
  }

  #set(next: RoomSnapshot): void {
    this.#snapshot = next
    for (const listener of this.#listeners) listener()
  }
}
