/**
 * Which microphone, speaker and camera this browser uses for huddles
 * (docs/build-plan-huddle-window.md D3).
 *
 * The choice is per-browser, not per-call: the pre-join dialog writes it and whatever joins
 * reads it back, so a headset picked once survives the next huddle, the next reload and the
 * shell's separate huddle window — which is a different renderer with the same origin, and
 * therefore the same `localStorage`.
 *
 * `enumerateDevices` answers with blank labels until the origin holds a camera or microphone
 * permission, so a picker built before the preview stream opens lists three anonymous rows.
 * Every caller enumerates again once the preview is live; a device with no id at all is
 * dropped rather than shown, because there is nothing to select it by.
 */

const STORAGE_KEY = 'taut.huddle.devices'

export interface DevicePreference {
  readonly micId?: string
  readonly speakerId?: string
  readonly cameraId?: string
}

export interface DeviceOption {
  readonly deviceId: string
  readonly label: string
}

export interface DeviceOptions {
  readonly mics: readonly DeviceOption[]
  readonly speakers: readonly DeviceOption[]
  readonly cameras: readonly DeviceOption[]
}

export const NO_DEVICES: DeviceOptions = { mics: [], speakers: [], cameras: [] }

/** Private-mode Safari throws on the whole storage object, not just on write. */
function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

const asId = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

export function loadDevicePreference(): DevicePreference {
  const raw = storage()?.getItem(STORAGE_KEY)
  if (raw === null || raw === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return {
      micId: asId(record['micId']),
      speakerId: asId(record['speakerId']),
      cameraId: asId(record['cameraId'])
    }
  } catch {
    // Someone else's key, or a half-written value. A default device is always better than none.
    return {}
  }
}

export function saveDevicePreference(preference: DevicePreference): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(preference))
  } catch {
    // Storage full or blocked: the choice holds for this session and is forgotten after it.
  }
}

const toOption = (device: MediaDeviceInfo, index: number, fallback: string): DeviceOption => ({
  deviceId: device.deviceId,
  // Blank until a permission is granted — name the row by position rather than showing "".
  label: device.label === '' ? `${fallback} ${index + 1}` : device.label
})

const pick = (
  devices: readonly MediaDeviceInfo[],
  kind: MediaDeviceKind,
  fallback: string
): readonly DeviceOption[] =>
  devices
    .filter((device) => device.kind === kind && device.deviceId !== '')
    .map((device, index) => toOption(device, index, fallback))

/**
 * Everything this browser can capture from or play to. Empty when the page has no
 * `mediaDevices` at all — an insecure origin, or a browser without WebRTC — which is the same
 * as having no choice to offer.
 */
export async function listDevices(): Promise<DeviceOptions> {
  if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) return NO_DEVICES
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return {
      mics: pick(devices, 'audioinput', 'Microphone'),
      speakers: pick(devices, 'audiooutput', 'Speaker'),
      cameras: pick(devices, 'videoinput', 'Camera')
    }
  } catch {
    return NO_DEVICES
  }
}

/**
 * The id to show as selected. A remembered device that has since been unplugged must not leave
 * the picker blank, so the browser's own first entry stands in for it.
 */
export const selectedDevice = (
  options: readonly DeviceOption[],
  preferred: string | undefined
): string | undefined =>
  options.find((option) => option.deviceId === preferred)?.deviceId ?? options[0]?.deviceId

/**
 * Firefox and Safari have no output picker at all: `setSinkId` is simply absent there, and a
 * speaker choice made on one machine must not throw on another (D3).
 */
export async function applySinkId(
  element: HTMLMediaElement,
  speakerId: string | undefined
): Promise<void> {
  if (speakerId === undefined) return
  if (typeof element.setSinkId !== 'function') return
  try {
    await element.setSinkId(speakerId)
  } catch {
    // A stale or forbidden device id. The default output is still a working speaker.
  }
}
