/**
 * Logfire-JS evals — offline + online evaluation built on the existing
 * logfire OTel infra. Wire-format-compatible with the Python pydantic-evals
 * package; emitted spans/log events ingest into the Logfire platform's
 * `experiments` table and Live Evals UI without further configuration.
 *
 * @see ./constants.ts for the full list of attribute keys we emit
 * @see plans/evals-port-prd.md for the design doc
 */

export {
  Contains,
  deepEqual,
  Equals,
  EqualsExpected,
  getDefaultJudge,
  HasMatchingSpan,
  IsInstance,
  type JudgeFn,
  type JudgeResult,
  LLMJudge,
  type LLMJudgeOutputConfig,
  MaxDuration,
  setDefaultJudge,
} from './builtins'
export { Case, type CaseOptions } from './Case'
export { CaseLifecycle, type CaseLifecycleClass } from './CaseLifecycle'
export * from './constants'
export { getCurrentTaskRun, incrementEvalMetric, runWithTaskRun, setEvalAttribute } from './currentTaskRun'
export { Dataset, type DatasetOptions } from './Dataset'
export { Evaluator } from './Evaluator'
export { buildEvaluationResultJson } from './evaluatorResults'
export {
  configureOnlineEvals,
  disableEvaluation,
  type EvaluationSink,
  getOnlineEvalConfig,
  type OnErrorCallback,
  type OnErrorLocation,
  type OnlineEvalConfig,
  OnlineEvaluator,
  type OnMaxConcurrencyCallback,
  type SamplingContext,
  type SamplingMode,
  type SinkPayload,
  waitForEvaluations,
  withOnlineEvaluation,
} from './online'
export { emitEvaluationResult, emitEvaluatorFailure, type SpanReference, spanReferenceFromSpan } from './otelEmit'
export {
  evaluatorRegistryKey,
  getEvaluatorClass,
  getReportEvaluatorClass,
  listRegisteredEvaluators,
  listRegisteredReportEvaluators,
  registerEvaluator,
  registerReportEvaluator,
} from './registry'
export { type RenderOptions, renderReport } from './render'
export {
  type ConfusionMatrixAnalysis,
  type KSAnalysis,
  type LinePlotAnalysis,
  type PrecisionRecallAnalysis,
  type ReportAnalysis,
  ReportEvaluator,
  type ReportEvaluatorContext,
  type ROCAnalysis,
  type ScalarAnalysis,
  type TableAnalysis,
} from './ReportEvaluator'
export {
  ConfusionMatrixEvaluator,
  type ConfusionMatrixOptions,
  KolmogorovSmirnovEvaluator,
  type KSOptions,
  type PositiveFrom,
  PrecisionRecallEvaluator,
  type PrecisionRecallOptions,
  ROCAUCEvaluator,
  type ROCAUCOptions,
  type ScoreFrom,
} from './reportEvaluators'
export {
  averageFromAggregates,
  averages,
  caseGroups,
  computeAssertionPassRate,
  computeAverages,
  type EvaluationReport,
  type ReportCase,
  type ReportCaseAggregate,
  type ReportCaseFailure,
  type ReportCaseGroup,
} from './reporting'
export { detectRuntime, hasAsyncLocalStorage, hasNodeFs, type RuntimeName } from './runtime'
export {
  buildDatasetJsonSchema,
  datasetFromObject,
  datasetToObject,
  decodeEvaluator,
  decodeReportEvaluator,
  decodeSpec,
  type EncodedEvaluator,
  encodeEvaluatorSpec,
  type FromOptions,
  type JsonSchema,
  parseYaml,
  type SerializedCase,
  type SerializedDataset,
  stringifyYaml,
  type ToOptions,
} from './serialization'
export {
  EvalsSpanProcessor,
  getEvalsSpanProcessor,
  SpanNode,
  type SpanQuery,
  spanQueryToSnakeCase,
  SpanTree,
  SpanTreeRecordingError,
} from './spanTree'
export type {
  EvaluateOptions,
  EvaluationReason,
  EvaluationResultJson,
  EvaluatorClass,
  EvaluatorContext,
  EvaluatorFailureRecord,
  EvaluatorOutput,
  EvaluatorSpec,
  ReportEvaluatorClass,
  TaskRunState,
} from './types'
