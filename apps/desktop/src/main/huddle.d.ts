/**
 * Open the huddle window on `<instanceUrl><path>`, or re-point and focus the one already open.
 * The instance URL comes from the caller because only `main/index.ts` knows which instance the
 * shell is currently attached to.
 */
export declare const openHuddle: (instanceUrl: string, path: string) => void
/**
 * Closing the window is a hard leave (D13): the page's unload handler disconnects LiveKit and
 * the webhook settles the truth a moment later, so the shell never calls the API itself. That
 * is also why this closes rather than destroys — `destroy()` would skip the renderer's unload
 * handlers and leave a ghost participant in the room until the server timed it out.
 */
export declare const closeHuddle: () => void
