// Wire-format constants for the evals integration.
//
// These names are the contract between this SDK and the Logfire platform's
// fusionfire ingest path / web UI. They MUST stay byte-identical to the
// Python pydantic-evals package — `pydantic_evals/_otel_emit.py:38–53` and
// `pydantic_evals/dataset.py:342–356, 1042–1076`. Renaming any of them is a
// breaking change that prevents experiments / cases / online evals from
// rendering in the Logfire UI.

/** OTel scope used by every evals span and log emission. */
export const EVALS_OTEL_SCOPE = 'pydantic-evals'

// --- Standard OTel gen_ai semantic-convention attribute names ---------------

export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name'
export const GEN_AI_EVAL_NAME = 'gen_ai.evaluation.name'
export const GEN_AI_SCORE_VALUE = 'gen_ai.evaluation.score.value'
export const GEN_AI_SCORE_LABEL = 'gen_ai.evaluation.score.label'
export const GEN_AI_EXPLANATION = 'gen_ai.evaluation.explanation'
export const ERROR_TYPE = 'error.type'

// --- Pydantic extensions in the gen_ai.* namespace ---------------------------

export const GEN_AI_EVAL_TARGET = 'gen_ai.evaluation.target'
export const GEN_AI_EVALUATOR_SOURCE = 'gen_ai.evaluation.evaluator.source'
export const GEN_AI_EVALUATOR_VERSION = 'gen_ai.evaluation.evaluator.version'

// --- Online-eval log event ---------------------------------------------------

export const EVAL_RESULT_EVENT_NAME = 'gen_ai.evaluation.result'

// --- logfire.experiment.* namespace -----------------------------------------

export const EXPERIMENT_REPEAT_KEY = 'logfire.experiment.repeat'
export const EXPERIMENT_METADATA_KEY = 'logfire.experiment.metadata'
export const EXPERIMENT_ANALYSES_KEY = 'logfire.experiment.analyses'
export const EXPERIMENT_REPORT_EVALUATOR_FAILURES_KEY = 'logfire.experiment.report_evaluator_failures'
export const EXPERIMENT_SOURCE_CASE_NAME_KEY = 'logfire.experiment.source_case_name'

// --- Span / case / experiment top-level attribute keys ----------------------

export const ATTR_NAME = 'name'
export const ATTR_TASK_NAME = 'task_name'
export const ATTR_DATASET_NAME = 'dataset_name'
export const ATTR_N_CASES = 'n_cases'
export const ATTR_CASE_NAME = 'case_name'
export const ATTR_INPUTS = 'inputs'
export const ATTR_METADATA = 'metadata'
export const ATTR_EXPECTED_OUTPUT = 'expected_output'
export const ATTR_OUTPUT = 'output'
export const ATTR_TASK_DURATION = 'task_duration'
export const ATTR_METRICS = 'metrics'
export const ATTR_ATTRIBUTES = 'attributes'
export const ATTR_ASSERTIONS = 'assertions'
export const ATTR_SCORES = 'scores'
export const ATTR_LABELS = 'labels'
export const ATTR_ASSERTION_PASS_RATE = 'assertion_pass_rate'
export const ATTR_EVALUATOR_NAME = 'evaluator_name'

// --- Span name templates ----------------------------------------------------

export const SPAN_NAME_EXPERIMENT = 'evaluate {name}'
export const SPAN_NAME_CASE = 'case: {case_name}'
export const SPAN_NAME_EXECUTE = 'execute {task}'
/** Stable span name for evaluator runs — kept literal across versions. */
export const SPAN_NAME_EVALUATOR_LITERAL = 'evaluator: {evaluator_name}'
/** Friendly message template for evaluator runs (the user-visible form in the UI). */
export const SPAN_MSG_TEMPLATE_EVALUATOR = 'Calling evaluator: {evaluator_name}'
export const SPAN_NAME_REPORT_EVALUATOR_LITERAL = 'report_evaluator: {evaluator_name}'
export const SPAN_MSG_TEMPLATE_REPORT_EVALUATOR = 'Running report evaluator: {evaluator_name}'

export const OPERATION_EXPERIMENT = 'experiment'
