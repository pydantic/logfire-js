/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
/**
 * EvaluatorSpec encoder/decoder. Mirrors pydantic-evals' three-form `NamedSpec`
 * (`pydantic_ai/_spec.py`):
 *
 *   1. Bare string                 — `'EvaluatorName'`        (no args)
 *   2. Single-key, non-dict value  — `{Name: positionalArg}`  (one positional)
 *   3. Single-key, dict value      — `{Name: {kwargs...}}`    (kwargs)
 *
 * For TS, evaluator constructors take an options object. We translate:
 *   - bare string → `new Cls()`
 *   - single positional → `new Cls(primaryArgKey ? { [primaryArgKey]: v } : v)`
 *   - kwargs → `new Cls(kwargs)`
 */

import type { Evaluator } from '../Evaluator'
import type { ReportEvaluator } from '../ReportEvaluator'
import type { EvaluatorClass, EvaluatorSpec, ReportEvaluatorClass } from '../types'

import { evaluatorRegistryKey } from '../registry'

export type EncodedEvaluator = Record<string, unknown> | string
export interface EvaluatorRegistry<T> {
  get(name: string): T | undefined
  keys(): Iterable<string>
}
type RegistryInput<T> = EvaluatorRegistry<T> | Map<string, T> | Record<string, T>

export function encodeEvaluatorSpec(evaluator: Evaluator | ReportEvaluator): EncodedEvaluator {
  const cls = evaluator.constructor as { evaluatorName?: string; name: string }
  const name = evaluatorRegistryKey(cls)
  const args = evaluator.toJSON()

  if (args === null) return name
  if (Array.isArray(args)) {
    if (args.length === 0) return name
    return { [name]: args }
  }
  const keys = Object.keys(args)
  if (keys.length === 0) return name
  if (keys.length === 1) {
    const onlyKey = keys[0]!
    const onlyVal = args[onlyKey]
    // Short form ONLY safe when value is NOT a string-keyed dict (otherwise round-trip
    // is ambiguous with the long form). Matches `pydantic_ai/_spec.py:36–46`.
    if (!isStringKeyedDict(onlyVal)) {
      return { [name]: onlyVal }
    }
  }
  return { [name]: args }
}

export function decodeEvaluator<I = unknown, O = unknown, M = unknown>(
  encoded: unknown,
  registry: RegistryInput<EvaluatorClass<I, O, M>>,
  primaryArgKeys: Map<string, string>
): Evaluator<I, O, M> {
  const spec = decodeSpec(encoded)
  const Cls = lookup(registry, spec.name)
  if (Cls === undefined) {
    throw new Error(`Unknown evaluator name: ${JSON.stringify(spec.name)} (registered: ${[...keys(registry)].join(', ')})`)
  }
  return constructEvaluator(Cls, spec, primaryArgKeys.get(spec.name))
}

export function decodeReportEvaluator<I = unknown, O = unknown, M = unknown>(
  encoded: unknown,
  registry: RegistryInput<ReportEvaluatorClass<I, O, M>>,
  primaryArgKeys: Map<string, string>
): ReportEvaluator<I, O, M> {
  const spec = decodeSpec(encoded)
  const Cls = lookup(registry, spec.name)
  if (Cls === undefined) {
    throw new Error(`Unknown report evaluator name: ${JSON.stringify(spec.name)}`)
  }
  return constructEvaluator(Cls, spec, primaryArgKeys.get(spec.name)) as ReportEvaluator<I, O, M>
}

export function decodeSpec(encoded: unknown): EvaluatorSpec {
  if (typeof encoded === 'string') {
    return { arguments: null, name: encoded }
  }
  if (encoded === null || typeof encoded !== 'object') {
    throw new Error(`Invalid evaluator encoding: ${JSON.stringify(encoded)}`)
  }
  const obj = encoded as Record<string, unknown>
  const objKeys = Object.keys(obj)
  if (objKeys.length !== 1) {
    throw new Error(`Evaluator encoding must be a single-key object (got keys: ${objKeys.join(', ')})`)
  }
  const name = objKeys[0]!
  const value = obj[name]
  if (Array.isArray(value)) {
    return { arguments: value, name }
  }
  if (value !== null && typeof value === 'object') {
    return { arguments: value as Record<string, unknown>, name }
  }
  return { arguments: [value], name }
}

function constructEvaluator<C extends new (...args: never[]) => Evaluator | ReportEvaluator>(
  Cls: C,
  spec: EvaluatorSpec,
  primaryArgKey: string | undefined
): InstanceType<C> {
  if (spec.arguments === null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (Cls as any)() as InstanceType<C>
  }
  if (Array.isArray(spec.arguments)) {
    // single positional → wrap into options-object using primaryArgKey if provided
    if (spec.arguments.length === 1 && primaryArgKey !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new (Cls as any)({ [primaryArgKey]: spec.arguments[0] }) as InstanceType<C>
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (Cls as any)(...spec.arguments) as InstanceType<C>
  }
  // kwargs → pass as the options object directly. We normalize snake_case keys
  // back to camelCase if the constructor expects camelCase. For built-ins we
  // hand-roll this in the class registration; for now use as-is.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (Cls as any)(spec.arguments) as InstanceType<C>
}

function isStringKeyedDict(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
}

function lookup<T>(registry: RegistryInput<T>, name: string): T | undefined {
  if (isLookupRegistry(registry)) return registry.get(name)
  return registry[name]
}

function keys<T>(registry: RegistryInput<T>): Iterable<string> {
  if (isLookupRegistry(registry)) return registry.keys()
  return Object.keys(registry)
}

function isLookupRegistry<T>(registry: RegistryInput<T>): registry is EvaluatorRegistry<T> | Map<string, T> {
  return typeof (registry as EvaluatorRegistry<T>).get === 'function' && typeof (registry as EvaluatorRegistry<T>).keys === 'function'
}
