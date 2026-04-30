/**
 * Shared types used across the evals subsystem.
 */

import type { Evaluator } from './Evaluator'
import type { CaseLifecycleClass } from './CaseLifecycle'
import type { ReportEvaluator } from './ReportEvaluator'
import type { SpanTree } from './spanTree/SpanTree'

/**
 * The serialized identity of an evaluator instance, used for the wire-format
 * `source` field on EvaluationResult and for round-tripping YAML / JSON.
 *
 * Mirrors pydantic-evals' `EvaluatorSpec`.
 */
export interface EvaluatorSpec {
  arguments: null | Record<string, unknown> | unknown[]
  name: string
}

/** Reason explanation paired with a scalar evaluator output. */
export interface EvaluationReason {
  reason?: string
  value: boolean | number | string
}

/**
 * The raw shape an evaluator's `evaluate()` may return. The driver
 * post-processes this into `EvaluationResult[]`.
 */
export type EvaluatorOutput = boolean | EvaluationReason | number | Record<string, boolean | EvaluationReason | number | string> | string

/**
 * The wire-format JSON shape the platform frontend strict-parses with Zod.
 * Anything we put in `case.scores | labels | assertions` must look like this.
 */
export interface EvaluationResultJson {
  evaluator_version?: string
  name: string
  reason: null | string
  source: EvaluatorSpec
  value: boolean | number | string
}

export interface EvaluatorContext<Inputs = unknown, Output = unknown, Metadata = unknown> {
  readonly attributes: Record<string, unknown>
  readonly duration: number
  readonly expectedOutput?: Output
  readonly inputs: Inputs
  readonly metadata?: Metadata
  readonly metrics: Record<string, number>
  readonly name?: string
  readonly output: Output
  /**
   * Captured tree of spans emitted under `execute {task}`. Throws
   * `SpanTreeRecordingError` on access if span-tree capture wasn't installed.
   */
  readonly spanTree: SpanTree
}

export interface EvaluatorClass<Inputs = unknown, Output = unknown, Metadata = unknown> {
  evaluatorName?: string
  new (...args: never[]): Evaluator<Inputs, Output, Metadata>
}

export interface ReportEvaluatorClass<Inputs = unknown, Output = unknown, Metadata = unknown> {
  evaluatorName?: string
  new (...args: never[]): ReportEvaluator<Inputs, Output, Metadata>
}

/**
 * Mutable per-case execution state. Lives in an `AsyncLocalStorage`-managed
 * context for the duration of a case run. Used by `setEvalAttribute` /
 * `incrementEvalMetric`.
 */
export interface TaskRunState {
  attributes: Record<string, unknown>
  /** Stable random ID used by the span-tree exporter to scope captured spans. */
  exporterContextId: string
  metrics: Record<string, number>
}

/** Internal — failure record produced when an evaluator throws. */
export interface EvaluatorFailureRecord {
  error_message: string
  error_stacktrace?: string
  error_type: string
  evaluator_version?: string
  name: string
  source: EvaluatorSpec
}

/**
 * Retry config — passed to `p-retry`. See https://github.com/sindresorhus/p-retry
 * for the full option set; only the most common options are documented here.
 */
export interface RetryConfig {
  factor?: number
  maxTimeout?: number
  minTimeout?: number
  retries?: number
}

/**
 * Options accepted by `Dataset.evaluate`. Mirrors pydantic-evals'
 * `Dataset.evaluate(...)` kwargs but with TS-idiomatic naming.
 */
export interface EvaluateOptions<Inputs = unknown, Output = unknown, Metadata = unknown> {
  // Phantom fields anchor the generic parameters for callers using this type directly.
  _phantomInputs?: Inputs
  _phantomMetadata?: Metadata
  _phantomOutput?: Output
  /** Per-case lifecycle hooks — pass the class, not an instance. */
  lifecycle?: CaseLifecycleClass<Inputs, Output, Metadata>
  /** Bound concurrent case execution with a semaphore. Undefined = unbounded. */
  maxConcurrency?: number
  /** User-provided experiment metadata — surfaces as a top-level `metadata` attribute. */
  metadata?: Record<string, unknown>
  /** Override the experiment name (defaults to dataset.name). */
  name?: string
  /** Progress reporter. `true` = default stderr reporter, callback = custom, `false`/undefined = silent. */
  progress?: ((event: { caseName: string; done: number; total: number }) => void) | boolean
  /** Number of times to repeat each case (default 1). */
  repeat?: number
  /** Retry config for evaluator runs. */
  retryEvaluators?: RetryConfig
  /** Retry config for the user's task. Powered by `p-retry`. */
  retryTask?: RetryConfig
  /** Cancel an evaluation. Cases not yet started are skipped; in-flight tasks are not interrupted automatically. */
  signal?: AbortSignal
  /** Override the task display name (defaults to function.name). */
  taskName?: string
}
