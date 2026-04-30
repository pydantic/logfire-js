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
  cases: [new Case({ expectedOutput: 'HELLO', inputs: { text: 'hello' }, name: 'deno-case' })],
  evaluators: [new EqualsExpected()],
  name: 'deno-runtime-smoke',
})

const report = await dataset.evaluate(({ text }) => {
  setEvalAttribute('runtime', 'deno')
  incrementEvalMetric('characters', text.length)
  return text.toUpperCase()
})
assert(report.cases[0]?.assertions.EqualsExpected?.value === true, 'offline evaluator did not pass')
assert(report.cases[0]?.attributes.runtime === 'deno', 'setEvalAttribute did not record')
assert(report.cases[0]?.metrics.characters === 5, 'incrementEvalMetric did not record')

const tmpdir = await Deno.makeTempDir({ prefix: 'logfire-evals-deno-' })
const datasetPath = `${tmpdir}/dataset.yaml`
await dataset.toFile(datasetPath, { schemaPath: 'dataset.schema.json' })
const restored = await Dataset.fromFile<{ text: string }, string>(datasetPath)
assert(restored.name === 'deno-runtime-smoke', 'Dataset.fromFile did not restore name')
assert((await Deno.readTextFile(`${tmpdir}/dataset.schema.json`)).includes('PydanticEvalsDataset'), 'schema sidecar missing')

const monitored = withOnlineEvaluation(async (text: string) => text.toUpperCase(), {
  emitOtelEvents: false,
  evaluators: [new HasUppercaseOutput()],
  target: 'deno-runtime-smoke',
})
assert((await monitored('ok')) === 'OK', 'online wrapper returned unexpected output')
await waitForEvaluations()

console.log('deno evals smoke ok')
