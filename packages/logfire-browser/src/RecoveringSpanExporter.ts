import { diag } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import type { OTLPExporterConfigBase } from '@opentelemetry/otlp-exporter-base'
import { createLegacyOtlpBrowserExportDelegate } from '@opentelemetry/otlp-exporter-base/browser-http'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-web'

import { DEFAULT_EXPORT_CONCURRENCY_LIMIT } from './DocumentHideChunkingExporter'
import { TraceExportStorage } from './TraceExportStorage'

export interface BrowserTracePersistenceOptions {
  /** Extra isolation for proxies whose destination depends on cookies or other state outside request headers. */
  key?: string
}

interface ActiveExport {
  done: Promise<void>
  saved?: { storage: TraceExportStorage; key: string }
}

type ExporterFactory = (headers: () => Promise<Record<string, string>>) => SpanExporter

function hasWebCrypto(): boolean {
  return (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle !== undefined
}

/** Retains scrubbed OTLP payloads until acknowledged, including requests already in flight at navigation. */
export class RecoveringSpanExporter implements SpanExporter {
  private readonly inner: SpanExporter
  private readonly createExporter: ExporterFactory
  private readonly active = new Set<ActiveExport>()
  private readonly url: string | undefined
  private readonly config: OTLPExporterConfigBase & { url: string }
  private readonly resolveHeaders: () => Promise<Record<string, string>>
  private readonly persistence: BrowserTracePersistenceOptions
  private signature: string | undefined
  private storage: TraceExportStorage | undefined
  private identityReady: Promise<void> = Promise.resolve()
  private recovery: Promise<void> | undefined
  private closed = false

  constructor(
    createExporter: ExporterFactory,
    config: OTLPExporterConfigBase & { url: string },
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
      // Leave URL handling to the configured exporter outside a browser URL context.
      this.url = undefined
    }
    // Preserve immediate exporter configuration validation and the fallback without Web Crypto.
    this.inner = createExporter(resolveHeaders)
  }

  /** Called only after configure succeeds, so failed startup cannot send a previous document's data. */
  startRecovery(): void {
    this.recovery ??= this.recover().catch((error: unknown) => {
      diag.debug('logfire-browser: trace recovery unavailable', error)
    })
  }

  get pendingExports(): number {
    return this.active.size
  }

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    this.send(
      (settle, entry, accepted) => {
        if (!hasWebCrypto() || this.url === undefined) {
          if (accepted) {
            this.inner.export(spans, settle)
          } else {
            settle({ code: ExportResultCode.FAILED, error: new Error('Trace export concurrency limit reached') })
          }
          return
        }
        this.headers()
          .then(({ headers, storage }) => {
            // Persist only after resolving the headers. Each request (and its retries) uses this
            // immutable snapshot, so a slow or rotating header factory cannot cross destinations.
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
            const exporter = this.createExporter(async () => Promise.resolve(headers))
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
          })
          .catch((error: unknown) => {
            settle({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
          })
      },
      undefined,
      callback
    )
  }

  async forceFlush(): Promise<void> {
    await this.recovery
    await Promise.all([...this.active].map(async ({ done }) => done))
    await this.inner.forceFlush?.()
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await this.forceFlush()
    await this.inner.shutdown()
  }

  private async headers(): Promise<{ headers: Record<string, string>; storage: TraceExportStorage | undefined }> {
    const headers = { ...(await this.resolveHeaders()) }
    const signature = JSON.stringify([this.url, this.persistence.key ?? '', [...new Headers(headers).entries()].sort()])
    if (signature !== this.signature) {
      this.signature = signature
      this.storage = undefined
      this.identityReady = crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(signature))
        .then((digest) => {
          if (this.closed || this.signature !== signature) {
            return
          }
          const scope = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
          try {
            this.storage = new TraceExportStorage(sessionStorage, scope)
          } catch {
            // sessionStorage itself can throw, for example when storage is disabled.
          }
        })
        .catch(() => undefined)
    }
    return { headers, storage: this.storage }
  }

  private async recover(): Promise<void> {
    if (!hasWebCrypto() || this.url === undefined) {
      return
    }
    await this.headers()
    await this.identityReady
    const storage = this.storage
    if (storage === undefined || this.closed) {
      return
    }
    for (const record of storage.read()) {
      while (this.pendingExports >= (this.config.concurrencyLimit ?? DEFAULT_EXPORT_CONCURRENCY_LIMIT)) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([...this.active].map(async ({ done }) => done))
      }
      // eslint-disable-next-line no-await-in-loop
      const { headers, storage: requestStorage } = await this.headers()
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- shutdown can run while headers resolve.
      if (this.closed || requestStorage !== storage) {
        return
      }
      const delegate = createLegacyOtlpBrowserExportDelegate<Uint8Array, ReturnType<typeof JsonTraceSerializer.deserializeResponse>>(
        { ...this.config, url: this.url, headers },
        { serializeRequest: (body) => body, deserializeResponse: (response) => JsonTraceSerializer.deserializeResponse(response) },
        'v1/traces',
        { 'Content-Type': 'application/json' }
      )
      // eslint-disable-next-line no-await-in-loop
      const result = await new Promise<ExportResult>((resolve) => {
        this.send(
          (settle, _entry, accepted) => {
            if (!accepted) {
              settle({ code: ExportResultCode.FAILED, error: new Error('Trace export concurrency limit reached') })
              return
            }
            delegate.export(new TextEncoder().encode(record.body), settle)
          },
          { storage, key: record.key },
          resolve
        )
      })
      // eslint-disable-next-line no-await-in-loop
      await delegate.shutdown()
      if (result.code !== ExportResultCode.SUCCESS) {
        return
      }
    }
  }

  private send(
    send: (settle: (result: ExportResult) => void, entry: ActiveExport, accepted: boolean) => void,
    saved: ActiveExport['saved'],
    callback: (result: ExportResult) => void
  ): void {
    if (this.closed) {
      callback({ code: ExportResultCode.FAILED, error: new Error('Trace exporter is closed') })
      return
    }
    const accepted = this.pendingExports < (this.config.concurrencyLimit ?? DEFAULT_EXPORT_CONCURRENCY_LIMIT)
    let resolveDone!: () => void
    const entry: ActiveExport = {
      done: new Promise<void>((resolve) => {
        resolveDone = resolve
      }),
      ...(saved === undefined ? {} : { saved }),
    }
    this.active.add(entry)
    const settle = (result: ExportResult) => {
      if (!this.active.delete(entry)) {
        return
      }
      if (result.code === ExportResultCode.SUCCESS && entry.saved !== undefined) {
        entry.saved.storage.remove(entry.saved.key)
      }
      resolveDone()
      callback(result)
    }
    try {
      send(settle, entry, accepted)
    } catch (error) {
      settle({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
}
