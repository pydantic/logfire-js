import 'dotenv/config'
import * as logfire from '@pydantic/logfire-node'
import { defineVar, targetingContext } from '@pydantic/logfire-node/vars'

logfire.configure({
  console: false,
  diagLogLevel: logfire.DiagLogLevel.NONE,
  environment: 'local',
  serviceName: 'example-node-variables',
  serviceVersion: '1.0.0',
  variables: {
    config: {
      variables: {
        checkout_button_copy: {
          labels: {
            control: { serialized_value: '"Start trial"', version: 1 },
            enterprise: { serialized_value: '"Talk to sales"', version: 2 },
          },
          name: 'checkout_button_copy',
          overrides: [
            {
              conditions: [{ attribute: 'plan', kind: 'value-equals', value: 'enterprise' }],
              rollout: { labels: { enterprise: 1 } },
            },
          ],
          rollout: { labels: { control: 1 } },
        },
        request_timeout_ms: {
          labels: {
            default: { serialized_value: '2500', version: 1 },
            patient: { serialized_value: '5000', version: 2 },
          },
          name: 'request_timeout_ms',
          overrides: [
            {
              conditions: [{ attribute: 'region', kind: 'value-is-in', values: ['apac', 'sa'] }],
              rollout: { labels: { patient: 1 } },
            },
          ],
          rollout: { labels: { default: 1 } },
        },
      },
    },
  },
})

const checkoutButtonCopy = defineVar('checkout_button_copy', { default: 'Continue' })
const requestTimeoutMs = defineVar('request_timeout_ms', { default: 1000 })
const featureConfig = defineVar('feature_config', { default: { maxItems: 10, showBeta: false } })

const enterpriseCopy = await checkoutButtonCopy.get({
  attributes: { plan: 'enterprise' },
  targetingKey: 'user_123',
})
console.log('enterprise copy:', enterpriseCopy.value, {
  label: enterpriseCopy.label,
  reason: enterpriseCopy.reason,
  version: enterpriseCopy.version,
})

await targetingContext('user_456', async () => {
  const timeout = await requestTimeoutMs.get({ attributes: { region: 'apac' } })
  console.log('regional timeout:', timeout.value, {
    label: timeout.label,
    reason: timeout.reason,
    version: timeout.version,
  })
})

await checkoutButtonCopy.override('Preview copy', async () => {
  const previewCopy = await checkoutButtonCopy.get({ targetingKey: 'preview-user' })
  console.log('override copy:', previewCopy.value, { reason: previewCopy.reason })
})

const missingRemoteConfig = await featureConfig.get()
console.log('code default object:', missingRemoteConfig.value, { reason: missingRemoteConfig.reason })

await enterpriseCopy.withContext(async () => {
  logfire.info('Resolved checkout copy is attached to baggage for this span')
})

await logfire.forceFlush()
