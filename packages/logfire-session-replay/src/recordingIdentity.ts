import { SEQ_STORAGE_KEY } from './transport'
import { uuidv7 } from './uuid'

export const RECORDING_STORAGE_KEY = 'lf_session_replay_recording'
export const RECORDING_OWNER_STORAGE_KEY = 'lf_session_replay_recording_owner'
export const MAX_RECORDING_DURATION_MS: number = 2 * 60 * 60 * 1_000

interface RecordingState {
  id: string
  rumSessionId: string
  startedAt: number
}

/** Tab-scoped replay identity, independent of RUM identity and its sampling decision. */
export class RecordingIdentity {
  private state: RecordingState | undefined
  private storage: Storage | null
  private readonly owner: string
  private readonly now: () => number
  private readonly maxDurationMs: number
  private readonly readOpenerState: () => string | null

  constructor(storage: Storage | null, now: () => number, maxDurationMs: number, readOpenerState: () => string | null = () => null) {
    this.storage = storage
    this.now = now
    this.owner = uuidv7(now)
    this.maxDurationMs = Math.min(maxDurationMs, MAX_RECORDING_DURATION_MS)
    this.readOpenerState = readOpenerState
    try {
      // A live owner's marker is copied into opener/duplicated tabs. Only a
      // document following a released owner may resume its replay and sequence.
      if (storage?.getItem(RECORDING_OWNER_STORAGE_KEY) === null) {
        this.state = this.readResumableState()
      }
      storage?.setItem(RECORDING_OWNER_STORAGE_KEY, this.owner)
      if (storage?.getItem(RECORDING_OWNER_STORAGE_KEY) !== this.owner) {
        this.storage = null
        this.state = undefined
      }
    } catch {
      this.storage = null
      this.state = undefined
    }
  }

  get(rumSessionId: string): string {
    if (this.state !== undefined && this.isCurrent(this.state.id, rumSessionId)) {
      return this.state.id
    }
    this.state = { id: uuidv7(this.now), rumSessionId, startedAt: this.now() }
    try {
      this.storage?.setItem(RECORDING_STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      // A later document cannot resume without a matching persisted sequence.
    }
    return this.state.id
  }

  isCurrent(recordingId: string, rumSessionId: string): boolean {
    const state = this.state
    if (state === undefined) {
      return false
    }
    const now = this.now()
    return (
      state.id === recordingId &&
      state.rumSessionId === rumSessionId &&
      now >= state.startedAt &&
      now - state.startedAt < this.maxDurationMs
    )
  }

  release(): void {
    try {
      if (this.storage?.getItem(RECORDING_OWNER_STORAGE_KEY) === this.owner) {
        this.storage.removeItem(RECORDING_OWNER_STORAGE_KEY)
      }
    } catch {
      // A stale marker fails closed: the next document starts a fresh replay.
    }
  }

  resume(): void {
    try {
      this.state = this.storage?.getItem(RECORDING_OWNER_STORAGE_KEY) === null ? this.readResumableState() : undefined
      this.storage?.setItem(RECORDING_OWNER_STORAGE_KEY, this.owner)
      if (this.storage?.getItem(RECORDING_OWNER_STORAGE_KEY) !== this.owner) {
        this.state = undefined
        this.storage = null
      }
    } catch {
      this.state = undefined
      this.storage = null
    }
  }

  private readResumableState(): RecordingState | undefined {
    const serialized = this.storage?.getItem(RECORDING_STORAGE_KEY)
    const serializedSequence = this.storage?.getItem(SEQ_STORAGE_KEY)
    if (serialized === undefined || serialized === null || serializedSequence === undefined || serializedSequence === null) {
      return undefined
    }
    // An uninstrumented opener can carry a released marker. Its copied state
    // still belongs to the parent tab, not this new browsing context.
    let openerState: string | null = null
    try {
      openerState = this.readOpenerState()
    } catch {
      // Cross-origin navigation can revoke access to the opener, not our own
      // storage. Retain the local marker/sequence checks in that case.
    }
    if (openerState === serialized) {
      return undefined
    }
    const candidate: unknown = JSON.parse(serialized)
    const sequence: unknown = JSON.parse(serializedSequence)
    if (typeof candidate !== 'object' || candidate === null || typeof sequence !== 'object' || sequence === null) {
      return undefined
    }
    const state = candidate as Partial<RecordingState>
    const next = sequence as { id?: unknown; seq?: unknown }
    if (
      typeof state.id !== 'string' ||
      state.id.length === 0 ||
      typeof state.rumSessionId !== 'string' ||
      typeof state.startedAt !== 'number' ||
      !Number.isFinite(state.startedAt) ||
      next.id !== state.id ||
      typeof next.seq !== 'number' ||
      !Number.isSafeInteger(next.seq) ||
      next.seq < 0
    ) {
      return undefined
    }
    return { id: state.id, rumSessionId: state.rumSessionId, startedAt: state.startedAt }
  }
}
