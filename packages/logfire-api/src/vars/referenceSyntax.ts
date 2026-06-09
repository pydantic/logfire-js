import Handlebars from 'handlebars'

import { createSafeHandlebarsContext } from './template'

export const HAS_REFERENCE: RegExp = /(?<!\\)@\{/u
export const REFERENCE_TAG: RegExp = /(?<!\\)@\{(.*?)\}@/gu
export const SIMPLE_REF: RegExp = /(?<!\\)@\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}@/gu
export const BLOCK_REF: RegExp = /(?<!\\)@\{#\w+\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s|\}@)/gu

export interface ReferenceSyntaxError {
  message: string
  type: 'parse_error'
}

export interface ReferencesAndErrors {
  errors: ReferenceSyntaxError[]
  references: string[]
}

let sentinelCounter = 0

export function renderOnce(template: string, context: Record<string, unknown>, options: { strict?: boolean } = {}): string {
  const adapted = adaptCompositionTemplate(template, collectStringLeaves(context))
  const rendered = Handlebars.compile(adapted.template, { strict: options.strict === true })(createSafeHandlebarsContext(context))
  return adapted.restore(rendered)
}

export function findReferencesAndErrorsInString(template: string): ReferencesAndErrors {
  const adapted = adaptCompositionTemplate(template, [])
  let ast: unknown
  try {
    ast = Handlebars.parse(adapted.template)
  } catch (error) {
    return {
      errors: [{ message: formatError(error), type: 'parse_error' }],
      references: [],
    }
  }

  const references = new Set<string>()
  collectReferencesFromAst(ast, references, 0)
  return { errors: [], references: [...references].sort() }
}

export function hasCompositionReferences(template: string): boolean {
  let index = 0
  while (index < template.length) {
    const next = template.indexOf('@{', index)
    if (next === -1) {
      return false
    }
    if (!isEscapedAt(template, next)) {
      return true
    }
    index = next + 2
  }
  return false
}

interface AdaptedTemplate {
  restore(value: string): string
  template: string
}

interface Placeholder {
  placeholder: string
  value: string
}

const CONTEXT_SHIFTING_HELPERS: ReadonlySet<string> = new Set(['each', 'with'])
const IGNORED_PATHS: ReadonlySet<string> = new Set(['', '.', 'else', 'this'])

function adaptCompositionTemplate(template: string, additionalCollisionValues: string[]): AdaptedTemplate {
  const placeholders: Placeholder[] = []
  const makePlaceholder = createPlaceholderFactory([template, ...additionalCollisionValues])
  let adapted = ''
  let index = 0

  while (index < template.length) {
    if (template.startsWith('@{', index)) {
      if (isEscapedAt(template, index)) {
        adapted = adapted.slice(0, -1) + protectValue('@{', placeholders, makePlaceholder)
        index += 2
        continue
      }

      const closeIndex = template.indexOf('}@', index + 2)
      if (closeIndex === -1) {
        adapted += `{{${template.slice(index + 2)}`
        break
      }

      adapted += `{{${template.slice(index + 2, closeIndex)}}}`
      index = closeIndex + 2
      continue
    }

    const runtimeDelimiter = readRuntimeDelimiter(template, index)
    if (runtimeDelimiter !== undefined) {
      adapted += protectValue(runtimeDelimiter, placeholders, makePlaceholder)
      index += runtimeDelimiter.length
      continue
    }

    adapted += template.charAt(index)
    index += 1
  }

  return {
    restore: (value) => restorePlaceholders(value, placeholders),
    template: adapted,
  }
}

function readRuntimeDelimiter(value: string, index: number): string | undefined {
  for (const delimiter of ['{{{{', '}}}}', '{{{', '}}}', '{{', '}}']) {
    if (value.startsWith(delimiter, index)) {
      return delimiter
    }
  }
  return undefined
}

function protectValue(value: string, placeholders: Placeholder[], makePlaceholder: () => string): string {
  const placeholder = makePlaceholder()
  placeholders.push({ placeholder, value })
  return placeholder
}

function restorePlaceholders(value: string, placeholders: Placeholder[]): string {
  let restored = value
  for (const { placeholder, value: original } of placeholders) {
    restored = restored.replaceAll(placeholder, original)
  }
  return restored
}

function createPlaceholderFactory(collisionValues: string[]): () => string {
  const unique = `${Date.now().toString(36)}-${(sentinelCounter++).toString(36)}`
  let index = 0
  return () => {
    let placeholder = `LOGFIRE_REFERENCE_SYNTAX_TOKEN_${unique}_${(index++).toString(36)}_LOGFIRE`
    while (collisionValues.some((value) => value.includes(placeholder))) {
      placeholder = `LOGFIRE_REFERENCE_SYNTAX_TOKEN_${unique}_${(index++).toString(36)}_LOGFIRE`
    }
    return placeholder
  }
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0
  let cursor = index - 1
  while (cursor >= 0 && value[cursor] === '\\') {
    backslashes += 1
    cursor -= 1
  }
  return backslashes % 2 === 1
}

function collectReferencesFromAst(node: unknown, references: Set<string>, shiftedDepth: number): void {
  if (!isRecord(node)) {
    return
  }

  const type = node['type']
  if (type === 'Program') {
    collectProgramReferences(node, references, shiftedDepth)
    return
  }
  if (type === 'MustacheStatement') {
    collectStatementReferences(node, references, shiftedDepth)
    return
  }
  if (type === 'SubExpression') {
    collectCallReferences(node, references, shiftedDepth)
    return
  }
  if (type === 'BlockStatement') {
    collectBlockReferences(node, references, shiftedDepth)
  }
}

function collectProgramReferences(program: Record<string, unknown>, references: Set<string>, shiftedDepth: number): void {
  const body = program['body']
  if (!Array.isArray(body)) {
    return
  }
  for (const statement of body) {
    collectReferencesFromAst(statement, references, shiftedDepth)
  }
}

function collectStatementReferences(statement: Record<string, unknown>, references: Set<string>, shiftedDepth: number): void {
  const params = statement['params']
  if (Array.isArray(params) && params.length > 0) {
    collectCallReferences(statement, references, shiftedDepth)
    return
  }
  addPathReference(statement['path'], references, shiftedDepth)
  collectHashReferences(statement['hash'], references, shiftedDepth)
}

function collectCallReferences(call: Record<string, unknown>, references: Set<string>, shiftedDepth: number): void {
  const params = call['params']
  if (Array.isArray(params)) {
    for (const param of params) {
      collectExpressionReference(param, references, shiftedDepth)
    }
  }
  collectHashReferences(call['hash'], references, shiftedDepth)
}

function collectBlockReferences(block: Record<string, unknown>, references: Set<string>, shiftedDepth: number): void {
  collectCallReferences(block, references, shiftedDepth)

  const helperName = getPathOriginal(block['path'])
  const childShiftedDepth = helperName !== undefined && CONTEXT_SHIFTING_HELPERS.has(helperName) ? shiftedDepth + 1 : shiftedDepth
  collectReferencesFromAst(block['program'], references, childShiftedDepth)
  collectReferencesFromAst(block['inverse'], references, shiftedDepth)
}

function collectExpressionReference(expression: unknown, references: Set<string>, shiftedDepth: number): void {
  if (!isRecord(expression)) {
    return
  }
  if (expression['type'] === 'SubExpression') {
    collectCallReferences(expression, references, shiftedDepth)
    return
  }
  addPathReference(expression, references, shiftedDepth)
}

function collectHashReferences(hash: unknown, references: Set<string>, shiftedDepth: number): void {
  if (!isRecord(hash) || !Array.isArray(hash['pairs'])) {
    return
  }
  for (const pair of hash['pairs']) {
    if (isRecord(pair)) {
      collectExpressionReference(pair['value'], references, shiftedDepth)
    }
  }
}

function addPathReference(path: unknown, references: Set<string>, shiftedDepth: number): void {
  if (!isRecord(path) || path['type'] !== 'PathExpression') {
    return
  }
  if (path['data'] === true) {
    return
  }

  const original = path['original']
  if (typeof original !== 'string' || !shouldCollectPath(original)) {
    return
  }

  const depth = typeof path['depth'] === 'number' ? path['depth'] : 0
  if (depth < shiftedDepth) {
    return
  }

  const parts = path['parts']
  const name = Array.isArray(parts) && typeof parts[0] === 'string' ? parts[0] : undefined
  if (name === undefined || IGNORED_PATHS.has(name)) {
    return
  }
  references.add(name)
}

function getPathOriginal(path: unknown): string | undefined {
  if (!isRecord(path) || path['type'] !== 'PathExpression') {
    return undefined
  }
  return typeof path['original'] === 'string' ? path['original'] : undefined
}

function shouldCollectPath(path: string): boolean {
  return !IGNORED_PATHS.has(path) && !path.startsWith('@') && !path.startsWith('this.') && (!path.includes('/') || path.startsWith('../'))
}

function collectStringLeaves(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStringLeaves)
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(collectStringLeaves)
  }
  return []
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
