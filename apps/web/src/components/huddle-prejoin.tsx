import * as React from 'react'
import {
  HeadphonesIcon,
  MicIcon,
  MicOffIcon,
  VideoIcon,
  VideoOffIcon,
  Volume2Icon,
  XIcon
} from 'lucide-react'
import type { ChannelId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { cn } from '@taut/ui/lib/utils'

import { EntityAvatar } from '@/components/entity-avatar'
import { useChannel, useCurrentUser, useDmView } from '@/hooks/use-directory'
import { useChannelCall, useHuddle } from '@/hooks/use-huddle'
import {
  listDevices,
  loadDevicePreference,
  saveDevicePreference,
  selectedDevice,
  NO_DEVICES,
  type DeviceOption,
  type DeviceOptions,
  type DevicePreference
} from '@/lib/devices'

/** What the preview managed to open, and the one line shown when it could not. */
interface Preview {
  readonly stream?: MediaStream
  readonly notice?: string
}

function stopStream(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

/**
 * What a failed `getUserMedia` actually means, in the words the person in front of it needs.
 * The generic "no camera" is wrong for most of these: a camera another app is holding, a
 * permission turned off in browser settings and a camera that was unplugged all want different
 * things done about them.
 */
function reasonFor(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera and microphone are blocked for this site — allow them and reopen this.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Your camera is busy in another app. Quit it, then reopen this.'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera found — you will join with video off.'
    default:
      return 'The camera could not be opened — you will join with video off.'
  }
}

/**
 * Opens the preview (D2). Camera *and* microphone are asked for together, because
 * `enumerateDevices` keeps every label blank until the origin holds a permission, so a dialog
 * that asked only for video would list three anonymous devices. The audio track is stopped the
 * moment it arrives: the permission is what we came for, and a live mic in a pre-join dialog is
 * a recording light nobody asked for.
 *
 * A refused or absent camera is not an error here — it costs the picture and nothing else. What
 * it must never cost is the explanation: every failure below comes back as a sentence.
 */
async function openPreview(cameraId: string | undefined): Promise<Preview> {
  if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
    return { notice: 'This browser cannot open a camera.' }
  }

  const attempt = async (id: string | undefined): Promise<MediaStream> => {
    const video: MediaTrackConstraints = id === undefined ? {} : { deviceId: { exact: id } }
    return navigator.mediaDevices.getUserMedia({ audio: true, video })
  }

  let failure: unknown
  try {
    const stream = await attempt(cameraId)
    for (const track of stream.getAudioTracks()) {
      track.stop()
      stream.removeTrack(track)
    }
    return { stream }
  } catch (error) {
    failure = error
  }

  // A remembered camera that has since been unplugged fails `exact` forever, and the dialog
  // would stay black for as long as the preference outlived the device (D3). Ask again for
  // whatever camera this machine does have before giving up on the picture.
  if (cameraId !== undefined) {
    try {
      const stream = await attempt(undefined)
      for (const track of stream.getAudioTracks()) {
        track.stop()
        stream.removeTrack(track)
      }
      return { stream }
    } catch (error) {
      failure = error
    }
  }

  // No camera, or the camera refused. Fall back to asking for the microphone alone, so the
  // device pickers still get their labels and Start Huddle still works.
  try {
    const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true })
    stopStream(audioOnly)
  } catch {
    return { notice: 'Camera and microphone are blocked — you can still join and listen.' }
  }
  return { notice: reasonFor(failure) }
}

function DeviceSelect({
  icon,
  label,
  options,
  value,
  onChange
}: {
  icon: React.ReactNode
  label: string
  options: readonly DeviceOption[]
  value: string | undefined
  onChange: (deviceId: string) => void
}) {
  const empty = options.length === 0
  return (
    <Select value={value ?? ''} onValueChange={onChange} disabled={empty}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className="w-full min-w-0 justify-between bg-muted/50"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left text-xs">
          <SelectValue placeholder={empty ? `No ${label.toLowerCase()}` : label} />
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.deviceId} value={option.deviceId}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The two toggles floating over the preview. Green when live, plain when off, like Slack. */
function PreviewToggle({
  on,
  label,
  onClick,
  children
}: {
  on: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex size-10 items-center justify-center rounded-full shadow-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        on
          ? 'bg-white text-zinc-900 hover:bg-white/90'
          : 'bg-zinc-900/70 text-white hover:bg-zinc-900/85'
      )}
    >
      {children}
    </button>
  )
}

/**
 * The only way into a huddle (docs/build-plan-huddle-window.md D1).
 *
 * Nothing reaches the server until Start Huddle is pressed: Cancel costs one `getUserMedia`
 * and nothing else. The preview runs whenever a camera is available even with the camera
 * toggle off (D2) — the toggle decides what is *published*, not what is shown here — and every
 * track it opened is stopped on close, on Cancel and on unmount, because a camera light left
 * on after a dialog closes is the bug that matters.
 */
export function HuddlePrejoin({
  channelId,
  open,
  onOpenChange
}: {
  channelId: ChannelId
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { join } = useHuddle()
  const channel = useChannel(channelId)
  const dm = useDmView(channelId)
  const openCall = useChannelCall(channelId)
  const me = useCurrentUser()

  const [mic, setMic] = React.useState(true)
  // Off by default, exactly as in the huddle itself (docs/build-plan-calls.md D16).
  const [camera, setCamera] = React.useState(false)
  const [devices, setDevices] = React.useState<DeviceOptions>(NO_DEVICES)
  const [preference, setPreference] = React.useState<DevicePreference>(loadDevicePreference)
  const [preview, setPreview] = React.useState<Preview>({})
  /**
   * The camera opened and is sending nothing. macOS answers a second app's `getUserMedia` with
   * a track that is `live` and perfectly black rather than an error, so without this the dialog
   * is a black rectangle with nothing to say for itself — which is exactly what it did.
   */
  const [blank, setBlank] = React.useState(false)

  const videoRef = React.useRef<HTMLVideoElement>(null)
  /** The live tracks, for the paths that must release them synchronously (Cancel, Start). */
  const streamRef = React.useRef<MediaStream | undefined>(undefined)

  const cameraId = preference.cameraId

  React.useEffect(() => {
    if (!open) return
    let cancelled = false

    void (async () => {
      const opened = await openPreview(cameraId)
      if (cancelled) {
        stopStream(opened.stream)
        return
      }
      streamRef.current = opened.stream
      setPreview(opened)
      // Labels only exist once a permission has been granted, so the pickers are built from a
      // second enumeration rather than the one before the prompt (D3).
      setDevices(await listDevices())
    })()

    return () => {
      cancelled = true
      stopStream(streamRef.current)
      streamRef.current = undefined
      setPreview({})
    }
  }, [open, cameraId])

  React.useEffect(() => {
    const element = videoRef.current
    const stream = preview.stream
    if (element === null) return
    element.srcObject = stream ?? null
    setBlank(false)
    if (stream === undefined) return

    // `autoplay` is not always enough once `srcObject` is assigned from an effect; a refusal
    // here is the browser's, and it leaves the poster black rather than throwing at us.
    void element.play().catch(() => undefined)

    /*
     * A picture, or an explanation. `muted` on a video track means the source is producing no
     * frames — the camera is held by something else — and a track that never reports a size is
     * the same story told differently. Both are silent, so they are polled once, late enough
     * that an ordinary camera has long since started.
     */
    const track = stream.getVideoTracks()[0]
    const check = (): void =>
      setBlank(track === undefined || track.muted || element.videoWidth === 0)
    const timer = window.setTimeout(check, 2500)
    track?.addEventListener('mute', check)
    track?.addEventListener('unmute', check)

    return () => {
      window.clearTimeout(timer)
      track?.removeEventListener('mute', check)
      track?.removeEventListener('unmute', check)
      element.srcObject = null
    }
  }, [preview.stream])

  const choose = React.useCallback((next: DevicePreference): void => {
    setPreference(next)
    saveDevicePreference(next)
  }, [])

  const micId = selectedDevice(devices.mics, preference.micId)
  const speakerId = selectedDevice(devices.speakers, preference.speakerId)
  const selectedCameraId = selectedDevice(devices.cameras, cameraId)

  const name =
    channel?.kind === 'dm'
      ? (dm?.partner?.name ?? dm?.label ?? 'Direct message')
      : `# ${channel?.name ?? 'channel'}`
  const joining = openCall !== undefined
  const title = `${joining ? 'Join' : 'Start'} huddle in ${name}`

  const close = React.useCallback((): void => {
    stopStream(streamRef.current)
    streamRef.current = undefined
    onOpenChange(false)
  }, [onOpenChange])

  const start = React.useCallback((): void => {
    // Released before LiveKit opens its own capture: two streams on one camera is a device the
    // browser may simply refuse the second time.
    stopStream(streamRef.current)
    streamRef.current = undefined
    saveDevicePreference({ micId, speakerId, cameraId: selectedCameraId })
    onOpenChange(false)
    join(channelId, { mic, camera })
  }, [micId, speakerId, selectedCameraId, onOpenChange, join, channelId, mic, camera])

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent showCloseButton={false} className="gap-5 p-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate text-base">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            Choose your microphone, speaker and camera before joining.
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-muted">
          {preview.stream === undefined ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <EntityAvatar
                avatar={me?.avatar}
                kind="user"
                name={me?.name ?? 'You'}
                size="xl"
                className="opacity-90"
              />
              <p className="text-xs text-muted-foreground">
                {preview.notice ?? 'Looking for a camera…'}
              </p>
            </div>
          ) : (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              // A face reads as a mirror; a huddle preview is the one place that is right.
              className="size-full -scale-x-100 bg-black object-cover"
            />
          )}

          {/* Over the video, not instead of it: the frames may still arrive. */}
          {blank ? (
            <div className="absolute inset-x-0 top-0 flex justify-center p-3">
              <p className="rounded-md bg-background/85 px-2.5 py-1.5 text-center text-xs text-muted-foreground">
                Your camera is on but sending no picture. Another app may be using it.
              </p>
            </div>
          ) : null}

          <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-3">
            <PreviewToggle
              on={mic}
              label={mic ? 'Join with microphone on' : 'Join muted'}
              onClick={() => setMic((current) => !current)}
            >
              {mic ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
            </PreviewToggle>
            <PreviewToggle
              on={camera}
              label={camera ? 'Join with camera on' : 'Join with camera off'}
              onClick={() => setCamera((current) => !current)}
            >
              {camera ? <VideoIcon className="size-4" /> : <VideoOffIcon className="size-4" />}
            </PreviewToggle>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <DeviceSelect
            icon={<MicIcon />}
            label="Microphone"
            options={devices.mics}
            value={micId}
            onChange={(deviceId) => choose({ ...preference, micId: deviceId })}
          />
          <DeviceSelect
            icon={<Volume2Icon />}
            label="Speaker"
            options={devices.speakers}
            value={speakerId}
            onChange={(deviceId) => choose({ ...preference, speakerId: deviceId })}
          />
          <DeviceSelect
            icon={<VideoIcon />}
            label="Camera"
            options={devices.cameras}
            value={selectedCameraId}
            onChange={(deviceId) => choose({ ...preference, cameraId: deviceId })}
          />
        </div>

        <DialogFooter className="grid grid-cols-2 gap-3 sm:flex-row">
          <Button type="button" variant="secondary" size="lg" onClick={close}>
            <XIcon />
            Cancel
          </Button>
          <Button
            type="button"
            size="lg"
            className="bg-emerald-600 text-white hover:bg-emerald-600/90"
            onClick={start}
          >
            <HeadphonesIcon />
            {joining ? 'Join Huddle' : 'Start Huddle'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
