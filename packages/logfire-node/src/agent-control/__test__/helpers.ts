/**
 * Shared test scaffolding: a local variables provider, a way to see what was warned, and a way to
 * see what was reported.
 *
 * Everything here is offline. The Logfire SDK's `LocalVariableProvider` is a full provider backed by
 * an in-memory `VariablesConfig`, and the hint span is read back off a real `InMemorySpanExporter`,
 * so both paths are exercised against the interfaces the remote ones implement, with no network and
 * no recorded fixtures to drift.
 */

import { trace as TraceAPI } from '@opentelemetry/api'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { configureLogfireApi } from 'logfire'
import { configureVariables, getVariableProvider } from 'logfire/vars'
import type { VariableConfig, VariablesConfig } from 'logfire/vars'
import { afterEach, beforeEach, vi } from 'vite-plus/test'

import { logfireConfig } from '../../logfireConfig'
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
    useDeployment(PRISTINE_DEPLOYMENT)
  })
  return captured
}

/**
 * The deployment identity the process started with, restored after every test by `captureWarnings`.
 *
 * `logfireConfig` is seeded from the environment at import, so a machine with `LOGFIRE_SERVICE_NAME`
 * set would otherwise give a different hint span here than CI does.
 */
const PRISTINE_DEPLOYMENT = {
  serviceName: logfireConfig.serviceName,
  environment: logfireConfig.deploymentEnvironment,
  serviceVersion: logfireConfig.serviceVersion,
}

/**
 * Say which deployment this process is, for the rest of the test.
 *
 * Every field is passed, and a field left out is how a test says the SDK does not know it -- which is
 * a state the hint has to report differently from knowing an empty string.
 */
export function useDeployment(identity: {
  serviceName?: string | undefined
  environment?: string | undefined
  serviceVersion?: string | undefined
}): void {
  logfireConfig.serviceName = identity.serviceName
  logfireConfig.deploymentEnvironment = identity.environment
  logfireConfig.serviceVersion = identity.serviceVersion
}

/** Read a variable's stored definition back out of whichever provider is configured. */
export function storedConfigFor(name: string): VariableConfig | undefined {
  return getVariableProvider().getVariableConfig?.(name) as VariableConfig | undefined
}

/** One span as this suite reads it: what the platform indexes on, and what it queries. */
export interface CapturedSpan {
  /** The OTel span name, which is what a Logfire-side query selects a hint by. */
  name: string
  /** Every attribute the span carries, the hint's and Logfire's own alike. */
  attributes: Record<string, unknown>
}

/**
 * Run `body` against a real exporter and hand back the spans it produced.
 *
 * A real `BasicTracerProvider` and a real `InMemorySpanExporter` rather than a spy on `logfire.span`,
 * because what this suite asserts is a cross-language contract the platform queries: the span name
 * the SDK actually exported, and the attribute keys and value types that actually landed on it.
 * A spy would agree with whatever the code passed, including a value the exporter drops.
 *
 * `configureLogfireApi` is re-run inside, exactly as the API package's own `collectSpans` helper
 * does: `trace.getTracer` hands back a proxy that caches its delegate the first time a span is
 * started, so a second test's provider would otherwise never see a span.
 */
export async function collectSpans(body: () => Promise<void> | void): Promise<CapturedSpan[]> {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  TraceAPI.setGlobalTracerProvider(provider)
  configureLogfireApi({ otelScope: 'logfire' })
  try {
    await body()
    await provider.forceFlush()
    return exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: { ...span.attributes } }))
  } finally {
    await provider.shutdown()
    TraceAPI.disable()
  }
}

/** The `agent_control.*` half of one span's attributes, which is the contract this suite pins. */
export function hintAttributes(span: CapturedSpan): Record<string, unknown> {
  return Object.fromEntries(Object.entries(span.attributes).filter(([name]) => name.startsWith('agent_control.')))
}

/**
 * Run `body` and hand back the hint spans it reported, as `[name, attributes]`.
 *
 * Every other span a test happens to open is filtered out by name, so a suite asserting "reported
 * once" is asserting about hints rather than about span traffic in general.
 */
export async function collectHints(body: () => Promise<void> | void): Promise<Record<string, unknown>[]> {
  const spans = await collectSpans(body)
  return spans.filter((span) => span.name === 'agent_control_config_hint').map(hintAttributes)
}
