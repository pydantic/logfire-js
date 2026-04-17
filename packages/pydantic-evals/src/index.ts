export { Case, Dataset, getCurrentTaskRun, incrementEvalMetric, setEvalAttribute } from './dataset'
export type { CaseInit, DatasetInit, EvaluateOptions } from './dataset'
export {
  Contains,
  DEFAULT_EVALUATORS,
  Equals,
  EqualsExpected,
  getDefaultJudgeFn,
  HasMatchingSpan,
  IsInstance,
  LLMJudge,
  MaxDuration,
  setDefaultJudgeFn,
} from './evaluators/common'
export type { ContainsOptions, GradingOutput, JudgeFn, LLMJudgeOptions, OutputConfig } from './evaluators/common'
export { EvaluatorContext } from './evaluators/context'
export { downcastEvaluationResult, evaluationReason, Evaluator, isEvaluationReason } from './evaluators/evaluator'
export type { EvaluationReason, EvaluationResult, EvaluationScalar, EvaluatorFailure, EvaluatorOutput } from './evaluators/evaluator'
export {
  ConfusionMatrixEvaluator,
  DEFAULT_REPORT_EVALUATORS,
  KolmogorovSmirnovEvaluator,
  PrecisionRecallEvaluator,
  ROCAUCEvaluator,
} from './evaluators/reportCommon'
export type {
  ConfusionMatrixEvaluatorOptions,
  KSEvaluatorOptions,
  PrecisionRecallEvaluatorOptions,
  ROCAUCEvaluatorOptions,
} from './evaluators/reportCommon'
export { ReportEvaluator } from './evaluators/reportEvaluator'
export type { ReportEvaluatorContext } from './evaluators/reportEvaluator'
export { runEvaluator } from './evaluators/runEvaluator'
export { parseEvaluatorSpec, serializeEvaluatorSpec } from './evaluators/spec'
export type { EvaluatorSerializedForm, EvaluatorSpec } from './evaluators/spec'
export { generateDataset } from './generation'
export type { GenerateDatasetOptions } from './generation'
export { CaseLifecycle } from './lifecycle'
export type { Case as CaseLike, ReportCaseLike } from './lifecycle'
export {
  CallbackSink,
  configure,
  DEFAULT_CONFIG,
  disableEvaluation,
  OnlineEvalConfig,
  evaluate as onlineEvaluate,
  OnlineEvaluator,
  runEvaluators,
  waitForEvaluations,
} from './online'
export type {
  EvaluationSink,
  OnErrorCallback,
  OnErrorLocation,
  OnlineEvalConfigOptions,
  OnlineEvaluatorOptions,
  OnMaxConcurrencyCallback,
  OnSamplingErrorCallback,
  SamplingContext,
  SamplingMode,
  SinkCallback,
  SpanReference,
} from './online'
export { getSpanTreeProcessor } from './otel/contextSubtree'
export { SpanTreeRecordingError } from './otel/errors'
export { SpanNode, SpanTree } from './otel/spanTree'
export type { AttributeValue, SpanAttributes, SpanPredicate, SpanQuery } from './otel/spanTree'
export type {
  ConfusionMatrix,
  LinePlot,
  LinePlotCurve,
  LinePlotPoint,
  PrecisionRecall,
  PrecisionRecallCurve,
  PrecisionRecallPoint,
  ReportAnalysis,
  ScalarResult,
  TableResult,
} from './reporting/analyses'
export {
  defaultRenderDuration,
  defaultRenderDurationDiff,
  defaultRenderNumber,
  defaultRenderNumberDiff,
  defaultRenderPercentage,
} from './reporting/renderNumbers'
export { aggregateAverage, aggregateAverageFromAggregates, EvaluationReport } from './reporting/report'
export type { RenderOptions, ReportCase, ReportCaseAggregate, ReportCaseFailure, ReportCaseGroup } from './reporting/report'
export { PydanticEvalsDeprecationWarning } from './utils'
