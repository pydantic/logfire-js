/**
 * YAML read/write. Wrapper around `js-yaml` so the rest of evals can stay
 * library-agnostic.
 */

import { dump as yamlDump, load as yamlLoad } from 'js-yaml'

export function parseYaml(text: string): unknown {
  return yamlLoad(text)
}

export function stringifyYaml(value: unknown, opts: { sortKeys?: boolean } = {}): string {
  return yamlDump(value, { lineWidth: 120, noRefs: true, sortKeys: opts.sortKeys ?? false })
}
