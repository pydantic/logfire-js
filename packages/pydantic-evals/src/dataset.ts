import { AsyncLocalStorage } from 'node:async_hooks'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { DEFAULT_EVALUATORS } from './evaluators/common'
import { EvaluatorContext } from './evaluators/context'
import { EvaluationResult, Evaluator, EvaluatorFailure } from './evaluators/evaluator'
import { DEFAULT_REPORT_EVALUATORS } from './evaluators/reportCommon'
import { ReportEvaluator, ReportEvaluatorContext } from './evaluators/reportEvaluator'
import { runEvaluator } from './evaluators/runEvaluator'
import { EvaluatorSerializedForm, EvaluatorSpec, parseEvaluatorSpec, serializeEvaluatorSpec } from './evaluators/spec'
import { CaseLifecycle } from './lifecycle'
import { contextSubtreeCapture } from './otel/contextSubtree'
import { SpanTreeRecordingError } from './otel/errors'
import { SpanNode, SpanTree } from './otel/spanTree'
import { EvaluationReport, ReportCase, ReportCaseFailure } from './reporting/report'
import { evalSpan } from './tracing'
import { getFunctionName, taskGroupGatherConcurrency, warnOnce } from './utils'

type EvaluatorCtor<I = unknown, O = unknown, M = unknown> = new (args: never) => Evaluator<I, O, M>
type ReportEvaluatorCtor<I = unknown, O = unknown, M = unknown> = new (args: never) => ReportEvaluator<I, O, M>

const taskRunStorage = new AsyncLocalStorage<TaskRun>()

class TaskRun {
  attributes: Record<string, unknown> = {}
  metrics: Record<string, number> = {}

  incrementMetric(name: string, amount: number): void {
    const current = this.metrics[name] ?? 0
    const next = current + amount
    if (current === 0 && next === 0) return
    this.metrics[name] = next
  }

  recordAttribute(name: string, value: unknown): void {
    this.attributes[name] = value
  }

  recordMetric(name: string, value: number): void {
    this.metrics[name] = value
  }
}

export function setEvalAttribute(name: string, value: unknown): void {
  const run = taskRunStorage.getStore()
  if (run !== undefined) run.recordAttribute(name, value)
}

export function incrementEvalMetric(name: string, amount: number): void {
  const run = taskRunStorage.getStore()
  if (run !== undefined) run.incrementMetric(name, amount)
}

export function getCurrentTaskRun(): null | TaskRun {
  return taskRunStorage.getStore() ?? null
}

export interface CaseInit<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  evaluators?: Evaluator<InputsT, OutputT, MetadataT>[]
  expectedOutput?: null | OutputT
  inputs: InputsT
  metadata?: MetadataT | null
  name?: null | string
}

export class Case<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  evaluators: Evaluator<InputsT, OutputT, MetadataT>[]
  expectedOutput: null | OutputT
  inputs: InputsT
  metadata: MetadataT | null
  name: null | string

  constructor(params: CaseInit<InputsT, OutputT, MetadataT>) {
    this.name = params.name ?? null
    this.inputs = params.inputs
    this.metadata = params.metadata ?? null
    this.expectedOutput = params.expectedOutput ?? null
    this.evaluators = [...(params.evaluators ?? [])]
  }
}

export interface DatasetInit<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  cases: Case<InputsT, OutputT, MetadataT>[]
  evaluators?: Evaluator<InputsT, OutputT, MetadataT>[]
  name?: null | string
  reportEvaluators?: ReportEvaluator<InputsT, OutputT, MetadataT>[]
}

export interface EvaluateOptions<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  lifecycle?: new (caseObj: Case<InputsT, OutputT, MetadataT>) => CaseLifecycle<InputsT, OutputT, MetadataT>
  maxConcurrency?: null | number
  metadata?: null | Record<string, unknown>
  name?: null | string
  progress?: boolean
  repeat?: number
  taskName?: null | string
}

export class Dataset<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  cases: Case<InputsT, OutputT, MetadataT>[]
  evaluators: Evaluator<InputsT, OutputT, MetadataT>[]
  name: null | string
  reportEvaluators: ReportEvaluator<InputsT, OutputT, MetadataT>[]

  constructor(params: DatasetInit<InputsT, OutputT, MetadataT>) {
    if (params.name === undefined || params.name === null) {
      warnOnce('dataset-name-missing', 'Omitting the `name` parameter is deprecated. Please provide a name for your `Dataset`.')
    }
    const caseNames = new Set<string>()
    for (const c of params.cases) {
      if (c.name === null) continue
      if (caseNames.has(c.name)) throw new Error(`Duplicate case name: ${JSON.stringify(c.name)}`)
      caseNames.add(c.name)
    }
    this.name = params.name ?? null
    this.cases = [...params.cases]
    this.evaluators = [...(params.evaluators ?? [])]
    this.reportEvaluators = [...(params.reportEvaluators ?? [])]
  }

  static fromDict<I = unknown, O = unknown, M = unknown>(
    data: Record<string, unknown>,
    options: {
      customEvaluatorTypes?: EvaluatorCtor<I, O, M>[]
      customReportEvaluatorTypes?: ReportEvaluatorCtor<I, O, M>[]
      defaultName?: null | string
    } = {}
  ): Dataset<I, O, M> {
    const evalRegistry = buildEvaluatorRegistry<Evaluator<I, O, M>>(
      options.customEvaluatorTypes ?? [],
      DEFAULT_EVALUATORS as unknown as EvaluatorCtor<I, O, M>[]
    )
    const reportRegistry = buildEvaluatorRegistry<ReportEvaluator<I, O, M>>(
      options.customReportEvaluatorTypes ?? [],
      DEFAULT_REPORT_EVALUATORS as unknown as ReportEvaluatorCtor<I, O, M>[]
    )

    const cases: Case<I, O, M>[] = []
    const casesArr = (data.cases as undefined | unknown[]) ?? []
    for (const raw of casesArr) {
      const rawCase = raw as {
        evaluators?: EvaluatorSerializedForm[]
        expected_output?: null | O
        inputs: I
        metadata?: M | null
        name?: null | string
      }
      const evaluators: Evaluator<I, O, M>[] = []
      for (const spec of rawCase.evaluators ?? []) {
        evaluators.push(instantiateFromRegistry(evalRegistry, parseEvaluatorSpec(spec)))
      }
      cases.push(
        new Case<I, O, M>({
          evaluators,
          expectedOutput: rawCase.expected_output ?? null,
          inputs: rawCase.inputs,
          metadata: rawCase.metadata ?? null,
          name: rawCase.name ?? null,
        })
      )
    }

    const dsEvals = ((data.evaluators as EvaluatorSerializedForm[] | undefined) ?? []).map((s) =>
      instantiateFromRegistry(evalRegistry, parseEvaluatorSpec(s))
    )
    const reportEvals = ((data.report_evaluators as EvaluatorSerializedForm[] | undefined) ?? []).map((s) =>
      instantiateFromRegistry(reportRegistry, parseEvaluatorSpec(s))
    )

    const datasetName = (data.name as null | string | undefined) ?? options.defaultName ?? null
    return new Dataset<I, O, M>({
      cases,
      evaluators: dsEvals,
      name: datasetName,
      reportEvaluators: reportEvals,
    })
  }

  static fromText<I = unknown, O = unknown, M = unknown>(
    content: string,
    options: {
      customEvaluatorTypes?: EvaluatorCtor<I, O, M>[]
      customReportEvaluatorTypes?: ReportEvaluatorCtor<I, O, M>[]
      defaultName?: null | string
      fmt?: 'json' | 'yaml'
    } = {}
  ): Dataset<I, O, M> {
    const fmt = options.fmt ?? 'yaml'
    const raw = fmt === 'json' ? JSON.parse(content) : parseYaml(content)
    return Dataset.fromDict<I, O, M>(raw as Record<string, unknown>, options)
  }

  addCase(params: CaseInit<InputsT, OutputT, MetadataT>): void {
    if (params.name !== null && params.name !== undefined) {
      for (const c of this.cases) {
        if (c.name === params.name) throw new Error(`Duplicate case name: ${JSON.stringify(params.name)}`)
      }
    }
    this.cases.push(new Case(params))
  }

  addEvaluator(evaluator: Evaluator<InputsT, OutputT, MetadataT>, specificCase?: string): void {
    if (specificCase === undefined) {
      this.evaluators.push(evaluator)
      return
    }
    let added = false
    for (const c of this.cases) {
      if (c.name === specificCase) {
        c.evaluators.push(evaluator)
        added = true
      }
    }
    if (!added) throw new Error(`Case ${JSON.stringify(specificCase)} not found in the dataset`)
  }

  async evaluate(
    task: (inputs: InputsT) => OutputT | Promise<OutputT>,
    options: EvaluateOptions<InputsT, OutputT, MetadataT> = {}
  ): Promise<EvaluationReport<InputsT, OutputT, MetadataT>> {
    const repeat = options.repeat ?? 1
    if (repeat < 1) throw new Error(`repeat must be >= 1, got ${String(repeat)}`)
    const taskName = options.taskName ?? getFunctionName(task as (...args: never[]) => unknown)
    const name = options.name ?? taskName
    const tasksToRun = this.buildTasksToRun(repeat)

    const report = await evalSpan(
      'evaluate {name}',
      {
        dataset_name: this.name,
        'gen_ai.operation.name': 'experiment',
        n_cases: this.cases.length,
        name,
        task_name: taskName,
        ...(options.metadata !== undefined && options.metadata !== null ? { metadata: options.metadata } : {}),
        ...(repeat > 1 ? { 'logfire.experiment.repeat': repeat } : {}),
      },
      async (span) => {
        const tasks = tasksToRun.map(
          ([caseObj, reportName, sourceName]) =>
            () =>
              runTaskAndEvaluators(task, caseObj, reportName, this.evaluators, sourceName, options.lifecycle ?? null)
        )
        const results = await taskGroupGatherConcurrency(tasks, options.maxConcurrency ?? null)

        const cases: ReportCase<InputsT, OutputT, MetadataT>[] = []
        const failures: ReportCaseFailure<InputsT, OutputT, MetadataT>[] = []
        for (const r of results) {
          if ('output' in r) cases.push(r)
          else failures.push(r)
        }

        const r = new EvaluationReport<InputsT, OutputT, MetadataT>({
          cases,
          experimentMetadata: options.metadata ?? null,
          failures,
          name,
        })
        const avg = r.averages()
        if (avg !== null && avg.assertions !== null) {
          span.setAttribute('assertion_pass_rate', avg.assertions)
        }
        return r
      }
    )

    if (this.reportEvaluators.length > 0) {
      await runReportEvaluators(
        this.reportEvaluators,
        {
          experimentMetadata: options.metadata ?? null,
          name,
          report: report as unknown as ReportEvaluatorContext<InputsT, OutputT, MetadataT>['report'],
        } as ReportEvaluatorContext<InputsT, OutputT, MetadataT>,
        report
      )
    }
    return report
  }

  async toDict(): Promise<Record<string, unknown>> {
    return await Promise.resolve({
      cases: this.cases.map((c) => ({
        evaluators: c.evaluators.map((e) => serializeEvaluatorSpec(e.asSpec())),
        expected_output: c.expectedOutput,
        inputs: c.inputs,
        metadata: c.metadata,
        name: c.name,
      })),
      evaluators: this.evaluators.map((e) => serializeEvaluatorSpec(e.asSpec())),
      name: this.name,
      report_evaluators: this.reportEvaluators.map((e) => serializeEvaluatorSpec(e.asSpec())),
    })
  }

  async toJSON(): Promise<string> {
    return JSON.stringify(await this.toDict(), null, 2)
  }

  async toYAML(): Promise<string> {
    return stringifyYaml(await this.toDict())
  }

  private buildTasksToRun(repeat: number): [Case<InputsT, OutputT, MetadataT>, string, null | string][] {
    if (repeat > 1) {
      const out: [Case<InputsT, OutputT, MetadataT>, string, null | string][] = []
      this.cases.forEach((caseObj, i) => {
        const caseName = caseObj.name ?? `Case ${String(i + 1)}`
        for (let runIdx = 1; runIdx <= repeat; runIdx++) {
          out.push([caseObj, `${caseName} [${String(runIdx)}/${String(repeat)}]`, caseName])
        }
      })
      return out
    }
    return this.cases.map((caseObj, i) => [caseObj, caseObj.name ?? `Case ${String(i + 1)}`, null])
  }
}

function buildEvaluatorRegistry<T>(
  custom: (new (...args: never[]) => T)[],
  defaults: (new (...args: never[]) => T)[]
): Map<string, new (args: never) => T> {
  const registry = new Map<string, new (args: never) => T>()
  for (const cls of defaults) {
    registry.set(cls.name, cls as unknown as new (args: never) => T)
  }
  for (const cls of custom) {
    registry.set(cls.name, cls as unknown as new (args: never) => T)
  }
  return registry
}

function instantiateFromRegistry<T>(registry: Map<string, new (args: never) => T>, spec: EvaluatorSpec): T {
  const ctor = registry.get(spec.name)
  if (ctor === undefined) {
    throw new Error(`Unknown evaluator: ${spec.name}. Register it via customEvaluatorTypes.`)
  }
  if (spec.arguments === null || spec.arguments === undefined) {
    return new ctor(undefined as unknown as never)
  }
  if (Array.isArray(spec.arguments)) {
    return new ctor(spec.arguments[0] as never)
  }
  return new ctor(spec.arguments as never)
}

function extractSpanTreeMetrics(taskRun: TaskRun, spanTree: SpanTree): void {
  for (const node of spanTree) {
    if (!('gen_ai.request.model' in node.attributes)) continue
    for (const [k, v] of Object.entries(node.attributes)) {
      if (k === 'gen_ai.operation.name' && v === 'chat') {
        taskRun.incrementMetric('requests', 1)
      } else if (typeof v !== 'number') {
        continue
      } else if (k === 'operation.cost') {
        taskRun.incrementMetric('cost', v)
      } else if (k.startsWith('gen_ai.usage.details.')) {
        taskRun.incrementMetric(k.slice('gen_ai.usage.details.'.length), v)
      } else if (k.startsWith('gen_ai.usage.')) {
        taskRun.incrementMetric(k.slice('gen_ai.usage.'.length), v)
      }
    }
  }
}

async function runTask<InputsT, OutputT, MetadataT>(
  task: (inputs: InputsT) => OutputT | Promise<OutputT>,
  caseObj: Case<InputsT, OutputT, MetadataT>
): Promise<EvaluatorContext<InputsT, OutputT, MetadataT>> {
  const taskRun = new TaskRun()
  /* v8 ignore next 3 - nested task run guard; prevented by evaluation flow */
  if (taskRunStorage.getStore() !== undefined) {
    throw new Error('A task run has already been entered. Task runs should not be nested')
  }
  let spanTreeRef: SpanTree | SpanTreeRecordingError = new SpanTreeRecordingError('not-started')
  let output: OutputT
  let duration: number
  await taskRunStorage.run(taskRun, async () => {
    await evalSpan('execute {task}', { task: getFunctionName(task as (...args: never[]) => unknown) }, async () => {
      await contextSubtreeCapture(async (getTree) => {
        const t0 = performance.now()
        output = await Promise.resolve(task(caseObj.inputs))
        duration = (performance.now() - t0) / 1000
        // Let any Promise-scheduled span.end() handlers drain (e.g. logfire's `span()`
        // wrapper, which calls `.then(() => span.end())` after the callback resolves)
        // so evaluators see a complete tree.
        await new Promise<void>((resolve) => setImmediate(resolve))
        spanTreeRef = getTree()
      })
    })
  })
  /* v8 ignore next 3 - only reached when a real TracerProvider is configured; covered in integration tests */
  if (spanTreeRef instanceof SpanTree) {
    extractSpanTreeMetrics(taskRun, spanTreeRef)
  }
  return new EvaluatorContext<InputsT, OutputT, MetadataT>({
    attributes: taskRun.attributes,
    duration: duration!,
    expectedOutput: caseObj.expectedOutput,
    inputs: caseObj.inputs,
    metadata: caseObj.metadata,
    metrics: taskRun.metrics,
    name: caseObj.name,
    output: output!,
    spanTree: spanTreeRef,
  })
}

async function runTaskAndEvaluators<InputsT, OutputT, MetadataT>(
  task: (inputs: InputsT) => OutputT | Promise<OutputT>,
  caseObj: Case<InputsT, OutputT, MetadataT>,
  reportCaseName: string,
  datasetEvaluators: Evaluator<InputsT, OutputT, MetadataT>[],
  sourceCaseName: null | string,
  lifecycleCtor: (new (caseObj: Case<InputsT, OutputT, MetadataT>) => CaseLifecycle<InputsT, OutputT, MetadataT>) | null
): Promise<ReportCase<InputsT, OutputT, MetadataT> | ReportCaseFailure<InputsT, OutputT, MetadataT>> {
  return await evalSpan(
    'case: {case_name}',
    {
      case_name: reportCaseName,
      expected_output: caseObj.expectedOutput,
      inputs: caseObj.inputs,
      metadata: caseObj.metadata,
      task_name: getFunctionName(task as (...args: never[]) => unknown),
      ...(sourceCaseName !== null ? { 'logfire.experiment.source_case_name': sourceCaseName } : {}),
    },
    async (span) => {
      const result = await runTaskAndEvaluatorsInner(task, caseObj, reportCaseName, datasetEvaluators, sourceCaseName, lifecycleCtor)
      if ('output' in result) {
        span.setAttribute('output', normalizeForAttribute(result.output))
        span.setAttribute('task_duration', result.taskDuration)
        span.setAttribute('metrics', normalizeForAttribute(result.metrics))
        span.setAttribute('attributes', normalizeForAttribute(result.attributes))
        span.setAttribute('assertions', normalizeForAttribute(result.assertions))
        span.setAttribute('scores', normalizeForAttribute(result.scores))
        span.setAttribute('labels', normalizeForAttribute(result.labels))
      }
      return result
    }
  )
}

function normalizeForAttribute(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

async function runTaskAndEvaluatorsInner<InputsT, OutputT, MetadataT>(
  task: (inputs: InputsT) => OutputT | Promise<OutputT>,
  caseObj: Case<InputsT, OutputT, MetadataT>,
  reportCaseName: string,
  datasetEvaluators: Evaluator<InputsT, OutputT, MetadataT>[],
  sourceCaseName: null | string,
  lifecycleCtor: (new (caseObj: Case<InputsT, OutputT, MetadataT>) => CaseLifecycle<InputsT, OutputT, MetadataT>) | null
): Promise<ReportCase<InputsT, OutputT, MetadataT> | ReportCaseFailure<InputsT, OutputT, MetadataT>> {
  const t0 = performance.now()
  let lc: CaseLifecycle<InputsT, OutputT, MetadataT> | null = null
  let result: ReportCase<InputsT, OutputT, MetadataT> | ReportCaseFailure<InputsT, OutputT, MetadataT>
  try {
    if (lifecycleCtor !== null) {
      lc = new lifecycleCtor(caseObj)
      await lc.setup()
    }
    let scoringContext = await runTask(task, caseObj)
    if (lc !== null) {
      scoringContext = await lc.prepareContext(scoringContext)
    }
    const evaluators = [...caseObj.evaluators, ...datasetEvaluators]
    const evaluatorOutputs: EvaluationResult[] = []
    const evaluatorFailures: EvaluatorFailure[] = []
    if (evaluators.length > 0) {
      const results = await Promise.all(
        evaluators.map((e) => runEvaluator(e as unknown as Evaluator, scoringContext as unknown as EvaluatorContext))
      )
      for (const r of results) {
        if (Array.isArray(r)) evaluatorOutputs.push(...r)
        else evaluatorFailures.push(r)
      }
    }
    const { assertions, labels, scores } = groupEvaluatorOutputs(evaluatorOutputs)
    result = {
      assertions,
      attributes: scoringContext.attributes,
      evaluatorFailures,
      expectedOutput: caseObj.expectedOutput,
      inputs: caseObj.inputs,
      labels,
      metadata: caseObj.metadata,
      metrics: scoringContext.metrics,
      name: reportCaseName,
      output: scoringContext.output,
      scores,
      sourceCaseName,
      spanId: null,
      taskDuration: scoringContext.duration,
      totalDuration: (performance.now() - t0) / 1000,
      traceId: null,
    }
  } catch (e) {
    const err = e as Error
    result = {
      errorMessage: `${err.name}: ${err.message}`,
      errorStacktrace: err.stack ?? String(e),
      expectedOutput: caseObj.expectedOutput,
      inputs: caseObj.inputs,
      metadata: caseObj.metadata,
      name: reportCaseName,
      sourceCaseName,
      spanId: null,
      traceId: null,
    }
  }
  if (lc !== null) {
    await lc.teardown(result)
  }
  if ('output' in result) {
    result.totalDuration = (performance.now() - t0) / 1000
  }
  return result
}

function groupEvaluatorOutputs(evaluationResults: EvaluationResult[]): {
  assertions: Record<string, EvaluationResult<boolean>>
  labels: Record<string, EvaluationResult<string>>
  scores: Record<string, EvaluationResult<number>>
} {
  const assertions: Record<string, EvaluationResult<boolean>> = {}
  const scores: Record<string, EvaluationResult<number>> = {}
  const labels: Record<string, EvaluationResult<string>> = {}
  const seen = new Set<string>()
  for (const er of evaluationResults) {
    let name = er.name
    if (seen.has(name)) {
      let suffix = 2
      while (seen.has(`${name}_${String(suffix)}`)) suffix++
      name = `${name}_${String(suffix)}`
    }
    seen.add(name)
    if (typeof er.value === 'boolean') {
      assertions[name] = er as EvaluationResult<boolean>
    } else if (typeof er.value === 'number') {
      scores[name] = er as EvaluationResult<number>
    } else if (typeof er.value === 'string') {
      labels[name] = er as EvaluationResult<string>
    }
  }
  return { assertions, labels, scores }
}

async function runReportEvaluators(reportEvals: ReportEvaluator[], ctx: ReportEvaluatorContext, report: EvaluationReport): Promise<void> {
  for (const re of reportEvals) {
    try {
      const result = await re.evaluateAsync(ctx)
      if (Array.isArray(result)) report.analyses.push(...result)
      else report.analyses.push(result)
    } catch (e) {
      const err = e as Error
      report.reportEvaluatorFailures.push({
        errorMessage: `${err.name}: ${err.message}`,
        errorStacktrace: err.stack ?? String(e),
        name: re.getSerializationName(),
        source: re.asSpec(),
      })
    }
  }
}

// Keep SpanNode import referenced to avoid unused warnings
void SpanNode
