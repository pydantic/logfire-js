export type AttributeValue = boolean | number | readonly boolean[] | readonly number[] | readonly string[] | string

export type SpanAttributes = Readonly<Record<string, AttributeValue | undefined>>

export interface SpanQuery {
  all_ancestors_have?: SpanQuery
  all_children_have?: SpanQuery
  all_descendants_have?: SpanQuery
  and_?: SpanQuery[]
  has_attribute_keys?: string[]
  has_attributes?: Record<string, unknown>
  max_child_count?: number
  max_depth?: number
  max_descendant_count?: number
  max_duration?: number
  min_child_count?: number
  min_depth?: number
  min_descendant_count?: number
  min_duration?: number
  name_contains?: string
  name_equals?: string
  name_matches_regex?: string
  no_ancestor_has?: SpanQuery
  no_child_has?: SpanQuery
  no_descendant_has?: SpanQuery
  not_?: SpanQuery
  or_?: SpanQuery[]
  some_ancestor_has?: SpanQuery
  some_child_has?: SpanQuery
  some_descendant_has?: SpanQuery
  stop_recursing_when?: SpanQuery
}

export type SpanPredicate = (node: SpanNode) => boolean

export interface SpanNodeInit {
  attributes?: SpanAttributes
  endTimestamp: Date
  name: string
  parentSpanId?: null | string
  spanId: string
  startTimestamp: Date
  traceId: string
}

export class SpanNode {
  readonly attributes: SpanAttributes
  readonly childrenById = new Map<string, SpanNode>()
  readonly endTimestamp: Date
  readonly name: string
  parent: null | SpanNode = null
  readonly parentSpanId: null | string
  readonly spanId: string
  readonly startTimestamp: Date
  readonly traceId: string

  get ancestors(): SpanNode[] {
    return this.findAncestors(() => true)
  }

  get children(): SpanNode[] {
    return Array.from(this.childrenById.values())
  }

  get descendants(): SpanNode[] {
    return this.findDescendants(() => true)
  }

  get duration(): number {
    return (this.endTimestamp.getTime() - this.startTimestamp.getTime()) / 1000
  }

  get nodeKey(): string {
    return `${this.traceId}:${this.spanId}`
  }

  get parentNodeKey(): null | string {
    return this.parentSpanId === null ? null : `${this.traceId}:${this.parentSpanId}`
  }

  constructor(init: SpanNodeInit) {
    this.name = init.name
    this.traceId = init.traceId
    this.spanId = init.spanId
    this.parentSpanId = init.parentSpanId ?? null
    this.startTimestamp = init.startTimestamp
    this.endTimestamp = init.endTimestamp
    this.attributes = init.attributes ?? {}
  }

  addChild(child: SpanNode): void {
    this.childrenById.set(child.nodeKey, child)
    child.parent = this
  }

  anyAncestor(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): boolean {
    return this.firstAncestor(predicate, stopRecursingWhen) !== null
  }

  anyChild(predicate: SpanPredicate | SpanQuery): boolean {
    return this.firstChild(predicate) !== null
  }

  anyDescendant(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): boolean {
    return this.firstDescendant(predicate, stopRecursingWhen) !== null
  }

  findAncestors(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): SpanNode[] {
    const out: SpanNode[] = []
    let node = this.parent
    while (node !== null) {
      if (node.matches(predicate)) out.push(node)
      if (stopRecursingWhen !== undefined && node.matches(stopRecursingWhen)) break
      node = node.parent
    }
    return out
  }

  findChildren(predicate: SpanPredicate | SpanQuery): SpanNode[] {
    return this.children.filter((child) => child.matches(predicate))
  }

  findDescendants(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): SpanNode[] {
    const out: SpanNode[] = []
    const stack: SpanNode[] = [...this.children]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.matches(predicate)) out.push(node)
      if (stopRecursingWhen !== undefined && node.matches(stopRecursingWhen)) continue
      stack.push(...node.children)
    }
    return out
  }

  firstAncestor(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): null | SpanNode {
    let node = this.parent
    while (node !== null) {
      if (node.matches(predicate)) return node
      if (stopRecursingWhen !== undefined && node.matches(stopRecursingWhen)) return null
      node = node.parent
    }
    return null
  }

  firstChild(predicate: SpanPredicate | SpanQuery): null | SpanNode {
    for (const child of this.children) {
      if (child.matches(predicate)) return child
    }
    return null
  }

  firstDescendant(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): null | SpanNode {
    const stack: SpanNode[] = [...this.children]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.matches(predicate)) return node
      if (stopRecursingWhen !== undefined && node.matches(stopRecursingWhen)) continue
      stack.push(...node.children)
    }
    return null
  }

  matches(query: SpanPredicate | SpanQuery): boolean {
    if (typeof query === 'function') return query(this)
    return this.matchesQuery(query)
  }

  toString(): string {
    if (this.children.length > 0) {
      return `<SpanNode name='${this.name}' span_id='${this.spanId}'>...</SpanNode>`
    }
    return `<SpanNode name='${this.name}' span_id='${this.spanId}' />`
  }

  private matchesQuery(query: SpanQuery): boolean {
    if (query.or_ !== undefined) {
      const keys = Object.keys(query)
      if (keys.length > 1) {
        throw new Error("Cannot combine 'or_' conditions with other conditions at the same level")
      }
      return query.or_.some((q) => this.matchesQuery(q))
    }
    if (query.not_ !== undefined && this.matchesQuery(query.not_)) return false
    if (query.and_ !== undefined && !query.and_.every((q) => this.matchesQuery(q))) return false

    if (query.name_equals !== undefined && this.name !== query.name_equals) return false
    if (query.name_contains !== undefined && !this.name.includes(query.name_contains)) return false
    if (query.name_matches_regex !== undefined && !new RegExp(query.name_matches_regex).test(this.name)) return false

    if (query.has_attributes !== undefined) {
      for (const [k, v] of Object.entries(query.has_attributes)) {
        if (this.attributes[k] !== v) return false
      }
    }
    if (query.has_attribute_keys !== undefined) {
      for (const k of query.has_attribute_keys) {
        if (!(k in this.attributes)) return false
      }
    }

    if (query.min_duration !== undefined && this.duration < query.min_duration) return false
    if (query.max_duration !== undefined && this.duration > query.max_duration) return false

    const children = this.children
    if (query.min_child_count !== undefined && children.length < query.min_child_count) return false
    if (query.max_child_count !== undefined && children.length > query.max_child_count) return false
    if (query.some_child_has !== undefined && !children.some((c) => c.matchesQuery(query.some_child_has!))) return false
    if (query.all_children_have !== undefined && !children.every((c) => c.matchesQuery(query.all_children_have!))) return false
    if (query.no_child_has !== undefined && children.some((c) => c.matchesQuery(query.no_child_has!))) return false

    const descendants = this.descendants
    const prunedDescendants =
      query.stop_recursing_when !== undefined ? this.findDescendants(() => true, query.stop_recursing_when) : descendants
    if (query.min_descendant_count !== undefined && descendants.length < query.min_descendant_count) return false
    if (query.max_descendant_count !== undefined && descendants.length > query.max_descendant_count) return false
    if (query.some_descendant_has !== undefined && !prunedDescendants.some((d) => d.matchesQuery(query.some_descendant_has!))) return false
    if (query.all_descendants_have !== undefined && !prunedDescendants.every((d) => d.matchesQuery(query.all_descendants_have!)))
      return false
    if (query.no_descendant_has !== undefined && prunedDescendants.some((d) => d.matchesQuery(query.no_descendant_has!))) return false

    const ancestors = this.ancestors
    const prunedAncestors = query.stop_recursing_when !== undefined ? this.findAncestors(() => true, query.stop_recursing_when) : ancestors
    if (query.min_depth !== undefined && ancestors.length < query.min_depth) return false
    if (query.max_depth !== undefined && ancestors.length > query.max_depth) return false
    if (query.some_ancestor_has !== undefined && !prunedAncestors.some((a) => a.matchesQuery(query.some_ancestor_has!))) return false
    if (query.all_ancestors_have !== undefined && !prunedAncestors.every((a) => a.matchesQuery(query.all_ancestors_have!))) return false
    if (query.no_ancestor_has !== undefined && prunedAncestors.some((a) => a.matchesQuery(query.no_ancestor_has!))) return false

    return true
  }
}

export class SpanTree {
  nodesById = new Map<string, SpanNode>()
  roots: SpanNode[] = []

  constructor(spans: SpanNode[] = []) {
    for (const span of spans) {
      this.nodesById.set(span.nodeKey, span)
    }
    this.rebuild()
  }

  addSpans(spans: SpanNode[]): void {
    for (const span of spans) {
      this.nodesById.set(span.nodeKey, span)
    }
    this.rebuild()
  }

  any(predicate: SpanPredicate | SpanQuery): boolean {
    return this.first(predicate) !== null
  }

  find(predicate: SpanPredicate | SpanQuery): SpanNode[] {
    return Array.from(this).filter((n) => n.matches(predicate))
  }

  first(predicate: SpanPredicate | SpanQuery): null | SpanNode {
    for (const n of this) {
      if (n.matches(predicate)) return n
    }
    return null
  }

  *[Symbol.iterator](): IterableIterator<SpanNode> {
    for (const node of this.nodesById.values()) {
      yield node
    }
  }

  toString(): string {
    return `<SpanTree num_roots=${String(this.roots.length)} total_spans=${String(this.nodesById.size)} />`
  }

  private rebuild(): void {
    // Sort by start_timestamp to ensure deterministic ordering
    const sorted = Array.from(this.nodesById.values()).sort((a, b) => a.startTimestamp.getTime() - b.startTimestamp.getTime())
    this.nodesById = new Map(sorted.map((n) => [n.nodeKey, n]))
    // Reset parent/children
    for (const node of this.nodesById.values()) {
      node.parent = null
      node.childrenById.clear()
    }
    for (const node of this.nodesById.values()) {
      const parentKey = node.parentNodeKey
      if (parentKey !== null) {
        const parent = this.nodesById.get(parentKey)
        if (parent !== undefined) {
          parent.addChild(node)
        }
      }
    }
    this.roots = []
    for (const node of this.nodesById.values()) {
      const parentKey = node.parentNodeKey
      if (parentKey === null || !this.nodesById.has(parentKey)) {
        this.roots.push(node)
      }
    }
  }
}
