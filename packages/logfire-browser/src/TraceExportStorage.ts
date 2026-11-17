const PREFIX = 'logfire:traces:v1:'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_RECORDS = 32
const MAX_AGE_MS = 5 * 60_000

interface StoredRequest {
  body: string
  createdAt: number
}

export interface StoredTraceRequest extends StoredRequest {
  key: string
}

/** Each request has its own key, so an old document's acknowledgment cannot erase newer writes. */
export class TraceExportStorage {
  private readonly prefix: string
  private readonly storage: Storage

  constructor(storage: Storage, scope: string) {
    this.storage = storage
    this.prefix = `${PREFIX}${scope}:`
  }

  read(): StoredTraceRequest[] {
    return this.readAll().filter(({ key }) => key.startsWith(this.prefix))
  }

  save(body: string): string | undefined {
    try {
      const value = JSON.stringify({ body, createdAt: Date.now() } satisfies StoredRequest)
      const key = `${this.prefix}${crypto.randomUUID()}`
      // Web Storage stores UTF-16 strings. Include keys, envelopes, and escaped payloads.
      const bytes = (key.length + value.length) * 2
      if (bytes > MAX_BYTES) {
        return undefined
      }
      const records = this.readAll()
      let total = records.reduce((sum, record) => sum + (record.key.length + (this.storage.getItem(record.key)?.length ?? 0)) * 2, 0)
      while (records.length >= MAX_RECORDS || total + bytes > MAX_BYTES) {
        const oldest = records.shift()
        if (oldest === undefined) {
          break
        }
        total -= (oldest.key.length + (this.storage.getItem(oldest.key)?.length ?? 0)) * 2
        this.storage.removeItem(oldest.key)
      }
      this.storage.setItem(key, value)
      return key
    } catch {
      // Storage denial or quota exhaustion must never prevent the normal export.
      return undefined
    }
  }

  remove(key: string): void {
    try {
      this.storage.removeItem(key)
    } catch {
      // A later startup can retry the copy if storage access becomes available again.
    }
  }

  private readAll(): StoredTraceRequest[] {
    const records: StoredTraceRequest[] = []
    try {
      const keys = Array.from({ length: this.storage.length }, (_, index) => this.storage.key(index))
      const now = Date.now()
      for (const key of keys) {
        if (key === null || !key.startsWith(PREFIX)) {
          continue
        }
        try {
          const record = JSON.parse(this.storage.getItem(key) ?? 'null') as Partial<StoredRequest> | null
          if (
            record === null ||
            typeof record.body !== 'string' ||
            typeof record.createdAt !== 'number' ||
            !Number.isFinite(record.createdAt) ||
            record.createdAt > now ||
            now - record.createdAt >= MAX_AGE_MS ||
            record.body.length * 2 > MAX_BYTES ||
            !Array.isArray((JSON.parse(record.body) as { resourceSpans?: unknown }).resourceSpans)
          ) {
            this.remove(key)
            continue
          }
          records.push({ key, body: record.body, createdAt: record.createdAt })
        } catch {
          this.remove(key)
        }
      }
    } catch {
      return []
    }
    return records.sort((a, b) => a.createdAt - b.createdAt)
  }
}
