/**
 * Test scaffolding: a local variables provider, captured warnings, and the fake `codex` binary.
 *
 * Everything is offline. Variables come from the Logfire SDK's `LocalVariableProvider`, which
 * implements the same interface the remote one does, and the `codex` process is a Node script that
 * records its argv -- so the two things this package does, reading a published value and turning it
 * into CLI flags, are both exercised end to end with no network and no API key.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resetAgentControl } from '@pydantic/logfire-node/agent-control/testing'
import { configureVariables, getVariableProvider } from '@pydantic/logfire-node/vars'
import type { VariableConfig, VariablesConfig } from '@pydantic/logfire-node/vars'
import { afterEach, beforeEach, vi } from 'vite-plus/test'

/** The stand-in `codex` binary, made executable here so a fresh clone does not depend on file modes. */
export const FAKE_CODEX: string = join(dirname(fileURLToPath(import.meta.url)), '../../test-fixtures/fake-codex.ts')
chmodSync(FAKE_CODEX, 0o755)

/**
 * A distinct agent name per call.
 *
 * `resetAgentControl` clears the core's once-per-process guards between tests, but two agents that
 * share a name also share a variable, and several tests here run two at once on purpose.
 */
let counter = 0
export function uniqueName(prefix = 'agent'): string {
  counter += 1
  return `${prefix}_${String(counter)}`
}

/** A variables config in which `name` holds `value` under one label at full rollout. */
export function publishedValue(name: string, value: unknown, label = 'production'): VariablesConfig {
  return {
    variables: {
      [name]: {
        name,
        labels: { [label]: { version: 1, serialized_value: JSON.stringify(value) } },
        rollout: { labels: { [label]: 1 } },
        overrides: [],
      },
    },
  }
}

/** Point the SDK at a local provider holding `config`. */
export function useLocalVariables(config: VariablesConfig = { variables: {} }): void {
  configureVariables({ config, instrument: false })
}

/** Switch variables off entirely, which installs the no-op provider. */
export function useNoVariables(): void {
  configureVariables(false)
}

/** Read a variable's stored definition back out of the local provider. */
export function storedConfig(name: string): VariableConfig | undefined {
  return getVariableProvider().getVariableConfig?.(name) as VariableConfig | undefined
}

/**
 * Capture `console.warn` for the duration of each test, starting from no variables at all.
 *
 * The core's warning memory and baseline-publish guard are per process by design, so each test
 * starts from a process that has done neither -- through the same `@pydantic/logfire-node/agent-control/testing`
 * entry point this package tells adapter authors to use.
 */
export function captureWarnings(): { messages: string[] } {
  const captured: { messages: string[] } = { messages: [] }
  beforeEach(() => {
    captured.messages.length = 0
    resetAgentControl()
    useNoVariables()
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      captured.messages.push(String(message))
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    useNoVariables()
  })
  return captured
}

/** Wait for the background baseline publish to settle. */
export async function settle(): Promise<void> {
  await Promise.all(Array.from({ length: 5 }, async () => Promise.resolve()))
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** A temporary file holding `contents`, for the tests that need a real path on disk. */
export function tempFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-control-test-')), name)
  writeFileSync(path, contents, 'utf8')
  return path
}

/** Where the fake binary writes what it was given, and the reader for it. */
export function argvCapture(): { path: string; read: () => string[] } {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-control-argv-')), 'argv.json')
  return { path, read: () => JSON.parse(readFileSync(path, 'utf8')) as string[] }
}

/**
 * The `--config key=value` overrides in an argv, in order, as a mapping.
 *
 * Values are left exactly as the SDK serialized them -- TOML literals, so strings keep their quotes
 * -- because that is what the assertion is about: `developer_instructions="Be terse."` is the flag
 * the binary parses, and a test that compared unquoted text would not notice the SDK changing how it
 * serializes one.
 */
export function configOverrides(argv: readonly string[]): Record<string, string> {
  const overrides: Record<string, string> = {}
  for (const [index, argument] of argv.entries()) {
    if (argument !== '--config') {
      continue
    }
    const pair = argv[index + 1] ?? ''
    const equals = pair.indexOf('=')
    if (equals !== -1) {
      overrides[pair.slice(0, equals)] = pair.slice(equals + 1)
    }
  }
  return overrides
}

/** The value of a flag such as `--model`, or `undefined` when the argv does not carry it. */
export function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
