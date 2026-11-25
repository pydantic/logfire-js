import { configure, shutdown, span } from '@pydantic/logfire-node'
import { defineFlag, withFeatureContext } from '@pydantic/logfire-node/experimental/feature-flags'
import { z } from 'zod'

configure({
  console: false,
  metrics: false,
  sendToLogfire: false,
  variables: {
    config: {
      variables: {
        assistant_model: {
          name: 'assistant_model',
          labels: { stable: { serialized_value: '"large"', version: 1 } },
          rollout: { labels: { stable: 1 } },
          overrides: [],
        },
        assistant_policy: {
          name: 'assistant_policy',
          labels: {
            team: { serialized_value: '{"model":"@{assistant_model}@","maxDocuments":4}', version: 1 },
          },
          rollout: { labels: {} },
          overrides: [
            {
              conditions: [{ kind: 'value-equals', attribute: 'plan', value: 'team' }],
              rollout: { labels: { team: 1 } },
            },
          ],
        },
      },
    },
  },
})

const showPreview = defineFlag('show_preview', { default: false })
const assistantPolicy = defineFlag('assistant_policy', {
  default: { model: 'small', maxDocuments: 1 },
  schema: z.object({
    model: z.enum(['small', 'large']),
    maxDocuments: z.number().int().min(1).max(10),
  }),
})

try {
  await span('support.request', {
    callback: async () =>
      withFeatureContext({ targetingKey: 'account-123', attributes: { plan: 'team' } }, async () => {
        const policy = await assistantPolicy.details()
        console.log(policy.value, policy.reason)
        console.log('Preview before override:', await showPreview.value())
        await showPreview.override(true, async () => {
          console.log('Preview inside override:', await showPreview.value())
        })
        console.log('Preview after override:', await showPreview.value())
      }),
  })
} finally {
  await shutdown()
}
