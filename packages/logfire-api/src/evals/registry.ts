/**
 * Evaluator class registry.
 *
 * Used to round-trip dataset YAML/JSON files: when a file references
 * `Equals: { value: foo }`, we look up the `Equals` class in the registry and
 * construct it. The 7 builtins auto-register on import; users register custom
 * evaluators with `registerEvaluator(MyEvaluator)`.
 *
 * Registry key resolution order:
 *   1. `static evaluatorName` on the class (preferred — survives minification)
 *   2. `class.name` (constructor name, falls back if no static is set)
 *
 * If a user's bundler renames classes and they didn't set `evaluatorName`,
 * registration will use the renamed name. This means YAML files referring to
 * the original name will fail to deserialize with a clear error.
 */

import type { EvaluatorClass, ReportEvaluatorClass } from './types'

const evaluatorRegistry = new Map<string, EvaluatorClass>()
const reportEvaluatorRegistry = new Map<string, ReportEvaluatorClass>()

/** Resolve the registry key for an evaluator class. */
export function evaluatorRegistryKey(cls: { evaluatorName?: string; name: string }): string {
  return cls.evaluatorName ?? cls.name
}

export function registerEvaluator(cls: EvaluatorClass): void {
  evaluatorRegistry.set(evaluatorRegistryKey(cls), cls)
}

export function registerReportEvaluator(cls: ReportEvaluatorClass): void {
  reportEvaluatorRegistry.set(evaluatorRegistryKey(cls), cls)
}

export function getEvaluatorClass(name: string): EvaluatorClass | undefined {
  return evaluatorRegistry.get(name)
}

export function getReportEvaluatorClass(name: string): ReportEvaluatorClass | undefined {
  return reportEvaluatorRegistry.get(name)
}

export function listRegisteredEvaluators(): readonly EvaluatorClass[] {
  return Array.from(evaluatorRegistry.values())
}

export function listRegisteredReportEvaluators(): readonly ReportEvaluatorClass[] {
  return Array.from(reportEvaluatorRegistry.values())
}

/** Test-only — clear both registries. */
export function _resetRegistry(): void {
  evaluatorRegistry.clear()
  reportEvaluatorRegistry.clear()
}
