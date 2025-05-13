import { describe, expect, it } from 'vitest'

import { aiSDKAttrTextGeneration, logfireAttrEventsTextGeneration } from './ai-attr-sample.mock'
import { vercelAIAttributeSchema } from './schema/vercel-ai-attribute.schema'
import { vercelAIToRecordAttribute } from './vercel-ai-to-record-attr'

describe('vercelAIToRecordAttribute', () => {
  it('should convert ai.prompt.messages to MessageEvent[]', () => {
    const aiAttr = vercelAIAttributeSchema.parse(aiSDKAttrTextGeneration)
    const events = vercelAIToRecordAttribute(aiAttr)
    expect(events).toEqual(logfireAttrEventsTextGeneration)
  })
})
