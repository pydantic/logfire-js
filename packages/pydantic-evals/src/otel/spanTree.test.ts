import { describe, expect, test } from 'vitest'

import { SpanNode, SpanTree } from './spanTree'

function makeNode(
  name: string,
  spanId: string,
  parentSpanId: null | string,
  startMs = 0,
  endMs = 1000,
  attrs: Record<string, unknown> = {}
) {
  return new SpanNode({
    attributes: attrs as never,
    endTimestamp: new Date(endMs),
    name,
    parentSpanId,
    spanId,
    startTimestamp: new Date(startMs),
    traceId: 'trace-1',
  })
}

describe('SpanTree', () => {
  test('builds tree with roots and children', () => {
    const a = makeNode('root', 'a', null)
    const b = makeNode('child', 'b', 'a')
    const c = makeNode('grandchild', 'c', 'b')
    const tree = new SpanTree([a, b, c])
    expect(tree.roots).toHaveLength(1)
    expect(tree.roots[0]?.name).toBe('root')
    expect(tree.roots[0]?.children).toHaveLength(1)
    expect(tree.roots[0]?.children[0]?.name).toBe('child')
  })

  test('treats orphaned nodes as roots', () => {
    const orphan = makeNode('orphan', 'x', 'missing')
    const tree = new SpanTree([orphan])
    expect(tree.roots).toHaveLength(1)
  })

  test('toString describes tree', () => {
    const a = makeNode('root', 'a', null)
    const tree = new SpanTree([a])
    expect(tree.toString()).toContain('num_roots=1')
    expect(tree.toString()).toContain('total_spans=1')
  })

  test('addSpans rebuilds', () => {
    const tree = new SpanTree()
    tree.addSpans([makeNode('a', 'a', null), makeNode('b', 'b', 'a')])
    expect(tree.roots).toHaveLength(1)
    expect(tree.roots[0]?.children).toHaveLength(1)
  })

  test('find/first/any work with predicates and queries', () => {
    const a = makeNode('root', 'a', null, 0, 1000, { ok: true })
    const b = makeNode('child', 'b', 'a')
    const tree = new SpanTree([a, b])
    expect(tree.find((n) => n.name === 'child')).toHaveLength(1)
    expect(tree.first({ name_equals: 'root' })?.name).toBe('root')
    expect(tree.any({ name_contains: 'hild' })).toBe(true)
    expect(tree.any({ name_equals: 'missing' })).toBe(false)
  })

  test('iterator yields all nodes', () => {
    const a = makeNode('a', 'a', null)
    const b = makeNode('b', 'b', 'a')
    const tree = new SpanTree([a, b])
    expect(Array.from(tree)).toHaveLength(2)
  })
})

describe('SpanNode query matching', () => {
  test('name predicates', () => {
    const n = makeNode('my-op', 'a', null)
    expect(n.matches({ name_equals: 'my-op' })).toBe(true)
    expect(n.matches({ name_equals: 'other' })).toBe(false)
    expect(n.matches({ name_contains: 'my' })).toBe(true)
    expect(n.matches({ name_contains: 'xy' })).toBe(false)
    expect(n.matches({ name_matches_regex: '^my' })).toBe(true)
    expect(n.matches({ name_matches_regex: 'xx' })).toBe(false)
  })

  test('attribute predicates', () => {
    const n = makeNode('x', 'a', null, 0, 1000, { key1: 'v', key2: 'v2' })
    expect(n.matches({ has_attributes: { key1: 'v' } })).toBe(true)
    expect(n.matches({ has_attributes: { key1: 'wrong' } })).toBe(false)
    expect(n.matches({ has_attribute_keys: ['key1', 'key2'] })).toBe(true)
    expect(n.matches({ has_attribute_keys: ['missing'] })).toBe(false)
  })

  test('duration predicates', () => {
    const n = makeNode('x', 'a', null, 0, 2000)
    expect(n.duration).toBe(2)
    expect(n.matches({ min_duration: 1 })).toBe(true)
    expect(n.matches({ min_duration: 3 })).toBe(false)
    expect(n.matches({ max_duration: 3 })).toBe(true)
    expect(n.matches({ max_duration: 1 })).toBe(false)
  })

  test('logical operators', () => {
    const n = makeNode('x', 'a', null, 0, 1000, { k: 'v' })
    expect(n.matches({ and_: [{ name_equals: 'x' }, { has_attributes: { k: 'v' } }] })).toBe(true)
    expect(n.matches({ or_: [{ name_equals: 'other' }, { name_equals: 'x' }] })).toBe(true)
    expect(n.matches({ not_: { name_equals: 'other' } })).toBe(true)
    expect(n.matches({ not_: { name_equals: 'x' } })).toBe(false)
    expect(() => n.matches({ name_equals: 'x', or_: [{ name_equals: 'x' }] })).toThrow()
  })

  test('callable predicate', () => {
    const n = makeNode('x', 'a', null)
    expect(n.matches((node) => node.name === 'x')).toBe(true)
  })

  test('child/descendant/ancestor predicates', () => {
    const root = makeNode('root', 'r', null)
    const child = makeNode('child', 'c', 'r')
    const grandchild = makeNode('gc', 'g', 'c')
    const tree = new SpanTree([root, child, grandchild])
    const actualRoot = tree.roots[0]!
    expect(actualRoot.matches({ some_child_has: { name_equals: 'child' } })).toBe(true)
    expect(actualRoot.matches({ some_descendant_has: { name_equals: 'gc' } })).toBe(true)
    expect(actualRoot.matches({ no_descendant_has: { name_equals: 'missing' } })).toBe(true)
    expect(actualRoot.matches({ min_child_count: 1 })).toBe(true)
    expect(actualRoot.matches({ max_child_count: 10 })).toBe(true)
    expect(actualRoot.matches({ min_descendant_count: 2 })).toBe(true)
    expect(actualRoot.matches({ max_descendant_count: 10 })).toBe(true)
    expect(actualRoot.matches({ all_children_have: { name_equals: 'child' } })).toBe(true)

    const gcNode = Array.from(tree).find((n) => n.name === 'gc')!
    expect(gcNode.matches({ some_ancestor_has: { name_equals: 'root' } })).toBe(true)
    expect(gcNode.matches({ no_ancestor_has: { name_equals: 'none' } })).toBe(true)
    expect(gcNode.matches({ all_ancestors_have: { name_matches_regex: '.' } })).toBe(true)
    expect(gcNode.matches({ min_depth: 1 })).toBe(true)
    expect(gcNode.matches({ max_depth: 10 })).toBe(true)

    expect(gcNode.ancestors).toHaveLength(2)
    expect(actualRoot.descendants).toHaveLength(2)
  })

  test('node methods: firstChild/anyChild/findChildren', () => {
    const root = makeNode('root', 'r', null)
    const c1 = makeNode('c1', 'c1', 'r')
    const c2 = makeNode('c2', 'c2', 'r')
    const tree = new SpanTree([root, c1, c2])
    const actualRoot = tree.roots[0]!
    expect(actualRoot.firstChild((n) => n.name === 'c2')?.name).toBe('c2')
    expect(actualRoot.firstChild((n) => n.name === 'missing')).toBeNull()
    expect(actualRoot.anyChild((n) => n.name === 'c1')).toBe(true)
    expect(actualRoot.findChildren(() => true)).toHaveLength(2)
  })

  test('node methods: firstDescendant/anyDescendant/findDescendants with stopRecursing', () => {
    const root = makeNode('root', 'r', null)
    const c = makeNode('c', 'c', 'r')
    const gc = makeNode('gc', 'gc', 'c')
    const tree = new SpanTree([root, c, gc])
    const actualRoot = tree.roots[0]!
    expect(actualRoot.firstDescendant({ name_equals: 'gc' })?.name).toBe('gc')
    expect(actualRoot.firstDescendant({ name_equals: 'missing' })).toBeNull()
    expect(actualRoot.anyDescendant({ name_equals: 'c' })).toBe(true)
    expect(actualRoot.findDescendants(() => true, { name_equals: 'c' })).toHaveLength(1)
  })

  test('node methods: firstAncestor/anyAncestor/findAncestors with stopRecursing', () => {
    const root = makeNode('root', 'r', null)
    const c = makeNode('c', 'c', 'r')
    const gc = makeNode('gc', 'gc', 'c')
    const tree = new SpanTree([root, c, gc])
    const gcNode = Array.from(tree).find((n) => n.name === 'gc')!
    expect(gcNode.firstAncestor({ name_equals: 'root' })?.name).toBe('root')
    expect(gcNode.firstAncestor({ name_equals: 'missing' })).toBeNull()
    expect(gcNode.anyAncestor({ name_equals: 'c' })).toBe(true)
    expect(gcNode.findAncestors(() => true, { name_equals: 'c' })).toHaveLength(1)
  })

  test('toString on nodes', () => {
    const leaf = makeNode('leaf', 'l', null)
    expect(leaf.toString()).toContain("name='leaf'")
    expect(leaf.toString()).toContain("span_id='l'")
    const root = makeNode('root', 'r', null)
    const child = makeNode('c', 'c', 'r')
    const tree = new SpanTree([root, child])
    const actualRoot = tree.roots[0]!
    expect(actualRoot.toString()).toContain('...')
  })

  test('parentNodeKey returns null for roots', () => {
    const root = makeNode('root', 'r', null)
    expect(root.parentNodeKey).toBeNull()
    const child = makeNode('c', 'c', 'r')
    expect(child.parentNodeKey).toBe('trace-1:r')
  })
})
