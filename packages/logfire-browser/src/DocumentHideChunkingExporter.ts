import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-web'

export const DEFAULT_DOCUMENT_HIDE_KEEPALIVE_BYTES = 12_000
/** The default `concurrencyLimit` of the OpenTelemetry OTLP exporters. */
export const DEFAULT_EXPORT_CONCURRENCY_LIMIT = 30

function serializedBytes(spans: ReadableSpan[]): number {
  return JsonTraceSerializer.serializeRequest(spans)?.byteLength ?? 0
}

/**
 * Splits the newest spans off the end of the list until their serialized OTLP request would
 * exceed `budgetBytes`. The newest span always goes, so it is never left behind.
 */
export function splitNewestSpans(spans: ReadableSpan[], budgetBytes: number): { newest: ReadableSpan[]; older: ReadableSpan[] } {
  let start = spans.length - 1
  while (start > 0 && serializedBytes(spans.slice(start - 1)) <= budgetBytes) {
    start -= 1
  }
  return { newest: spans.slice(Math.max(start, 0)), older: spans.slice(0, Math.max(start, 0)) }
}

interface PendingExport {
  spans: ReadableSpan[]
  resultCallback: (result: ExportResult) => void
}

/**
 * Sends the newest spans of a document-hide flush or a public `forceFlush()` first, in one request
 * small enough to outlive a navigation, and the rest in a second request started at the same time.
 * Every other export passes through unchanged.
 *
 * An application calls `forceFlush()` right after a record that must arrive, so that record is the
 * newest span of the flush. By then the buffer can hold a whole page load, and one request for all
 * of it is too large for `keepalive`. An unload soon after can cancel that request, with the record
 * inside.
 *
 * The browser only lets a request started during unload complete when it is small enough for
 * `keepalive`, and OpenTelemetry's fetch transport turns `keepalive` off once its own in-flight
 * budget of 60 KiB is used. Session replay reserves 48 000 bytes of the browser's 64 KiB
 * keepalive quota on the same events, so the default budget stays well under what remains.
 *
 * The batch processor hands a hide flush to `export` one batch at a time, oldest batch first.
 * The exporter collects every batch of one flush and sends them together in a microtask, so the
 * newest spans of the whole queue lead and the flush costs one keepalive request. The second
 * request starts in the same task, because a page that unloads never receives the first
 * response. The transport gives it `keepalive` only when it fits the budget that the first leaves,
 * so the unload can still cancel a large remainder, but the request has started. A remainder small
 * enough for that budget can still exceed what session replay leaves of the browser quota, and the
 * browser then rejects it.
 *
 * The split needs two free export slots. The OTLP exporter fails an export at once when all of its
 * `concurrencyLimit` slots are in use, and the batch processor has already removed those spans from
 * its buffer. So when fewer than two slots are free, the flush goes out unsplit in one request, as
 * it did before the split existed. Every export passes through this exporter, so it counts the slots
 * in use itself.
 */
export class DocumentHideChunkingExporter implements SpanExporter {
  private readonly concurrencyLimit: number
  private exportsInFlight = 0
  private readonly inner: SpanExporter
  private readonly keepaliveBytes: number
  private newestFirstDepth = 0
  private pending: PendingExport[] = []

  constructor(
    inner: SpanExporter,
    keepaliveBytes: number = DEFAULT_DOCUMENT_HIDE_KEEPALIVE_BYTES,
    concurrencyLimit: number = DEFAULT_EXPORT_CONCURRENCY_LIMIT
  ) {
    this.inner = inner
    this.keepaliveBytes = keepaliveBytes
    this.concurrencyLimit = concurrencyLimit
  }

  /**
   * Runs `flush` with newest-first chunking on until it settles. The document-hide flush and the
   * public `forceFlush()` both use it, because both export records that must outlive the page.
   * Processors ahead of the batch processor await before they delegate, so the batches reach
   * `export` a few microtasks after the call, still before the page unloads. A timer export that
   * lands inside that window is grouped in as well.
   */
  async withNewestFirstFlush(flush: () => Promise<void>): Promise<void> {
    this.newestFirstDepth += 1
    try {
      await flush()
    } finally {
      this.newestFirstDepth -= 1
    }
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.newestFirstDepth === 0) {
      this.send(spans, resultCallback)
      return
    }
    if (this.pending.length === 0) {
      queueMicrotask(() => {
        this.sendPending()
      })
    }
    this.pending.push({ spans, resultCallback })
  }

  async forceFlush(): Promise<void> {
    await this.inner.forceFlush?.()
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown()
  }

  private sendPending(): void {
    const pending = this.pending
    this.pending = []
    const settle = (result: ExportResult) => {
      for (const { resultCallback } of pending) {
        resultCallback(result)
      }
    }
    const spans = pending.flatMap(({ spans: batch }) => batch)
    if (this.concurrencyLimit - this.exportsInFlight < 2) {
      this.send(spans, settle)
      return
    }
    const { newest, older } = splitNewestSpans(spans, this.keepaliveBytes)
    if (older.length === 0) {
      this.send(newest, settle)
      return
    }
    let newestResult: ExportResult | undefined
    let olderResult: ExportResult | undefined
    const settleWhenBoth = () => {
      if (newestResult === undefined || olderResult === undefined) {
        return
      }
      settle(newestResult.code === ExportResultCode.SUCCESS ? olderResult : newestResult)
    }
    this.send(newest, (result) => {
      newestResult = result
      settleWhenBoth()
    })
    this.send(older, (result) => {
      olderResult = result
      settleWhenBoth()
    })
  }

  private send(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.exportsInFlight += 1
    this.inner.export(spans, (result) => {
      this.exportsInFlight -= 1
      resultCallback(result)
    })
  }
}
