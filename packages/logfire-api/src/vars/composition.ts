import { VariableCompositionCycleError, VariableCompositionDepthError, VariableCompositionError } from './errors'
import { HAS_REFERENCE, REFERENCE_TAG, findReferencesAndErrorsInString, hasCompositionReferences, renderOnce } from './referenceSyntax'
import type { ReferenceSyntaxError } from './referenceSyntax'
import type { VariableResolutionReason } from './index'

export const MAX_COMPOSITION_DEPTH = 20
export const HBS_KEYWORDS: ReadonlySet<string> = new Set(['else', 'this'])
const BLOCK_OPEN_EXPRESSION = /^#(\w+)\s+([a-zA-Z_][a-zA-Z0-9_]*)/u
const BLOCK_CLOSE_EXPRESSION = /^\/(\w+)\s*$/u

export interface ComposedReference {
  composedFrom?: ComposedReference[]
  error?: string
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

interface Range {
  end: number
  start: number
}

interface BlockRange extends Range {
  helper: string
  name: string
}

interface BlockFrame {
  helper: string
  name: string
  start: number
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

  const expanded = await expandValue(value, resolveReference, options.rootName === undefined ? [] : [options.rootName], 0)
  return {
    composedFrom: dedupeComposedReferences(expanded.composedFrom),
    serializedValue: JSON.stringify(expanded.value),
  }
}

export function hasFatalCompositionError(composedFrom: ComposedReference[]): boolean {
  return composedFrom.some(
    (item) =>
      item.error?.includes('VariableCompositionCycleError') === true ||
      item.error?.includes('VariableCompositionDepthError') === true ||
      (item.composedFrom !== undefined && hasFatalCompositionError(item.composedFrom))
  )
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

async function expandValue(value: unknown, resolveReference: ResolveReference, stack: string[], depth: number): Promise<ExpandedValue> {
  if (typeof value === 'string') {
    return expandString(value, resolveReference, stack, depth)
  }
  if (Array.isArray(value)) {
    const expandedItems = await Promise.all(
      value.map(async (item) => {
        const expanded = await expandValue(item, resolveReference, stack, depth)
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
      Object.entries(value).map(async ([key, item]) => [key, await expandValue(item, resolveReference, stack, depth)] as const)
    )
    const entries = expandedEntries.map(([key, expanded]) => [key, expanded.value] as const)
    const composedFrom = expandedEntries.flatMap(([, expanded]) => expanded.composedFrom)
    return { composedFrom, value: Object.fromEntries(entries) }
  }
  return { composedFrom: [], value }
}

async function expandString(value: string, resolveReference: ResolveReference, stack: string[], depth: number): Promise<ExpandedValue> {
  const referencesResult = findReferencesAndErrorsInString(value)
  const referenceNames = referencesResult.references
  if (referenceNames.length === 0) {
    return { composedFrom: [], value: value.includes('\\@{') || referencesResult.errors.length > 0 ? renderOnce(value, {}) : value }
  }

  const context: Record<string, unknown> = {}
  const resolvedReferences = await Promise.all(
    referenceNames.map(async (name) => {
      const expanded = await expandNamedReference(name, resolveReference, stack, depth)
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

  const protectedValue = protectUnresolvedReferences(value, context)
  try {
    return {
      composedFrom,
      value: restoreProtected(renderOnce(protectedValue.template, context), protectedValue.sentinel),
    }
  } catch (error) {
    throw new VariableCompositionError(`Failed to render composed variable: ${formatError(error)}`)
  }
}

async function expandNamedReference(
  name: string,
  resolveReference: ResolveReference,
  stack: string[],
  depth: number
): Promise<{ reference: ComposedReference; value?: unknown }> {
  if (stack.includes(name)) {
    const error = new VariableCompositionCycleError(`Circular variable reference: ${[...stack, name].join(' -> ')}`)
    return {
      reference: { error: formatCompositionError(error), name, reason: 'other_error' },
      value: undefined,
    }
  }
  if (depth >= MAX_COMPOSITION_DEPTH) {
    const error = new VariableCompositionDepthError(`Variable composition exceeded maximum depth of ${String(MAX_COMPOSITION_DEPTH)}`)
    return {
      reference: { error: formatCompositionError(error), name, reason: 'other_error' },
      value: undefined,
    }
  }

  const resolved = await resolveReference(name)
  const reference: ComposedReference = {
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

  const nested = await expandReferenceSerializedValue(name, resolved.value, resolveReference, stack, depth)
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
  depth: number
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

  const expanded = await expandValue(parsed, resolveReference, [...stack, name], depth + 1)
  const expandedSerializedValue = JSON.stringify(expanded.value)
  return { composedFrom: dedupeComposedReferences(expanded.composedFrom), serializedValue: expandedSerializedValue, value: expanded.value }
}

function protectUnresolvedReferences(value: string, context: Record<string, unknown>): { sentinel: string; template: string } {
  const sentinel = `LOGFIRE_UNRESOLVED_REFERENCE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_LOGFIRE`
  const protectedBlocks = protectRanges(value, collectUnresolvedBlockRanges(value, context), sentinel)
  const resolvedBlockRanges = collectResolvedBlockRanges(protectedBlocks, context)
  return {
    sentinel,
    template: protectedBlocks.replace(REFERENCE_TAG, (match, expression, offset) => {
      const baseName = getExpressionBaseName(String(expression))
      if (baseName === undefined) {
        return match
      }
      if (HBS_KEYWORDS.has(baseName)) {
        return isOffsetInRanges(Number(offset), resolvedBlockRanges) ? match : encodeProtected(match, sentinel)
      }
      return !Object.hasOwn(context, baseName) ? encodeProtected(match, sentinel) : match
    }),
  }
}

function collectUnresolvedBlockRanges(value: string, context: Record<string, unknown>): Range[] {
  const ranges = collectBlockRanges(value).filter((range) => !Object.hasOwn(context, range.name) || HBS_KEYWORDS.has(range.name))
  return ranges.filter((range) => !ranges.some((other) => other !== range && containsRange(other, range)))
}

function collectResolvedBlockRanges(value: string, context: Record<string, unknown>): Range[] {
  const ranges: Range[] = []
  for (const block of collectBlockRanges(value)) {
    if (Object.hasOwn(context, block.name) && !HBS_KEYWORDS.has(block.name)) {
      ranges.push({ end: block.end, start: block.start })
    }
  }
  return ranges
}

function collectBlockRanges(value: string): BlockRange[] {
  const ranges: BlockRange[] = []
  const stack: BlockFrame[] = []
  for (const match of value.matchAll(REFERENCE_TAG)) {
    const expression = (match[1] ?? '').trim()
    const openMatch = BLOCK_OPEN_EXPRESSION.exec(expression)
    if (openMatch?.[1] !== undefined && openMatch[2] !== undefined) {
      stack.push({ helper: openMatch[1], name: openMatch[2], start: match.index })
      continue
    }

    const closeMatch = BLOCK_CLOSE_EXPRESSION.exec(expression)
    const frame = stack.at(-1)
    if (closeMatch?.[1] !== undefined && frame?.helper === closeMatch[1]) {
      stack.pop()
      ranges.push({
        end: match.index + match[0].length,
        helper: frame.helper,
        name: frame.name,
        start: frame.start,
      })
    }
  }
  return ranges
}

function protectRanges(value: string, ranges: Range[], sentinel: string): string {
  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start)
  let protectedValue = ''
  let cursor = 0
  for (const range of sortedRanges) {
    if (range.start < cursor) {
      continue
    }
    protectedValue += value.slice(cursor, range.start)
    protectedValue += encodeProtected(value.slice(range.start, range.end), sentinel)
    cursor = range.end
  }
  return protectedValue + value.slice(cursor)
}

function containsRange(outer: Range, inner: Range): boolean {
  return outer.start <= inner.start && outer.end >= inner.end
}

function isOffsetInRanges(offset: number, ranges: Range[]): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end)
}

function encodeProtected(value: string, sentinel: string): string {
  return sentinel + Array.from(value, (char) => (char.codePointAt(0) ?? 0).toString(16).padStart(6, '0')).join('') + sentinel
}

function restoreProtected(value: string, sentinel: string): string {
  return value.replaceAll(new RegExp(`${escapeRegExp(sentinel)}([0-9a-f]+)${escapeRegExp(sentinel)}`, 'gu'), (_match, hex) => {
    const chunks = String(hex).match(/.{1,6}/gu) ?? []
    return chunks.map((chunk) => String.fromCodePoint(Number.parseInt(chunk, 16))).join('')
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function getExpressionBaseName(expression: string): string | undefined {
  const trimmed = expression.trim()
  if (trimmed === '' || trimmed === 'else' || trimmed.startsWith('/')) {
    return undefined
  }
  const blockMatch = /^#\w+\s+([a-zA-Z_][a-zA-Z0-9_]*)/u.exec(trimmed)
  if (blockMatch?.[1] !== undefined) {
    return blockMatch[1]
  }
  const simpleMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\.|$)/u.exec(trimmed)
  return simpleMatch?.[1]
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
