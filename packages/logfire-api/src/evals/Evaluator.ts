import type { EvaluatorContext, EvaluatorOutput, EvaluatorSpec } from './types'

import { evaluatorRegistryKey } from './registry'

/**
 * Base class for evaluators.
 *
 * Subclasses should:
 *   - Set a `static evaluatorName` if they want a stable, minification-proof
 *     registry key (otherwise the class's runtime `name` is used).
 *   - Implement `evaluate(ctx)` returning a boolean (assertion) / number (score)
 *     / string (label) / `EvaluationReason` / map of any of those.
 *   - Optionally implement `toJSON()` returning the constructor args used for
 *     serialization to YAML / JSON dataset files.
 */
export abstract class Evaluator<Inputs = unknown, Output = unknown, Metadata = unknown> {
  static evaluatorName?: string

  /** Optional override for the result name in the report (defaults to class name). */
  evaluationName?: string

  /** Optional version string propagated to `gen_ai.evaluation.evaluator.version`. */
  evaluatorVersion?: string

  abstract evaluate(ctx: EvaluatorContext<Inputs, Output, Metadata>): EvaluatorOutput | Promise<EvaluatorOutput>

  /** Resolved name used as the dictionary key in `case.scores | labels | assertions`. */
  getResultName(): string {
    if (this.evaluationName !== undefined) {
      return this.evaluationName
    }
    const cls = this.constructor as { evaluatorName?: string; name: string }
    return evaluatorRegistryKey(cls)
  }

  /** Wire-format spec used in the `source` field of `EvaluationResult` and in YAML. */
  getSpec(): EvaluatorSpec {
    const cls = this.constructor as { evaluatorName?: string; name: string }
    return {
      arguments: this.toJSON(),
      name: evaluatorRegistryKey(cls),
    }
  }

  /**
   * Optional. Implement to return the constructor arguments used to recreate
   * this instance from a YAML / JSON dataset file. Should exclude fields equal
   * to their declared default.
   *
   * Default returns `null` (no arguments) — appropriate for parameterless evaluators.
   */
  toJSON(): null | Record<string, unknown> | unknown[] {
    return null
  }
}
