/**
 * Power management facade — wraps window.muse.power IPC calls.
 *
 * Centralises preventSleep / allowSleep so callers don't need to
 * repeat the optional-chaining + catch boilerplate.
 */

export function preventSleep(): void {
  window.muse?.power?.preventSleep?.()?.catch?.(() => {})
}

export function allowSleep(): void {
  window.muse?.power?.allowSleep?.()?.catch?.(() => {})
}
