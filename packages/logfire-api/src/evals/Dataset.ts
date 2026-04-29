/* eslint-disable camelcase */
import type { Span } from '@opentelemetry/api'

import pRetry from 'p-retry'

import type { CaseLifecycle, CaseLifecycleClass } from './CaseLifecycle'
import type { Evaluator } from './Evaluator'
import type { ReportAnalysis, ReportEvaluator } from './ReportEvaluator'
import type { EvaluateOptions, EvaluatorContext, EvaluatorFailureRecord, TaskRunState } from './types'

import { Case, type CaseOptions } from './Case'
import {
  ATTR_ASSERTION_PASS_RATE,
  ATTR_ASSERTIONS,
  ATTR_ATTRIBUTES,
  ATTR_CASE_NAME,
  ATTR_DATASET_NAME,
  ATTR_EXPECTED_OUTPUT,
  ATTR_INPUTS,
  ATTR_LABELS,
  ATTR_METADATA,
  ATTR_METRICS,
  ATTR_N_CASES,
  ATTR_NAME,
  ATTR_OUTPUT,
  ATTR_SCORES,
  ATTR_TASK_DURATION,
  ATTR_TASK_NAME,
  EXPERIMENT_ANALYSES_KEY,
  EXPERIMENT_METADATA_KEY,
  EXPERIMENT_REPEAT_KEY,
  EXPERIMENT_REPORT_EVALUATOR_FAILURES_KEY,
  EXPERIMENT_SOURCE_CASE_NAME_KEY,
  GEN_AI_OPERATION_NAME,
  OPERATION_EXPERIMENT,
  SPAN_MSG_TEMPLATE_REPORT_EVALUATOR,
  SPAN_NAME_CASE,
  SPAN_NAME_EXECUTE,
  SPAN_NAME_EXPERIMENT,
  SPAN_NAME_REPORT_EVALUATOR_LITERAL,
} from './constants'
import { runWithTaskRun } from './currentTaskRun'
import { buildEvaluatorFailureRecord } from './evaluatorResults'
import { extractMetricsFromSpanTree } from './extractMetrics'
import { evalsSpan, setEvalsSpanAttributes } from './internal'
import { computeAssertionPassRate, computeAverages, type EvaluationReport, type ReportCase, type ReportCaseFailure } from './reporting'
import { runEvaluators } from './runEvaluators'
import { hasNodeFs } from './runtime'
import { Semaphore } from './Semaphore'
import {
  buildDatasetJsonSchema,
  datasetFromObject,
  datasetToObject,
  type FromOptions,
  type JsonSchema,
  parseYaml,
  stringifyYaml,
  type ToOptions,
} from './serialization'
import { buildSpanTree, getEvalsSpanProcessor, isProcessorInstalledOnGlobal, SpanTree, SpanTreeRecordingError } from './spanTree'

export interface DatasetOptions<Inputs, Output, Metadata = unknown> {
  cases?: readonly Case<Inputs, Output, Metadata>[]
  evaluators?: readonly Evaluator<Inputs, Output, Metadata>[]
  name: string
  reportEvaluators?: readonly ReportEvaluator<Inputs, Output, Metadata>[]
}

export class Dataset<Inputs = unknown, Output = unknown, Metadata = unknown> {
  cases: Case<Inputs, Output, Metadata>[]
  evaluators: Evaluator<Inputs, Output, Metadata>[]
  name: string
  reportEvaluators: ReportEvaluator<Inputs, Output, Metadata>[]

  constructor(opts: DatasetOptions<Inputs, Output, Metadata>) {
    this.name = opts.name
    this.cases = opts.cases ? [...opts.cases] : []
    this.evaluators = opts.evaluators ? [...opts.evaluators] : []
    this.reportEvaluators = opts.reportEvaluators ? [...opts.reportEvaluators] : []
    assertUniqueNames(this.cases)
  }

  static async fromFile<I = unknown, O = unknown, M = unknown>(filePath: string, options: FromOptions = {}): Promise<Dataset<I, O, M>> {
    if (!hasNodeFs()) throw new Error('Dataset.fromFile is only supported on Node, Bun, and Deno (no filesystem in browser/CF Workers)')
    const text = await readTextFile(filePath)
    const format: 'json' | 'yaml' = filePath.endsWith('.json') ? 'json' : 'yaml'
    const defaultName = options.defaultName ?? fileStem(filePath)
    return Dataset.fromText<I, O, M>(text, { ...options, defaultName, format })
  }

  static fromObject<I = unknown, O = unknown, M = unknown>(data: unknown, options: FromOptions = {}): Dataset<I, O, M> {
    return datasetFromObject<I, O, M>(data, options)
  }

  static fromText<I = unknown, O = unknown, M = unknown>(
    text: string,
    options: FromOptions & { format: 'json' | 'yaml' }
  ): Dataset<I, O, M> {
    const parsed = options.format === 'json' ? (JSON.parse(text) as unknown) : parseYaml(text)
    return datasetFromObject<I, O, M>(parsed, options)
  }

  addCase(opts: CaseOptions<Inputs, Output, Metadata>): void {
    const c = new Case(opts)
    this.cases.push(c)
    assertUniqueNames(this.cases)
  }

  addEvaluator(evaluator: Evaluator<Inputs, Output, Metadata>, options?: { specificCase?: string }): void {
    if (options?.specificCase !== undefined) {
      const target = this.cases.find((c) => c.name === options.specificCase)
      if (target === undefined) {
        throw new Error(`addEvaluator: no case named ${JSON.stringify(options.specificCase)}`)
      }
      ;(target.evaluators as Evaluator<Inputs, Output, Metadata>[]).push(evaluator)
    } else {
      this.evaluators.push(evaluator)
    }
  }

  async evaluate(
    task: (inputs: Inputs) => Output | Promise<Output>,
    options: EvaluateOptions<Inputs, Output, Metadata> = {}
  ): Promise<EvaluationReport<Inputs, Output, Metadata>> {
    const taskName = options.taskName ?? (task.name === '' ? 'task' : task.name)
    const experimentName = options.name ?? taskName
    const repeat = options.repeat ?? 1
    if (!Number.isInteger(repeat) || repeat < 1) {
      throw new Error(`Dataset.evaluate: repeat must be >= 1 (got ${repeat.toString()})`)
    }
    const totalCases = this.cases.length * repeat
    if (options.maxConcurrency !== undefined && (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)) {
      throw new Error(`Dataset.evaluate: maxConcurrency must be a positive integer (got ${options.maxConcurrency.toString()})`)
    }

    const initialAttrs: Record<string, unknown> = {
      [ATTR_DATASET_NAME]: this.name,
      [ATTR_N_CASES]: totalCases,
      [ATTR_NAME]: experimentName,
      [ATTR_TASK_NAME]: taskName,
      [GEN_AI_OPERATION_NAME]: OPERATION_EXPERIMENT,
    }
    if (options.metadata !== undefined) initialAttrs[ATTR_METADATA] = options.metadata
    if (repeat > 1) initialAttrs[EXPERIMENT_REPEAT_KEY] = repeat

    return evalsSpan(
      SPAN_NAME_EXPERIMENT,
      { attributes: initialAttrs },
      async (experimentSpan): Promise<EvaluationReport<Inputs, Output, Metadata>> => {
        const sctx = experimentSpan.spanContext()
        const trace_id = sctx.traceId
        const span_id = sctx.spanId

        const sem = new Semaphore(options.maxConcurrency ?? Math.max(this.cases.length * repeat, 1))
        const cases: ReportCase<Inputs, Output, Metadata>[] = []
        const failures: ReportCaseFailure<Inputs, Output, Metadata>[] = []

        const expandedCases: { case: Case<Inputs, Output, Metadata>; positionalIndex: number; runIndex: number }[] = []
        this.cases.forEach((c, i) => {
          for (let r = 0; r < repeat; r++) {
            expandedCases.push({ case: c, positionalIndex: i, runIndex: r })
          }
        })

        let done = 0
        const runOne = async ({
          case: c,
          positionalIndex,
          runIndex,
        }: {
          case: Case<Inputs, Output, Metadata>
          positionalIndex: number
          runIndex: number
        }): Promise<void> => {
          if (options.signal?.aborted) return
          const release = await sem.acquire()
          if (options.signal?.aborted) {
            release()
            return
          }
          try {
            const sourceCaseName = c.name ?? `Case ${(positionalIndex + 1).toString()}`
            const caseName = repeat > 1 ? `${sourceCaseName} [${(runIndex + 1).toString()}/${repeat.toString()}]` : sourceCaseName
            const result = await runOneCase({
              caseName,
              dataset: this,
              datasetEvaluators: this.evaluators,
              lifecycleClass: options.lifecycle,
              originalCase: c,
              retryEvaluators: options.retryEvaluators,
              retryTask: options.retryTask,
              sourceCaseName: repeat > 1 ? sourceCaseName : undefined,
              task,
              taskName,
            })
            if ('error_type' in result) {
              failures.push(result)
            } else {
              cases.push(result)
            }
            done += 1
            reportProgress(options.progress, { caseName, done, total: totalCases })
          } finally {
            release()
          }
        }

        await Promise.all(expandedCases.map(runOne))

        // Run report evaluators inside the experiment span — analyses must land
        // on the span's attributes BEFORE it closes so the platform sees them.
        const analyses: ReportAnalysis[] = []
        const reportEvaluatorFailures: EvaluatorFailureRecord[] = []
        const report: EvaluationReport<Inputs, Output, Metadata> = {
          analyses,
          cases,
          experiment_metadata: options.metadata,
          failures,
          name: experimentName,
          report_evaluator_failures: reportEvaluatorFailures,
          span_id,
          trace_id,
        }
        for (const re of this.reportEvaluators) {
          const evaluatorName = (re.constructor as { evaluatorName?: string; name: string }).evaluatorName ?? re.constructor.name
          try {
            const out = await evalsSpan(
              SPAN_MSG_TEMPLATE_REPORT_EVALUATOR,
              {
                attributes: { evaluator_name: evaluatorName },
                spanName: SPAN_NAME_REPORT_EVALUATOR_LITERAL,
              },
              async () =>
                re.evaluate({
                  cases: [...cases, ...failures],
                  experimentMetadata: options.metadata,
                  name: experimentName,
                  report,
                })
            )
            const list = Array.isArray(out) ? out : [out]
            for (const item of list) analyses.push(item)
          } catch (err) {
            reportEvaluatorFailures.push(buildEvaluatorFailureRecord(err, evaluatorName, re.getSpec(), re.evaluatorVersion))
          }
        }

        // Set after-evaluation attributes on the experiment span before it ends.
        const experimentMetadata: Record<string, unknown> = { n_cases: totalCases }
        if (repeat > 1) experimentMetadata.repeat = repeat
        if (options.metadata !== undefined) experimentMetadata.metadata = options.metadata
        experimentMetadata.averages = computeAverages(experimentName, cases)

        const finalAttrs: Record<string, unknown> = { [EXPERIMENT_METADATA_KEY]: experimentMetadata }
        const passRate = computeAssertionPassRate(cases)
        if (passRate !== null) finalAttrs[ATTR_ASSERTION_PASS_RATE] = passRate
        if (analyses.length > 0) finalAttrs[EXPERIMENT_ANALYSES_KEY] = analyses
        if (reportEvaluatorFailures.length > 0) finalAttrs[EXPERIMENT_REPORT_EVALUATOR_FAILURES_KEY] = reportEvaluatorFailures
        setEvalsSpanAttributes(experimentSpan, finalAttrs)

        return report
      }
    )
  }

  /** JSON-schema description of the dataset file format, suitable for IDE auto-complete. */
  jsonSchema(
    opts: {
      customEvaluators?: readonly import('./types').EvaluatorClass[]
      customReportEvaluators?: readonly import('./types').ReportEvaluatorClass[]
    } = {}
  ): JsonSchema {
    return buildDatasetJsonSchema({
      customEvaluators: opts.customEvaluators,
      customReportEvaluators: opts.customReportEvaluators,
    })
  }

  async toFile(filePath: string, opts: ToOptions = {}): Promise<void> {
    if (!hasNodeFs()) throw new Error('Dataset.toFile is only supported on Node, Bun, and Deno (no filesystem in browser/CF Workers)')
    const format: 'json' | 'yaml' = filePath.endsWith('.json') ? 'json' : 'yaml'
    const text = this.toText(format, opts)
    const finalText =
      format === 'yaml' && opts.schemaPath !== undefined ? `# yaml-language-server: $schema=${opts.schemaPath}\n${text}` : text
    await writeTextFile(filePath, finalText)
    if (opts.schemaPath !== undefined) {
      const schemaText = `${JSON.stringify(this.jsonSchema(), null, 2)}\n`
      await writeTextFileIfChanged(resolveSiblingPath(filePath, opts.schemaPath), schemaText)
    }
  }

  toObject(opts?: ToOptions): Record<string, unknown> {
    return datasetToObject(this, opts) as unknown as Record<string, unknown>
  }

  toText(format: 'json' | 'yaml', opts: ToOptions = {}): string {
    const obj = datasetToObject(this, opts)
    if (format === 'json') return JSON.stringify(obj, null, 2)
    return stringifyYaml(obj)
  }
}

function assertUniqueNames(cases: readonly Case[]): void {
  const seen = new Set<string>()
  for (const c of cases) {
    if (c.name === undefined) continue
    if (seen.has(c.name)) {
      throw new Error(`Duplicate case name: ${JSON.stringify(c.name)}`)
    }
    seen.add(c.name)
  }
}

function reportProgress(progress: EvaluateOptions['progress'], event: { caseName: string; done: number; total: number }): void {
  if (typeof progress === 'function') {
    progress(event)
  } else if (progress === true) {
    console.error(`[${event.done.toString()}/${event.total.toString()}] ${event.caseName}`)
  }
}

async function runOneCase<Inputs, Output, Metadata>(args: {
  caseName: string
  dataset: Dataset<Inputs, Output, Metadata>
  datasetEvaluators: readonly Evaluator<Inputs, Output, Metadata>[]
  lifecycleClass?: CaseLifecycleClass<Inputs, Output, Metadata>
  originalCase: Case<Inputs, Output, Metadata>
  retryEvaluators?: import('./types').RetryConfig
  retryTask?: import('./types').RetryConfig
  sourceCaseName?: string
  task: (inputs: Inputs) => Output | Promise<Output>
  taskName: string
}): Promise<ReportCase<Inputs, Output, Metadata> | ReportCaseFailure<Inputs, Output, Metadata>> {
  const { caseName, datasetEvaluators, lifecycleClass, originalCase, retryEvaluators, retryTask, sourceCaseName, task, taskName } = args
  // eslint-disable-next-line new-cap
  const lifecycle: CaseLifecycle<Inputs, Output, Metadata> | null = lifecycleClass ? new lifecycleClass(originalCase) : null

  const exporterContextId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  const caseAttrs: Record<string, unknown> = {
    [ATTR_CASE_NAME]: caseName,
    [ATTR_INPUTS]: originalCase.inputs,
    [ATTR_TASK_NAME]: taskName,
  }
  if (originalCase.metadata !== undefined) caseAttrs[ATTR_METADATA] = originalCase.metadata
  if (originalCase.expectedOutput !== undefined) caseAttrs[ATTR_EXPECTED_OUTPUT] = originalCase.expectedOutput
  if (sourceCaseName !== undefined) caseAttrs[EXPERIMENT_SOURCE_CASE_NAME_KEY] = sourceCaseName

  const totalStart = nowSec()

  return evalsSpan(SPAN_NAME_CASE, { attributes: caseAttrs }, async (caseSpan) => {
    const sctx = caseSpan.spanContext()
    const trace_id = sctx.traceId
    const span_id = sctx.spanId

    const taskRunState: TaskRunState = {
      attributes: {},
      exporterContextId,
      metrics: {},
    }

    const evalsProcessor = getEvalsSpanProcessor()
    evalsProcessor.openBucket(exporterContextId)

    let output: Output
    let taskDuration = 0
    try {
      if (lifecycle?.setup !== undefined) await lifecycle.setup()

      const runTaskOnce = async (): Promise<Output> => {
        return evalsSpan(SPAN_NAME_EXECUTE, { attributes: { task: taskName } }, async (): Promise<Output> => {
          const taskStart = nowSec()
          try {
            return await Promise.resolve(task(originalCase.inputs))
          } finally {
            taskDuration = nowSec() - taskStart
          }
        })
      }

      output = await runWithTaskRun(taskRunState, async () => {
        return evalsProcessor.runWithBucket(exporterContextId, async (): Promise<Output> => {
          if (retryTask !== undefined) {
            return pRetry(runTaskOnce, retryTask)
          }
          return runTaskOnce()
        })
      })
    } catch (err) {
      // Drain bucket so we don't leak even on task failure.
      evalsProcessor.drainBucket(exporterContextId)
      // Still record the exception on the case span — the platform shows it.
      recordException(caseSpan, err)
      const failure = buildCaseFailure(err, {
        caseName,
        expectedOutput: originalCase.expectedOutput,
        inputs: originalCase.inputs,
        metadata: originalCase.metadata,
        sourceCaseName,
        span_id,
        trace_id,
      })
      await runLifecycleTeardown(lifecycle, failure, caseSpan)
      return failure
    }

    // Build span tree and auto-extract metrics
    const capturedSpans = evalsProcessor.drainBucket(exporterContextId)
    let spanTree: SpanTree
    if (capturedSpans.length === 0 && !isProcessorInstalledOnGlobal()) {
      spanTree = buildSpanTree([], new SpanTreeRecordingError())
    } else {
      spanTree = buildSpanTree(capturedSpans, null)
    }
    extractMetricsFromSpanTree(spanTree, taskRunState.metrics)

    let ctx: EvaluatorContext<Inputs, Output, Metadata> = {
      attributes: taskRunState.attributes,
      duration: taskDuration,
      expectedOutput: originalCase.expectedOutput,
      inputs: originalCase.inputs,
      metadata: originalCase.metadata,
      metrics: taskRunState.metrics,
      name: caseName,
      output,
      spanTree,
    }
    if (lifecycle?.prepareContext !== undefined) {
      try {
        ctx = await lifecycle.prepareContext(ctx)
      } catch (err) {
        recordException(caseSpan, err)
        const failure = buildCaseFailure(err, {
          caseName,
          expectedOutput: originalCase.expectedOutput,
          inputs: originalCase.inputs,
          metadata: originalCase.metadata,
          sourceCaseName,
          span_id,
          trace_id,
        })
        await runLifecycleTeardown(lifecycle, failure, caseSpan)
        return failure
      }
    }

    const allEvaluators: Evaluator<Inputs, Output, Metadata>[] = [...originalCase.evaluators, ...datasetEvaluators]
    const evResult = await runEvaluators(allEvaluators as Evaluator[], ctx as EvaluatorContext, retryEvaluators)

    const totalDuration = nowSec() - totalStart

    const finalAttrs: Record<string, unknown> = {
      [ATTR_ASSERTIONS]: evResult.assertions,
      [ATTR_ATTRIBUTES]: taskRunState.attributes,
      [ATTR_LABELS]: evResult.labels,
      [ATTR_METRICS]: taskRunState.metrics,
      [ATTR_OUTPUT]: output,
      [ATTR_SCORES]: evResult.scores,
      [ATTR_TASK_DURATION]: taskDuration,
    }
    setEvalsSpanAttributes(caseSpan, finalAttrs)

    const reportCase: ReportCase<Inputs, Output, Metadata> = {
      assertions: evResult.assertions,
      attributes: taskRunState.attributes,
      evaluator_failures: evResult.failures,
      expected_output: originalCase.expectedOutput,
      inputs: originalCase.inputs,
      labels: evResult.labels,
      metadata: originalCase.metadata,
      metrics: taskRunState.metrics,
      name: caseName,
      output,
      scores: evResult.scores,
      source_case_name: sourceCaseName,
      span_id,
      task_duration: taskDuration,
      total_duration: totalDuration,
      trace_id,
    }
    await runLifecycleTeardown(lifecycle, reportCase, caseSpan)
    return reportCase
  })
}

function buildCaseFailure<Inputs, Output, Metadata>(
  err: unknown,
  opts: {
    caseName: string
    expectedOutput?: Output
    inputs: Inputs
    metadata?: Metadata
    sourceCaseName?: string
    span_id: null | string
    trace_id: null | string
  }
): ReportCaseFailure<Inputs, Output, Metadata> {
  const isErr = err instanceof Error
  return {
    error_message: isErr ? err.message : String(err),
    error_stacktrace: isErr ? err.stack : undefined,
    error_type: isErr ? err.constructor.name : 'Error',
    expected_output: opts.expectedOutput,
    inputs: opts.inputs,
    metadata: opts.metadata,
    name: opts.caseName,
    source_case_name: opts.sourceCaseName,
    span_id: opts.span_id,
    trace_id: opts.trace_id,
  }
}

function recordException(span: Span, err: unknown): void {
  if (err instanceof Error) {
    span.recordException(err)
  } else {
    span.recordException(String(err))
  }
}

function nowSec(): number {
  return performance.now() / 1000
}

interface DenoTextFileRuntime {
  Deno?: {
    readTextFile?: (path: string) => Promise<string>
    writeTextFile?: (path: string, data: string) => Promise<void>
  }
}

async function readTextFile(filePath: string): Promise<string> {
  const deno = (globalThis as DenoTextFileRuntime).Deno
  if (typeof deno?.readTextFile === 'function') return deno.readTextFile(filePath)
  const fs: typeof import('node:fs/promises') = await import('node:fs/promises')
  return fs.readFile(filePath, 'utf8')
}

async function writeTextFile(filePath: string, text: string): Promise<void> {
  const deno = (globalThis as DenoTextFileRuntime).Deno
  if (typeof deno?.writeTextFile === 'function') {
    await deno.writeTextFile(filePath, text)
    return
  }
  const fs: typeof import('node:fs/promises') = await import('node:fs/promises')
  await fs.writeFile(filePath, text, 'utf8')
}

async function writeTextFileIfChanged(filePath: string, text: string): Promise<void> {
  let existing: string | undefined
  try {
    existing = await readTextFile(filePath)
  } catch {
    existing = undefined
  }
  if (existing !== text) await writeTextFile(filePath, text)
}

function fileStem(filePath: string): string {
  const base =
    filePath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

function resolveSiblingPath(filePath: string, siblingPath: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(siblingPath)) return siblingPath
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const dir = lastSep === -1 ? '.' : trimmed.slice(0, lastSep)
  return dir === '.' ? siblingPath : `${dir}${sep}${siblingPath}`
}

async function runLifecycleTeardown<Inputs, Output, Metadata>(
  lifecycle: CaseLifecycle<Inputs, Output, Metadata> | null,
  result: ReportCase<Inputs, Output, Metadata> | ReportCaseFailure<Inputs, Output, Metadata>,
  caseSpan: Span
): Promise<void> {
  if (lifecycle?.teardown === undefined) return
  try {
    await lifecycle.teardown(result)
  } catch (err) {
    if (err instanceof Error) {
      caseSpan.recordException(err)
    } else {
      caseSpan.recordException(String(err))
    }
  }
}
