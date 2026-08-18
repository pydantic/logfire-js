/**
 * Walk a captured span tree and extract gen_ai-flavored metrics.
 *
 * For each span with `gen_ai.request.model` set:
 *   - if `gen_ai.operation.name === 'chat'`, increment `requests`
 *   - copy `operation.cost` -> `cost`
 *   - copy any `gen_ai.usage.<x>` and `gen_ai.usage.details.<x>` keys to `<x>`
 *
 * Mirrors pydantic-evals' `_task_run.extract_span_tree_metrics`.
 */

import type { SpanTree } from './spanTree/SpanTree'

import { incrementMetric } from './currentTaskRun'

export function extractMetricsFromSpanTree(tree: SpanTree, into: Record<string, number>): void {
  for (const node of tree.all()) {
    const attrs = node.attributes
    if (typeof attrs['gen_ai.request.model'] !== 'string') {
      continue
    }
    if (attrs['gen_ai.operation.name'] === 'chat') {
      incrementMetric(into, 'requests', 1)
    }
    const cost = attrs['operation.cost']
    if (typeof cost === 'number') {
      incrementMetric(into, 'cost', cost)
    }
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v !== 'number') {
        continue
      }
      const usagePrefix = 'gen_ai.usage.'
      const detailsPrefix = 'gen_ai.usage.details.'
      if (k.startsWith(detailsPrefix)) {
        incrementMetric(into, k.slice(detailsPrefix.length), v)
      } else if (k.startsWith(usagePrefix)) {
        incrementMetric(into, k.slice(usagePrefix.length), v)
      }
    }
  }
}
