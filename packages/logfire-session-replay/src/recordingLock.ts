const RECORDING_LOCK_PREFIX = 'logfire-session-replay:'

/**
 * How long a document waits for a recording's lock. A browser releases the previous document's
 * lock asynchronously during a reload or a back-forward cache restore, so the wait must outlast
 * that release. A copy of another tab's storage waits this long before it starts a new recording.
 */
export const RECORDING_LOCK_WAIT_MS = 1_000

export interface RecordingLock {
  release(): void
}

export type RecordingLockClaim = { kind: 'held'; lock: RecordingLock } | { kind: 'timeout' } | { kind: 'aborted' }

/** The Web Locks manager, when this document can coordinate recording writers through it. */
export function recordingLockManager(): LockManager | undefined {
  try {
    if (typeof window === 'undefined' || !window.isSecureContext) {
      return undefined
    }
    const locks = (globalThis.navigator as Navigator | undefined)?.locks
    return typeof locks?.request === 'function' ? locks : undefined
  } catch {
    return undefined
  }
}

/**
 * Waits up to `waitMs` for the exclusive lock of `recordingId`. `lifecycle` ends the wait when the
 * page hides, the replay stops, or a newer recording supersedes this one. A grant that arrives after
 * that is released at once.
 *
 * Do not call `navigator.locks.query()` near this code: Chromium evicts a back-forward cached page
 * that holds a lock as soon as another page touches the lock, and a query counts.
 */
export async function claimRecordingLock(
  locks: LockManager,
  recordingId: string,
  lifecycle: AbortSignal,
  waitMs: number = RECORDING_LOCK_WAIT_MS
): Promise<RecordingLockClaim> {
  if (lifecycle.aborted) {
    return { kind: 'aborted' }
  }
  // The attempt has its own controller, so the wait bound never aborts the lifecycle.
  const attempt = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    attempt.abort()
  }, waitMs)
  const onLifecycleAbort = (): void => {
    attempt.abort()
  }
  lifecycle.addEventListener('abort', onLifecycleAbort)
  const stopWaiting = (): void => {
    clearTimeout(timer)
    lifecycle.removeEventListener('abort', onLifecycleAbort)
  }

  return new Promise<RecordingLockClaim>((resolve) => {
    let granted = false
    const notGranted = (): void => {
      stopWaiting()
      resolve(timedOut ? { kind: 'timeout' } : { kind: 'aborted' })
    }
    try {
      locks
        .request(`${RECORDING_LOCK_PREFIX}${recordingId}`, { mode: 'exclusive', signal: attempt.signal }, async () => {
          granted = true
          stopWaiting()
          if (lifecycle.aborted) {
            resolve({ kind: 'aborted' })
            return
          }
          await new Promise<void>((release) => {
            resolve({ kind: 'held', lock: { release } })
          })
        })
        .catch(() => {
          // After a grant, a rejection means the browser dropped the held lock, as Safari does when
          // the page enters the back-forward cache. The pagehide path has already released it.
          if (!granted) {
            notGranted()
          }
        })
    } catch {
      notGranted()
    }
  })
}
