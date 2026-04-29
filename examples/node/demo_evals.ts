/**
 * TypeScript port of `platform/src/demos/logfire_demo/demo_evals.py`.
 *
 * Loads the same `time_range_v1.yaml` dataset Python uses, runs a stub
 * time-range "agent" against it (no model calls — we don't have pydantic-ai-js),
 * and emits experiment + case + evaluator spans against the local Logfire
 * backend. Use this to verify the JS evals output ingests into the platform's
 * `experiments` table and renders in the web UI.
 *
 * Usage:
 *   pnpm install
 *   pnpm demo-evals
 *
 * Override the backend / token via env:
 *   LOGFIRE_BASE_URL=http://localhost:3000
 *   LOGFIRE_TOKEN=test-e2e-write-token
 *
 * Open http://localhost:3000/e2e-test/test-e2e-project#token=test-e2e-token
 * to inspect the resulting experiment.
 */

import 'dotenv/config'
import { resolve } from 'node:path'

import * as logfire from '@pydantic/logfire-node'
import {
  Dataset,
  Evaluator,
  type EvaluatorContext,
  type EvaluatorOutput,
  IsInstance,
  LLMJudge,
  registerEvaluator,
  renderReport,
  setDefaultJudge,
} from '@pydantic/logfire-node/evals'

logfire.configure({
  baseUrl: process.env.LOGFIRE_BASE_URL ?? 'http://localhost:3000',
  console: false,
  diagLogLevel: logfire.DiagLogLevel.NONE,
  environment: 'development',
  serviceName: 'evals',
  token: process.env.LOGFIRE_TOKEN ?? 'test-e2e-write-token',
})

// Stub LLMJudge so the dataset's `LLMJudge: <rubric>` entries work without an
// actual model client. We're not testing the judge — we're testing wire-format.
setDefaultJudge(({ output }) => ({
  pass: output !== null && output !== undefined,
  reason: 'stub judge — output present',
  score: 1.0,
}))

// `IsInstance` matches by constructor name. Define stub classes whose `name`
// matches the YAML's references so `IsInstance: TimeRangeBuilderSuccess`
// resolves correctly.
class TimeRangeBuilderSuccess {
  min_timestamp_with_offset: string
  max_timestamp_with_offset: string
  explanation?: string
  constructor(min: string, max: string, explanation?: string) {
    this.min_timestamp_with_offset = min
    this.max_timestamp_with_offset = max
    this.explanation = explanation
  }
}

class TimeRangeBuilderError {
  error_message: string
  constructor(message: string) {
    this.error_message = message
  }
}

interface TimeRangeInputs {
  now: string
  prompt: string
}

type TimeRangeResponse = TimeRangeBuilderError | TimeRangeBuilderSuccess

/**
 * Stub agent — returns a `TimeRangeBuilderSuccess` for prompts that look
 * unambiguously like a date, otherwise a `TimeRangeBuilderError`. Doesn't
 * actually parse anything; the goal is to produce a mix of output classes
 * so `IsInstance` exercises both branches.
 */
async function inferTimeRange(inputs: TimeRangeInputs): Promise<TimeRangeResponse> {
  return logfire.span('task: infer_time_range', { prompt: inputs.prompt }, {}, () => {
    const lower = inputs.prompt.toLowerCase()
    const looksAmbiguous = /(conflict|but|and also|2025.*2020|both apply|some logs)/i.test(lower)
    if (looksAmbiguous) {
      return new TimeRangeBuilderError('Conflicting time instructions: could not reconcile.')
    }
    // Pretend we resolved a 24h window around `now`
    const now = new Date(inputs.now)
    const min = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString()
    const max = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString()
    return new TimeRangeBuilderSuccess(min, max, 'Stub explanation — not a real LLM.')
  })
}

/**
 * Custom evaluator — emits a mix of assertion / label / score outputs to
 * exercise all three case-attribute paths.
 */
class DemoEvaluator extends Evaluator {
  static evaluatorName = 'DemoEvaluator'
  evaluate(_ctx: EvaluatorContext): EvaluatorOutput {
    const out: EvaluatorOutput = {
      my_assertion_1: true,
      my_assertion_2: false,
      my_label: `my_value_${(Math.random() * 4).toFixed(0)}`,
    }
    if (Math.random() > 0.5) {
      ;(out as Record<string, number>).my_score = Math.random()
    }
    return out
  }
}
registerEvaluator(DemoEvaluator)

async function evaluateDataset(): Promise<void> {
  const datasetPath = resolve(import.meta.dirname ?? __dirname, 'datasets', 'time_range_v1.yaml')
  const dataset = await Dataset.fromFile<TimeRangeInputs, TimeRangeResponse>(datasetPath)

  // Add our custom evaluator to the dataset (the YAML doesn't know about it).
  dataset.addEvaluator(new DemoEvaluator())

  // Replace the dataset-level `LLMJudge` with the BYO judge wired above.
  dataset.evaluators = dataset.evaluators.map((e) => {
    if (e.constructor.name === 'LLMJudge') {
      return new LLMJudge({ rubric: 'Stub judge for local-platform smoke test.' })
    }
    return e
  })

  const report = await dataset.evaluate(inferTimeRange)
  console.log(renderReport(report, { includeInput: true, includeOutput: true }))
  console.log()
  console.log('Open http://localhost:3000/e2e-test/test-e2e-project#token=test-e2e-token to view the experiment.')
}

await evaluateDataset()
// Force-flush the OTel SDK so the experiment lands before the process exits.
await new Promise((resolve) => setTimeout(resolve, 1500))
