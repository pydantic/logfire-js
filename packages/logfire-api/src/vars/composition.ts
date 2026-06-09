import { VariableCompositionCycleError, VariableCompositionDepthError, VariableCompositionError } from './errors'
import { HAS_REFERENCE, findReferencesAndErrorsInString, hasCompositionReferences, renderOnce } from './referenceSyntax'
import type { ReferenceSyntaxError } from './referenceSyntax'
import type { VariableResolutionReason } from './index'

export const MAX_COMPOSITION_DEPTH = 20

export interface ComposedReference {
  composedFrom?: ComposedReference[]
  error?: string
  fatal: boolean
  label?: string
  name: string
  reason: VariableResolutionReason
  value?: string
  version?: number
}

export interface ResolvedReference {
  label?: string
  name?: string
  reason: VariableResolutionReason
  value: string | undefined
  version?: number
}

export type ResolveReference = (name: string) => Promise<ResolvedReference> | ResolvedReference

export interface ExpandReferencesOptions {
  rootName?: string
  strict?: boolean
}

export interface ExpandReferencesResult {
  composedFrom: ComposedReference[]
  serializedValue: string
}

export interface FindReferencesAndErrorsResult {
  errors: ReferenceSyntaxError[]
  references: string[]
}

interface ExpandedValue {
  composedFrom: ComposedReference[]
  value: unknown
}

export function hasReferences(value: unknown): boolean {
  if (typeof value === 'string') {
    return hasCompositionReferences(value)
  }
  if (Array.isArray(value)) {
    return value.some(hasReferences)
  }
  if (isRecord(value)) {
    return Object.values(value).some(hasReferences)
  }
  return false
}

export function findReferences(value: unknown): string[] {
  return findReferencesAndErrors(value).references
}

export function findReferencesAndErrors(value: unknown): FindReferencesAndErrorsResult {
  const references = new Set<string>()
  const errors: ReferenceSyntaxError[] = []
  collectReferences(decodeReferenceInput(value), references, errors)
  return { errors, references: [...references].sort() }
}

export async function expandReferences(
  serializedValue: string,
  resolveReference: ResolveReference,
  options: ExpandReferencesOptions = {}
): Promise<ExpandReferencesResult> {
  let value: unknown
  try {
    value = JSON.parse(serializedValue)
  } catch {
    return { composedFrom: [], serializedValue }
  }

  const expanded = await expandValue(
    value,
    resolveReference,
    options.rootName === undefined ? [] : [options.rootName],
    0,
    options.strict === true
  )
  return {
    composedFrom: dedupeComposedReferences(expanded.composedFrom),
    serializedValue: JSON.stringify(expanded.value),
  }
}

export function hasFatalCompositionError(composedFrom: ComposedReference[]): boolean {
  return composedFrom.some((item) => item.fatal || (item.composedFrom !== undefined && hasFatalCompositionError(item.composedFrom)))
}

export function hasCompositionError(
  composedFrom: ComposedReference[],
  options: { includeSoft: boolean } = { includeSoft: false }
): boolean {
  return composedFrom.some(
    (item) =>
      item.fatal ||
      (options.includeSoft && (item.error !== undefined || item.value === undefined)) ||
      (item.composedFrom !== undefined && hasCompositionError(item.composedFrom, options))
  )
}

export function firstCompositionError(
  composedFrom: ComposedReference[],
  options: { includeSoft: boolean } = { includeSoft: false }
): string | undefined {
  for (const item of composedFrom) {
    if (item.fatal || (options.includeSoft && (item.error !== undefined || item.value === undefined))) {
      return item.error ?? `Referenced variable '${item.name}' could not be resolved.`
    }
    if (item.composedFrom !== undefined) {
      const nested = firstCompositionError(item.composedFrom, options)
      if (nested !== undefined) {
        return nested
      }
    }
  }
  return undefined
}

function collectReferences(value: unknown, references: Set<string>, errors: ReferenceSyntaxError[]): void {
  if (typeof value === 'string') {
    const result = findReferencesAndErrorsInString(value)
    result.references.forEach((reference) => {
      references.add(reference)
    })
    errors.push(...result.errors)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, references, errors)
    }
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectReferences(item, references, errors)
    }
  }
}

function decodeReferenceInput(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

async function expandValue(
  value: unknown,
  resolveReference: ResolveReference,
  stack: string[],
  depth: number,
  strict: boolean
): Promise<ExpandedValue> {
  if (typeof value === 'string') {
    return expandString(value, resolveReference, stack, depth, strict)
  }
  if (Array.isArray(value)) {
    const expandedItems = await Promise.all(
      value.map(async (item) => {
        const expanded = await expandValue(item, resolveReference, stack, depth, strict)
        return expanded
      })
    )
    return {
      composedFrom: expandedItems.flatMap((expanded) => expanded.composedFrom),
      value: expandedItems.map((expanded) => expanded.value),
    }
  }
  if (isRecord(value)) {
    const expandedEntries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await expandValue(item, resolveReference, stack, depth, strict)] as const)
    )
    const entries = expandedEntries.map(([key, expanded]) => [key, expanded.value] as const)
    const composedFrom = expandedEntries.flatMap(([, expanded]) => expanded.composedFrom)
    return { composedFrom, value: Object.fromEntries(entries) }
  }
  return { composedFrom: [], value }
}

async function expandString(
  value: string,
  resolveReference: ResolveReference,
  stack: string[],
  depth: number,
  strict: boolean
): Promise<ExpandedValue> {
  const referencesResult = findReferencesAndErrorsInString(value)
  const referenceNames = referencesResult.references
  if (referenceNames.length === 0) {
    return {
      composedFrom: [],
      value: value.includes('\\@{') || referencesResult.errors.length > 0 ? renderOnce(value, {}, { strict }) : value,
    }
  }

  const context: Record<string, unknown> = {}
  const resolvedReferences = await Promise.all(
    referenceNames.map(async (name) => {
      const expanded = await expandNamedReference(name, resolveReference, stack, depth, strict)
      return expanded
    })
  )
  const composedFrom: ComposedReference[] = []
  for (const resolved of resolvedReferences) {
    composedFrom.push(resolved.reference)
    if (resolved.value !== undefined) {
      context[resolved.reference.name] = resolved.value
    }
  }

  if (hasFatalCompositionError(composedFrom)) {
    return { composedFrom, value }
  }

  try {
    return {
      composedFrom,
      value: renderOnce(value, context, { strict }),
    }
  } catch (error) {
    throw new VariableCompositionError(`Failed to render composed variable: ${formatError(error)}`)
  }
}

async function expandNamedReference(
  name: string,
  resolveReference: ResolveReference,
  stack: string[],
  depth: number,
  strict: boolean
): Promise<{ reference: ComposedReference; value?: unknown }> {
  if (stack.includes(name)) {
    const error = new VariableCompositionCycleError(`Circular variable reference: ${[...stack, name].join(' -> ')}`)
    return {
      reference: { error: formatCompositionError(error), fatal: true, name, reason: 'other_error' },
      value: undefined,
    }
  }
  if (depth >= MAX_COMPOSITION_DEPTH) {
    const error = new VariableCompositionDepthError(`Variable composition exceeded maximum depth of ${String(MAX_COMPOSITION_DEPTH)}`)
    return {
      reference: { error: formatCompositionError(error), fatal: true, name, reason: 'other_error' },
      value: undefined,
    }
  }

  const resolved = await resolveReference(name)
  const reference: ComposedReference = {
    fatal: false,
    name,
    reason: resolved.reason,
  }
  if (resolved.label !== undefined) {
    reference.label = resolved.label
  }
  if (resolved.version !== undefined) {
    reference.version = resolved.version
  }

  if (resolved.value === undefined) {
    return { reference, value: undefined }
  }

  const nested = await expandReferenceSerializedValue(name, resolved.value, resolveReference, stack, depth, strict)
  if (nested.error !== undefined) {
    reference.error = nested.error
    return { reference, value: undefined }
  }
  reference.value = nested.serializedValue
  if (nested.composedFrom.length > 0) {
    reference.composedFrom = nested.composedFrom
  }
  return { reference, value: nested.value }
}

async function expandReferenceSerializedValue(
  name: string,
  serializedValue: string,
  resolveReference: ResolveReference,
  stack: string[],
  depth: number,
  strict: boolean
): Promise<{ composedFrom: ComposedReference[]; error?: string; serializedValue: string; value?: unknown }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(serializedValue)
  } catch (error) {
    return {
      composedFrom: [],
      error: `Referenced variable '${name}' resolved to non-JSON value: ${formatError(error)}`,
      serializedValue,
    }
  }

  if (!HAS_REFERENCE.test(serializedValue)) {
    return { composedFrom: [], serializedValue, value: parsed }
  }

  const expanded = await expandValue(parsed, resolveReference, [...stack, name], depth + 1, strict)
  const expandedSerializedValue = JSON.stringify(expanded.value)
  return { composedFrom: dedupeComposedReferences(expanded.composedFrom), serializedValue: expandedSerializedValue, value: expanded.value }
}

function dedupeComposedReferences(references: ComposedReference[]): ComposedReference[] {
  const deduped: ComposedReference[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    const key = JSON.stringify(reference)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(reference)
    }
  }
  return deduped
}

function formatCompositionError(error: Error): string {
  return `${error.name}: ${error.message}`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
