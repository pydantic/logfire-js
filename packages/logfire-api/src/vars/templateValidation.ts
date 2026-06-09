import Handlebars from 'handlebars'

import type { ComposedReference } from './composition'
import type { JsonSchema } from './index'

export interface ReferenceValidationIssue {
  label?: string
  message: string
  reference?: string
  type: 'composition_cycle' | 'composition_depth' | 'invalid_reference' | 'missing_reference'
  variableName: string
}

export interface TemplateInputValidationIssue {
  label?: string
  message: string
  path: string
  variableName: string
}

export interface TemplateFieldIssue {
  fieldName: string
  foundInLabel?: string
  foundInVariable: string
  message: string
  referencePath: string[]
  rootVariable: string
}

export function collectReferenceValidationIssues(
  variableName: string,
  label: string | undefined,
  composedFrom: ComposedReference[]
): ReferenceValidationIssue[] {
  const issues: ReferenceValidationIssue[] = []
  for (const reference of composedFrom) {
    if (reference.error !== undefined) {
      const issue: ReferenceValidationIssue = {
        message: reference.error,
        reference: reference.name,
        type: reference.error.includes('VariableCompositionCycleError')
          ? 'composition_cycle'
          : reference.error.includes('VariableCompositionDepthError')
            ? 'composition_depth'
            : 'invalid_reference',
        variableName,
      }
      if (label !== undefined) {
        issue.label = label
      }
      issues.push(issue)
    } else if (reference.value === undefined) {
      const issue: ReferenceValidationIssue = {
        message: `Variable '${variableName}' references missing variable '${reference.name}'`,
        reference: reference.name,
        type: 'missing_reference',
        variableName,
      }
      if (label !== undefined) {
        issue.label = label
      }
      issues.push(issue)
    }
    if (reference.composedFrom !== undefined) {
      issues.push(...collectReferenceValidationIssues(variableName, label, reference.composedFrom))
    }
  }
  return dedupeIssues(issues)
}

export function validateTemplateInputs(
  serializedValue: string,
  templateInputsSchema: JsonSchema | null | undefined,
  variableName: string,
  label: string | undefined
): TemplateInputValidationIssue[] {
  if (templateInputsSchema === undefined || templateInputsSchema === null) {
    return []
  }
  let value: unknown
  try {
    value = JSON.parse(serializedValue)
  } catch {
    return []
  }

  const issues: TemplateInputValidationIssue[] = []
  for (const template of collectStringLeaves(value)) {
    for (const path of extractTemplatePaths(template)) {
      if (!isSchemaPathKnown(templateInputsSchema, path)) {
        const issue: TemplateInputValidationIssue = {
          message: `Template path '${path}' is not present in template_inputs_schema`,
          path,
          variableName,
        }
        if (label !== undefined) {
          issue.label = label
        }
        issues.push(issue)
      }
    }
  }
  return dedupeIssues(issues)
}

export function extractTemplatePaths(template: string): string[] {
  let ast: unknown
  try {
    ast = Handlebars.parse(template)
  } catch {
    return []
  }
  const paths: string[] = []
  const seen = new Set<string>()
  collectPathsFromAst(ast, paths, seen)
  return paths
}

function collectPathsFromAst(node: unknown, paths: string[], seen: Set<string>): void {
  if (!isRecord(node)) {
    return
  }

  const type = node['type']
  if (type === 'MustacheStatement' || type === 'SubExpression') {
    const params = Array.isArray(node['params']) ? node['params'] : []
    if (params.length === 0) {
      addPathNode(node['path'], paths, seen)
    } else {
      for (const param of params) {
        addPathNode(param, paths, seen)
      }
    }
    collectHashPaths(node['hash'], paths, seen)
  } else if (type === 'BlockStatement') {
    const params = Array.isArray(node['params']) ? node['params'] : []
    for (const param of params) {
      addPathNode(param, paths, seen)
    }
    collectHashPaths(node['hash'], paths, seen)
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectPathsFromAst(item, paths, seen)
      }
    } else if (isRecord(value)) {
      collectPathsFromAst(value, paths, seen)
    }
  }
}

function collectHashPaths(hash: unknown, paths: string[], seen: Set<string>): void {
  if (!isRecord(hash) || !Array.isArray(hash['pairs'])) {
    return
  }
  for (const pair of hash['pairs']) {
    if (isRecord(pair)) {
      addPathNode(pair['value'], paths, seen)
    }
  }
}

function addPathNode(node: unknown, paths: string[], seen: Set<string>): void {
  if (!isRecord(node) || node['type'] !== 'PathExpression') {
    if (isRecord(node) && node['type'] === 'SubExpression') {
      collectPathsFromAst(node, paths, seen)
    }
    return
  }
  const original = node['original']
  if (typeof original !== 'string' || !shouldValidatePath(original) || seen.has(original)) {
    return
  }
  seen.add(original)
  paths.push(original)
}

function shouldValidatePath(path: string): boolean {
  return (
    path !== '' &&
    path !== '.' &&
    path !== 'this' &&
    path !== 'else' &&
    !path.startsWith('@') &&
    !path.startsWith('../') &&
    !path.includes('/')
  )
}

function isSchemaPathKnown(schema: JsonSchema, path: string): boolean {
  let current: unknown = schema
  for (const segment of path.split('.')) {
    if (!isRecord(current)) {
      return false
    }
    const properties = current['properties']
    if (!isRecord(properties)) {
      return true
    }
    if (!Object.hasOwn(properties, segment)) {
      const additionalProperties = current['additionalProperties']
      if (additionalProperties === true) {
        return true
      }
      if (!isRecord(additionalProperties)) {
        return false
      }
      current = additionalProperties
      continue
    }
    current = properties[segment]
  }
  return true
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

function dedupeIssues<T>(issues: T[]): T[] {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const issue of issues) {
    const key = JSON.stringify(issue)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(issue)
    }
  }
  return deduped
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
