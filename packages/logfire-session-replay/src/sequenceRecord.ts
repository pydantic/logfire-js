const SEQUENCE_RECORD_PREFIX = 'lf_session_replay_seq:'
const PROBE_KEY = 'lf_session_replay_probe'

/**
 * The next sequence of each recording, shared by every document of the origin. Only the document
 * that holds a recording's lock writes its record. Each document's `sessionStorage` sequence is a
 * copy that a duplicated tab inherits, so it cannot show what another document already uploaded.
 */
export class SequenceRecords {
  private readonly storage: Storage
  private readonly now: () => number

  constructor(storage: Storage, now: () => number) {
    this.storage = storage
    this.now = now
  }

  read(recordingId: string): number | undefined {
    try {
      return parseRecord(this.storage.getItem(recordKey(recordingId)))?.seq
    } catch {
      return undefined
    }
  }

  /** Write the next sequence and read it back. A failed or silently discarded write returns false. */
  write(recordingId: string, seq: number): boolean {
    try {
      this.storage.setItem(recordKey(recordingId), JSON.stringify({ seq, at: this.now() }))
      return this.read(recordingId) === seq
    } catch {
      return false
    }
  }

  /** Remove records that were last written more than `maxAgeMs` ago, or that cannot be parsed. */
  prune(maxAgeMs: number): void {
    try {
      const oldest = this.now() - maxAgeMs
      const stale: string[] = []
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index)
        if (key === null || !key.startsWith(SEQUENCE_RECORD_PREFIX)) {
          continue
        }
        const record = parseRecord(this.storage.getItem(key))
        if (record === undefined || record.at < oldest) {
          stale.push(key)
        }
      }
      for (const key of stale) {
        this.storage.removeItem(key)
      }
    } catch {
      // A stale record only costs storage space; it never resumes an expired recording.
    }
  }
}

/** `localStorage`, when this document can write to it and read the value back. */
export function writableLocalStorage(): Storage | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    if (storage === undefined) {
      return null
    }
    storage.setItem(PROBE_KEY, '1')
    const readable = storage.getItem(PROBE_KEY) === '1'
    storage.removeItem(PROBE_KEY)
    return readable ? storage : null
  } catch {
    return null
  }
}

function recordKey(recordingId: string): string {
  return `${SEQUENCE_RECORD_PREFIX}${recordingId}`
}

function parseRecord(raw: string | null): { seq: number; at: number } | undefined {
  if (raw === null) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined
    }
    const value = parsed as { seq?: unknown; at?: unknown }
    if (
      typeof value.seq !== 'number' ||
      !Number.isSafeInteger(value.seq) ||
      value.seq < 0 ||
      typeof value.at !== 'number' ||
      !Number.isFinite(value.at)
    ) {
      return undefined
    }
    return { seq: value.seq, at: value.at }
  } catch {
    return undefined
  }
}
