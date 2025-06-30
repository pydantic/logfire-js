import { AttributeValue } from '@opentelemetry/api'
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { vercelAIAttributeSchema } from './schema/vercel-ai-attribute.schema'
import { vercelAIToRecordAttribute } from './vercel-ai-to-record-attr'

export class LogfireVercelAISpanProcessor implements SpanProcessor {
  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  onEnd(span: ReadableSpan): void {
    const isAI = this.isSpanIsAI(span)

    if (isAI) {
      const parsedAttributes = vercelAIAttributeSchema.safeParse(span.attributes)
      if (parsedAttributes.success) {
        try {
          const messageEvents = vercelAIToRecordAttribute(parsedAttributes.data)

          if (messageEvents.length > 0) {
            span.attributes.all_messages_events = messageEvents as unknown as AttributeValue
            span.attributes.final_result = parsedAttributes.data['ai.response.text']
          }
        } catch (_) {}
      }
    }
  }

  onStart(): void {
    // do nothing
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  private isSpanIsAI(span: ReadableSpan): boolean {
    // if find any key starts with ai.
    return Object.keys(span.attributes).some((key) => key.startsWith('ai.'))
  }
}
