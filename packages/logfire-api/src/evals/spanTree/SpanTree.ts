/* eslint-disable @typescript-eslint/no-non-null-assertion */
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
  allAncestorsHave?: SpanQuery
  allChildrenHave?: SpanQuery
  allDescendantsHave?: SpanQuery
  and_?: SpanQuery[]
  hasAttributeKeys?: string[]
  hasAttributes?: Record<string, unknown>
  maxChildCount?: number
  maxDescendantCount?: number
  /** Min duration in milliseconds. */
  maxDuration?: number
  minChildCount?: number
  minDescendantCount?: number
  /** Max duration in milliseconds. */
  minDuration?: number
  nameContains?: string
  nameEquals?: string
  nameMatchesRegex?: string
  not_?: SpanQuery
  or_?: SpanQuery[]
  someAncestorHas?: SpanQuery
  someChildHas?: SpanQuery
  someDescendantHas?: SpanQuery
  stopRecursingWhen?: SpanQuery
}

function nsFromHrTime(hr: [number, number]): number {
  return hr[0] * 1_000_000_000 + hr[1]
}

function matchesQuery(node: SpanNode, q: SpanQuery): boolean {
  if (q.nameEquals !== undefined && node.name !== q.nameEquals) return false
  if (q.nameContains !== undefined && !node.name.includes(q.nameContains)) return false
  if (q.nameMatchesRegex !== undefined && !new RegExp(q.nameMatchesRegex).test(node.name)) return false
  if (q.minDuration !== undefined && node.durationMs < q.minDuration) return false
  if (q.maxDuration !== undefined && node.durationMs > q.maxDuration) return false
  if (q.hasAttributes !== undefined) {
    for (const [k, v] of Object.entries(q.hasAttributes)) {
      if (node.attributes[k] !== v) return false
    }
  }
  if (q.hasAttributeKeys !== undefined) {
    for (const k of q.hasAttributeKeys) {
      if (!(k in node.attributes)) return false
    }
  }
  if (q.minChildCount !== undefined && node.children.length < q.minChildCount) return false
  if (q.maxChildCount !== undefined && node.children.length > q.maxChildCount) return false
  const descendants = Array.from(node.descendants())
  if (q.minDescendantCount !== undefined && descendants.length < q.minDescendantCount) return false
  if (q.maxDescendantCount !== undefined && descendants.length > q.maxDescendantCount) return false
  if (q.someChildHas !== undefined && !node.children.some((c) => matchesQuery(c, q.someChildHas!))) return false
  if (q.allChildrenHave !== undefined && !node.children.every((c) => matchesQuery(c, q.allChildrenHave!))) return false
  if (q.someDescendantHas !== undefined && !descendants.some((d) => matchesQuery(d, q.someDescendantHas!))) return false
  if (q.allDescendantsHave !== undefined && !descendants.every((d) => matchesQuery(d, q.allDescendantsHave!))) return false
  const ancestors = Array.from(node.ancestors())
  if (q.someAncestorHas !== undefined && !ancestors.some((a) => matchesQuery(a, q.someAncestorHas!))) return false
  if (q.allAncestorsHave !== undefined && !ancestors.every((a) => matchesQuery(a, q.allAncestorsHave!))) return false
  if (q.not_ !== undefined && matchesQuery(node, q.not_)) return false
  if (q.and_ !== undefined && !q.and_.every((sub) => matchesQuery(node, sub))) return false
  if (q.or_ !== undefined && !q.or_.some((sub) => matchesQuery(node, sub))) return false
  return true
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
