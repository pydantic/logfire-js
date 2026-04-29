import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Case,
  Dataset,
  EqualsExpected,
  Evaluator,
  incrementEvalMetric,
  setEvalAttribute,
  waitForEvaluations,
  withOnlineEvaluation,
} from '../../packages/logfire-api/dist/evals.js'

class HasUppercaseOutput extends Evaluator<string, string> {
  static evaluatorName = 'HasUppercaseOutput'

  evaluate(ctx: { output: string }): boolean {
    return ctx.output === ctx.output.toUpperCase()
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const dataset = new Dataset<{ text: string }, string>({
  cases: [new Case({ expectedOutput: 'HELLO', inputs: { text: 'hello' }, name: 'bun-case' })],
  evaluators: [new EqualsExpected()],
  name: 'bun-runtime-smoke',
})

const report = await dataset.evaluate(({ text }) => {
  setEvalAttribute('runtime', 'bun')
  incrementEvalMetric('characters', text.length)
  return text.toUpperCase()
})
assert(report.cases[0]?.assertions.EqualsExpected?.value === true, 'offline evaluator did not pass')
assert(report.cases[0]?.attributes.runtime === 'bun', 'setEvalAttribute did not record')
assert(report.cases[0]?.metrics.characters === 5, 'incrementEvalMetric did not record')

const tmpdirPath = await mkdtemp(join(tmpdir(), 'logfire-evals-bun-'))
const datasetPath = join(tmpdirPath, 'dataset.yaml')
await dataset.toFile(datasetPath, { schemaPath: 'dataset.schema.json' })
const restored = await Dataset.fromFile<{ text: string }, string>(datasetPath)
assert(restored.name === 'bun-runtime-smoke', 'Dataset.fromFile did not restore name')
assert((await readFile(join(tmpdirPath, 'dataset.schema.json'), 'utf8')).includes('PydanticEvalsDataset'), 'schema sidecar missing')

const monitored = withOnlineEvaluation(async (text: string) => text.toUpperCase(), {
  emitOtelEvents: false,
  evaluators: [new HasUppercaseOutput()],
  target: 'bun-runtime-smoke',
})
assert((await monitored('ok')) === 'OK', 'online wrapper returned unexpected output')
await waitForEvaluations()

console.log('bun evals smoke ok')
