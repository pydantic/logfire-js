/**
 * Shared test scaffolding: a local variables provider, and a way to see what was warned.
 *
 * Everything here is offline. The Logfire SDK's `LocalVariableProvider` is a full provider backed by
 * an in-memory `VariablesConfig` -- it reads, creates, and updates -- so the publish path is
 * exercised against the same interface the remote provider implements, with no network and no
 * recorded fixtures to drift.
 */

import { configureVariables, getVariableProvider } from 'logfire/vars'
import type { VariableConfig, VariablesConfig } from 'logfire/vars'
import { afterEach, beforeEach, vi } from 'vite-plus/test'

import { resetAgentControl } from '../testing'

/**
 * A variables config in which `name` holds `value` under one label at full rollout.
 *
 * The shape a Logfire project has once someone has saved a value in the UI, which is what a control
 * with a matching label then resolves.
 */
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

/** A variables config in which `name` exists but nothing is published for it. */
export function emptyVariable(name: string, config: Partial<VariableConfig> = {}): VariablesConfig {
  return {
    variables: { [name]: { name, labels: {}, rollout: { labels: {} }, overrides: [], ...config } },
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

/**
 * Capture `console.warn` for the duration of a test, and reset every once-per-process guard.
 *
 * The guards are the reason this is a fixture rather than a per-test spy: "warns once per process"
 * is a property worth asserting, which means each test has to start from a process that has not
 * warned yet.
 */
export function captureWarnings(): { messages: string[] } {
  const captured: { messages: string[] } = { messages: [] }
  beforeEach(() => {
    captured.messages.length = 0
    // The same entry point an adapter's suite uses, so the package's own tests exercise the thing it
    // ships rather than a private shortcut past it.
    resetAgentControl()
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

/** Read a variable's stored definition back out of whichever provider is configured. */
export function storedConfigFor(name: string): VariableConfig | undefined {
  return getVariableProvider().getVariableConfig?.(name) as VariableConfig | undefined
}
