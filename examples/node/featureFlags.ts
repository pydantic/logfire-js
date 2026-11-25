import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

import * as nodeSdk from '@pydantic/logfire-node'
import * as flags from '@pydantic/logfire-node/experimental/feature-flags'
import type { VariableConfig } from 'logfire/vars'
import { defineVar } from 'logfire/vars'
import { z } from 'zod'

const require = createRequire(import.meta.url)
const esmConfig = process.argv.includes('--esm-config')
const sdk = esmConfig ? nodeSdk : (require('@pydantic/logfire-node') as typeof nodeSdk)
const commonJsFlags = require('@pydantic/logfire-node/experimental/feature-flags') as typeof flags
const { defineFlag } = esmConfig ? commonJsFlags : flags
const { withFeatureContext } = esmConfig ? flags : commonJsFlags

function fixedValue(name: string, value: unknown): VariableConfig {
  return {
    name,
    labels: { active: { serialized_value: JSON.stringify(value), version: 1 } },
    rollout: { labels: { active: 1 } },
    overrides: [],
  }
}

sdk.configure({
  console: false,
  metrics: false,
  sendToLogfire: false,
  sampling: { head: esmConfig ? 1 : 0 },
  variables: {
    instrument: false,
    config: {
      variables: {
        assistant_model: fixedValue('assistant_model', 'large'),
        assistant_policy: {
          name: 'assistant_policy',
          aliases: ['support_policy'],
          labels: {
            team: { serialized_value: '{"model":"@{assistant_model}@","maxDocuments":4}', version: 1 },
            invalid: { serialized_value: '{"model":"large","maxDocuments":999}', version: 2 },
          },
          rollout: { labels: {} },
          overrides: [
            { conditions: [{ kind: 'value-equals', attribute: 'plan', value: 'team' }], rollout: { labels: { team: 1 } } },
            { conditions: [{ kind: 'value-equals', attribute: 'plan', value: 'invalid' }], rollout: { labels: { invalid: 1 } } },
          ],
        },
        legacy_prompt: fixedValue('legacy_prompt', 'Read up to @{assistant_policy.maxDocuments}@ documents'),
        checkout: {
          name: 'checkout',
          labels: { control: { ref: 'code_default' }, treatment: { serialized_value: 'true', version: 1 } },
          rollout: { labels: { control: 0.5, treatment: 0.5 } },
          overrides: [],
        },
      },
    },
  },
})

const assistantPolicy = defineFlag('support_policy', {
  default: { model: 'small', maxDocuments: 1 },
  schema: z.object({ model: z.enum(['small', 'large']), maxDocuments: z.number().int().min(1).max(10) }),
})
const checkout = defineFlag('checkout', { default: false })
const preview = defineFlag('preview', { default: false })
const legacyPrompt = defineVar('legacy_prompt', { default: 'Use the safe prompt' })

async function respond(url: URL) {
  const account = url.searchParams.get('account')
  const attributes = { plan: url.searchParams.get('plan') ?? 'free' }
  return withFeatureContext({ ...(account === null ? {} : { targetingKey: account }), attributes }, async () =>
    sdk.span('assistant.request', {
      async callback() {
        const policy = await assistantPolicy.details()
        const [assignment, repeated] = await Promise.all([checkout.details(), checkout.details()])
        const previewOn =
          url.searchParams.get('preview') === '1' ? await preview.override(true, async () => preview.value()) : await preview.value()
        return {
          policy,
          assignment,
          repeated,
          preview: previewOn,
          previewAfterOverride: await preview.value(),
          legacyPrompt: (await legacyPrompt.get({ attributes })).value,
        }
      },
    })
  )
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/assistant') {
    response.writeHead(404).end()
    return
  }
  void respond(url).then(
    (value) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    },
    () => {
      response.writeHead(500).end()
    }
  )
})

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/assistant`
  if (process.argv.includes('--serve')) {
    console.log(`Open ${url}?plan=team&account=demo&preview=1`)
    await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM')])
  } else {
    await smoke(url)
    console.log(
      `Feature flags HTTP smoke passed (${esmConfig ? 'ESM config, CommonJS flags, sampled' : 'CommonJS config, ESM flags, unsampled'})`
    )
  }
} finally {
  server.close()
  await sdk.shutdown()
}

async function smoke(url: string) {
  async function request(query: string): Promise<Awaited<ReturnType<typeof respond>>> {
    const response = await fetch(url + query)
    assert.equal(response.status, 200)
    return (await response.json()) as Awaited<ReturnType<typeof respond>>
  }

  const [team, free, invalid] = await Promise.all([
    request('?plan=team&account=account-3&preview=1'),
    request(''),
    request('?plan=invalid'),
  ])
  assert.deepEqual(team.policy.value, { model: 'large', maxDocuments: 4 })
  assert.equal(team.policy.reason, 'targeting_match')
  assert.equal(team.legacyPrompt, 'Read up to 4 documents')
  assert.deepEqual(free.policy.value, { model: 'small', maxDocuments: 1 })
  assert.equal(free.policy.reason, 'default')
  assert.deepEqual(invalid.policy.value, free.policy.value)
  assert.equal(invalid.policy.errorCode, 'type_mismatch')
  assert.equal(invalid.legacyPrompt, 'Use the safe prompt')
  assert.deepEqual([team.preview, team.previewAfterOverride, free.preview, invalid.preview], [true, false, false, false])
  for (const result of [team, free, invalid]) {
    assert.deepEqual(result.assignment, result.repeated)
    assert.equal(result.assignment.reason, 'split')
    assert.equal(result.assignment.value, result.assignment.variant === 'treatment')
  }
  assert.deepEqual((await request('?account=account-3')).assignment, team.assignment)
  assert.equal((await checkout.details()).errorCode, 'targeting_key_missing')
  const traced = await sdk.span('outside-request-scope', { callback: async () => checkout.details() })
  assert.equal(traced.errorCode, 'targeting_key_missing')
}
