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
  return new Promise<RecordingLockClaim>((resolve) => {
    // The claim settles at the wait bound or the lifecycle abort without waiting for the browser to
    // reject the request, and a grant that arrives after the claim settled is released at once.
    let settled = false
    const settle = (claim: RecordingLockClaim): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        lifecycle.removeEventListener('abort', onLifecycleAbort)
        resolve(claim)
      }
    }
    // The attempt has its own controller, so the wait bound never aborts the lifecycle.
    const attempt = new AbortController()
    const timer = setTimeout(() => {
      attempt.abort()
      settle({ kind: 'timeout' })
    }, waitMs)
    const onLifecycleAbort = (): void => {
      attempt.abort()
      settle({ kind: 'aborted' })
    }
    lifecycle.addEventListener('abort', onLifecycleAbort)
    let granted = false
    try {
      locks
        .request(`${RECORDING_LOCK_PREFIX}${recordingId}`, { mode: 'exclusive', signal: attempt.signal }, async () => {
          granted = true
          if (settled || lifecycle.aborted) {
            settle({ kind: 'aborted' })
            return
          }
          await new Promise<void>((release) => {
            settle({ kind: 'held', lock: { release } })
          })
        })
        .catch(() => {
          // After a grant, a rejection means the browser dropped the held lock, as Safari does when
          // the page enters the back-forward cache. The pagehide path has already released it.
          if (!granted) {
            settle({ kind: 'aborted' })
          }
        })
    } catch {
      settle({ kind: 'aborted' })
    }
  })
}
