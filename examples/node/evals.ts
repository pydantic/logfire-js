/**
 * Evals demo. Mirrors the `pydantic-evals` sentiment-classifier example in TS.
 *
 * Run with:
 *   pnpm install
 *   pnpm evals
 *
 * If you have `LOGFIRE_TOKEN` set, the spans + log events go straight to your
 * Logfire project — the experiment lights up in the web UI under
 * "Evaluations" and the Live Evals panel picks up the `gen_ai.evaluation.result`
 * events emitted by `withOnlineEvaluation`.
 */

import 'dotenv/config'
import * as logfire from '@pydantic/logfire-node'
import {
  Case,
  Contains,
  Dataset,
  EqualsExpected,
  renderReport,
  waitForEvaluations,
  withOnlineEvaluation,
} from '@pydantic/logfire-node/evals'

logfire.configure({
  console: false,
  diagLogLevel: logfire.DiagLogLevel.NONE,
  environment: 'staging',
  serviceName: 'evals-example',
  serviceVersion: '1.0.0',
})

interface ClassifyInputs {
  text: string
}

async function classify(inputs: ClassifyInputs): Promise<string> {
  const lower = inputs.text.toLowerCase()
  if (lower.includes('error') || lower.includes('fail')) return 'NEGATIVE'
  if (lower.includes('great') || lower.includes('love')) return 'POSITIVE'
  return 'NEUTRAL'
}

const dataset = new Dataset<ClassifyInputs, string>({
  cases: [
    new Case<ClassifyInputs, string>({ expectedOutput: 'POSITIVE', inputs: { text: 'I love this!' }, name: 'positive-1' }),
    new Case<ClassifyInputs, string>({ expectedOutput: 'NEGATIVE', inputs: { text: 'This is an error' }, name: 'negative-1' }),
    new Case<ClassifyInputs, string>({ expectedOutput: 'NEUTRAL', inputs: { text: 'just fine' }, name: 'neutral-1' }),
    new Case<ClassifyInputs, string>({
      evaluators: [new Contains({ value: 'POSITIVE' })],
      expectedOutput: 'POSITIVE',
      inputs: { text: 'it is great' },
      name: 'great-with-contains',
    }),
  ],
  evaluators: [new EqualsExpected()],
  name: 'sentiment-classifier',
})

console.log('Running offline evaluation…')
const report = await dataset.evaluate(classify, { maxConcurrency: 4 })
console.log(renderReport(report, { includeInput: true, includeOutput: true }))

console.log('\nWiring `classify` for online evaluation…')
const monitoredClassify = withOnlineEvaluation(classify, {
  evaluators: [new EqualsExpected()],
  // The function runs normally; evaluators run in the background after each call.
  sampleRate: 1.0,
  target: 'sentiment-classifier',
})

await monitoredClassify({ text: 'I love this!' })
await monitoredClassify({ text: 'fail' })
await waitForEvaluations()
console.log('Online evaluations dispatched.')
