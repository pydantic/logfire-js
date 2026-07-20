import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { describe, expect, test } from 'vite-plus/test'

import { collectSpans } from './__test__/collectSpans'
import { ATTRIBUTES_SPAN_TYPE_KEY } from './constants'
import { startPendingSpan } from './index'
import { PendingSpanProcessor } from './PendingSpanProcessor'
import { TailSamplingProcessor } from './TailSamplingProcessor'

function pendingSpans(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter((span) => span.attributes[ATTRIBUTES_SPAN_TYPE_KEY] === 'pending_span')
}

describe('startPendingSpan integration', () => {
  test('emits one manual pending span with non-tail automatic pending processing installed', async () => {
    const spans = await collectSpans(
      (primary) => [primary, new PendingSpanProcessor(primary)],
      () => {
        const span = startPendingSpan('manual root')
        span.end()
      }
    )

    expect(pendingSpans(spans)).toHaveLength(1)
    expect(spans.map((span) => span.attributes[ATTRIBUTES_SPAN_TYPE_KEY])).toEqual(['pending_span', 'span'])
  })

  test('emits one manual pending span when a tail-buffered trace is accepted on root end', async () => {
    const spans = await collectSpans(
      (primary) => [
        new TailSamplingProcessor(primary, (info) => (info.event === 'end' && info.span.name === 'manual root' ? 1.0 : 0.0), {
          deferredProcessor: new PendingSpanProcessor(primary),
        }),
      ],
      () => {
        const span = startPendingSpan('manual root')
        span.end()
      }
    )

    expect(pendingSpans(spans)).toHaveLength(1)
    expect(spans.map((span) => span.attributes[ATTRIBUTES_SPAN_TYPE_KEY])).toEqual(['pending_span', 'span'])
  })
})
