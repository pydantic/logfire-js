import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-web'

export const DEFAULT_DOCUMENT_HIDE_KEEPALIVE_BYTES = 12_000

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
 * Sends the newest spans of a document-hide flush first, in one request small enough to outlive
 * a navigation, and the rest in a second request started at the same time. Every other export
 * passes through unchanged.
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
 * browser then rejects it. The flush needs two free slots, and an exporter with
 * `concurrencyLimit: 1` rejects the second request.
 */
export class DocumentHideChunkingExporter implements SpanExporter {
  private readonly inner: SpanExporter
  private readonly keepaliveBytes: number
  private hideFlushDepth = 0
  private pending: PendingExport[] = []

  constructor(inner: SpanExporter, keepaliveBytes: number = DEFAULT_DOCUMENT_HIDE_KEEPALIVE_BYTES) {
    this.inner = inner
    this.keepaliveBytes = keepaliveBytes
  }

  /**
   * Runs `flush` with hide-time chunking on until it settles. Processors ahead of the batch
   * processor await before they delegate, so the batches reach `export` a few microtasks after
   * the call, still before the page unloads. A timer export that lands inside that window is
   * grouped in as well.
   */
  async withHideFlush(flush: () => Promise<void>): Promise<void> {
    this.hideFlushDepth += 1
    try {
      await flush()
    } finally {
      this.hideFlushDepth -= 1
    }
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.hideFlushDepth === 0) {
      this.inner.export(spans, resultCallback)
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
    const { newest, older } = splitNewestSpans(
      pending.flatMap(({ spans }) => spans),
      this.keepaliveBytes
    )
    if (older.length === 0) {
      this.inner.export(newest, settle)
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
    this.inner.export(newest, (result) => {
      newestResult = result
      settleWhenBoth()
    })
    this.inner.export(older, (result) => {
      olderResult = result
      settleWhenBoth()
    })
  }
}
