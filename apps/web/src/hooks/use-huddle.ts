/**
 * One huddle at a time, per tab (docs/build-plan-calls.md D13).
 *
 * The room is global chrome: the bar has to survive a route change, so the LiveKit connection
 * lives in a context mounted by the app shell rather than in whatever route started it.
 * Joining a second huddle leaves the first — two rooms means two microphones.
 *
 * `HuddleProvider` is written with `createElement` so this stays one `.ts` file next to the
 * hook it exists for; it renders nothing but its children.
 */
import * as React from 'react'
import type { Call, CallId, ChannelId } from '@taut/contract'

import { useCurrentUser, useDmViews } from '@/hooks/use-directory'
import { useActiveCalls, useCallsConfig, useJoinCall, useLeaveCall } from '@/lib/api'
import { delegatesHuddle, desktop, huddlePath } from '@/lib/desktop'
import { loadDevicePreference } from '@/lib/devices'
import { EMPTY_SNAPSHOT, HuddleRoom, type RoomSnapshot } from '@/lib/livekit'
import { createRosterSounds, playSound, startRing, stopRing } from '@/lib/sounds'

/**
 * What the pre-join dialog decided (docs/build-plan-huddle-window.md D1): nothing reaches the
 * server until Start Huddle is pressed, and what it publishes on arrival is this.
 */
export interface HuddleIntent {
  readonly mic: boolean
  readonly camera: boolean
}

export interface HuddleState {
  /**
   * The single gate (D3). `false` — no LiveKit configured on this deployment — hides every
   * huddle affordance in the app, so no component needs its own opinion about it.
   */
  readonly enabled: boolean
  /** The huddle this tab is in, if any. */
  readonly call: Call | undefined
  readonly room: RoomSnapshot
  /** The channel whose join is in flight, so its button can say so. */
  readonly joining: ChannelId | undefined
  readonly join: (channelId: ChannelId, intent: HuddleIntent) => void
  readonly leave: () => void
  readonly toggleMic: () => void
  readonly toggleCamera: () => void
  readonly toggleScreenShare: () => void
}

const IDLE: HuddleState = {
  enabled: false,
  call: undefined,
  room: EMPTY_SNAPSHOT,
  joining: undefined,
  join: () => undefined,
  leave: () => undefined,
  toggleMic: () => undefined,
  toggleCamera: () => undefined,
  toggleScreenShare: () => undefined
}

const HuddleContext = React.createContext<HuddleState>(IDLE)

export function HuddleProvider({ children }: { children: React.ReactNode }) {
  const enabled = useCallsConfig().data?.enabled === true
  const [room] = React.useState(() => new HuddleRoom())
  const snapshot = React.useSyncExternalStore(room.subscribe, room.getSnapshot)

  const [call, setCall] = React.useState<Call | undefined>(undefined)
  const [joining, setJoining] = React.useState<ChannelId | undefined>(undefined)

  const joinCall = useJoinCall()
  const leaveCall = useLeaveCall()
  const requestJoin = joinCall.mutateAsync
  const requestLeave = leaveCall.mutate

  // Callbacks below must not be rebuilt every time the call changes, or every huddle button
  // in the tree re-renders on every participant event.
  const callRef = React.useRef<Call | undefined>(undefined)
  React.useEffect(() => {
    callRef.current = call
  }, [call])

  const detach = React.useCallback(
    async (notify: boolean): Promise<void> => {
      const current = callRef.current
      callRef.current = undefined
      setCall(undefined)
      // Your own pop-out (D14a). Before the teardown, because in the shell's huddle window the
      // renderer that would play it is closing behind us.
      if (current !== undefined) playSound('leave')
      await room.disconnect()
      // The webhook settles the truth (D2); this only makes everyone else's bar instant.
      if (notify && current !== undefined) requestLeave(current.id)
    },
    [room, requestLeave]
  )

  const join = React.useCallback(
    (channelId: ChannelId, intent: HuddleIntent): void => {
      if (callRef.current?.channelId === channelId) return
      /*
       * Inside the shell's main window the huddle belongs to a second renderer (D6): hand the
       * path over and stop here. Nothing is requested from the server and no track is opened,
       * so there is no way to end up with the same person in the room twice.
       */
      if (delegatesHuddle()) {
        desktop?.openHuddle(huddlePath(channelId, intent))
        return
      }
      setJoining(channelId)
      void (async () => {
        try {
          await detach(true)
          // Capture defaults have to be in place before the room publishes anything (D3).
          room.setDevices(loadDevicePreference())
          const credentials = await requestJoin(channelId)
          // The Electron shell is default-deny per origin and the SFU is usually a second
          // host, so it has to be named before the signalling socket is opened. No-op in a
          // browser (docs/build-plan-calls.md).
          window.taut?.allowMediaOrigin(credentials.url)
          await room.connect(credentials.url, credentials.token, () => {
            // Dropped without us asking — a dead network, or the same user joining from a
            // second device, which LiveKit resolves by evicting the older one (D6). Still a
            // huddle ending under you, so it sounds like one.
            callRef.current = undefined
            setCall(undefined)
            playSound('leave')
          })
          callRef.current = credentials.call
          setCall(credentials.call)
          // Your own pop-in: starting a huddle and joining one are the same arrival, and both
          // land here. In the shell this is the huddle window, never the main one, so the
          // sound plays once however many renderers are open (D6).
          playSound('join')
          // The dialog already asked (D1): its toggles decide what is published here. A
          // refused prompt leaves us listen-only rather than out of the room; `room.micDenied`
          // is what the bar shows for it.
          await room.setMicEnabled(intent.mic)
          if (intent.camera) await room.setCameraEnabled(true)
        } catch {
          // `mutationCache.onError` already raised the toast; nothing left to say.
          await room.disconnect()
        } finally {
          setJoining(undefined)
        }
      })()
    },
    [detach, requestJoin, room]
  )

  const leave = React.useCallback((): void => {
    void detach(true)
  }, [detach])

  const toggleMic = React.useCallback((): void => {
    void room.setMicEnabled(!room.getSnapshot().micEnabled)
  }, [room])

  const toggleCamera = React.useCallback((): void => {
    void room.setCameraEnabled(!room.getSnapshot().cameraEnabled)
  }, [room])

  const toggleScreenShare = React.useCallback((): void => {
    void room.setScreenShareEnabled(!room.getSnapshot().screenShareEnabled)
  }, [room])

  // Closing the tab is a hard leave; the webhook cleans up the room either way.
  React.useEffect(
    () => () => {
      void room.disconnect()
    },
    [room]
  )

  /*
   * Someone *else* arriving in or leaving this huddle (D14a). The diff is fed the remote
   * identities only — your own join and leave are played by `join` and `detach` above, where
   * they happen — and `undefined` whenever the room is not connected, which re-seeds it so the
   * next connect is silent however many people are already in the room.
   */
  const [roster] = React.useState(() => createRosterSounds())
  React.useEffect(() => {
    roster(
      snapshot.connection === 'connected'
        ? snapshot.participants
            .filter((participant) => !participant.local)
            .map((participant) => participant.identity)
        : undefined
    )
  }, [roster, snapshot])

  const value = React.useMemo<HuddleState>(
    () => ({
      enabled,
      call,
      room: snapshot,
      joining,
      join,
      leave,
      toggleMic,
      toggleCamera,
      toggleScreenShare
    }),
    [enabled, call, snapshot, joining, join, leave, toggleMic, toggleCamera, toggleScreenShare]
  )

  return React.createElement(HuddleContext.Provider, { value }, children)
}

export function useHuddle(): HuddleState {
  return React.useContext(HuddleContext)
}

/**
 * The open huddle in a channel, whoever is in it — what the headphones button and the
 * sidebar dot read. Empty whenever calls are off, so both hide themselves (D3).
 */
export function useChannelCall(channelId: string | undefined): Call | undefined {
  const { enabled } = useHuddle()
  const calls = useActiveCalls(enabled).data
  if (channelId === undefined) return undefined
  return calls?.find((entry) => entry.channelId === channelId)
}

const inCall = (call: Call, userId: string | undefined): boolean =>
  userId !== undefined &&
  call.participants.some((participant) => participant.kind === 'user' && participant.id === userId)

/**
 * The huddle this user is in *somewhere else* — the shell's huddle window (D7).
 *
 * The server already knows who is in a room (calls D2), so the main window renders its
 * "Return to huddle" bar from the active-call list rather than holding a room of its own.
 * Empty in a plain browser, where the tab that joined is the tab you are looking at (D5).
 */
export function useElsewhereCall(): Call | undefined {
  const { enabled } = useHuddle()
  const calls = useActiveCalls(enabled).data
  const me = useCurrentUser()

  return React.useMemo(() => {
    if (!enabled || !delegatesHuddle()) return undefined
    return calls?.find((call) => inCall(call, me?.id))
  }, [enabled, calls, me?.id])
}

/** A DM huddle somebody started that this user has not answered yet (D11). */
export interface HuddleInvite {
  readonly call: Call
  readonly channelId: ChannelId
}

export interface HuddleInvites {
  readonly invites: readonly HuddleInvite[]
  /** Local only, for Join and Decline alike: there is no declined state on the server. */
  readonly dismiss: (callId: CallId) => void
}

const NO_IDS: ReadonlySet<string> = new Set()

/**
 * Ringing DM invites (D11). A huddle qualifies when it is in a DM this user is a member of,
 * this user is not already in it, and this user did not start it — a channel huddle stays
 * silent (calls D8), and so does one you are standing in.
 *
 * A huddle that was already running when this window opened is not an invitation to answer:
 * the first list seen is a seed, and only a call that appears after it raises a card. The ring
 * follows the cards exactly, so declining, joining, the caller hanging up and this component
 * unmounting all stop it through the same effect.
 */
export function useHuddleInvites(): HuddleInvites {
  const { enabled, call: mine } = useHuddle()
  const calls = useActiveCalls(enabled).data
  const dms = useDmViews()
  const me = useCurrentUser()
  const myId = me?.id

  const [invited, setInvited] = React.useState<ReadonlySet<string>>(NO_IDS)
  /** The previous qualifying set; `undefined` until the first list arrives. */
  const seenRef = React.useRef<ReadonlySet<string> | undefined>(undefined)

  const dmIds = React.useMemo(() => new Set(dms.map((view) => view.channel.id)), [dms])

  const candidates = React.useMemo(
    () =>
      (calls ?? []).filter(
        (call) =>
          dmIds.has(call.channelId) &&
          call.startedById !== myId &&
          call.channelId !== mine?.channelId &&
          !inCall(call, myId)
      ),
    [calls, dmIds, myId, mine?.channelId]
  )

  // A string, so the effect fires when the *set* changes rather than on every participant tick.
  const key = candidates.map((call) => call.id).join(',')

  React.useEffect(() => {
    if (calls === undefined) return
    const ids = new Set(key === '' ? [] : key.split(','))
    const seen = seenRef.current
    seenRef.current = ids
    if (seen === undefined) return

    setInvited((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)))
      for (const id of ids) if (!seen.has(id)) next.add(id)
      const same = next.size === current.size && [...next].every((id) => current.has(id))
      return same ? current : next
    })
  }, [calls, key])

  const invites = React.useMemo(
    () =>
      candidates
        .filter((call) => invited.has(call.id))
        .map((call) => ({ call, channelId: call.channelId })),
    [candidates, invited]
  )

  const ringing = invites.length > 0
  React.useEffect(() => {
    if (!ringing) return
    startRing()
    return stopRing
  }, [ringing])

  const dismiss = React.useCallback((callId: CallId): void => {
    setInvited((current) => {
      if (!current.has(callId)) return current
      const next = new Set(current)
      next.delete(callId)
      return next
    })
  }, [])

  return { invites, dismiss }
}
