/**
 * In-memory representation of a captured subtree of OTel spans.
 *
 * Mirrors pydantic-evals' `SpanTree` / `SpanNode` / `SpanQuery`. This module
 * intentionally uses only `@opentelemetry/api` and `@opentelemetry/sdk-trace-base`
 * types (both already peer deps) so it works in any runtime.
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

export class SpanTreeRecordingError extends Error {
  constructor(
    message = 'Span-tree recording was not available. Pass `getEvalsSpanProcessor()` to your TracerProvider, or call `logfire.configure()` so the evals processor is installed automatically.'
  ) {
    super(message)
    this.name = 'SpanTreeRecordingError'
  }
}

export class SpanNode {
  attributes: Record<string, unknown>
  children: SpanNode[] = []
  durationMs: number
  endTimeNs: number
  name: string
  parent: null | SpanNode = null
  parentSpanId?: string
  spanId: string
  startTimeNs: number
  traceId: string

  constructor(span: ReadableSpan) {
    this.name = span.name
    this.spanId = span.spanContext().spanId
    this.traceId = span.spanContext().traceId
    this.parentSpanId = span.parentSpanContext?.spanId
    this.startTimeNs = nsFromHrTime(span.startTime)
    this.endTimeNs = nsFromHrTime(span.endTime)
    this.durationMs = (this.endTimeNs - this.startTimeNs) / 1_000_000
    this.attributes = { ...span.attributes }
  }

  *ancestors(): Generator<SpanNode> {
    let n: null | SpanNode = this.parent
    while (n !== null) {
      yield n
      n = n.parent
    }
  }

  *descendants(): Generator<SpanNode> {
    for (const c of this.children) {
      yield c
      yield* c.descendants()
    }
  }

  matches(query: SpanQuery): boolean {
    return matchesQuery(this, query)
  }
}

export interface SpanQuery {
  all_ancestors_have?: SpanQuery
  all_children_have?: SpanQuery
  all_descendants_have?: SpanQuery
  allAncestorsHave?: SpanQuery
  allChildrenHave?: SpanQuery
  allDescendantsHave?: SpanQuery
  and_?: SpanQuery[]
  has_attribute_keys?: string[]
  has_attributes?: Record<string, unknown>
  hasAttributeKeys?: string[]
  hasAttributes?: Record<string, unknown>
  max_child_count?: number
  max_depth?: number
  max_descendant_count?: number
  /** Max duration in seconds. */
  max_duration?: number
  maxChildCount?: number
  maxDescendantCount?: number
  /** @deprecated Use max_duration. Values are interpreted as seconds for Python parity. */
  maxDuration?: number
  min_child_count?: number
  min_depth?: number
  min_descendant_count?: number
  /** Min duration in seconds. */
  min_duration?: number
  minChildCount?: number
  minDescendantCount?: number
  /** @deprecated Use min_duration. Values are interpreted as seconds for Python parity. */
  minDuration?: number
  name_contains?: string
  name_equals?: string
  name_matches_regex?: string
  nameContains?: string
  nameEquals?: string
  nameMatchesRegex?: string
  no_ancestor_has?: SpanQuery
  no_child_has?: SpanQuery
  no_descendant_has?: SpanQuery
  noAncestorHas?: SpanQuery
  noChildHas?: SpanQuery
  noDescendantHas?: SpanQuery
  not_?: SpanQuery
  or_?: SpanQuery[]
  some_ancestor_has?: SpanQuery
  some_child_has?: SpanQuery
  some_descendant_has?: SpanQuery
  someAncestorHas?: SpanQuery
  someChildHas?: SpanQuery
  someDescendantHas?: SpanQuery
  stop_recursing_when?: SpanQuery
  stopRecursingWhen?: SpanQuery
}

function nsFromHrTime(hr: [number, number]): number {
  return hr[0] * 1_000_000_000 + hr[1]
}

function matchesQuery(node: SpanNode, q: SpanQuery): boolean {
  const or = queryValue(q, 'or_', 'or_') as SpanQuery[] | undefined
  if (or !== undefined && or.length > 0) {
    if (definedQueryKeys(q).length > 1) {
      throw new Error("Cannot combine 'or_' conditions with other conditions at the same level")
    }
    return or.some((sub) => matchesQuery(node, sub))
  }
  const not = queryValue(q, 'not_', 'not_') as SpanQuery | undefined
  if (not !== undefined && matchesQuery(node, not)) return false
  const and = queryValue(q, 'and_', 'and_') as SpanQuery[] | undefined
  if (and !== undefined && !and.every((sub) => matchesQuery(node, sub))) return false

  const nameEquals = queryValue(q, 'name_equals', 'nameEquals') as string | undefined
  const nameContains = queryValue(q, 'name_contains', 'nameContains') as string | undefined
  const nameMatchesRegex = queryValue(q, 'name_matches_regex', 'nameMatchesRegex') as string | undefined
  if (nameEquals !== undefined && node.name !== nameEquals) return false
  if (nameContains !== undefined && !node.name.includes(nameContains)) return false
  if (nameMatchesRegex !== undefined) {
    const match = new RegExp(nameMatchesRegex).exec(node.name)
    if (match?.index !== 0) return false
  }

  const durationSec = node.durationMs / 1000
  const minDuration = queryValue(q, 'min_duration', 'minDuration') as number | undefined
  const maxDuration = queryValue(q, 'max_duration', 'maxDuration') as number | undefined
  if (minDuration !== undefined && durationSec < minDuration) return false
  if (maxDuration !== undefined && durationSec > maxDuration) return false

  const hasAttributes = queryValue(q, 'has_attributes', 'hasAttributes') as Record<string, unknown> | undefined
  if (hasAttributes !== undefined) {
    for (const [k, v] of Object.entries(hasAttributes)) {
      if (node.attributes[k] !== v) return false
    }
  }
  const hasAttributeKeys = queryValue(q, 'has_attribute_keys', 'hasAttributeKeys') as string[] | undefined
  if (hasAttributeKeys !== undefined) {
    for (const k of hasAttributeKeys) {
      if (!(k in node.attributes)) return false
    }
  }
  const minChildCount = queryValue(q, 'min_child_count', 'minChildCount') as number | undefined
  const maxChildCount = queryValue(q, 'max_child_count', 'maxChildCount') as number | undefined
  if (minChildCount !== undefined && node.children.length < minChildCount) return false
  if (maxChildCount !== undefined && node.children.length > maxChildCount) return false

  const someChildHas = queryValue(q, 'some_child_has', 'someChildHas') as SpanQuery | undefined
  const allChildrenHave = queryValue(q, 'all_children_have', 'allChildrenHave') as SpanQuery | undefined
  const noChildHas = queryValue(q, 'no_child_has', 'noChildHas') as SpanQuery | undefined
  if (someChildHas !== undefined && !node.children.some((c) => matchesQuery(c, someChildHas))) return false
  if (allChildrenHave !== undefined && !node.children.every((c) => matchesQuery(c, allChildrenHave))) return false
  if (noChildHas !== undefined && node.children.some((c) => matchesQuery(c, noChildHas))) return false

  const descendants = Array.from(node.descendants())
  const minDescendantCount = queryValue(q, 'min_descendant_count', 'minDescendantCount') as number | undefined
  const maxDescendantCount = queryValue(q, 'max_descendant_count', 'maxDescendantCount') as number | undefined
  if (minDescendantCount !== undefined && descendants.length < minDescendantCount) return false
  if (maxDescendantCount !== undefined && descendants.length > maxDescendantCount) return false

  const stopRecursingWhen = queryValue(q, 'stop_recursing_when', 'stopRecursingWhen') as SpanQuery | undefined
  const prunedDescendants = stopRecursingWhen === undefined ? descendants : findDescendants(node, stopRecursingWhen)
  const someDescendantHas = queryValue(q, 'some_descendant_has', 'someDescendantHas') as SpanQuery | undefined
  const allDescendantsHave = queryValue(q, 'all_descendants_have', 'allDescendantsHave') as SpanQuery | undefined
  const noDescendantHas = queryValue(q, 'no_descendant_has', 'noDescendantHas') as SpanQuery | undefined
  if (someDescendantHas !== undefined && !prunedDescendants.some((d) => matchesQuery(d, someDescendantHas))) return false
  if (allDescendantsHave !== undefined && !prunedDescendants.every((d) => matchesQuery(d, allDescendantsHave))) return false
  if (noDescendantHas !== undefined && prunedDescendants.some((d) => matchesQuery(d, noDescendantHas))) return false

  const ancestors = Array.from(node.ancestors())
  const minDepth = queryValue(q, 'min_depth', 'minDepth') as number | undefined
  const maxDepth = queryValue(q, 'max_depth', 'maxDepth') as number | undefined
  if (minDepth !== undefined && ancestors.length < minDepth) return false
  if (maxDepth !== undefined && ancestors.length > maxDepth) return false

  const prunedAncestors = stopRecursingWhen === undefined ? ancestors : findAncestors(node, stopRecursingWhen)
  const someAncestorHas = queryValue(q, 'some_ancestor_has', 'someAncestorHas') as SpanQuery | undefined
  const allAncestorsHave = queryValue(q, 'all_ancestors_have', 'allAncestorsHave') as SpanQuery | undefined
  const noAncestorHas = queryValue(q, 'no_ancestor_has', 'noAncestorHas') as SpanQuery | undefined
  if (someAncestorHas !== undefined && !prunedAncestors.some((a) => matchesQuery(a, someAncestorHas))) return false
  if (allAncestorsHave !== undefined && !prunedAncestors.every((a) => matchesQuery(a, allAncestorsHave))) return false
  if (noAncestorHas !== undefined && prunedAncestors.some((a) => matchesQuery(a, noAncestorHas))) return false
  return true
}

const QUERY_KEY_MAP: Record<string, string> = {
  allAncestorsHave: 'all_ancestors_have',
  allChildrenHave: 'all_children_have',
  allDescendantsHave: 'all_descendants_have',
  hasAttributeKeys: 'has_attribute_keys',
  hasAttributes: 'has_attributes',
  maxChildCount: 'max_child_count',
  maxDepth: 'max_depth',
  maxDescendantCount: 'max_descendant_count',
  maxDuration: 'max_duration',
  minChildCount: 'min_child_count',
  minDepth: 'min_depth',
  minDescendantCount: 'min_descendant_count',
  minDuration: 'min_duration',
  nameContains: 'name_contains',
  nameEquals: 'name_equals',
  nameMatchesRegex: 'name_matches_regex',
  noAncestorHas: 'no_ancestor_has',
  noChildHas: 'no_child_has',
  noDescendantHas: 'no_descendant_has',
  someAncestorHas: 'some_ancestor_has',
  someChildHas: 'some_child_has',
  someDescendantHas: 'some_descendant_has',
  stopRecursingWhen: 'stop_recursing_when',
}

const RECURSIVE_QUERY_KEYS = new Set([
  'all_ancestors_have',
  'all_children_have',
  'all_descendants_have',
  'and_',
  'no_ancestor_has',
  'no_child_has',
  'no_descendant_has',
  'not_',
  'or_',
  'some_ancestor_has',
  'some_child_has',
  'some_descendant_has',
  'stop_recursing_when',
])

export function spanQueryToSnakeCase(query: SpanQuery): SpanQuery {
  const out: Record<string, unknown> = {}
  for (const [rawKey, rawValue] of Object.entries(query as Record<string, unknown>)) {
    if (rawValue === undefined) continue
    const key = QUERY_KEY_MAP[rawKey] ?? rawKey
    if (RECURSIVE_QUERY_KEYS.has(key)) {
      out[key] = Array.isArray(rawValue)
        ? rawValue.map((item) => spanQueryToSnakeCase(item as SpanQuery))
        : spanQueryToSnakeCase(rawValue as SpanQuery)
    } else {
      out[key] = rawValue
    }
  }
  return out as SpanQuery
}

function queryValue(query: SpanQuery, snakeKey: string, camelKey: string): unknown {
  const q = query as Record<string, unknown>
  return q[snakeKey] ?? q[camelKey]
}

function definedQueryKeys(query: SpanQuery): string[] {
  return Object.entries(query as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => QUERY_KEY_MAP[key] ?? key)
}

function findDescendants(node: SpanNode, stopRecursingWhen: SpanQuery): SpanNode[] {
  const out: SpanNode[] = []
  const visit = (children: readonly SpanNode[]): void => {
    for (const child of children) {
      out.push(child)
      if (!matchesQuery(child, stopRecursingWhen)) visit(child.children)
    }
  }
  visit(node.children)
  return out
}

function findAncestors(node: SpanNode, stopRecursingWhen: SpanQuery): SpanNode[] {
  const out: SpanNode[] = []
  let current = node.parent
  while (current !== null) {
    out.push(current)
    if (matchesQuery(current, stopRecursingWhen)) break
    current = current.parent
  }
  return out
}

export class SpanTree {
  readonly roots: SpanNode[]
  /** Set when the user-provided custom OTel provider didn't allow processor installation. */
  private readonly recordingError: null | SpanTreeRecordingError

  constructor(roots: SpanNode[] = [], recordingError: null | SpanTreeRecordingError = null) {
    this.roots = roots
    this.recordingError = recordingError
  }

  static fromError(err: SpanTreeRecordingError): SpanTree {
    return new SpanTree([], err)
  }

  static fromSpans(spans: ReadableSpan[]): SpanTree {
    const byId = new Map<string, SpanNode>()
    for (const s of spans) {
      const node = new SpanNode(s)
      byId.set(node.spanId, node)
    }
    const roots: SpanNode[] = []
    for (const node of byId.values()) {
      const parent = node.parentSpanId === undefined ? undefined : byId.get(node.parentSpanId)
      if (parent === undefined) {
        roots.push(node)
      } else {
        node.parent = parent
        parent.children.push(node)
      }
    }
    // sort siblings by start time so traversal is deterministic
    const sortRecursive = (nodes: SpanNode[]): void => {
      nodes.sort((a, b) => a.startTimeNs - b.startTimeNs)
      for (const n of nodes) sortRecursive(n.children)
    }
    sortRecursive(roots)
    return new SpanTree(roots)
  }

  *all(): Generator<SpanNode> {
    for (const r of this.roots) {
      yield r
      yield* r.descendants()
    }
  }

  any(query: SpanQuery): boolean {
    return this.first(query) !== null
  }

  /** Throws if span-tree recording wasn't available. Mirrors Python's `span_tree` property. */
  ensureAvailable(): void {
    if (this.recordingError !== null) throw this.recordingError
  }

  find(query: SpanQuery): SpanNode[] {
    this.ensureAvailable()
    const results: SpanNode[] = []
    for (const node of this.all()) {
      if (matchesQuery(node, query)) results.push(node)
    }
    return results
  }

  first(query: SpanQuery): null | SpanNode {
    this.ensureAvailable()
    for (const node of this.all()) {
      if (matchesQuery(node, query)) return node
    }
    return null
  }
}
