import { diag } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import type { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-web'

import { DEFAULT_EXPORT_CONCURRENCY_LIMIT } from './DocumentHideChunkingExporter'
import { recoverTraceRequest } from './recoverTraceRequest'
import { TraceExportStorage } from './TraceExportStorage'
import type { StoredTraceRequest } from './TraceExportStorage'

export interface BrowserTracePersistenceOptions {
  /** Extra isolation for proxies whose destination depends on cookies or other state outside request headers. */
  key?: string
}

interface ActiveExport {
  done: Promise<void>
  saved?: { storage: TraceExportStorage; key: string }
}

type ExporterFactory = (headers: () => Promise<Record<string, string>>, url: string) => SpanExporter
type ExporterConfig = NonNullable<ConstructorParameters<typeof OTLPTraceExporter>[0]> & { url: string }

/** Optional at-least-once recovery. Lost acknowledgments can cause duplicate delivery. */
export class RecoveringSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter
  private readonly createExporter: ExporterFactory
  private readonly live = new Set<ActiveExport>()
  private readonly recovering = new Map<Promise<void>, AbortController>()
  private readonly identities = new Map<string, Promise<TraceExportStorage | undefined>>()
  private readonly url: string
  private readonly config: ExporterConfig
  private readonly resolveHeaders: () => Promise<Record<string, string>>
  private readonly persistence: BrowserTracePersistenceOptions
  private readonly locks: LockManager | undefined
  private readonly lockWaits = new Set<AbortController>()
  private owner = ''
  private ownerReady: Promise<boolean> | undefined
  private releaseOwner: (() => void) | undefined
  private recovery: Promise<void> | undefined
  private closed = false
  private stop!: () => void
  private readonly stopped = new Promise<void>((resolve) => {
    this.stop = resolve
  })

  constructor(
    createExporter: ExporterFactory,
    config: ExporterConfig,
    resolveHeaders: () => Promise<Record<string, string>>,
    persistence: BrowserTracePersistenceOptions = {}
  ) {
    this.config = config
    this.createExporter = createExporter
    this.resolveHeaders = resolveHeaders
    this.persistence = persistence
    try {
      this.url = new URL(config.url, (globalThis as { location?: Location }).location?.href).href
    } catch {
      this.url = config.url
    }
    try {
      this.locks = (globalThis.navigator as Navigator | undefined)?.locks
    } catch {
      this.locks = undefined
    }
    // The same absolute URL is used by every live request, even after SPA navigation.
    this.inner = createExporter(resolveHeaders, this.url)
  }

  /** Called only after configure succeeds. Does not hold up public forceFlush(). */
  async startRecovery(): Promise<void> {
    this.recovery ??= this.recover()
    return this.recovery
  }

  get pendingExports(): number {
    return this.live.size + this.recovering.size
  }

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    if (this.closed) {
      callback({ code: ExportResultCode.FAILED, error: new Error('Trace exporter is closed') })
      return
    }
    const accepted = this.live.size < this.limit
    let done!: () => void
    const entry: ActiveExport = {
      done: new Promise<void>((resolve) => {
        done = resolve
      }),
    }
    this.live.add(entry)
    const settle = (result: ExportResult) => {
      if (!this.live.delete(entry)) {
        return
      }
      if (result.code === ExportResultCode.SUCCESS && entry.saved !== undefined) {
        entry.saved.storage.remove(entry.saved.key)
      }
      done()
      callback(result)
    }
    // Live exports take priority, including when concurrencyLimit is one.
    const preempted = accepted && this.pendingExports > this.limit ? [...this.recovering.entries()] : []
    for (const [, controller] of preempted) {
      controller.abort()
    }
    this.exportLive(
      spans,
      entry,
      accepted,
      preempted.map(async ([promise]) => promise),
      settle
    ).catch((error: unknown) => {
      settle({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
    })
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.live].map(async ({ done }) => done))
    await this.inner.forceFlush?.()
  }

  async shutdown(): Promise<void> {
    this.closed = true
    this.stop()
    for (const controller of this.lockWaits) {
      controller.abort()
    }
    for (const controller of this.recovering.values()) {
      controller.abort()
    }
    await this.forceFlush()
    await Promise.all([...this.recovering.keys()])
    this.releaseOwner?.()
    await this.inner.shutdown()
  }

  private get limit(): number {
    return this.config.concurrencyLimit ?? DEFAULT_EXPORT_CONCURRENCY_LIMIT
  }

  private async exportLive(
    spans: ReadableSpan[],
    entry: ActiveExport,
    accepted: boolean,
    preempted: Promise<void>[],
    settle: (result: ExportResult) => void
  ): Promise<void> {
    await Promise.all(preempted)
    if (!(await this.ensureOwner())) {
      if (accepted) {
        this.inner.export(spans, settle)
      } else {
        settle({ code: ExportResultCode.FAILED, error: new Error('Trace export concurrency limit reached') })
      }
      return
    }
    const { headers, storage } = await this.headers()
    if (storage !== undefined) {
      try {
        const bytes = JsonTraceSerializer.serializeRequest(spans)
        if (bytes !== undefined) {
          const key = storage.save(new TextDecoder().decode(bytes))
          if (key !== undefined) {
            entry.saved = { storage, key }
          }
        }
      } catch {
        // The normal exporter remains responsible for reporting serialization failures.
      }
    }
    if (!accepted) {
      settle({ code: ExportResultCode.FAILED, error: new Error('Trace export concurrency limit reached') })
      return
    }
    const exporter = this.createExporter(async () => Promise.resolve(headers), this.url)
    exporter.export(spans, (result) => {
      exporter.shutdown().then(
        () => {
          settle(result)
        },
        (error: unknown) => {
          settle({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
        }
      )
    })
  }

  private async ensureOwner(): Promise<boolean> {
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
    if (this.closed || subtle === undefined || this.locks === undefined) {
      return Promise.resolve(false)
    }
    if (this.ownerReady !== undefined) {
      return this.ownerReady
    }
    const owner = `logfire:trace-owner:${crypto.randomUUID()}`
    this.owner = owner
    this.identities.clear()
    const locks = this.locks
    this.ownerReady = new Promise<boolean>((resolve) => {
      locks
        .request(owner, {}, async () => {
          if (this.closed) {
            resolve(false)
            return
          }
          await new Promise<void>((release) => {
            this.releaseOwner = release
            resolve(true)
          })
        })
        .catch(() => {
          if (this.owner === owner) {
            this.ownerReady = undefined
            this.identities.clear()
          }
          resolve(false)
        })
    })
    return this.ownerReady
  }

  private async headers(): Promise<{ headers: Record<string, string>; storage: TraceExportStorage | undefined }> {
    const headers = { ...(await this.resolveHeaders()) }
    const signature = JSON.stringify([this.url, this.persistence.key ?? '', [...new Headers(headers).entries()].sort()])
    let identity = this.identities.get(signature)
    if (identity === undefined) {
      const owner = this.owner
      identity = crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(signature))
        .then((digest) => {
          const scope = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
          try {
            return new TraceExportStorage(sessionStorage, scope, owner)
          } catch {
            return undefined
          }
        })
        .catch(() => undefined)
      if (this.identities.size >= 16) {
        const oldest = this.identities.keys().next().value
        if (oldest !== undefined) {
          this.identities.delete(oldest)
        }
      }
      this.identities.set(signature, identity)
    }
    // Await this request's identity, not a shared mutable promise or storage field.
    return { headers, storage: await identity }
  }

  private async whileOpen<T>(promise: Promise<T>): Promise<T | undefined> {
    return Promise.race([promise, this.stopped.then(() => undefined)])
  }

  private async recover(): Promise<void> {
    if (!(await this.ensureOwner())) {
      return
    }
    const identity = await this.whileOpen(this.headers())
    if (identity?.storage === undefined || this.closed) {
      return
    }
    const storage = identity.storage
    const groups = new Map<string, StoredTraceRequest[]>()
    for (const record of storage.read()) {
      if (record.owner === this.owner) {
        continue
      }
      const group = groups.get(record.owner) ?? []
      group.push(record)
      groups.set(record.owner, group)
    }
    await Promise.all([...groups].map(async ([owner, records]) => this.recoverOwner(owner, records, storage)))
  }

  private async recoverOwner(owner: string, records: StoredTraceRequest[], storage: TraceExportStorage): Promise<void> {
    const wait = new AbortController()
    this.lockWaits.add(wait)
    // A departing document's lock may take a short time to be released by the browser.
    const timer = setTimeout(() => {
      wait.abort()
    }, 1_000)
    try {
      await this.locks?.request(owner, { signal: wait.signal }, async () => {
        clearTimeout(timer)
        if (this.closed) {
          return
        }
        await Promise.all(records.map(async (record) => this.recoverOne(record, storage)))
      })
    } catch (error) {
      if (!wait.signal.aborted) {
        diag.warn('logfire-browser: trace recovery lock unavailable', error)
      }
    } finally {
      clearTimeout(timer)
      this.lockWaits.delete(wait)
    }
  }

  private async recoverOne(record: StoredTraceRequest, storage: TraceExportStorage): Promise<void> {
    const identity = await this.whileOpen(this.headers())
    if (identity?.storage?.scope !== storage.scope) {
      return
    }
    while (!this.closed && (this.pendingExports >= this.limit || this.recovering.size >= 4)) {
      // eslint-disable-next-line no-await-in-loop
      await this.whileOpen(Promise.race([...this.live].map(async ({ done }) => done).concat([...this.recovering.keys()])))
    }
    // The original owner may have acknowledged this request while we waited for its lock.
    if (this.closed || !storage.has(record.key)) {
      return
    }
    const controller = new AbortController()
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.recovering.set(done, controller)
    try {
      const result = await recoverTraceRequest(
        this.url,
        record.body,
        identity.headers,
        this.config.timeoutMillis ?? 10_000,
        controller.signal
      )
      if (result === 'success' || result === 'permanent-failure') {
        storage.remove(record.key)
      }
    } finally {
      this.recovering.delete(done)
      finish()
    }
  }
}
